/**
 * GET   /api/user  — own profile (id, name, username, status, showcase, badgeCount)
 * PATCH /api/user  — update username | status | showcaseBadges
 */

import { getServerSession } from 'next-auth/next';
import { after, NextResponse } from 'next/server';
import { authOptions }      from '@/lib/auth';
import { prisma }              from '@/lib/prisma';
import { userPatchSchema }     from '@/lib/validators';
import { normalizeBadgeIcons } from '@/lib/badgeEngine';
import { getBattleRecord }     from '@/lib/battleEngine';
import { PROFILE_PHOTO_KEY }   from '@/lib/constants';
import { userLimit }           from '@/lib/ratelimit';

export async function GET(): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json(null, { status: 401 });

  const [user, battleRecord, referralCount] = await Promise.all([
    prisma.appUser.findUnique({
      where:   { id: session.user.id },
      include: { badges: { orderBy: { earnedAt: 'desc' } }, workoutData: { select: { settings: true } }, coinWallet: { select: { balance: true } } },
    }),
    getBattleRecord(session.user.id),
    prisma.coinTransaction.count({ where: { reason: 'referral_sent', wallet: { userId: session.user.id } } }),
  ]);
  if (!user) return NextResponse.json(null, { status: 404 });

  const statusActive = !user.statusExpiresAt || user.statusExpiresAt > new Date();
  if (!statusActive) after(() =>
    prisma.appUser.update({ where: { id: user.id }, data: { status: null, statusExpiresAt: null } }).catch(() => {})
  );
  const settings = (user.workoutData?.settings ?? {}) as Record<string, unknown>;

  return NextResponse.json({
    id:              user.id,
    name:            user.name,
    username:        user.username,
    status:          statusActive ? user.status : null,
    statusExpiresAt: statusActive ? user.statusExpiresAt?.toISOString() ?? null : null,
    showcaseBadges:  (user.showcaseBadges as string[] | null) ?? [],
    leaderboardOptIn: user.leaderboardOptIn,
    badges:          normalizeBadgeIcons(user.badges),
    badgeCount:      user.badges.length,
    profilePhoto:    (settings[PROFILE_PHOTO_KEY] as string | undefined) ?? null,
    coinBalance:     user.coinWallet?.balance ?? 0,
    battleRecord,
    referralCount,
  });
}

export async function PATCH(req: Request): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json(null, { status: 401 });

  const { success } = await userLimit.limit(session.user.id);
  if (!success) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  let raw: unknown;
  try { raw = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const parsed = userPatchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;

  const update: Record<string, unknown> = {};

  // ── Username ──────────────────────────────────────────────────────────────
  if (body.username !== undefined) {
    const username = body.username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      return NextResponse.json({ error: '3–20 chars, letters / numbers / underscores only' }, { status: 400 });
    }
    update.username = username;
  }

  // ── Status ────────────────────────────────────────────────────────────────
  if (body.statusDuration === 'clear') {
    update.status          = null;
    update.statusExpiresAt = null;
  } else if (body.status !== undefined) {
    const text = body.status?.trim().slice(0, 60) ?? '';
    update.status = text || null;
    update.statusExpiresAt = body.statusDuration === '24h'
      ? new Date(Date.now() + 24 * 60 * 60 * 1000)
      : null;
  }

  // ── Showcase ──────────────────────────────────────────────────────────────
  // Filter requested slugs to only those the user has actually earned. Without
  // this, a client could PATCH any badge slug into their showcase via devtools
  // and display badges they never earned.
  if (body.showcaseBadges !== undefined) {
    const requested = body.showcaseBadges.slice(0, 8).filter((s): s is string => typeof s === 'string');
    if (requested.length === 0) {
      update.showcaseBadges = [];
    } else {
      const owned = await prisma.badge.findMany({
        where:  { userId: session.user.id, slug: { in: requested } },
        select: { slug: true },
      });
      const ownedSet = new Set(owned.map(b => b.slug));
      // Preserve user's chosen order; drop any slugs they don't own.
      update.showcaseBadges = requested.filter(s => ownedSet.has(s));
    }
  }

  // ── Leaderboard opt-in ──────────────────────────────────────────────────────
  if (body.leaderboardOptIn !== undefined) {
    update.leaderboardOptIn = body.leaderboardOptIn;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  try {
    await prisma.appUser.update({ where: { id: session.user.id }, data: update });
    return NextResponse.json({ ok: true });
  } catch (e) {
    // P2002 = unique constraint violation (username taken)
    const code = (e as { code?: string }).code;
    return NextResponse.json(
      { error: code === 'P2002' ? 'Username already taken' : 'Update failed' },
      { status: code === 'P2002' ? 409 : 500 },
    );
  }
}
