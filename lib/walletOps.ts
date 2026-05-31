/**
 * lib/walletOps.ts
 *
 * The single audited primitive for moving coins OUT of a wallet. Coins are real
 * in-app currency (battle wagers), so "never let a balance go negative" is an
 * invariant worth having in exactly one tested place instead of copy-pasted into
 * every route that takes a wager.
 *
 * Usage is always inside a Prisma `$transaction`: the throw aborts and rolls back
 * the whole transaction, so a failed debit leaves the wallet untouched. Callers
 * catch `INSUFFICIENT_FUNDS` to turn it into a 400. The matching credit side
 * (winnings/refunds) can't underflow, so it stays inline in the engines.
 */

/** Structural subset of a Prisma transaction client this primitive needs.
 *  Prisma's real `tx` satisfies it; tests pass a fake that does too. */
export interface WalletDebitTx {
  coinWallet: {
    update(args: {
      where: { id: string };
      data:  { balance: { decrement: number } };
    }): Promise<{ balance: number }>;
  };
}

/** Thrown (as a plain Error with this exact message, for back-compat with
 *  existing `e.message === 'INSUFFICIENT_FUNDS'` catches) when a debit would
 *  overdraw the wallet. */
export const INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS';

/**
 * Decrement a wallet by `amount` and throw if it would go negative, aborting the
 * enclosing transaction. Returns the post-debit balance. `amount <= 0` is a
 * no-op debit that still returns the current balance (no row mutation needed),
 * which keeps bragging-rights (wager 0) battles free of ledger churn.
 */
export async function debitWalletOrThrow(
  tx:       WalletDebitTx,
  walletId: string,
  amount:   number,
): Promise<number> {
  const after = await tx.coinWallet.update({
    where: { id: walletId },
    data:  { balance: { decrement: amount } },
  });
  if (after.balance < 0) throw new Error(INSUFFICIENT_FUNDS);
  return after.balance;
}
