/**
 * GET /api/leaderboard?category=<slug>
 *
 * The global, weekly-seasonal leaderboard. Auth required. Returns the current
 * season's ranked top N for the chosen category plus the requester's own row
 * (if they're opted in and have logged something this week), and whether they're
 * opted in (drives the join CTA). Cached server-side in Redis (10 min).
 */

import { getServerSession } from 'next-auth/next';
import { NextResponse }     from 'next/server';
import { authOptions }      from '@/lib/auth';
import { prisma }           from '@/lib/prisma';
import { leaderboardLimit } from '@/lib/ratelimit';
import {
  getLeaderboard, LEADERBOARD_CATEGORIES, DEFAULT_LEADERBOARD_CATEGORY,
} from '@/lib/leaderboard';

export async function GET(req: Request): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json(null, { status: 401 });

  const { success } = await leaderboardLimit.limit(session.user.id);
  if (!success) return NextResponse.json({ error: 'Slow down' }, { status: 429 });

  const category = new URL(req.url).searchParams.get('category') ?? DEFAULT_LEADERBOARD_CATEGORY;

  const me = await prisma.appUser.findUnique({
    where:  { id: session.user.id },
    select: { username: true, leaderboardOptIn: true },
  });

  // Only pass the username when opted in — the rank lookup should find their row
  // only if they're actually part of the board.
  const result = await getLeaderboard(category, me?.leaderboardOptIn ? (me.username ?? null) : null);

  return NextResponse.json({
    ...result,
    optedIn:    !!me?.leaderboardOptIn,
    categories: LEADERBOARD_CATEGORIES,
  });
}
