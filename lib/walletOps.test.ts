/**
 * lib/walletOps.test.ts
 *
 * Locks the overdraft invariant: a wallet can never be debited below zero, and a
 * failed debit inside a transaction leaves the balance untouched. Coins are real
 * currency in battles, so this guard is the difference between "not enough coins"
 * and a silently corrupted balance.
 */

import { describe, it, expect } from 'vitest';
import { makeFakePrisma } from '@/lib/test-fakes';
import { debitWalletOrThrow } from '@/lib/walletOps';

describe('debitWalletOrThrow', () => {
  it('debits and returns the new balance when funds suffice', async () => {
    const db = makeFakePrisma();
    const w = db.seedWallet('u1', 100);
    await expect(debitWalletOrThrow(db, w.id, 30)).resolves.toBe(70);
    expect(db.walletOf('u1')!.balance).toBe(70);
  });

  it('allows debiting the exact balance down to zero', async () => {
    const db = makeFakePrisma();
    const w = db.seedWallet('u1', 50);
    await expect(debitWalletOrThrow(db, w.id, 50)).resolves.toBe(0);
  });

  it('throws INSUFFICIENT_FUNDS when the debit would overdraw', async () => {
    const db = makeFakePrisma();
    const w = db.seedWallet('u1', 20);
    await expect(debitWalletOrThrow(db, w.id, 21)).rejects.toThrow('INSUFFICIENT_FUNDS');
  });

  it('rolls the decrement back inside a $transaction on overdraw', async () => {
    const db = makeFakePrisma();
    const w = db.seedWallet('u1', 20);
    await expect(
      db.$transaction(async tx => debitWalletOrThrow(tx, w.id, 50)),
    ).rejects.toThrow('INSUFFICIENT_FUNDS');
    expect(db.walletOf('u1')!.balance).toBe(20); // unchanged — transaction rolled back
  });
});
