/**
 * app/api/sync/route.ts
 *
 * GET  /api/sync  — pull the user's cloud snapshot
 * POST /api/sync  — push a partial or full snapshot update
 *
 * localDB is stored as individual DayRecord rows (one per YYYY-MM-DD).
 * GET falls back to WorkoutData.localDB blob for days not yet migrated.
 * Profile and settings remain in WorkoutData.
 */

import { getServerSession }        from 'next-auth/next';
import { after, NextResponse }     from 'next/server';
import { Redis }                   from '@upstash/redis';
import { authOptions }             from '@/lib/auth';
import { prisma }                  from '@/lib/prisma';
import { checkAndAwardBadges }     from '@/lib/badgeEngine';
import type { AwardedBadge }       from '@/lib/badgeEngine';
import { checkAndAwardCoins }      from '@/lib/coinEngine';
import type { CoinAward }          from '@/lib/coinEngine';
import { syncLimit }               from '@/lib/ratelimit';
import { syncPostSchema }          from '@/lib/validators';
import { commitDayWithMerge, type DayCasStore } from '@/lib/dayCommit';
import type { MergeableDay }       from '@/lib/dayMerge';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

// ─────────────────────────────────────────────────────────────────────────────
// GET — pull latest snapshot
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json(null, { status: 401 });

  const userId = session.user.id;

  const dayRecordClient = (prisma as unknown as {
    dayRecord: { findMany: (args: unknown) => Promise<Array<{ date: string; data: unknown; updatedAt: Date }>> };
  }).dayRecord;

  const [wd, dayRows, pendingBadgesRaw] = await Promise.all([
    prisma.workoutData.findUnique({ where: { userId } }),
    dayRecordClient.findMany({ where: { userId }, select: { date: true, data: true, updatedAt: true } }),
    redis.getdel<AwardedBadge[]>(`pending:badges:${userId}`),
  ]);

  // Merge: legacy blob provides the base, DayRecord rows win for days already migrated.
  // Embed _syncedAt so the client can send it back and we can detect stale writes.
  const blobDB  = (wd?.localDB ?? {}) as Record<string, unknown>;
  const rowsMap = Object.fromEntries(
    dayRows.map((r: { date: string; data: unknown; updatedAt: Date }) => [
      r.date,
      { ...(r.data as object), _syncedAt: r.updatedAt.toISOString() },
    ])
  );
  const localDB   = { ...blobDB, ...rowsMap };
  const newBadges = pendingBadgesRaw ?? [];

  return NextResponse.json({
    localDB,
    profile:  wd?.profile  ?? {},
    settings: wd?.settings ?? {},
    ...(newBadges.length > 0 && { newBadges }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — push partial or full snapshot
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: Request): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json(null, { status: 401 });

  const userId = session.user.id;

  const { success } = await syncLimit.limit(userId);
  if (!success) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  let raw: unknown;
  try { raw = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const parsed = syncPostSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;

  // ── Fetch pending notifications from the previous background run (in parallel
  //    with the WorkoutData read so the Redis calls add zero extra latency) ────
  // Coins + revocations share ONE `pending:extra` key (both are POST-only), so a
  // sync drains 2 Redis keys instead of 3. `pending:badges` stays separate — it's
  // also drained by GET and written by the battle cron, so its contract is untouched.
  type PendingExtra = { coins?: { newCoins: CoinAward[]; walletBalance: number }; revoked?: AwardedBadge[] };
  const [existing, pendingBadgesRaw, pendingExtraRaw] = await Promise.all([
    prisma.workoutData.findUnique({ where: { userId } }),
    redis.getdel<AwardedBadge[]>(`pending:badges:${userId}`),
    redis.getdel<PendingExtra>(`pending:extra:${userId}`),
  ]);
  const newBadges:     AwardedBadge[] = pendingBadgesRaw ?? [];
  const revokedBadges: AwardedBadge[] = pendingExtraRaw?.revoked        ?? [];
  const newCoins:      CoinAward[]    = pendingExtraRaw?.coins?.newCoins ?? [];
  const walletBalance                 = pendingExtraRaw?.coins?.walletBalance;

  // ── Profile + settings go to WorkoutData ────────────────────────────────────
  const existingSettings = (existing?.settings ?? {}) as Record<string, unknown>;
  const mergedSettings   = body.settings !== undefined
    ? { ...existingSettings, ...body.settings }
    : existingSettings;

  await prisma.workoutData.upsert({
    where:  { userId },
    create: {
      userId,
      localDB:  {} as never,   // no longer written here
      profile:  (body.profile ?? {}) as never,
      settings: mergedSettings as never,
      syncedAt: new Date(),
    },
    update: {
      ...(body.profile !== undefined && { profile: body.profile as never }),
      settings: mergedSettings as never,
      syncedAt: new Date(),
    },
  });

  // ── Each day goes to its own DayRecord row (with conflict detection) ─────────
  // A conflict entry is either a MERGE conflict (server reconciled fields; client
  // adopts the merged day) or a DEFERRED one (`deferred: true` — the CAS commit
  // exhausted retries under pathological same-day contention). The client treats
  // them differently: adopt-and-clear-dirty for a merge, keep-dirty-and-retry for
  // a deferral (see the que-conflict handler).
  const conflicts: Array<{ date: string; data: unknown; deferred?: boolean }> = [];

  if (body.localDB && Object.keys(body.localDB).length > 0) {
    // 60s tolerance for legitimate clock skew between client browser and server.
    const FUTURE_TOLERANCE_MS = 60_000;
    const now = Date.now();

    // Prisma-backed store for the per-day CAS commit. DayRecord isn't in the
    // generated static types in this repo (cast as the rest of this file does);
    // updateMany's `count` is the compare-and-set on `updatedAt`.
    const drClient = (prisma as unknown as {
      dayRecord: {
        findUnique: (a: unknown) => Promise<{ data: unknown; updatedAt: Date } | null>;
        create:     (a: unknown) => Promise<unknown>;
        updateMany: (a: unknown) => Promise<{ count: number }>;
      };
    }).dayRecord;

    const store: DayCasStore = {
      async read(uid, date) {
        const row = await drClient.findUnique({
          where:  { userId_date: { userId: uid, date } },
          select: { data: true, updatedAt: true },
        });
        return row ? { data: row.data as MergeableDay, updatedAt: row.updatedAt } : null;
      },
      async create(uid, date, data) {
        // Throws P2002 if the row already exists (lost a create race) — the
        // commit loop catches that and re-reads onto the update path.
        await drClient.create({ data: { userId: uid, date, data } });
      },
      async casUpdate(uid, date, data, expected) {
        // Compare-and-set: write only if updatedAt still matches what we read.
        // count === 0 ⇒ a concurrent push wrote in the gap ⇒ the loop re-reads.
        const { count } = await drClient.updateMany({
          where: { userId: uid, date, updatedAt: expected },
          data:  { data },
        });
        return count;
      },
    };

    for (const [date, rawData] of Object.entries(body.localDB)) {
      // Strip the transport-only _syncedAt before it ever reaches the merge or
      // the store; _editedAt / _fieldEditedAt are real data the merge needs.
      const { _syncedAt: _drop, ...incoming } = rawData as Record<string, unknown>;

      const result = await commitDayWithMerge(
        store, userId, date, incoming as MergeableDay, now, FUTURE_TOLERANCE_MS,
      );

      if (result.status === 'deferred') {
        // Failed closed after MAX_ATTEMPTS CAS losses (pathological same-day
        // contention). Mark the day DEFERRED so the client keeps it dirty and
        // re-sends the SAME pending edit next sync — it must NOT adopt server
        // state (that would overwrite the very edit we're preserving and re-send
        // server data instead). We send no `data`: the client leaves its local
        // copy and its honest _fieldEditedAt untouched and just retries.
        conflicts.push({ date, data: null, deferred: true });
      } else if (result.localWonFields.length > 0) {
        // The stored row beat the push on ≥1 field — the merge reconciled them.
        // Return the MERGED day so the client ADOPTS it (not just toasts): its
        // local copy is now stale for the fields the server knew about, and
        // without write-back the next edit would re-push stale and ping-pong.
        const current = await store.read(userId, date);
        conflicts.push({
          date,
          data: { ...(result.merged as object), _syncedAt: (current?.updatedAt ?? new Date()).toISOString() },
        });
      }
    }
  }

  // Badge + coin evaluation runs in the BACKGROUND (after the response is sent)
  // instead of blocking the sync. Both engines derive purely from already-
  // persisted data (DayRecords / settings / wallet) and are idempotent (badges
  // use @@unique skipDuplicates; coins write one txn per date), so running them
  // off the hot path never loses anything — newly awarded badges/coins are
  // stashed in Redis and delivered on the NEXT sync via the same pending-drain
  // this route already uses (and that coins already used).
  //
  // A 30s per-user lock debounces the heavy full-history scan: a burst of syncs
  // (e.g. logging a workout, which pushes every ~4s) triggers it once, not every
  // time. The client shows badge/coin popups optimistically, so the small delay
  // to server persistence is invisible. Previously this scan loaded EVERY
  // DayRecord and ran on EVERY sync while blocking the response — the launch
  // bottleneck this removes.
  after(async () => {
    try {
      // SET NX EX returns 'OK' when acquired, null when a run is already in
      // flight/recent. A redis error throws → we fall through and evaluate
      // (favour correctness over the optimisation).
      const lock = await redis.set(`eval:lock:${userId}`, '1', { nx: true, ex: 30 });
      if (lock === null) return;
    } catch { /* redis unavailable — evaluate anyway */ }

    // Coins + revocations are collected here and written together to the single
    // `pending:extra` key (one setex instead of two), matching the read above.
    const extra: PendingExtra = {};

    // ── Badges ──
    try {
      const badgeResult = await checkAndAwardBadges(userId, mergedSettings);
      if (badgeResult.awarded.length > 0) {
        await redis.setex(`pending:badges:${userId}`, 3600, JSON.stringify(badgeResult.awarded));
      }
      if (badgeResult.revoked.length > 0) {
        extra.revoked = badgeResult.revoked;
        // Drop revoked badges from the public showcase.
        const revokedSlugs = new Set(badgeResult.revoked.map(b => b.slug));
        const user = await prisma.appUser.findUnique({
          where:  { id: userId },
          select: { showcaseBadges: true },
        });
        if (user) {
          const current = (user.showcaseBadges as string[] | null) ?? [];
          const cleaned = current.filter(s => !revokedSlugs.has(s));
          if (cleaned.length !== current.length) {
            await prisma.appUser.update({ where: { id: userId }, data: { showcaseBadges: cleaned } });
          }
        }
      }
    } catch { /* non-critical */ }

    // ── Coins ──
    try {
      // Pass the user's tz offset so coins are gated on their LOCAL today —
      // future calendar days can't be filled in to farm coins. Pass the plan
      // direction so coin awarding matches plan intent (deficit/surplus vs the
      // strict ±100 band) — see isGoalDay.
      const tzOffset = typeof mergedSettings.queTzOffset === 'number'
        ? mergedSettings.queTzOffset
        : undefined;
      const planType = (mergedSettings.queAthletePlan as { type?: string } | null | undefined)?.type;
      const planDirection = planType === 'cut' || planType === 'bulk' ? planType : null;
      const coinResult = await checkAndAwardCoins(userId, tzOffset, planDirection);
      if (coinResult.awarded.length > 0) {
        extra.coins = { newCoins: coinResult.awarded, walletBalance: coinResult.walletBalance };
      }
    } catch { /* non-critical */ }

    if (extra.coins || extra.revoked) {
      await redis.setex(`pending:extra:${userId}`, 3600, JSON.stringify(extra));
    }
  });

  // Lightweight daily push-sync counter for the /api/stats usage dashboard.
  // Best-effort (never blocks or fails the sync), ~1 Redis command/sync, and the
  // key self-expires after 8 days so it never accumulates. Independent of the
  // eval lock above so every push is counted, not just one per 30s burst.
  after(async () => {
    try {
      const key = `stats:syncs:${new Date().toISOString().slice(0, 10)}`;
      const n   = await redis.incr(key);
      if (n === 1) await redis.expire(key, 60 * 60 * 24 * 8);
    } catch { /* metrics are non-critical */ }
  });

  // Return the server's own timestamp so the client can stamp _syncedAt without
  // relying on its (possibly skewed or maliciously forged) local clock. This is
  // strictly >= every upsert's actual updatedAt in this request.
  const syncedAt = new Date().toISOString();

  return NextResponse.json({
    ok: true,
    syncedAt,
    ...(conflicts.length     > 0 && { conflicts }),
    ...(newBadges.length     > 0 && { newBadges }),
    ...(revokedBadges.length > 0 && { revokedBadges }),
    ...(newCoins.length      > 0 && { newCoins, walletBalance }),
  });
}
