/**
 * lib/leaderboard-season.test.ts
 *
 * Locks the global leaderboard's season window (Monday→Sunday UTC) and its
 * tie-aware ranking, so a refactor can't quietly shift week boundaries or
 * mis-rank tied users.
 */

import { describe, it, expect } from 'vitest';
import { currentSeason, assignRanks } from '@/lib/leaderboard-season';

// 2026-01-05 is a Monday; 2026-01-11 the following Sunday.
const at = (ds: string) => Date.parse(`${ds}T12:00:00Z`);

describe('currentSeason', () => {
  it('starts the week on Monday and ends the following Sunday', () => {
    const s = currentSeason(at('2026-01-07')); // a Wednesday
    expect(s.start).toBe('2026-01-05');
    expect(s.end).toBe('2026-01-11');
  });
  it('reports days left, counting down to 0 on Sunday', () => {
    expect(currentSeason(at('2026-01-05')).daysLeft).toBe(6); // Monday
    expect(currentSeason(at('2026-01-07')).daysLeft).toBe(4); // Wednesday
    expect(currentSeason(at('2026-01-11')).daysLeft).toBe(0); // Sunday
  });
  it('a Sunday still belongs to the week that began the prior Monday', () => {
    const s = currentSeason(at('2026-01-11'));
    expect(s.start).toBe('2026-01-05');
    expect(s.end).toBe('2026-01-11');
  });
});

describe('assignRanks', () => {
  it('ranks 1..n with no ties', () => {
    const r = assignRanks([
      { username: 'a', score: 100 },
      { username: 'b', score: 80 },
      { username: 'c', score: 50 },
    ]);
    expect(r.map(x => x.rank)).toEqual([1, 2, 3]);
  });
  it('shares a rank on ties and skips the next (1, 2, 2, 4)', () => {
    const r = assignRanks([
      { username: 'a', score: 100 },
      { username: 'b', score: 80 },
      { username: 'c', score: 80 },
      { username: 'd', score: 50 },
    ]);
    expect(r.map(x => x.rank)).toEqual([1, 2, 2, 4]);
  });
});
