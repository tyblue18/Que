/**
 * GET /api/cron/weekly-recap
 *
 * Scheduled at 23:00 UTC every Sunday (= 7 pm US Eastern). Sends a teaser push
 * that drives the user into the app, where WeeklyRecapModal renders the full
 * "Week in Review" (PRs, cardio highlights, plan progress, etc.). A local-hour
 * gate keeps the push to the user's Sunday evening; the in-app modal is the
 * timezone-proof delivery and shows for everyone once it's 7 pm their time.
 * Protected by CRON_SECRET.
 */

import { NextResponse }   from 'next/server';
import { prisma }         from '@/lib/prisma';
import { isAuthorizedCron } from '@/lib/cronAuth';
import { sendPushToUser } from '@/lib/push';
import { GOAL_TOLERANCE, LAST_STREAK_KEY } from '@/lib/constants';
import { mapWithConcurrency } from '@/lib/asyncBatch';

interface DayRecord {
  calsEaten?: string | number;
  exercises?: string;
  budget?:    number | string;
}

type PushSubClient = {
  findMany: (args: {
    distinct: string[];
    select:   Record<string, boolean>;
  }) => Promise<Array<{ userId: string }>>;
};

const ps = () => (prisma as unknown as { pushSubscription: PushSubClient }).pushSubscription;

type DayClient = { findMany: (a: unknown) => Promise<Array<{ userId: string; date: string; data: unknown }>> };
const dr = () => (prisma as unknown as { dayRecord: DayClient }).dayRecord;

// ── Date helpers ──────────────────────────────────────────────────────────────

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// US-Eastern default for users who haven't synced a timezone yet; local = UTC − offset.
const DEFAULT_TZ_OFFSET = 240;
function localHour(tzOffsetMin: number): number {
  return new Date(Date.now() - tzOffsetMin * 60_000).getUTCHours();
}

/** The 7 date strings Mon–Sun for the week ending TODAY (the recap Sunday) —
 *  matches the window WeeklyRecapModal computes on the client. */
function weekDates(): string[] {
  const dates: string[] = [];
  const d = new Date();
  for (let i = 6; i >= 0; i--) {
    const day = new Date(d);
    day.setUTCDate(d.getUTCDate() - i);
    dates.push(dateStr(day));
  }
  return dates;
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function hasWorkout(day: DayRecord | undefined): boolean {
  if (!day?.exercises) return false;
  try {
    const entries = JSON.parse(day.exercises) as Array<{ k: string }>;
    return entries.some(e => e.k === 'lift' || e.k === 'run' || e.k === 'bike' || e.k === 'swim');
  } catch { return false; }
}

function hitGoal(day: DayRecord | undefined): boolean {
  if (!day) return false;
  const eaten  = parseFloat(String(day.calsEaten ?? '0'));
  const budget = parseFloat(String(day.budget    ?? '0'));
  return eaten > 50 && budget > 0 && Math.abs(eaten - budget) <= GOAL_TOLERANCE;
}

interface WeekStats {
  workoutDays: number;
  goalDays:    number;
  loggedDays:  number;
}

function computeStats(localDB: Record<string, DayRecord>, dates: string[]): WeekStats {
  let workoutDays = 0, goalDays = 0, loggedDays = 0;
  for (const d of dates) {
    const day = localDB[d];
    if (!day) continue;
    if (hasWorkout(day))  workoutDays++;
    if (hitGoal(day))     goalDays++;
    if (parseFloat(String(day.calsEaten ?? '0')) > 50) loggedDays++;
  }
  return { workoutDays, goalDays, loggedDays };
}

// ── Message builder ───────────────────────────────────────────────────────────

function buildRecap(
  stats: WeekStats,
  streak: number,
): { title: string; body: string } {
  const { workoutDays, goalDays, loggedDays } = stats;
  const hasAnyData = workoutDays > 0 || loggedDays > 0;

  if (!hasAnyData) {
    return {
      title: 'New week, fresh start 🎯',
      body:  'Nothing logged last week. Jump in today and start your streak.',
    };
  }

  // Title based on overall performance
  let title: string;
  if (workoutDays >= 4 || goalDays >= 5) {
    title = 'Solid week 🔥';
  } else if (workoutDays >= 2 || goalDays >= 3) {
    title = 'Keep it going 💪';
  } else {
    title = 'Weekly recap 📊';
  }

  // Body — build stat fragments
  const parts: string[] = [];

  if (workoutDays > 0) {
    parts.push(`${workoutDays} workout${workoutDays !== 1 ? 's' : ''}`);
  }

  if (loggedDays > 0) {
    parts.push(`calorie goal ${goalDays}/${loggedDays} days`);
  }

  if (streak >= 3) {
    parts.push(`🔥 ${streak}-day streak`);
  }

  // Teaser only — the full breakdown lives in the in-app recap. Always end with
  // a CTA so the notification drives the user to open it.
  const body = (parts.length > 0 ? `${parts.join(' · ')} — ` : '') + 'tap to see your full week ▸';

  return { title, body };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(req: Request): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dates = weekDates();

  const subscribers = await ps().findMany({
    distinct: ['userId'],
    select:   { userId: true },
  });

  if (subscribers.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, week: dates[0] });
  }

  const userIds = subscribers.map(s => s.userId);

  // Settings (for streak) come from WorkoutData; per-day stats come from
  // DayRecord rows — the WorkoutData.localDB blob is no longer written by sync.
  const [settingsRows, dayRows] = await Promise.all([
    prisma.workoutData.findMany({
      where:  { userId: { in: userIds } },
      select: { userId: true, settings: true },
    }),
    dr().findMany({
      where:  { userId: { in: userIds }, date: { in: dates } },
      select: { userId: true, date: true, data: true },
    }),
  ]);

  const settingsByUser = new Map(settingsRows.map(r => [r.userId, (r.settings ?? {}) as Record<string, unknown>]));
  const daysByUser = new Map<string, Record<string, DayRecord>>();
  for (const r of dayRows) {
    const m = daysByUser.get(r.userId) ?? {};
    m[r.date] = (r.data ?? {}) as DayRecord;
    daysByUser.set(r.userId, m);
  }

  // Per-user push is pure network I/O — fan out with bounded concurrency.
  const settled = await mapWithConcurrency(subscribers, 10, async ({ userId }) => {
    const settings = settingsByUser.get(userId) ?? {};
    const localDB  = daysByUser.get(userId) ?? {};

    // Only push during the user's Sunday evening. At 23:00 UTC this covers all
    // US timezones (ET 7pm → PT 4pm); far-east zones (already Monday) are
    // skipped — the in-app recap still greets them at 7 pm their time.
    const tz   = typeof settings.queTzOffset === 'number' ? settings.queTzOffset : DEFAULT_TZ_OFFSET;
    const hour = localHour(tz);
    if (hour < 16 || hour > 23) return 'skipped' as const;

    const streak = (() => {
      try {
        const raw = settings[LAST_STREAK_KEY];
        return typeof raw === 'number' ? raw : parseInt(String(raw ?? '0')) || 0;
      } catch { return 0; }
    })();

    const stats = computeStats(localDB, dates);
    const msg   = buildRecap(stats, streak);

    await sendPushToUser(userId, { ...msg, url: '/app', tag: 'weekly-recap' });
    return 'sent' as const;
  });

  let sent = 0, skipped = 0, failed = 0;
  for (const s of settled) {
    if (s.status === 'rejected') failed++;
    else if (s.value === 'sent') sent++;
    else                         skipped++;
  }

  console.log(`[cron/weekly-recap] week of ${dates[0]} — sent:${sent} skipped:${skipped} failed:${failed}`);
  return NextResponse.json({ ok: true, week: dates[0], sent, skipped, failed });
}
