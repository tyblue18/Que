/**
 * lib/battleEngine.test.ts
 *
 * Locks the money-moving and decision logic of battle resolution:
 *   • computeResolution — pure win / tie / no-data / majority rules.
 *   • resolveBattle (1v1) — winner takes 2× wager, tie refunds both, wager 0
 *     moves nothing, and resolution is idempotent (cron retries can't double-pay,
 *     and a lost compare-and-set aborts without paying).
 *   • resolveTeamBattle — teams pot split, FFA winner-take-all, tie refunds.
 *
 * The DB is a faithful in-memory fake (lib/test-fakes) with transactional
 * rollback and a status-guarded updateMany, so these exercise the real code.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeFakePrisma, type FakePrisma, type FakeChallenge, type FakeTeamBattle } from '@/lib/test-fakes';

// Swap the prisma singleton for our fake. The Proxy forwards every property to
// whatever fake the current test installed in beforeEach.
const h = vi.hoisted(() => ({ db: null as unknown as FakePrisma }));
vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy({}, { get: (_t, prop) => (h.db as unknown as Record<PropertyKey, unknown>)[prop] }),
}));

import { resolveBattle, resolveTeamBattle, computeResolution } from '@/lib/battleEngine';

beforeEach(() => { h.db = makeFakePrisma(); });

const DAY = '2026-01-01';

function seedBattle(over: Partial<FakeChallenge> = {}): FakeChallenge {
  return h.db.seedChallenge({
    id: 'c1', challengerId: 'A', challengeeId: 'B',
    wager: 50, status: 'active', type: 'typed',
    categories: ['cardio.steps'], startDate: DAY, endDate: DAY,
    ...over,
  });
}

// ── Pure decision logic ──────────────────────────────────────────────────────
describe('computeResolution', () => {
  const rows = (steps: number | null) =>
    steps === null ? [] : [{ date: DAY, data: { steps: String(steps) } }];

  it('higher-is-better: more steps wins the category and the battle', () => {
    const r = computeResolution('A', 'B', ['cardio.steps'], rows(100), rows(50));
    expect(r.winnerId).toBe('A');
    expect(r.summary).toMatchObject({ challengerWins: 1, challengeeWins: 0, decided: 1 });
  });

  it('a logger beats a non-logger (null auto-loses)', () => {
    const r = computeResolution('A', 'B', ['cardio.steps'], rows(null), rows(50));
    expect(r.winnerId).toBe('B');
    expect(r.perCategory[0].outcome).toBe('challengee');
  });

  it('both no-data is a no-result, not counted as decided', () => {
    const r = computeResolution('A', 'B', ['cardio.steps'], rows(null), rows(null));
    expect(r.winnerId).toBeNull();
    expect(r.summary.decided).toBe(0);
    expect(r.perCategory[0].outcome).toBe('nodata');
  });

  it('equal scores tie the category → overall tie', () => {
    const r = computeResolution('A', 'B', ['cardio.steps'], rows(100), rows(100));
    expect(r.winnerId).toBeNull();
    expect(r.perCategory[0].outcome).toBe('tie');
  });

  it('majority of decided categories wins (2–1)', () => {
    const r = computeResolution(
      'A', 'B',
      ['cardio.steps', 'diet.kcal_less', 'cardio.run_miles'],
      [{ date: DAY, data: { steps: '100', calsEaten: '3000', runDist: '5' } }],
      [{ date: DAY, data: { steps: '50',  calsEaten: '1500', runDist: '2' } }],
    );
    // A wins steps + run_miles; B wins kcal_less (lower is better) → 2–1 A.
    expect(r.winnerId).toBe('A');
    expect(r.summary).toMatchObject({ challengerWins: 2, challengeeWins: 1 });
  });
});

// ── 1v1 settlement ───────────────────────────────────────────────────────────
describe('resolveBattle (1v1)', () => {
  it('pays the winner 2× the wager and records one battle_win', async () => {
    h.db.seedWallet('A', 0); h.db.seedWallet('B', 0);
    seedBattle();
    h.db.seedDay('A', DAY, { steps: '10000' });
    h.db.seedDay('B', DAY, { steps: '5000' });

    const res = await resolveBattle('c1');

    expect(res?.winnerId).toBe('A');
    expect(h.db.walletOf('A')!.balance).toBe(100); // 2 × 50
    expect(h.db.walletOf('B')!.balance).toBe(0);
    const wins = h.db.txnsFor('c1').filter(t => t.reason === 'battle_win');
    expect(wins).toHaveLength(1);
    expect(wins[0].amount).toBe(100);
    expect(h.db.state.challenges[0].status).toBe('resolved');
  });

  it('refunds both sides their wager on an overall tie', async () => {
    h.db.seedWallet('A', 0); h.db.seedWallet('B', 0);
    seedBattle({ categories: ['cardio.steps', 'diet.kcal_less'] });
    // A wins steps (more); B wins kcal_less (fewer cals) → 1–1 → tie.
    h.db.seedDay('A', DAY, { steps: '10000', calsEaten: '3000' });
    h.db.seedDay('B', DAY, { steps: '5000',  calsEaten: '1500' });

    const res = await resolveBattle('c1');

    expect(res?.winnerId).toBeNull();
    expect(h.db.walletOf('A')!.balance).toBe(50);
    expect(h.db.walletOf('B')!.balance).toBe(50);
    expect(h.db.txnsFor('c1').filter(t => t.reason === 'refund')).toHaveLength(2);
  });

  it('moves no coins for a bragging-rights (wager 0) battle', async () => {
    h.db.seedWallet('A', 0); h.db.seedWallet('B', 0);
    seedBattle({ wager: 0 });
    h.db.seedDay('A', DAY, { steps: '10000' });
    h.db.seedDay('B', DAY, { steps: '5000' });

    const res = await resolveBattle('c1');

    expect(res?.winnerId).toBe('A');
    expect(h.db.txnsFor('c1')).toHaveLength(0);
    expect(h.db.walletOf('A')!.balance).toBe(0);
    expect(h.db.state.challenges[0].status).toBe('resolved');
  });

  it('is idempotent — a second resolve (cron retry) pays nothing more', async () => {
    h.db.seedWallet('A', 0); h.db.seedWallet('B', 0);
    seedBattle();
    h.db.seedDay('A', DAY, { steps: '10000' });
    h.db.seedDay('B', DAY, { steps: '5000' });

    await resolveBattle('c1');
    const afterFirst = h.db.walletOf('A')!.balance;
    const second = await resolveBattle('c1');

    expect(second).toBeNull(); // already-resolved status guard short-circuits
    expect(h.db.walletOf('A')!.balance).toBe(afterFirst);
    expect(h.db.txnsFor('c1').filter(t => t.reason === 'battle_win')).toHaveLength(1);
  });

  it('aborts without paying if the compare-and-set is lost to a concurrent resolve', async () => {
    h.db.seedWallet('A', 0); h.db.seedWallet('B', 0);
    seedBattle();
    h.db.seedDay('A', DAY, { steps: '10000' });
    h.db.seedDay('B', DAY, { steps: '5000' });
    // Simulate another worker claiming the row first: updateMany matches nothing.
    h.db.challenge.updateMany = async () => ({ count: 0 });

    await expect(resolveBattle('c1')).rejects.toThrow('ALREADY_RESOLVED');
    expect(h.db.walletOf('A')!.balance).toBe(0); // rolled back — no double-pay
    expect(h.db.txnsFor('c1')).toHaveLength(0);
  });
});

// ── Team / FFA settlement ────────────────────────────────────────────────────
describe('resolveTeamBattle', () => {
  function seedTeams(over: Partial<FakeTeamBattle> = {}): FakeTeamBattle {
    return h.db.seedTeamBattle({
      id: 'tb1', status: 'active', mode: 'teams', wager: 10,
      categories: ['cardio.steps'], startDate: DAY, endDate: DAY,
      participants: [{ userId: 'A', team: 0 }, { userId: 'B', team: 1 }],
      ...over,
    });
  }

  it('teams: the winning team takes the pot (wager × participants)', async () => {
    h.db.seedWallet('A', 0); h.db.seedWallet('B', 0);
    seedTeams();
    h.db.seedDay('A', DAY, { steps: '8000' });
    h.db.seedDay('B', DAY, { steps: '3000' });

    const res = await resolveTeamBattle('tb1');

    expect(res?.mode).toBe('teams');
    expect(h.db.walletOf('A')!.balance).toBe(20); // pot 10×2, one winner
    expect(h.db.walletOf('B')!.balance).toBe(0);
  });

  it('teams: refunds every participant on an overall tie', async () => {
    h.db.seedWallet('A', 0); h.db.seedWallet('B', 0);
    seedTeams({ categories: ['cardio.steps', 'diet.kcal_more'] });
    // team0 (A) wins steps; team1 (B) wins kcal_more → 1–1 tie.
    h.db.seedDay('A', DAY, { steps: '8000', calsEaten: '1000' });
    h.db.seedDay('B', DAY, { steps: '3000', calsEaten: '5000' });

    const res = await resolveTeamBattle('tb1');

    expect(res?.mode === 'teams' && res.winningTeam).toBeNull();
    expect(h.db.walletOf('A')!.balance).toBe(10);
    expect(h.db.walletOf('B')!.balance).toBe(10);
  });

  it('ffa: the single top scorer takes the whole pot', async () => {
    h.db.seedWallet('A', 0); h.db.seedWallet('B', 0); h.db.seedWallet('C', 0);
    h.db.seedTeamBattle({
      id: 'tb2', status: 'active', mode: 'ffa', wager: 10,
      categories: ['cardio.steps'], startDate: DAY, endDate: DAY,
      participants: [{ userId: 'A', team: 0 }, { userId: 'B', team: 0 }, { userId: 'C', team: 0 }],
    });
    h.db.seedDay('A', DAY, { steps: '9000' });
    h.db.seedDay('B', DAY, { steps: '5000' });
    h.db.seedDay('C', DAY, { steps: '1000' });

    const res = await resolveTeamBattle('tb2');

    expect(res?.mode).toBe('ffa');
    expect(h.db.walletOf('A')!.balance).toBe(30); // pot 10×3 to the winner
    expect(h.db.walletOf('B')!.balance).toBe(0);
  });
});
