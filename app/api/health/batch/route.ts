/**
 * POST /api/health/batch
 *
 * One request for a whole sync's worth of Garmin data — activities AND daily
 * wellness together — instead of N per-item POSTs crawling under the per-minute
 * rate limit (a 60-day backfill used to take ~100 sequential requests).
 *
 * Body: { activities?: [<healthActivitySchema>...], wellness?: [<healthWellnessSchema>...] }
 * Auth: same personal bearer token as the per-item routes (which remain for
 * simple automations like iOS Shortcuts).
 *
 * Processing groups by DATE: each day's record is read once, every matching
 * activity/wellness entry is applied through the same pure engines
 * (applyActivity's ledger dedup/absorption, applyWellness's no-op idempotency),
 * and the day is upserted once. Response reports per-day changed flags.
 */

import { NextResponse }      from 'next/server';
import { prisma }            from '@/lib/prisma';
import { activityLimit }     from '@/lib/ratelimit';
import { healthBatchSchema } from '@/lib/validators';
import { applyActivity, applyWellness, toMiles } from '@/lib/healthActivity';
import type { MergeableDay } from '@/lib/dayMerge';

export async function POST(req: Request): Promise<NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'anon';
  const { success } = await activityLimit.limit(ip);
  if (!success) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const auth  = req.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 });

  let raw: unknown;
  try { raw = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = healthBatchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, { status: 400 });
  }
  const b = parsed.data;

  const workoutData = await prisma.workoutData.findFirst({
    where:  { settings: { path: ['stepApiToken'], equals: token } },
    select: { userId: true, settings: true },
  });
  if (!workoutData) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  const tzOffset  = (workoutData.settings as { queTzOffset?: unknown } | null)?.queTzOffset;
  const offsetMin = typeof tzOffset === 'number' ? tzOffset : 0;
  const localToday = () => new Date(Date.now() - offsetMin * 60_000).toISOString().slice(0, 10);

  // Group everything by target date so each day is read+written exactly once.
  type DayWork = { activities: NonNullable<typeof b.activities>; wellness: NonNullable<typeof b.wellness> };
  const byDate = new Map<string, DayWork>();
  const workFor = (date: string): DayWork => {
    let w = byDate.get(date);
    if (!w) { w = { activities: [], wellness: [] }; byDate.set(date, w); }
    return w;
  };
  for (const a of b.activities ?? []) workFor(a.date ?? localToday()).activities.push(a);
  for (const w of b.wellness ?? [])   workFor(w.date ?? localToday()).wellness.push(w);

  const dr = (prisma as unknown as {
    dayRecord: {
      findUnique: (a: unknown) => Promise<{ data: unknown } | null>;
      upsert:     (a: unknown) => Promise<unknown>;
    };
  }).dayRecord;

  const nowIso = new Date().toISOString();
  const days: Record<string, boolean> = {};
  for (const [date, work] of byDate) {
    const existing = await dr.findUnique({
      where:  { userId_date: { userId: workoutData.userId, date } },
      select: { data: true },
    });
    let data = (existing?.data ?? {}) as MergeableDay;
    let changed = false;
    for (const a of work.activities) {
      const res = applyActivity(data, {
        type: a.type,
        distanceMi: a.distance == null ? 0 : toMiles(a.distance, a.unit),
        timeMin: a.time,
        calories: a.calories,
        externalId: a.externalId,
      }, nowIso);
      data = res.data; changed = changed || res.changed;
    }
    for (const w of work.wellness) {
      const res = applyWellness(data, {
        steps: w.steps, weightLb: w.weightLb, restingHr: w.restingHr, hrv: w.hrv,
        sleepScore: w.sleepScore, sleepMin: w.sleepMin, bodyBattery: w.bodyBattery,
      }, nowIso);
      data = res.data; changed = changed || res.changed;
    }
    if (changed) {
      await dr.upsert({
        where:  { userId_date: { userId: workoutData.userId, date } },
        create: { userId: workoutData.userId, date, data },
        update: { data },
      });
    }
    days[date] = changed;
  }

  const changedCount = Object.values(days).filter(Boolean).length;
  return NextResponse.json({ ok: true, days, changedDays: changedCount, totalDays: byDate.size });
}
