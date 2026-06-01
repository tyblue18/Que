/**
 * POST /api/team-battles/[id] — { action: 'accept' | 'decline' | 'cancel' }
 *
 *   accept  — a pending participant antes their wager; when the LAST one
 *             accepts, the battle flips to 'active'.
 *   decline — a participant bails → battle cancelled, everyone who anted refunded.
 *   cancel  — the creator calls it off while pending → same refund.
 *
 * Resolution (after the window ends) is handled by the resolve-battles cron.
 */

import { getServerSession }       from 'next-auth/next';
import { NextResponse }           from 'next/server';
import { Prisma }                 from '@prisma/client';
import { authOptions }            from '@/lib/auth';
import { prisma }                 from '@/lib/prisma';
import { sendPushToUser }         from '@/lib/push';
import { challengeLimit }         from '@/lib/ratelimit';
import { teamBattleActionSchema } from '@/lib/validators';

/** Refund every participant who already anted (used on decline / cancel). */
async function refundAnted(
  tx: Prisma.TransactionClient,
  battleId: string,
  wager: number,
  participants: { userId: string; accepted: boolean }[],
): Promise<void> {
  if (wager <= 0) return;
  for (const p of participants) {
    if (!p.accepted) continue;
    const w = await tx.coinWallet.upsert({ where: { userId: p.userId }, create: { userId: p.userId, balance: 0 }, update: {} });
    await tx.coinWallet.update({ where: { id: w.id }, data: { balance: { increment: wager } } });
    await tx.coinTransaction.create({ data: { walletId: w.id, amount: wager, reason: 'refund', refId: battleId } });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json(null, { status: 401 });
  const meId = session.user.id;

  const { success } = await challengeLimit.limit(meId);
  if (!success) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const { id } = await params;
  const parsed = teamBattleActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  const { action } = parsed.data;

  const battle = await prisma.teamBattle.findUnique({
    where:   { id },
    include: { participants: { select: { userId: true, accepted: true } } },
  });
  if (!battle) return NextResponse.json({ error: 'Battle not found' }, { status: 404 });
  if (battle.status !== 'pending') {
    return NextResponse.json({ error: 'This battle is no longer open' }, { status: 409 });
  }

  const me = battle.participants.find(p => p.userId === meId);
  const isCreator = battle.creatorId === meId;
  if (!me && !isCreator) return NextResponse.json({ error: 'Not your battle' }, { status: 403 });

  // ── Decline / cancel → cancel the battle and refund anyone who anted ────────
  if (action === 'decline' || action === 'cancel') {
    if (action === 'cancel' && !isCreator) {
      return NextResponse.json({ error: 'Only the creator can cancel' }, { status: 403 });
    }
    await prisma.$transaction(async tx => {
      const claimed = await tx.teamBattle.updateMany({ where: { id, status: 'pending' }, data: { status: 'cancelled' } });
      if (claimed.count === 0) throw new Error('RACE');
      await refundAnted(tx, id, battle.wager, battle.participants);
    }).catch(() => {});
    sendPushToUser(battle.creatorId, { title: 'Team battle cancelled', body: 'A team battle was called off — coins refunded.', url: '/app' }).catch(() => {});
    return NextResponse.json({ ok: true, cancelled: true });
  }

  // ── Accept → ante, and activate once everyone is in ─────────────────────────
  if (!me) return NextResponse.json({ error: 'You are not in this battle' }, { status: 403 });
  if (me.accepted) return NextResponse.json({ ok: true, alreadyAccepted: true });

  const wallet = await prisma.coinWallet.upsert({ where: { userId: meId }, create: { userId: meId, balance: 0 }, update: {} });
  if (battle.wager > 0 && wallet.balance < battle.wager) {
    return NextResponse.json({ error: `Not enough coins (have ${wallet.balance})` }, { status: 400 });
  }

  let activated = false;
  try {
    await prisma.$transaction(async tx => {
      if (battle.wager > 0) {
        const updated = await tx.coinWallet.update({ where: { id: wallet.id }, data: { balance: { decrement: battle.wager } } });
        if (updated.balance < 0) throw new Error('INSUFFICIENT_FUNDS');
        await tx.coinTransaction.create({ data: { walletId: wallet.id, amount: -battle.wager, reason: 'battle_bet', refId: id } });
      }
      await tx.teamBattleParticipant.updateMany({ where: { battleId: id, userId: meId }, data: { accepted: true } });

      // Activate atomically once no participant is left unaccepted. The relation
      // filter is evaluated by the DB at update time, so two simultaneous
      // accepts can't both miss each other (the count()-then-update approach
      // could, leaving the battle stuck pending).
      const claimed = await tx.teamBattle.updateMany({
        where: { id, status: 'pending', participants: { none: { accepted: false } } },
        data:  { status: 'active' },
      });
      activated = claimed.count > 0;
    });
  } catch (e) {
    if (e instanceof Error && e.message === 'INSUFFICIENT_FUNDS') {
      return NextResponse.json({ error: 'Not enough coins' }, { status: 400 });
    }
    // P2002 on the battle_bet insert = a concurrent/duplicate accept already
    // anted this user (the [walletId,'battle_bet',refId] unique constraint). The
    // transaction rolled back this duplicate decrement, so the wallet is correct
    // (debited exactly once by the first accept). Resolve as idempotent success —
    // the double-tapping user's accept went through, not an error.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return NextResponse.json({ ok: true, alreadyAccepted: true });
    }
    throw e;
  }

  if (activated) {
    for (const p of battle.participants) {
      sendPushToUser(p.userId, { title: 'Team battle is live ⚔️', body: 'Everyone\'s in — the battle has started. Go log!', url: '/app' }).catch(() => {});
    }
  }
  return NextResponse.json({ ok: true, activated });
}
