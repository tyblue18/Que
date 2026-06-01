/**
 * lib/coinEngine.test.ts
 *
 * Locks calorie-coin awards: goal days earn coins on a weekly-escalating
 * multiplier (floor(streak/7)+1), each date is awarded at most once (idempotent
 * across syncs), and future days never earn. Coins are spendable in battles, so
 * an over-award is as bad as an under-award.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeFakePrisma, type FakePrisma } from '@/lib/test-fakes';

const h = vi.hoisted(() => ({ db: null as unknown as FakePrisma }));
vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy({}, { get: (_t, prop) => (h.db as unknown as Record<PropertyKey, unknown>)[prop] }),
}));

import { checkAndAwardCoins } from '@/lib/coinEngine';

beforeEach(() => { h.db = makeFakePrisma(); });

/** YYYY-MM-DD `n` days from now (negative = past). */
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
/** A day that hits goal with no plan: calsEaten within ±100 of budget, > 0. */
const goalDay = { calsEaten: '2000', budget: '2000' };

describe('checkAndAwardCoins', () => {
  it('awards 1 coin/day in week one and escalates the multiplier at day 7', async () => {
    h.db.seedWallet('u1', 0);
    // 8 consecutive goal days, all in the past so none are excluded.
    for (let i = 8; i >= 1; i--) h.db.seedDay('u1', iso(-i), goalDay);

    const { awarded, walletBalance } = await checkAndAwardCoins('u1', 0, null);

    expect(awarded).toHaveLength(8);
    // streak 1..6 → 1 coin; streak 7 → floor(7/7)+1 = 2; streak 8 → 2.
    const byDate = Object.fromEntries(awarded.map(a => [a.date, a.coins]));
    expect(byDate[iso(-8)]).toBe(1); // first day of the run (streak 1)
    expect(byDate[iso(-2)]).toBe(2); // seventh day of the run (streak 7)
    expect(byDate[iso(-1)]).toBe(2); // eighth day  (streak 8)
    expect(walletBalance).toBe(6 * 1 + 2 + 2); // 10
  });

  it('does not re-award dates already in the ledger (idempotent across syncs)', async () => {
    const w = h.db.seedWallet('u1', 3);
    h.db.seedDay('u1', iso(-3), goalDay);
    h.db.seedDay('u1', iso(-2), goalDay);
    h.db.seedDay('u1', iso(-1), goalDay);
    // First three already awarded in a prior sync (1 coin each → balance 3).
    for (const d of [iso(-3), iso(-2), iso(-1)]) {
      await h.db.coinTransaction.create({ data: { walletId: w.id, amount: 1, reason: 'goal_hit', refId: d } });
    }

    const { awarded, walletBalance } = await checkAndAwardCoins('u1', 0, null);

    expect(awarded).toHaveLength(0);
    expect(walletBalance).toBe(3); // unchanged
  });

  it('only awards the newly-logged day on an incremental sync', async () => {
    const w = h.db.seedWallet('u1', 2);
    h.db.seedDay('u1', iso(-2), goalDay);
    h.db.seedDay('u1', iso(-1), goalDay);
    for (const d of [iso(-2), iso(-1)]) {
      await h.db.coinTransaction.create({ data: { walletId: w.id, amount: 1, reason: 'goal_hit', refId: d } });
    }
    // A new goal day arrives (today), extending the streak to 3.
    h.db.seedDay('u1', iso(0), goalDay);

    const { awarded, walletBalance } = await checkAndAwardCoins('u1', 0, null);

    expect(awarded).toHaveLength(1);
    expect(awarded[0].date).toBe(iso(0));
    expect(awarded[0].coins).toBe(1); // streak 3 → floor(3/7)+1 = 1
    expect(walletBalance).toBe(3);
  });

  it('never awards a future day', async () => {
    h.db.seedWallet('u1', 0);
    h.db.seedDay('u1', iso(0), goalDay);   // today — eligible
    h.db.seedDay('u1', iso(3), goalDay);   // future — must be ignored

    const { awarded } = await checkAndAwardCoins('u1', 0, null);

    expect(awarded.map(a => a.date)).toEqual([iso(0)]);
  });

  it('ignores days that miss the goal band', async () => {
    h.db.seedWallet('u1', 0);
    h.db.seedDay('u1', iso(-1), { calsEaten: '2600', budget: '2000' }); // 600 over → miss
    h.db.seedDay('u1', iso(0),  goalDay);                                // hit

    const { awarded } = await checkAndAwardCoins('u1', 0, null);

    expect(awarded.map(a => a.date)).toEqual([iso(0)]);
  });

  // ── HIGH-2 DB backstop: the unique constraint rejects a duplicate goal_hit ──
  // The per-user Redis lock can fail open, letting two evals race. The engine's
  // in-tx re-read handles "the other eval already committed"; the
  // [walletId,'goal_hit',refId] unique constraint handles "the other eval's row
  // isn't visible yet" — a second insert of the same date raises P2002, which
  // rolls back the whole transaction (balance increment included), so a date is
  // never credited twice. True concurrent-transaction isolation isn't
  // unit-testable (same as the sync CAS race), so we assert the DB backstop
  // deterministically: a duplicate goal_hit triple is rejected.
  it('GUARD: a duplicate goal_hit for the same date is rejected by the constraint', async () => {
    const w = h.db.seedWallet('u1', 1);
    const d = iso(-1);
    await h.db.coinTransaction.create({ data: { walletId: w.id, amount: 1, reason: 'goal_hit', refId: d } });
    await expect(
      h.db.coinTransaction.create({ data: { walletId: w.id, amount: 1, reason: 'goal_hit', refId: d } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(h.db.txnsFor(d).filter(t => t.reason === 'goal_hit')).toHaveLength(1);
  });

  it('a re-run after a full award credits nothing more (in-tx re-read idempotency)', async () => {
    h.db.seedWallet('u1', 0);
    for (let i = 3; i >= 1; i--) h.db.seedDay('u1', iso(-i), goalDay);
    await checkAndAwardCoins('u1', 0, null);          // first run awards 3
    const after1 = h.db.walletOf('u1')!.balance;
    const { awarded } = await checkAndAwardCoins('u1', 0, null); // second run
    expect(after1).toBe(3);
    expect(awarded).toHaveLength(0);                  // nothing new
    expect(h.db.walletOf('u1')!.balance).toBe(3);     // not 6
  });

  // ── HIGH-1 DB backstop: duplicate battle_bet rejected (debit once) ──────────
  // The team double-accept wrote a second battle_bet with the same (wallet,
  // reason, refId). The constraint rejects the duplicate so the wallet is
  // debited once. (Route-level P2002→idempotent-success handling is in the
  // accept handlers; this asserts the DB layer it relies on.)
  it('GUARD: a duplicate battle_bet for the same battle is rejected (debit once)', async () => {
    const w = h.db.seedWallet('u1', 100);
    await h.db.coinTransaction.create({ data: { walletId: w.id, amount: -10, reason: 'battle_bet', refId: 'battle-1' } });
    await expect(
      h.db.coinTransaction.create({ data: { walletId: w.id, amount: -10, reason: 'battle_bet', refId: 'battle-1' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(h.db.txnsFor('battle-1').filter(t => t.reason === 'battle_bet')).toHaveLength(1);
  });
});
