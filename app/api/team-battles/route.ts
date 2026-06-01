/**
 * GET  /api/team-battles — every team battle the user is in, categorised.
 * POST /api/team-battles — create one (creator antes immediately; teammates and
 *                          opponents ante when they accept; it goes active once
 *                          everyone has accepted).
 */

import { getServerSession }       from 'next-auth/next';
import { NextResponse }           from 'next/server';
import { authOptions }            from '@/lib/auth';
import { prisma }                 from '@/lib/prisma';
import { sendPushToUser }         from '@/lib/push';
import { challengeLimit }         from '@/lib/ratelimit';
import { teamBattleCreateSchema } from '@/lib/validators';
import { windowBounds, todayUTC, getCategory } from '@/lib/battleEngine';
import { PROFILE_PHOTO_KEY }      from '@/lib/constants';

function photoFrom(settings: unknown): string | null {
  const s = (settings ?? {}) as Record<string, unknown>;
  return typeof s[PROFILE_PHOTO_KEY] === 'string' ? (s[PROFILE_PHOTO_KEY] as string) : null;
}

export async function GET(): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json(null, { status: 401 });
  const meId = session.user.id;

  const myParts = await prisma.teamBattleParticipant.findMany({ where: { userId: meId }, select: { battleId: true } });
  const ids = myParts.map(p => p.battleId);
  if (ids.length === 0) return NextResponse.json({ invites: [], pending: [], active: [], resolved: [] });

  const battles = await prisma.teamBattle.findMany({
    where:   { id: { in: ids } },
    orderBy: { createdAt: 'desc' },
    include: {
      group:        { select: { id: true, name: true } },
      participants: {
        select: {
          userId: true, team: true, accepted: true,
          user: { select: { id: true, name: true, username: true, workoutData: { select: { settings: true } } } },
        },
      },
    },
  });

  const shaped = battles.map(b => {
    const mine = b.participants.find(p => p.userId === meId);
    return {
      id: b.id, groupId: b.groupId, groupName: b.group.name, creatorId: b.creatorId,
      mode: b.mode, wager: b.wager, bestOf: b.bestOf, windowKind: b.windowKind,
      startDate: b.startDate, endDate: b.endDate, categories: b.categories,
      status: b.status, winningTeam: b.winningTeam, resolution: b.resolution,
      myTeam: mine?.team ?? null, myAccepted: mine?.accepted ?? false,
      participants: b.participants.map(p => ({
        id: p.userId, team: p.team, accepted: p.accepted,
        name: p.user.name, username: p.user.username, photo: photoFrom(p.user.workoutData?.settings),
      })),
    };
  });

  return NextResponse.json({
    invites:  shaped.filter(b => b.status === 'pending' && !b.myAccepted),
    pending:  shaped.filter(b => b.status === 'pending' && b.myAccepted),
    active:   shaped.filter(b => b.status === 'active'),
    resolved: shaped.filter(b => b.status === 'resolved' || b.status === 'cancelled').slice(0, 10),
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json(null, { status: 401 });
  const meId = session.user.id;

  const { success } = await challengeLimit.limit(meId);
  if (!success) return NextResponse.json({ error: 'Too many battles — slow down' }, { status: 429 });

  const parsed = teamBattleCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid battle setup' }, { status: 400 });
  const { groupId, mode, wager, bestOf, windowKind, startDate, categories } = parsed.data;

  // ── Resolve players per mode + sanity-check shape ───────────────────────────
  // For 'teams' we keep the A/B split (team 0/1, summed); for 'ffa' everyone
  // competes individually so team is irrelevant — we store 0 for all of them.
  let allIds: string[];
  let teamOf: (uid: string) => number;

  if (parsed.data.mode === 'teams') {
    const { teamA, teamB } = parsed.data;
    if (teamA.length !== teamB.length) {
      return NextResponse.json({ error: 'Teams must be the same size' }, { status: 400 });
    }
    allIds = [...teamA, ...teamB];
    teamOf = (uid) => (teamA.includes(uid) ? 0 : 1);
  } else {
    allIds = parsed.data.participants;
    if (allIds.length < 2) {
      return NextResponse.json({ error: 'FFA needs at least 2 players' }, { status: 400 });
    }
    teamOf = () => 0;
  }
  if (new Set(allIds).size !== allIds.length) {
    return NextResponse.json({ error: 'A player can only appear once' }, { status: 400 });
  }
  if (!allIds.includes(meId)) {
    return NextResponse.json({ error: 'You have to be in the battle' }, { status: 400 });
  }

  // ── Categories: exactly bestOf, valid, no dupes, higher-is-better only ──────
  if (categories.length !== bestOf) {
    return NextResponse.json({ error: `Pick exactly ${bestOf} categor${bestOf === 1 ? 'y' : 'ies'}` }, { status: 400 });
  }
  const seen = new Set<string>();
  for (const slug of categories) {
    if (seen.has(slug)) return NextResponse.json({ error: 'Duplicate category' }, { status: 400 });
    seen.add(slug);
    const cat = getCategory(slug);
    if (!cat) return NextResponse.json({ error: `Unknown category: ${slug}` }, { status: 400 });
    // Teams mode sums member scores, so a "lower-is-better" category could be
    // gamed by not logging (null → 0 helps the team). FFA scores per person
    // (null just makes you lose that category), so any direction is fair.
    if (mode === 'teams' && cat.direction !== 'higher') {
      return NextResponse.json({ error: 'Team mode only supports "most wins" categories — use FFA for lower-is-better.' }, { status: 400 });
    }
  }

  // ── Group membership: I'm in it, and every player is a member ───────────────
  const group = await prisma.group.findUnique({
    where: { id: groupId }, select: { id: true, members: { select: { userId: true } } },
  });
  if (!group) return NextResponse.json({ error: 'Group not found' }, { status: 404 });
  const memberSet = new Set(group.members.map(m => m.userId));
  if (!memberSet.has(meId)) return NextResponse.json({ error: 'You are not in this group' }, { status: 403 });
  if (!allIds.every(id => memberSet.has(id))) {
    return NextResponse.json({ error: 'Everyone must be a member of the group' }, { status: 400 });
  }

  // ── Window: today or later (everyone accepts before it runs) ────────────────
  const today = todayUTC();
  if (startDate < today) return NextResponse.json({ error: 'Start date must be today or later' }, { status: 400 });
  const { endDate } = windowBounds(startDate, windowKind);

  // ── Creator antes their wager up front ──────────────────────────────────────
  const wallet = await prisma.coinWallet.upsert({ where: { userId: meId }, create: { userId: meId, balance: 0 }, update: {} });
  if (wallet.balance < wager) {
    return NextResponse.json({ error: `Not enough coins (have ${wallet.balance})` }, { status: 400 });
  }

  let battleId: string;
  try {
    const created = await prisma.$transaction(async tx => {
      // Create the battle FIRST so the creator's ante can carry refId: battle.id —
      // the [walletId, reason, refId] unique constraint needs it. The overdraft
      // throw below still rolls back this create (same transaction).
      const battle = await tx.teamBattle.create({
        data: {
          groupId, creatorId: meId, mode, wager, bestOf, windowKind, startDate, endDate,
          categories, status: 'pending',
          participants: { create: allIds.map(uid => ({ userId: uid, team: teamOf(uid), accepted: uid === meId })) },
        },
        select: { id: true },
      });
      if (wager > 0) {
        const updated = await tx.coinWallet.update({ where: { id: wallet.id }, data: { balance: { decrement: wager } } });
        if (updated.balance < 0) throw new Error('INSUFFICIENT_FUNDS');
        await tx.coinTransaction.create({ data: { walletId: wallet.id, amount: -wager, reason: 'battle_bet', refId: battle.id } });
      }
      return battle;
    });
    battleId = created.id;
  } catch (e) {
    if (e instanceof Error && e.message === 'INSUFFICIENT_FUNDS') {
      return NextResponse.json({ error: 'Not enough coins' }, { status: 400 });
    }
    throw e;
  }

  // Notify everyone else to accept.
  const creator = await prisma.appUser.findUnique({ where: { id: meId }, select: { name: true, username: true } });
  const who = creator?.name ?? creator?.username ?? 'Someone';
  for (const uid of allIds) {
    if (uid === meId) continue;
    sendPushToUser(uid, { title: 'Team battle invite ⚔️', body: `${who} added you to a team battle. Accept to lock it in.`, url: '/app' }).catch(() => {});
  }

  return NextResponse.json({ ok: true, id: battleId });
}
