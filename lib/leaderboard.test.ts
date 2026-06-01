/**
 * lib/leaderboard.test.ts
 *
 * Locks the leaderboard compute pipeline (getSeasonRankings → rankAll): only
 * opted-in users with data are ranked, ordering is by score desc, ties share a
 * rank, and an unknown category falls back to the default. The pure season /
 * tie-rank math is covered separately in leaderboard-season.test.ts.
 *
 * Redis is mocked to a no-op (cache always misses → always computes); Prisma is
 * the in-memory fake (lib/test-fakes), extended with appUser for this.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeFakePrisma, type FakePrisma } from '@/lib/test-fakes';

// leaderboard.ts constructs `new Redis(...)` at module load — stub it so it
// builds without env vars and every cache read misses (forcing a fresh compute).
vi.mock('@upstash/redis', () => ({
  Redis: class { async get() { return null; } async setex() { /* no-op */ } },
}));

const h = vi.hoisted(() => ({ db: null as unknown as FakePrisma }));
vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy({}, { get: (_t, prop) => (h.db as unknown as Record<PropertyKey, unknown>)[prop] }),
}));

import { getSeasonRankings } from '@/lib/leaderboard';

beforeEach(() => { h.db = makeFakePrisma(); });

const today = new Date().toISOString().slice(0, 10); // always inside the current season window

describe('getSeasonRankings', () => {
  it('ranks opted-in users by score, excluding opted-out and no-data users', async () => {
    h.db.seedUser({ id: 'u1', username: 'alice', leaderboardOptIn: true });
    h.db.seedUser({ id: 'u2', username: 'bob',   leaderboardOptIn: true });
    h.db.seedUser({ id: 'u3', username: 'carol', leaderboardOptIn: false }); // opted out → excluded
    h.db.seedUser({ id: 'u4', username: 'dave',  leaderboardOptIn: true });  // opted in but no data → excluded
    h.db.seedDay('u1', today, { steps: '5000' });
    h.db.seedDay('u2', today, { steps: '8000' });
    h.db.seedDay('u3', today, { steps: '9999' }); // not loaded — carol isn't opted in

    const { ranked } = await getSeasonRankings('cardio.steps');

    expect(ranked.map(r => r.username)).toEqual(['bob', 'alice']);
    expect(ranked.map(r => r.rank)).toEqual([1, 2]);
    expect(ranked[0].score).toBe(8000);
  });

  it('sums a user\'s scores across the season window', async () => {
    h.db.seedUser({ id: 'u1', username: 'alice', leaderboardOptIn: true });
    h.db.seedDay('u1', today, { steps: '3000' });
    h.db.seedDay('u1', today, { steps: '2500' }); // two entries same window → summed
    const { ranked } = await getSeasonRankings('cardio.steps');
    expect(ranked[0].score).toBe(5500);
  });

  it('shares a rank on ties', async () => {
    h.db.seedUser({ id: 'u1', username: 'alice', leaderboardOptIn: true });
    h.db.seedUser({ id: 'u2', username: 'bob',   leaderboardOptIn: true });
    h.db.seedDay('u1', today, { steps: '5000' });
    h.db.seedDay('u2', today, { steps: '5000' });
    const { ranked } = await getSeasonRankings('cardio.steps');
    expect(ranked.map(r => r.rank)).toEqual([1, 1]);
  });

  it('falls back to the default category for an unknown slug', async () => {
    const { category } = await getSeasonRankings('bogus.category');
    expect(category).toBe('cardio.steps');
  });

  it('returns an empty field when no one has opted in', async () => {
    h.db.seedUser({ id: 'u1', username: 'alice', leaderboardOptIn: false });
    const { ranked } = await getSeasonRankings('cardio.steps');
    expect(ranked).toEqual([]);
  });
});
