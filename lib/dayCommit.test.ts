/**
 * lib/dayCommit.test.ts
 *
 * The race guard — the one piece of the sync-merge effort the pure matrix can't
 * cover, because it needs interleaved concurrent writes. We simulate the gap
 * with an injectable fake store and assert the property that actually matters:
 *
 *   on a lost CAS (count:0), the loop RE-READS and RE-MERGES against fresh state
 *   — it does not just re-write the stale merged blob.
 *
 * This is the race analogue of the resurrection-guard test: it goes red if a
 * future change hoists the read out of the loop (the classic optimistic-CAS bug).
 */

import { describe, it, expect, vi } from 'vitest';
import { commitDayWithMerge, MAX_ATTEMPTS, type DayCasStore, type StoredDayRow } from '@/lib/dayCommit';
import type { MergeableDay } from '@/lib/dayMerge';

const NOW = Date.parse('2026-03-10T12:00:00.000Z');
const TOL = 60_000;
const T = {
  early: '2026-03-10T10:00:00.000Z',
  mid:   '2026-03-10T10:30:00.000Z',
  late:  '2026-03-10T11:00:00.000Z',
};
const fieldDay = (fields: Record<string, unknown>, times: Record<string, string>): MergeableDay =>
  ({ ...fields, _fieldEditedAt: times });

/** A controllable fake store. `rows` is the live state; reads return a snapshot
 *  of it, casUpdate enforces the updatedAt guard against live state, and a queue
 *  of scripted "someone wrote in the gap" mutations lets us force CAS losses. */
function makeFakeStore(initial: StoredDayRow | null) {
  let row: StoredDayRow | null = initial ? { ...initial } : null;
  const reads: Array<StoredDayRow | null> = [];
  // Each entry: a mutation applied to `row` right AFTER the next read (simulating
  // a concurrent writer landing in the read→write gap), bumping updatedAt.
  const gapWrites: Array<(r: StoredDayRow | null) => StoredDayRow> = [];

  const store: DayCasStore = {
    async read(_u, _d) {
      const snapshot = row ? { data: { ...row.data }, updatedAt: row.updatedAt } : null;
      reads.push(snapshot);
      // After handing back the snapshot, a queued concurrent writer mutates live state.
      const gap = gapWrites.shift();
      if (gap) row = gap(row);
      return snapshot;
    },
    async create(_u, _d, data) {
      if (row) { const e = new Error('unique') as Error & { code: string }; e.code = 'P2002'; throw e; }
      row = { data: { ...data }, updatedAt: new Date(NOW) };
    },
    async casUpdate(_u, _d, data, expected) {
      if (!row || row.updatedAt.getTime() !== expected.getTime()) return 0; // lost the CAS
      row = { data: { ...data }, updatedAt: new Date((row.updatedAt.getTime()) + 1000) };
      return 1;
    },
  };
  return {
    store, reads,
    queueGapWrite: (fn: (r: StoredDayRow | null) => StoredDayRow) => gapWrites.push(fn),
    current: () => row,
  };
}

describe('commitDayWithMerge — happy paths', () => {
  it('creates a brand-new day when no row exists', async () => {
    const f = makeFakeStore(null);
    const incoming = fieldDay({ weight: 180 }, { weight: T.mid });
    const res = await commitDayWithMerge(f.store, 'u1', '2026-03-10', incoming, NOW, TOL);
    expect(res.status).toBe('committed');
    expect(f.current()?.data.weight).toBe(180);
  });

  it('merges against the stored row on a clean update (no contention)', async () => {
    const f = makeFakeStore({ data: fieldDay({ foods: '[breakfast]', weight: 170 }, { foods: T.early, weight: T.early }), updatedAt: new Date(NOW - 5000) });
    const incoming = fieldDay({ weight: 185 }, { weight: T.late });
    const res = await commitDayWithMerge(f.store, 'u1', '2026-03-10', incoming, NOW, TOL);
    expect(res.status).toBe('committed');
    expect(f.current()?.data.weight).toBe(185);          // newer push
    expect(f.current()?.data.foods).toBe('[breakfast]'); // stored field NOT clobbered
  });
});

describe('commitDayWithMerge — the RACE guard (re-read + re-merge on lost CAS)', () => {
  it('CRITICAL: a lost CAS forces a re-read, and the re-merge respects the concurrent write', async () => {
    // Stored: just weight. Our push adds foods. But a concurrent writer lands a
    // NEWER weight in the gap after our first read — the re-merge must keep it.
    const f = makeFakeStore({ data: fieldDay({ weight: 170 }, { weight: T.early }), updatedAt: new Date(NOW - 10_000) });

    // After the FIRST read, a concurrent device writes weight=200 (newer) and bumps updatedAt.
    f.queueGapWrite(() => ({
      data: fieldDay({ weight: 200 }, { weight: T.late }),
      updatedAt: new Date(NOW), // different token → our first CAS will lose
    }));

    // Our push: add foods at mid-time (older than the concurrent weight).
    const incoming = fieldDay({ foods: '[lunch]' }, { foods: T.mid });
    const res = await commitDayWithMerge(f.store, 'u1', '2026-03-10', incoming, NOW, TOL);

    expect(res.status).toBe('committed');
    expect(f.reads.length).toBe(2);                    // proves the RE-READ happened
    // The re-merge was against the FRESH state (weight=200), so the concurrent
    // write survives AND our foods is added — neither is lost.
    expect(f.current()?.data.weight).toBe(200);        // concurrent write preserved
    expect(f.current()?.data.foods).toBe('[lunch]');   // our field added
  });

  it('would clobber the concurrent write if the read were hoisted (documents what this guards)', async () => {
    // Sanity: confirm the fake actually loses the first CAS (so the test above
    // is exercising the retry, not trivially passing).
    const f = makeFakeStore({ data: fieldDay({ weight: 170 }, { weight: T.early }), updatedAt: new Date(NOW - 10_000) });
    const casSpy = vi.spyOn(f.store, 'casUpdate');
    f.queueGapWrite(() => ({ data: fieldDay({ weight: 200 }, { weight: T.late }), updatedAt: new Date(NOW) }));
    await commitDayWithMerge(f.store, 'u1', '2026-03-10', fieldDay({ foods: '[x]' }, { foods: T.mid }), NOW, TOL);
    expect(casSpy).toHaveBeenCalledTimes(2); // first lost (count:0), second succeeded
  });

  it('handles a create→exists race: P2002 routes back to the top and switches to update', async () => {
    const f = makeFakeStore(null); // looks empty on first read…
    // …but a concurrent writer creates the row right after our first read.
    f.queueGapWrite(() => ({ data: fieldDay({ weight: 150 }, { weight: T.early }), updatedAt: new Date(NOW) }));
    const incoming = fieldDay({ foods: '[a]' }, { foods: T.late });
    const res = await commitDayWithMerge(f.store, 'u1', '2026-03-10', incoming, NOW, TOL);
    expect(res.status).toBe('committed');
    expect(f.reads.length).toBe(2);                  // re-read after P2002
    expect(f.current()?.data.weight).toBe(150);      // concurrent create preserved
    expect(f.current()?.data.foods).toBe('[a]');     // our field merged in
  });
});

describe('commitDayWithMerge — fails CLOSED on exhaustion', () => {
  it('defers (does not blind-write) when every CAS attempt loses', async () => {
    const f = makeFakeStore({ data: fieldDay({ weight: 1 }, { weight: T.early }), updatedAt: new Date(NOW) });
    // Every read is followed by a concurrent write that bumps updatedAt → every CAS loses.
    let v = 0;
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      f.queueGapWrite(() => ({ data: fieldDay({ weight: 100 + v }, { weight: T.late }), updatedAt: new Date(NOW + (++v) * 1000) }));
    }
    const before = f.current()?.data.weight;
    const res = await commitDayWithMerge(f.store, 'u1', '2026-03-10', fieldDay({ foods: '[x]' }, { foods: T.mid }), NOW, TOL);
    expect(res.status).toBe('deferred');             // failed closed
    // Our push was NOT blind-written — the row holds only concurrent writes, never our foods.
    expect(f.current()?.data.foods).toBeUndefined();
    expect(f.current()?.data.weight).not.toBe(before); // (concurrent writers did land; we didn't)
  });

  it('stops at MAX_ATTEMPTS reads', async () => {
    const f = makeFakeStore({ data: fieldDay({ weight: 1 }, { weight: T.early }), updatedAt: new Date(NOW) });
    let v = 0;
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      f.queueGapWrite(() => ({ data: fieldDay({ weight: 100 }, { weight: T.late }), updatedAt: new Date(NOW + (++v) * 1000) }));
    }
    await commitDayWithMerge(f.store, 'u1', '2026-03-10', fieldDay({ foods: '[x]' }, { foods: T.mid }), NOW, TOL);
    expect(f.reads.length).toBe(MAX_ATTEMPTS); // bounded — no unbounded grind
  });
});
