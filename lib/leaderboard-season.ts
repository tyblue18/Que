/**
 * lib/leaderboard-season.ts
 *
 * Pure season-window + ranking helpers for the global leaderboard, split out
 * from lib/leaderboard.ts so they can be unit-tested without importing the Redis
 * client (which requires env vars at module load).
 */

export interface RankedRow { username: string; score: number }

function addDaysUTC(ds: string, n: number): string {
  const [y, m, d] = ds.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** The current weekly season (Monday→Sunday, UTC). `nowMs` injectable for tests. */
export function currentSeason(nowMs: number = Date.now()): { start: string; end: string; daysLeft: number } {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const [y, m, d] = today.split('-').map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 0 = Monday … 6 = Sunday
  const start = addDaysUTC(today, -dow);
  return { start, end: addDaysUTC(start, 6), daysLeft: 6 - dow };
}

/**
 * Assign 1-based ranks to a score-descending list, sharing a rank on ties —
 * standard competition ranking (1, 2, 2, 4). Input must be pre-sorted desc.
 */
export function assignRanks(sorted: RankedRow[]): Array<RankedRow & { rank: number }> {
  const out: Array<RankedRow & { rank: number }> = [];
  for (let i = 0; i < sorted.length; i++) {
    const rank = i > 0 && sorted[i].score === sorted[i - 1].score ? out[i - 1].rank : i + 1;
    out.push({ ...sorted[i], rank });
  }
  return out;
}
