/**
 * lib/dayCommit.ts
 *
 * Server-side transactional commit of ONE incoming day under field-level merge.
 * This closes the read-modify-write RACE that field-level merge would otherwise
 * introduce: `resolveIncomingDay` needs the stored row as input, so a naive
 * read → merge-in-app → write lets two same-day pushes both read the same stored
 * data and the second clobber the first's merge — the breakfast bug reborn as a
 * race, invisible to any non-interleaved test.
 *
 * The guard is OPTIMISTIC COMPARE-AND-SET on `updatedAt` (the row's version
 * token; Prisma's `@updatedAt` bumps it on every write) — the same idiom already
 * shipped + debugged in resolveBattle (`updateMany` + `count === 0` ⇒ lost the
 * CAS). Chosen over a Serializable transaction because Serializable doesn't
 * remove the retry — it converts the race into a serialization failure you retry
 * anyway — at the cost of the strictest isolation on a hot path. Lowest-novelty
 * wins at the data-safety core.
 *
 * TWO correctness properties this file lives or dies by:
 *   1. The retry RE-READS and RE-MERGES inside the loop. The whole point of a
 *      failed CAS is that someone wrote in the gap, so the data we merged against
 *      is stale; re-writing the same merged blob with a fresh token would re-clobber.
 *      The fresh read MUST be inside the loop (it is — see the loop body).
 *   2. The bounded retry FAILS CLOSED. On exhaustion we do NOT blind-write (that's
 *      the clobber we're preventing, just rarer) and do NOT silently drop — we
 *      report the day as deferred so the client re-sends next sync (its copy is
 *      still safe locally). Failing open reintroduces loss.
 *
 * The store is INJECTED so the race is unit-testable: a fake store can return
 * count:0 once and the test asserts the loop re-read fresh state.
 */

import { resolveIncomingDay, type MergeableDay } from '@/lib/dayMerge';

export interface StoredDayRow {
  data:      MergeableDay;
  updatedAt: Date;
}

/** Minimal store the commit loop needs. The Prisma adapter lives at the call
 *  site (route.ts); tests inject a fake. */
export interface DayCasStore {
  /** Read the current row (fresh) or null if it doesn't exist yet. */
  read(userId: string, date: string): Promise<StoredDayRow | null>;
  /** Insert a brand-new row. MUST reject with a unique-violation-shaped error
   *  (`code === 'P2002'`) if the row already exists (lost a create race). */
  create(userId: string, date: string, data: MergeableDay): Promise<void>;
  /** Compare-and-set: write `data` only if the row's `updatedAt` still equals
   *  `expected`. Returns the number of rows written (0 ⇒ lost the CAS). Must NOT
   *  set `updatedAt` in `data` — the store's `@updatedAt` bumps it. */
  casUpdate(userId: string, date: string, data: MergeableDay, expected: Date): Promise<number>;
}

export type CommitResult =
  | { status: 'committed'; merged: MergeableDay; localWonFields: string[] }
  | { status: 'deferred' }; // exhausted retries → client re-sends next sync (fail closed)

/** Small bound: 5 consecutive same-day CAS losses means contention beyond
 *  normal multi-device use — surface (defer), don't grind. */
export const MAX_ATTEMPTS = 5;

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2002';
}

/**
 * Commit one day, merging against the freshest stored state with a CAS guard.
 * Single loop, two entry conditions — no row → create; row exists → CAS update —
 * and BOTH retry paths (P2002 on create, count:0 on update) route back to the
 * top, which re-reads and re-merges. Pure-of-Prisma (store injected).
 */
export async function commitDayWithMerge(
  store: DayCasStore,
  userId: string,
  date: string,
  incoming: MergeableDay,
  nowMs: number,
  toleranceMs: number,
): Promise<CommitResult> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // READ INSIDE THE LOOP — a retry must re-read so the re-merge is against
    // fresh state, not the stale data that just lost the CAS. Hoisting this
    // above the loop reintroduces the race disguised as a working guard.
    const stored = await store.read(userId, date);

    if (!stored) {
      // No row yet → nothing to merge against; resolve sanitizes + takes incoming.
      const { merged, localWonFields } = resolveIncomingDay(undefined, incoming, nowMs, toleranceMs);
      try {
        await store.create(userId, date, merged);
        return { status: 'committed', merged, localWonFields };
      } catch (e) {
        if (isUniqueViolation(e)) continue; // someone created it in the gap → re-read, it now exists
        throw e;
      }
    }

    // Row exists → merge incoming against the FRESH stored data, then CAS-write.
    const { merged, localWonFields } = resolveIncomingDay(stored.data, incoming, nowMs, toleranceMs);
    const count = await store.casUpdate(userId, date, merged, stored.updatedAt);
    if (count > 0) return { status: 'committed', merged, localWonFields };
    // count === 0 → someone wrote in the gap → loop: re-read, re-merge, re-CAS.
  }

  // Exhausted → FAIL CLOSED: defer (no blind write, no silent drop). The client
  // still holds the data and re-sends on the next sync.
  return { status: 'deferred' };
}
