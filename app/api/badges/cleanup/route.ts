/**
 * POST /api/badges/cleanup
 *
 * Two modes:
 *  1. No body (or empty body): full badge re-evaluation — awards/revokes based on
 *     current DayRecord data. Use after correcting entries.
 *  2. Body `{ force: string[] }`: unconditionally deletes those badge slugs for the
 *     authenticated user AND zeros out orphaned cardio fields (where exercises is
 *     empty/blank) so the badges don't get re-awarded on the next sync.
 */

import { getServerSession } from 'next-auth/next';
import { NextResponse }     from 'next/server';
import { authOptions }      from '@/lib/auth';
import { prisma }           from '@/lib/prisma';
import { checkAndAwardBadges } from '@/lib/badgeEngine';
import { badgeLimit }        from '@/lib/ratelimit';

// Which DayRecord fields to zero out per badge slug when force-deleting.
const BADGE_FIELDS: Record<string, string[]> = {
  bike_first:   ['bikeDist', 'bikeTime'],
  bike_50mi:    ['bikeDist', 'bikeTime'],
  bike_1000mi:  ['bikeDist', 'bikeTime'],
  swim_first:   ['swimTime', 'swimDist'],
  swim_15mi:    ['swimTime', 'swimDist'],
  triathlete:   ['runDist', 'runTime', 'bikeDist', 'bikeTime', 'swimTime', 'swimDist'],
  cal_1000:     ['burn'],
  run_5k:       ['runDist', 'runTime'],
  run_10k:      ['runDist', 'runTime'],
  run_15k:      ['runDist', 'runTime'],
  run_half:     ['runDist', 'runTime'],
  run_marathon: ['runDist', 'runTime'],
  run_50mi:     ['runDist', 'runTime'],
  run_50mi_single: ['runDist', 'runTime'],
};

type DayRow = { id: string; date: string; data: unknown };

const dr = (prisma as unknown as {
  dayRecord: {
    findMany:  (args: unknown) => Promise<DayRow[]>;
    update:    (args: unknown) => Promise<unknown>;
  };
}).dayRecord;

export async function POST(req: Request): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json(null, { status: 401 });

  const userId = session.user.id;

  const { success } = await badgeLimit.limit(userId);
  if (!success) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  // ── Mode 2: force-delete specific slugs ──────────────────────────────────────
  let force: string[] = [];
  try {
    const body = await req.json() as { force?: unknown };
    // Only accept string slugs, capped at 100 — keeps a malformed/oversized
    // body from turning into a huge deleteMany / per-row scan. Self-scoped to
    // the session user regardless.
    force = Array.isArray(body?.force)
      ? body.force.filter((s): s is string => typeof s === 'string').slice(0, 100)
      : [];
  } catch { /* no body / parse error — fall through to mode 1 */ }

  if (force.length > 0) {
    // 1. Delete the badge rows unconditionally.
    await prisma.badge.deleteMany({ where: { userId, slug: { in: force } } });

    // 2. Determine which DayRecord fields need to be zeroed out.
    const fieldsToZero = new Set<string>();
    for (const slug of force) {
      for (const field of (BADGE_FIELDS[slug] ?? [])) fieldsToZero.add(field);
    }

    if (fieldsToZero.size > 0) {
      // Fetch all rows for this user.
      const rows = await dr.findMany({ where: { userId }, select: { id: true, date: true, data: true } } as unknown as never);

      await Promise.all(
        (rows as DayRow[]).map(async row => {
          const data = (row.data ?? {}) as Record<string, unknown>;

          let changed = false;
          const next = { ...data };
          for (const field of fieldsToZero) {
            const v = parseFloat(String(next[field] ?? '0'));
            if (v !== 0) { next[field] = 0; changed = true; }
          }
          if (!changed) return;

          await dr.update({
            where: { userId_date: { userId, date: row.date } } as unknown as never,
            data:  { data: next },
          } as unknown as never);
        })
      );
    }

    return NextResponse.json({ ok: true, forceDeleted: force });
  }

  // ── Mode 1: full re-evaluation ────────────────────────────────────────────────
  const wd = await prisma.workoutData.findUnique({
    where:  { userId },
    select: { settings: true },
  });

  const settings = (wd?.settings ?? {}) as Record<string, unknown>;
  const { awarded, revoked } = await checkAndAwardBadges(userId, settings);

  return NextResponse.json({ awarded, revoked });
}
