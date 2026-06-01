/**
 * GET /api/cron/weigh-in-reminder
 *
 * Scheduled at 13:00 UTC daily by Vercel Cron (≈ 8–9 am US Eastern).
 * Sends a morning weigh-in push to every subscribed user who hasn't logged
 * their weight for their LOCAL today yet.
 *
 * Reads per-day data from DayRecord rows (the WorkoutData.localDB blob is no
 * longer written by /api/sync), and resolves each user's local date from the
 * timezone offset stamped into their synced settings (queTzOffset).
 * Protected by CRON_SECRET.
 */

import { NextResponse }   from 'next/server';
import { prisma }         from '@/lib/prisma';
import { isAuthorizedCron } from '@/lib/cronAuth';
import { sendPushToUser } from '@/lib/push';
import { mapWithConcurrency } from '@/lib/asyncBatch';

type SubClient = { findMany: (a: unknown) => Promise<Array<{ userId: string }>> };
const ps = () => (prisma as unknown as { pushSubscription: SubClient }).pushSubscription;

type DayClient = { findMany: (a: unknown) => Promise<Array<{ userId: string; date: string; data: unknown }>> };
const dr = () => (prisma as unknown as { dayRecord: DayClient }).dayRecord;

// Default offset for users who haven't synced since timezone capture shipped.
// US Eastern (this app's primary audience); local = UTC − offsetMinutes.
const DEFAULT_TZ_OFFSET = 240;

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

  // Settings carry each user's timezone offset.
  const wd = await prisma.workoutData.findMany({
    where:  { userId: { in: userIds } },
    select: { userId: true, settings: true },
  });
  const settingsByUser = new Map(wd.map(r => [r.userId, (r.settings ?? {}) as Record<string, unknown>]));

  // A user's local date is always one of yesterday/today/tomorrow UTC.
  const dates = [utcDateStr(-1), utcDateStr(0), utcDateStr(1)];
  const rows  = await dr().findMany({
    where:  { userId: { in: userIds }, date: { in: dates } },
    select: { userId: true, date: true, data: true },
  });
  const byUser = new Map<string, Record<string, { weight?: string | number }>>();
  for (const r of rows) {
    const m = byUser.get(r.userId) ?? {};
    m[r.date] = (r.data ?? {}) as { weight?: string | number };
    byUser.set(r.userId, m);
  }

  // Per-user push is pure network I/O — fan out with bounded concurrency.
  const settled = await mapWithConcurrency(subscribers, 10, async ({ userId }) => {
    const settings = settingsByUser.get(userId) ?? {};
    const tz   = typeof settings.queTzOffset === 'number' ? settings.queTzOffset : DEFAULT_TZ_OFFSET;
    const { date, hour } = localParts(tz);

    // Only ping during the user's morning so distant timezones don't get a 3am alert.
    if (hour < 4 || hour > 12) return 'skipped' as const;

    const day    = byUser.get(userId)?.[date];
    const logged = day?.weight !== undefined && parseFloat(String(day.weight)) > 0;
    if (logged) return 'skipped' as const;

    await sendPushToUser(userId, {
      title: 'Morning weigh-in ⚖️',
      body:  'Log today\'s weight to keep your trend accurate.',
      url:   '/app',
      tag:   'weigh-in',
    });
    return 'sent' as const;
  });

  let sent = 0, skipped = 0, failed = 0;
  for (const s of settled) {
    if (s.status === 'rejected') failed++;
    else if (s.value === 'sent') sent++;
    else                         skipped++;
  }

  console.log(`[cron/weigh-in-reminder] sent:${sent} skipped:${skipped} failed:${failed}`);
  return NextResponse.json({ ok: true, sent, skipped, failed });
}
