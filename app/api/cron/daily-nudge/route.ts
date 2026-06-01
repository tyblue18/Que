/**
 * GET /api/cron/daily-nudge  — Evening food-log reminder
 *
 * Scheduled at 00:00 UTC daily by Vercel Cron (= 8 pm US Eastern).
 * For every subscribed user, if it's evening in THEIR timezone and they
 * haven't logged any calories for their local today, send a reminder.
 *
 * Reads per-day data from DayRecord rows (the WorkoutData.localDB blob is no
 * longer written by /api/sync) and resolves each user's local date + hour from
 * the timezone offset stamped into their synced settings (queTzOffset).
 *
 * Note: Vercel Hobby crons run once per day at a fixed UTC time, so this fires
 * at the evening of US-timezone users (around 00:00 UTC). The local-hour gate
 * keeps users far from that window from getting an off-hours ping.
 * Protected by CRON_SECRET.
 */

import { NextResponse }    from 'next/server';
import { prisma }          from '@/lib/prisma';
import { isAuthorizedCron } from '@/lib/cronAuth';
import { sendPushToUser }  from '@/lib/push';
import { LAST_STREAK_KEY } from '@/lib/constants';
import { mapWithConcurrency } from '@/lib/asyncBatch';

type SubClient = { findMany: (a: unknown) => Promise<Array<{ userId: string }>> };
const ps = () => (prisma as unknown as { pushSubscription: SubClient }).pushSubscription;

type DayClient = { findMany: (a: unknown) => Promise<Array<{ userId: string; date: string; data: unknown }>> };
const dr = () => (prisma as unknown as { dayRecord: DayClient }).dayRecord;

const DEFAULT_TZ_OFFSET = 240; // US Eastern; local = UTC − offsetMinutes

function utcDateStr(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
function localParts(tzOffsetMin: number): { date: string; hour: number } {
  const d = new Date(Date.now() - tzOffsetMin * 60_000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const subscribers = await ps().findMany({ distinct: ['userId'], select: { userId: true } });
  if (subscribers.length === 0) return NextResponse.json({ ok: true, sent: 0, skipped: 0 });

  const userIds = subscribers.map(s => s.userId);

  const wd = await prisma.workoutData.findMany({
    where:  { userId: { in: userIds } },
    select: { userId: true, settings: true },
  });
  const settingsByUser = new Map(wd.map(r => [r.userId, (r.settings ?? {}) as Record<string, unknown>]));

  const dates = [utcDateStr(-1), utcDateStr(0), utcDateStr(1)];
  const rows  = await dr().findMany({
    where:  { userId: { in: userIds }, date: { in: dates } },
    select: { userId: true, date: true, data: true },
  });
  const byUser = new Map<string, Record<string, { calsEaten?: string | number }>>();
  for (const r of rows) {
    const m = byUser.get(r.userId) ?? {};
    m[r.date] = (r.data ?? {}) as { calsEaten?: string | number };
    byUser.set(r.userId, m);
  }

  // Per-user push is pure network I/O — fan out with bounded concurrency so the
  // run scales with the user base instead of creeping toward the 300s timeout.
  const settled = await mapWithConcurrency(subscribers, 10, async ({ userId }) => {
    const settings = settingsByUser.get(userId) ?? {};
    const tz   = typeof settings.queTzOffset === 'number' ? settings.queTzOffset : DEFAULT_TZ_OFFSET;
    const { date, hour } = localParts(tz);

    // Only fire in the user's evening (~6 pm–11 pm local).
    if (hour < 18 || hour > 23) return 'skipped' as const;

    const eaten = parseFloat(String(byUser.get(userId)?.[date]?.calsEaten ?? '0')) || 0;
    if (eaten > 50) return 'skipped' as const; // already logged food today

    const streak = (() => {
      const raw = settings[LAST_STREAK_KEY];
      return typeof raw === 'number' ? raw : parseInt(String(raw ?? '0')) || 0;
    })();
    const streakNote = streak >= 3 ? ` Don't break your ${streak}-day streak.` : '';

    await sendPushToUser(userId, {
      title: 'Log your meals 🍽️',
      body:  `You haven't tracked any calories today.${streakNote}`,
      url:   '/app',
      tag:   'food-log',
    });
    return 'sent' as const;
  });

  let sent = 0, skipped = 0, failed = 0;
  for (const s of settled) {
    if (s.status === 'rejected')      failed++;
    else if (s.value === 'sent')      sent++;
    else                              skipped++;
  }

  console.log(`[cron/daily-nudge] evening food reminder — sent:${sent} skipped:${skipped} failed:${failed}`);
  return NextResponse.json({ ok: true, sent, skipped, failed });
}
