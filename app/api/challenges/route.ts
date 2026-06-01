/**
 * GET  /api/challenges — list incoming, sent, and resolved challenges
 * POST /api/challenges — send a challenge to a friend (deducts the wager
 *   immediately). A wager of 0 is a "bragging rights" battle — no coins move and
 *   no ledger row is written, matching team-battle behaviour.
 */

import { getServerSession } from 'next-auth/next';
import { NextResponse }     from 'next/server';
import { authOptions }      from '@/lib/auth';
import { prisma }           from '@/lib/prisma';
import { sendPushToUser }   from '@/lib/push';
import { challengeLimit }   from '@/lib/ratelimit';
import { challengePostSchema } from '@/lib/validators';
import { debitWalletOrThrow } from '@/lib/walletOps';
import {
  windowBounds, todayUTC, isWindowComplete,
} from '@/lib/battleEngine';
import { getCategory, hasLoggedExercise } from '@/lib/battle-categories';

export async function GET(): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json(null, { status: 401 });

  const me = { id: session.user.id };

  const select = {
    id: true, wager: true, status: true, categories: true,
    winnerId: true, resolvedAt: true, createdAt: true,
    type: true, bestOf: true, windowKind: true,
    startDate: true, endDate: true, resolution: true,
    challenger: { select: { id: true, name: true, username: true } },
    challengee: { select: { id: true, name: true, username: true } },
  };

  const [sent, received] = await Promise.all([
    prisma.challenge.findMany({
      where:   { challengerId: me.id },
      select,
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    prisma.challenge.findMany({
      where:   { challengeeId: me.id },
      select,
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  ]);

  const incoming    = received.filter(c => c.status === 'pending');
  const sentPending = sent.filter(c => c.status === 'pending');
  const active      = [...sent, ...received]
    .filter(c => c.status === 'active')
    .sort((a, b) => (a.endDate ?? '').localeCompare(b.endDate ?? ''));
  const resolved    = [...sent, ...received]
    .filter(c => c.status === 'resolved' || c.status === 'cancelled')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 10);

  return NextResponse.json({ incoming, sent: sentPending, active, resolved });
}

export async function POST(req: Request): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json(null, { status: 401 });

  const { success } = await challengeLimit.limit(session.user.id);
  if (!success) return NextResponse.json({ error: 'Too many challenges — slow down' }, { status: 429 });

  const parsed = challengePostSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'friendId required and wager must be 0–100,000' }, { status: 400 });
  }
  const { friendId, wager, bestOf, windowKind, startDate, categories } = parsed.data;

  const me = { id: session.user.id };

  // ── Verify friendship ──────────────────────────────────────────────────────
  const friendship = await prisma.friendship.findFirst({
    where: {
      status: 'accepted',
      OR: [
        { requesterId: me.id, receiverId: friendId },
        { requesterId: friendId, receiverId: me.id },
      ],
    },
  });
  if (!friendship) return NextResponse.json({ error: 'Not friends' }, { status: 403 });

  // ── Balance check ──────────────────────────────────────────────────────────
  const wallet = await prisma.coinWallet.upsert({
    where:  { userId: me.id },
    create: { userId: me.id, balance: 0 },
    update: {},
  });
  if (wallet.balance < wager) {
    return NextResponse.json({ error: `Not enough coins (have ${wallet.balance})` }, { status: 400 });
  }

  // ── One-active-battle-per-pair rule ────────────────────────────────────────
  // pending OR active counts — block until the existing one resolves/cancels.
  const existing = await prisma.challenge.findFirst({
    where: {
      status: { in: ['pending', 'active'] },
      OR: [
        { challengerId: me.id, challengeeId: friendId },
        { challengerId: friendId, challengeeId: me.id },
      ],
    },
  });
  if (existing) {
    return NextResponse.json({ error: 'You already have a battle in progress with this user' }, { status: 409 });
  }

  // ── Typed-battle validation ────────────────────────────────────────────────
  // If ANY typed field is set we treat this as a typed battle and require ALL
  // typed fields plus a category/bestOf length match. Otherwise fall back to
  // a legacy 'classic' battle (existing badge-count comparison on accept).
  const isTyped = bestOf !== undefined || windowKind !== undefined ||
                  startDate !== undefined || categories !== undefined;

  let typedFields: {
    type: 'typed'; bestOf: number; windowKind: 'day' | '3day' | 'week';
    startDate: string; endDate: string; categories: string[];
  } | null = null;

  if (isTyped) {
    if (bestOf === undefined || windowKind === undefined ||
        startDate === undefined || categories === undefined) {
      return NextResponse.json(
        { error: 'Typed battles need bestOf, windowKind, startDate, and categories' },
        { status: 400 },
      );
    }
    if (categories.length !== bestOf) {
      return NextResponse.json(
        { error: `Pick exactly ${bestOf} category${bestOf === 1 ? '' : ' (best of ' + bestOf + ')'}` },
        { status: 400 },
      );
    }
    // Reject duplicate or unknown categories.
    const seen = new Set<string>();
    for (const slug of categories) {
      if (seen.has(slug)) return NextResponse.json({ error: 'Duplicate category in list' }, { status: 400 });
      seen.add(slug);
      if (!getCategory(slug))  return NextResponse.json({ error: `Unknown category: ${slug}` }, { status: 400 });
    }

    const { endDate } = windowBounds(startDate, windowKind);
    const today       = todayUTC();
    if (endDate < startDate) {
      return NextResponse.json({ error: 'Invalid date window' }, { status: 400 });
    }
    // Hard limit on backdating — no battles older than ~6 months. Prevents
    // gaming and keeps DayRecord scans cheap.
    const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    if (startDate < sixMonthsAgo.toISOString().slice(0, 10)) {
      return NextResponse.json({ error: 'Start date is too far in the past' }, { status: 400 });
    }

    // ── Prereq: only for a FULLY-RETROSPECTIVE window (already over). That guard
    //    stops gaming a past battle whose outcome you can already see. An ongoing
    //    or forward window (e.g. "Next 7 days") builds data DURING the battle, so
    //    requiring logs up front would block two fresh users from ever starting —
    //    exactly the case we want to support, so we skip the check there.
    const windowEnded = isWindowComplete(endDate, today);
    if (windowEnded) {
      const requiresExercise = categories.some(c => getCategory(c)?.requiresExercise);
      if (requiresExercise) {
        const [meRows, friendRows] = await Promise.all([
          loadDayRecords(me.id,    startDate, endDate),
          loadDayRecords(friendId, startDate, endDate),
        ]);
        if (!hasLoggedExercise(meRows)) {
          return NextResponse.json({ error: 'You have no logged exercise in that window' }, { status: 400 });
        }
        if (!hasLoggedExercise(friendRows)) {
          return NextResponse.json({ error: 'Your friend has no logged exercise in that window' }, { status: 400 });
        }
      }
    }

    typedFields = {
      type:       'typed',
      bestOf,
      windowKind,
      startDate,
      endDate,
      categories,
    };
  }

  // ── Create challenge + deduct challenger's wager atomically ────────────────
  let challenge;
  try {
    challenge = await prisma.$transaction(async tx => {
      // Create the challenge FIRST so the ante can carry refId: created.id — the
      // [walletId, reason, refId] unique constraint needs it. The debit's
      // overdraft throw still rolls back this create (same transaction), so no
      // challenge persists for a user who can't afford the wager.
      const created = await tx.challenge.create({
        data: {
          challengerId: me.id,
          challengeeId: friendId,
          wager,
          // Typed battles store the picked slugs; legacy battles store ['all'].
          categories:   typedFields ? typedFields.categories : ['all'],
          status:       'pending',
          ...(typedFields && {
            type:       typedFields.type,
            bestOf:     typedFields.bestOf,
            windowKind: typedFields.windowKind,
            startDate:  typedFields.startDate,
            endDate:    typedFields.endDate,
          }),
        },
      });
      // Bragging-rights battles (wager 0) move no coins and write no ledger row.
      if (wager > 0) {
        await debitWalletOrThrow(tx, wallet.id, wager);
        await tx.coinTransaction.create({
          data: { walletId: wallet.id, amount: -wager, reason: 'battle_bet', refId: created.id },
        });
      }
      return created;
    });
  } catch (e) {
    if (e instanceof Error && e.message === 'INSUFFICIENT_FUNDS') {
      return NextResponse.json({ error: 'Not enough coins' }, { status: 400 });
    }
    throw e;
  }

  const challenger = await prisma.appUser.findUnique({
    where:  { id: me.id },
    select: { name: true, username: true },
  });
  sendPushToUser(friendId, {
    title: 'New challenge!',
    body:  `${challenger?.name ?? challenger?.username ?? 'Someone'} challenged you to a battle`,
    url:   '/',
  }).catch(() => {});

  return NextResponse.json({ ok: true, challengeId: challenge.id });
}

// Loads DayRecord rows for a user across an inclusive date window.
// Mirrors the same untyped escape hatch used elsewhere (see lib/battleEngine.ts).
async function loadDayRecords(userId: string, startDate: string, endDate: string) {
  const rows = await (prisma as unknown as {
    dayRecord: {
      findMany: (args: unknown) => Promise<Array<{ date: string; data: unknown }>>;
    };
  }).dayRecord.findMany({
    where:  { userId, date: { gte: startDate, lte: endDate } },
    select: { date: true, data: true },
  });
  return rows.map(r => ({
    date: r.date,
    data: (r.data ?? {}) as Record<string, unknown>,
  }));
}
