/**
 * POST /api/health/wellness
 *
 * Daily wellness import from the user's OWN device (via their data_tracker or
 * any automation holding the personal health token — same auth as the step and
 * activity pushes). Carries whatever Garmin has for the day: steps, weight,
 * resting HR, overnight HRV, sleep score/duration, body battery.
 *
 * steps and weight land on the SAME DayRecord fields the manual paths write
 * (so a Garmin scale weigh-in also satisfies the morning weight prompt); the
 * recovery metrics land on new fields read by the Metrics tab's Recovery panel.
 * Idempotent: unchanged values are a no-op so re-pushes never refresh edit
 * stamps (see applyWellness).
 *
 * Headers:
 *   Authorization: Bearer <token>        ← same token as /api/health/steps
 * Body:
 *   { "date": "2026-08-12", "steps": 9200, "weightLb": 180.4, "restingHr": 47,
 *     "hrv": 62, "sleepScore": 81, "sleepMin": 442, "bodyBattery": 88 }
 *   (all metrics optional — at least one required)
 */

import { NextResponse }         from 'next/server';
import { prisma }               from '@/lib/prisma';
import { wellnessLimit }        from '@/lib/ratelimit';
import { healthWellnessSchema } from '@/lib/validators';
import { applyWellness }        from '@/lib/healthActivity';
import type { MergeableDay }    from '@/lib/dayMerge';

export async function POST(req: Request): Promise<NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'anon';
  const { success } = await wellnessLimit.limit(ip);
  if (!success) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const auth  = req.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 });

  let raw: unknown;
  try { raw = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = healthWellnessSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, { status: 400 });
  }
  const b = parsed.data;

  const workoutData = await prisma.workoutData.findFirst({
    where:  { settings: { path: ['stepApiToken'], equals: token } },
    select: { userId: true, settings: true },
  });
  if (!workoutData) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  // Explicit date, else the user's LOCAL today via stored queTzOffset.
  const tzOffset  = (workoutData.settings as { queTzOffset?: unknown } | null)?.queTzOffset;
  const offsetMin = typeof tzOffset === 'number' ? tzOffset : 0;
  const dateStr   = b.date ?? new Date(Date.now() - offsetMin * 60_000).toISOString().slice(0, 10);

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

  const { data, changed } = applyWellness(
    (existing?.data ?? {}) as MergeableDay,
    {
      steps: b.steps, weightLb: b.weightLb, restingHr: b.restingHr, hrv: b.hrv,
      sleepScore: b.sleepScore, sleepMin: b.sleepMin, bodyBattery: b.bodyBattery,
    },
    new Date().toISOString(),
  );

  if (changed) {
    await dr.upsert({
      where:  { userId_date: { userId: workoutData.userId, date: dateStr } },
      create: { userId: workoutData.userId, date: dateStr, data },
      update: { data },
    });
  }

  return NextResponse.json({ ok: true, date: dateStr, changed });
}
