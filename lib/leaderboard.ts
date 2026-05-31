/**
 * lib/leaderboard.ts
 *
 * Global, seasonal (weekly) leaderboard — a no-friends-needed competitive hook.
 *
 *  • A "season" is an ISO week (Monday→Sunday, UTC). It resets every Monday, so
 *    everyone starts level and there's a fresh race each week.
 *  • Only users who explicitly opted in (AppUser.leaderboardOptIn) are ranked or
 *    shown — opting in is the privacy gate for publishing your weekly stat.
 *  • Scores reuse the real battle-category scorers, so the metric is identical to
 *    what a friend battle would compute. Storage is canonical (steps unitless,
 *    distance miles, lift volume lb), so the board is comparable across users.
 *
 * Computation is on-demand but cached in Redis for 10 min: one query for the
 * opted-in users, one for all their week DayRecords, then group + score + rank.
 * At larger scale this would move to a cron-precomputed table — see README notes.
 */

import { Redis } from '@upstash/redis';
import { prisma } from '@/lib/prisma';
import { getCategory, type DayRow } from '@/lib/battle-categories';
import { currentSeason, assignRanks, type RankedRow } from '@/lib/leaderboard-season';

export { currentSeason, assignRanks } from '@/lib/leaderboard-season';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

/** Categories offered on the global board — all higher-is-better and additive
 *  over a week, so a weekly sum ranks cleanly. */
export const LEADERBOARD_CATEGORIES = [
  { slug: 'cardio.steps',     label: 'Steps',       unit: 'steps' },
  { slug: 'cardio.run_miles', label: 'Run Distance', unit: 'mi'   },
  { slug: 'lift.volume',      label: 'Lift Volume',  unit: 'lb'   },
] as const;
export const DEFAULT_LEADERBOARD_CATEGORY = 'cardio.steps';
export function isLeaderboardCategory(slug: string): boolean {
  return LEADERBOARD_CATEGORIES.some(c => c.slug === slug);
}

export interface LeaderboardEntry { rank: number; username: string; score: number; me: boolean }
export interface LeaderboardResult {
  category:    string;
  seasonStart: string;   // YYYY-MM-DD (Monday)
  seasonEnd:   string;   // YYYY-MM-DD (Sunday)
  daysLeft:    number;   // days remaining in the season (0 on Sunday)
  totalRanked: number;
  top:         LeaderboardEntry[];   // top N
  me:          LeaderboardEntry | null; // requester's row (may be outside top N)
}

const CACHE_TTL_S = 600; // 10 min
const TOP_N       = 50;

/** Load + score + rank every opted-in user for the window. Two DB queries. */
async function rankAll(categorySlug: string, start: string, end: string): Promise<RankedRow[]> {
  const cat = getCategory(categorySlug);
  if (!cat) return [];

  const users = await prisma.appUser.findMany({
    where:  { leaderboardOptIn: true, username: { not: null } },
    select: { id: true, username: true },
  });
  if (users.length === 0) return [];

  const ids  = users.map(u => u.id);
  const rows = await (prisma as unknown as {
    dayRecord: { findMany: (a: unknown) => Promise<Array<{ userId: string; date: string; data: unknown }>> };
  }).dayRecord.findMany({
    where:  { userId: { in: ids }, date: { gte: start, lte: end } },
    select: { userId: true, date: true, data: true },
  });

  const byUser = new Map<string, DayRow[]>();
  for (const r of rows) {
    const arr = byUser.get(r.userId) ?? [];
    arr.push({ date: r.date, data: (r.data ?? {}) as Record<string, unknown> });
    byUser.set(r.userId, arr);
  }

  const ranked: RankedRow[] = [];
  for (const u of users) {
    if (!u.username) continue;
    const score = cat.score(byUser.get(u.id) ?? []);
    if (score === null || score <= 0) continue; // unranked until you log something
    ranked.push({ username: u.username, score: Math.round(score) });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/**
 * Build the leaderboard for a category. `meUsername` is the requester's username
 * ONLY when they're opted in (so their row is findable); pass null otherwise.
 */
export async function getLeaderboard(categorySlug: string, meUsername: string | null): Promise<LeaderboardResult> {
  const slug   = isLeaderboardCategory(categorySlug) ? categorySlug : DEFAULT_LEADERBOARD_CATEGORY;
  const season = currentSeason();
  const key    = `lb:v1:${slug}:${season.start}`;

  let ranked: RankedRow[] | null = null;
  try { ranked = await redis.get<RankedRow[]>(key); } catch { /* cache unavailable — compute */ }
  if (!ranked) {
    ranked = await rankAll(slug, season.start, season.end);
    try { await redis.setex(key, CACHE_TTL_S, JSON.stringify(ranked)); } catch { /* ignore */ }
  }

  const withRank = assignRanks(ranked);
  const top = withRank.slice(0, TOP_N).map(r => ({ rank: r.rank, username: r.username, score: r.score, me: r.username === meUsername }));
  const mine = meUsername ? withRank.find(r => r.username === meUsername) : undefined;

  return {
    category:    slug,
    seasonStart: season.start,
    seasonEnd:   season.end,
    daysLeft:    season.daysLeft,
    totalRanked: ranked.length,
    top,
    me: mine ? { rank: mine.rank, username: mine.username, score: mine.score, me: true } : null,
  };
}
