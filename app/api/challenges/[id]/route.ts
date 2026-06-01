/**
 * POST /api/challenges/[id]
 * Body: { action: 'accept' | 'decline' }
 *
 * accept:  challengee pays wager, badge counts compared, winner gets 2× wager.
 *          Tie → both refunded.
 * decline: challenge cancelled, challenger refunded.
 *
 * A wager of 0 is a "bragging rights" battle: no coins are deducted, transferred,
 * or refunded on any path — only the win/loss/tie outcome is recorded.
 */

import { getServerSession } from 'next-auth/next';
import { NextResponse }     from 'next/server';
import { Prisma }           from '@prisma/client';
import { authOptions }      from '@/lib/auth';
import { prisma }           from '@/lib/prisma';
import { challengeLimit }   from '@/lib/ratelimit';
import { challengeActionSchema } from '@/lib/validators';
import { debitWalletOrThrow } from '@/lib/walletOps';
import { resolveBattle, isWindowComplete, todayUTC } from '@/lib/battleEngine';
import { awardBadgesForUser } from '@/lib/badgeEngine';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json(null, { status: 401 });

  const { success } = await challengeLimit.limit(session.user.id);
  if (!success) return NextResponse.json({ error: 'Too many requests — slow down' }, { status: 429 });

  const parsed = challengeActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'action must be accept or decline' }, { status: 400 });
  }
  const { action } = parsed.data;

  const me = { id: session.user.id };

  const challenge = await prisma.challenge.findUnique({ where: { id } });
  if (!challenge || challenge.status !== 'pending') {
    return NextResponse.json({ error: 'Challenge not found or already resolved' }, { status: 404 });
  }
  if (challenge.challengeeId !== me.id) {
    return NextResponse.json({ error: 'Not your challenge to respond to' }, { status: 403 });
  }

  // ── Decline — refund challenger (nothing to refund on a bragging-rights battle) ──
  if (action === 'decline') {
    if (challenge.wager > 0) {
      const challengerWallet = await prisma.coinWallet.upsert({
        where:  { userId: challenge.challengerId },
        create: { userId: challenge.challengerId, balance: 0 },
        update: {},
      });
      await prisma.$transaction([
        prisma.coinWallet.update({
          where: { id: challengerWallet.id },
          data:  { balance: { increment: challenge.wager } },
        }),
        prisma.coinTransaction.create({
          data: { walletId: challengerWallet.id, amount: challenge.wager, reason: 'refund', refId: challenge.id },
        }),
        prisma.challenge.update({
          where: { id: challenge.id },
          data:  { status: 'cancelled', resolvedAt: new Date() },
        }),
      ]);
    } else {
      await prisma.challenge.update({
        where: { id: challenge.id },
        data:  { status: 'cancelled', resolvedAt: new Date() },
      });
    }

    return NextResponse.json({ ok: true, result: 'declined' });
  }

  // ── Accept — deduct challengee's wager ───────────────────────────────────
  // For TYPED battles: deduct, mark 'active'; resolution happens later via
  //   resolveBattle() (cron after endDate, or inline if the window is already
  //   complete at accept time).
  // For CLASSIC battles: legacy badge-count comparison resolves inline.
  const challengeeWallet = await prisma.coinWallet.upsert({
    where:  { userId: me.id },
    create: { userId: me.id, balance: 0 },
    update: {},
  });
  if (challengeeWallet.balance < challenge.wager) {
    return NextResponse.json(
      { error: `Not enough coins (have ${challengeeWallet.balance}, need ${challenge.wager})` },
      { status: 400 },
    );
  }

  const isTyped = challenge.type === 'typed';

  // ── TYPED PATH ───────────────────────────────────────────────────────────
  if (isTyped) {
    if (!challenge.endDate) {
      return NextResponse.json({ error: 'Typed challenge is missing endDate' }, { status: 500 });
    }

    // 1. Deduct the challengee's wager and mark the battle active. Concurrent
    //    accepts are blocked via the status='pending' guard on updateMany.
    try {
      await prisma.$transaction(async tx => {
        if (challenge.wager > 0) {
          await debitWalletOrThrow(tx, challengeeWallet.id, challenge.wager);
          await tx.coinTransaction.create({
            data: { walletId: challengeeWallet.id, amount: -challenge.wager, reason: 'battle_bet', refId: challenge.id },
          });
        }
        const claimed = await tx.challenge.updateMany({
          where: { id: challenge.id, status: 'pending' },
          data:  { status: 'active' },
        });
        if (claimed.count === 0) throw new Error('ALREADY_RESOLVED');
      });
    } catch (e) {
      if (e instanceof Error && e.message === 'INSUFFICIENT_FUNDS') {
        return NextResponse.json({ error: 'Not enough coins to accept this challenge' }, { status: 400 });
      }
      if (e instanceof Error && e.message === 'ALREADY_RESOLVED') {
        return NextResponse.json({ error: 'Challenge already resolved' }, { status: 409 });
      }
      // Duplicate ante (concurrent accept) → the unique constraint rolled back
      // this transaction; the wallet was debited once by the first accept. The
      // status CAS would also catch the second accept, but the insert runs first
      // so P2002 can surface — treat it as the already-resolved case.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return NextResponse.json({ error: 'Challenge already resolved' }, { status: 409 });
      }
      throw e;
    }

    // 2. If the window is already over (e.g. retrospective past-week battle),
    //    resolve immediately instead of waiting for the cron.
    if (isWindowComplete(challenge.endDate, todayUTC())) {
      const resolution = await resolveBattle(challenge.id);
      // Award battle-count badges to the winner so they appear in-collection
      // immediately (no need to wait for the next sync to pick them up).
      let awardedBadges: Awaited<ReturnType<typeof awardBadgesForUser>> = [];
      if (resolution?.winnerId) {
        try {
          awardedBadges = await awardBadgesForUser(resolution.winnerId);
        } catch (e) {
          console.error('[challenges/[id]] typed-resolve badge award failed:', e);
        }
      }
      return NextResponse.json({
        ok:        true,
        status:    'resolved',
        result:    resolution?.winnerId === me.id ? 'win' :
                   resolution?.winnerId === null  ? 'tie' :
                   'loss',
        winnerId:  resolution?.winnerId ?? null,
        resolution,
        awardedBadges: resolution?.winnerId === me.id ? awardedBadges : [],
      });
    }

    return NextResponse.json({
      ok:      true,
      status:  'active',
      endDate: challenge.endDate,
    });
  }

  // ── CLASSIC PATH (legacy badge-count comparison) ─────────────────────────
  const challengerWallet = await prisma.coinWallet.upsert({
    where:  { userId: challenge.challengerId },
    create: { userId: challenge.challengerId, balance: 0 },
    update: {},
  });

  // Compare total badge counts
  const [challengerCount, challengeeCount] = await Promise.all([
    prisma.badge.count({ where: { userId: challenge.challengerId } }),
    prisma.badge.count({ where: { userId: me.id } }),
  ]);

  const winnerId: string | null =
    challengerCount > challengeeCount ? challenge.challengerId :
    challengeeCount > challengerCount ? me.id :
    null; // tie

  const pot = challenge.wager * 2;

  try {
  await prisma.$transaction(async tx => {
    // Coins only move when something was actually wagered (bragging-rights = 0).
    if (challenge.wager > 0) {
      // Deduct wager from challengee — re-check balance atomically
      await debitWalletOrThrow(tx, challengeeWallet.id, challenge.wager);
      await tx.coinTransaction.create({ data: { walletId: challengeeWallet.id, amount: -challenge.wager, reason: 'battle_bet', refId: challenge.id } });

      if (winnerId) {
        // Award pot to winner
        const winnerWalletId = winnerId === challenge.challengerId ? challengerWallet.id : challengeeWallet.id;
        await tx.coinWallet.update({ where: { id: winnerWalletId }, data: { balance: { increment: pot } } });
        await tx.coinTransaction.create({ data: { walletId: winnerWalletId, amount: pot, reason: 'battle_win', refId: challenge.id } });
      } else {
        // Tie: refund both
        for (const wId of [challengerWallet.id, challengeeWallet.id]) {
          await tx.coinWallet.update({ where: { id: wId }, data: { balance: { increment: challenge.wager } } });
          await tx.coinTransaction.create({ data: { walletId: wId, amount: challenge.wager, reason: 'refund', refId: challenge.id } });
        }
      }
    }

    // Guard against concurrent accepts: only succeed if challenge is still pending.
    const resolved = await tx.challenge.updateMany({
      where: { id: challenge.id, status: 'pending' },
      data:  { status: 'resolved', winnerId, resolvedAt: new Date() },
    });
    if (resolved.count === 0) throw new Error('ALREADY_RESOLVED');
  });
  } catch (e) {
    if (e instanceof Error && e.message === 'INSUFFICIENT_FUNDS') {
      return NextResponse.json({ error: 'Not enough coins to accept this challenge' }, { status: 400 });
    }
    if (e instanceof Error && e.message === 'ALREADY_RESOLVED') {
      return NextResponse.json({ error: 'Challenge already resolved' }, { status: 409 });
    }
    // Duplicate ante (concurrent accept) → unique constraint rolled back the tx;
    // wallet debited once by the first accept. Treat as already-resolved.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return NextResponse.json({ error: 'Challenge already resolved' }, { status: 409 });
    }
    throw e;
  }

  // Award any battle-count badges the winner just earned. Run outside the
  // transaction (no need to roll back the resolution if a badge write fails)
  // and return the awarded list so the client can fire the celebration popup
  // via the existing que-badge-earned event.
  let awardedBadges: Awaited<ReturnType<typeof awardBadgesForUser>> = [];
  if (winnerId) {
    try {
      awardedBadges = await awardBadgesForUser(winnerId);
    } catch (e) {
      console.error('[challenges/[id]] badge award failed:', e);
    }
  }

  return NextResponse.json({
    ok: true,
    result: winnerId === me.id ? 'win' : winnerId === null ? 'tie' : 'loss',
    winnerId,
    challengerCount,
    challengeeCount,
    // Only surfaced when the calling user is the winner — losers don't need
    // to know what badges the opponent unlocked.
    awardedBadges: winnerId === me.id ? awardedBadges : [],
  });
}
