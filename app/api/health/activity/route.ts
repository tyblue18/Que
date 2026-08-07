/**
 * POST /api/health/activity
 *
 * Auto-import a cardio activity (run / bike / swim) from the user's OWN device —
 * an iOS Shortcut / "Auto Health Export"-style automation / Tasker — using the
 * same personal bearer token as the step push (GET /api/health/token).
 *
 * This is the FREE, no-third-party path: the user's phone pushes THEIR OWN
 * workout to us, so there are no wearable-API fees and no platform data-sharing
 * restrictions — it's the user's data, so it can legitimately feed battles /
 * groups (unlike Strava-sourced data, whose terms forbid showing it to others).
 *
 * The endpoint only writes distance + time onto the day's cardio fields; CALORIES
 * are derived client-side by the existing ACSM/METs budget engine from those
 * fields + the user's profile weight — nothing to compute here.
 *
 * Headers:
 *   Authorization: Bearer <token>        ← same token as /api/health/steps
 *   Content-Type:  application/json
 *
 * Body:
 *   { "type": "run", "distance": 3.1, "unit": "mi", "time": 27,
 *     "date": "2026-08-06", "externalId": "<workout-uuid>" }
 *   - type       'run' | 'bike' | 'swim'
 *   - distance   number — required for run/bike, optional for swim. In `unit`.
 *   - unit       'mi' | 'km'  (defaults to 'mi')
 *   - time       number — duration in MINUTES (required)
 *   - date       'YYYY-MM-DD' — defaults to the user's LOCAL today (via queTzOffset)
 *   - externalId string — the source workout's stable id → idempotent re-sends
 *
 * Response: { ok, type, date, changed, runTime, runDist?, … }
 */

import { NextResponse }         from 'next/server';
import { prisma }               from '@/lib/prisma';
import { activityLimit }        from '@/lib/ratelimit';
import { healthActivitySchema } from '@/lib/validators';
import { applyActivity, toMiles, FIELD_MAP } from '@/lib/healthActivity';
import type { MergeableDay }    from '@/lib/dayMerge';

export async function POST(req: Request): Promise<NextResponse> {
  // Rate-limit by IP first — caps token brute-forcing and shields the per-request
  // DB token lookup below from anonymous hammering.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'anon';
  const { success } = await activityLimit.limit(ip);
  if (!success) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const auth  = req.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 });

  let raw: unknown;
  try { raw = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = healthActivitySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, { status: 400 });
  }
  const b = parsed.data;

  // Find the user whose stepApiToken matches (also grab settings for their tz).
  const workoutData = await prisma.workoutData.findFirst({
    where:  { settings: { path: ['stepApiToken'], equals: token } },
    select: { userId: true, settings: true },
  });
  if (!workoutData) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  // Prefer the explicit date; else the user's LOCAL today via stored queTzOffset
  // (getTimezoneOffset minutes; local = UTC − offset). Falls back to UTC. Without
  // this, an evening push from a user behind UTC files onto the next (future) day.
  const tzOffset  = (workoutData.settings as { queTzOffset?: unknown } | null)?.queTzOffset;
  const offsetMin = typeof tzOffset === 'number' ? tzOffset : 0;
  const dateStr   = b.date ?? new Date(Date.now() - offsetMin * 60_000).toISOString().slice(0, 10);

  const distanceMi = b.distance == null ? 0 : toMiles(b.distance, b.unit);

  // Write to the DayRecord row (the authoritative per-day store /api/sync reads),
  // NOT the legacy WorkoutData.localDB blob. Read-modify-write the day's data and
  // let applyActivity merge (dedup + accumulate + per-field stamps).
  const dr = (prisma as unknown as {
    dayRecord: {
      findUnique: (a: unknown) => Promise<{ data: unknown } | null>;
      upsert:     (a: unknown) => Promise<unknown>;
    };
  }).dayRecord;

  const existing = await dr.findUnique({
    where:  { userId_date: { userId: workoutData.userId, date: dateStr } },
    select: { data: true },
  });

  const { data, changed } = applyActivity(
    (existing?.data ?? {}) as MergeableDay,
    { type: b.type, distanceMi, timeMin: b.time, externalId: b.externalId },
    new Date().toISOString(),
  );

  if (changed) {
    await dr.upsert({
      where:  { userId_date: { userId: workoutData.userId, date: dateStr } },
      create: { userId: workoutData.userId, date: dateStr, data },
      update: { data },
    });
  }

  const { dist: distKey, time: timeKey } = FIELD_MAP[b.type];
  return NextResponse.json({
    ok: true, type: b.type, date: dateStr, changed,
    [timeKey]: data[timeKey] ?? 0,
    ...(data[distKey] != null ? { [distKey]: data[distKey] } : {}),
  });
}
