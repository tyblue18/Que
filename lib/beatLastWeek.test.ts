/**
 * lib/beatLastWeek.test.ts
 *
 * Locks the "Beat Last Week" pace comparison — in particular that it races this
 * week against the SAME elapsed portion of last week (not the full week), so a
 * partial week isn't unfairly judged against seven full days.
 */

import { describe, it, expect } from 'vitest';
import type { LocalDB } from '@/lib/AppContext';
import { computeBeatLastWeek } from '@/lib/beatLastWeek';

// 2026-01-05 is a Monday; 2026-01-07 a Wednesday. Weeks start Monday.
const MON = '2026-01-05';
const WED = '2026-01-07';

describe('computeBeatLastWeek', () => {
  it('on Monday, compares today vs the same day last week', () => {
    const db: LocalDB = {
      '2026-01-05': { steps: '5000' },   // this week, day 1
      '2025-12-29': { steps: '3000' },   // last week, day 1 (the prior Monday)
    } as unknown as LocalDB;

    const r = computeBeatLastWeek(db, MON);

    expect(r.daysElapsed).toBe(1);
    expect(r.daysLeft).toBe(6);
    const steps = r.categories.find(c => c.slug === 'cardio.steps')!;
    expect(steps.thisWeek).toBe(5000);
    expect(steps.lastWeek).toBe(3000);
    expect(steps.outcome).toBe('ahead');
    expect(r.ahead).toBe(1);
  });

  it('only counts last week up to the same elapsed day (fair pace)', () => {
    const db: LocalDB = {
      '2026-01-05': { steps: '2000' },   // this week so far (Mon–Wed = 3 days elapsed)
      '2025-12-29': { steps: '1000' },   // last week day 1 — counts
      '2026-01-01': { steps: '99999' },  // last week day 4 — OUTSIDE the 3-day portion, must NOT count
    } as unknown as LocalDB;

    const r = computeBeatLastWeek(db, WED);

    expect(r.daysElapsed).toBe(3);
    const steps = r.categories.find(c => c.slug === 'cardio.steps')!;
    expect(steps.thisWeek).toBe(2000);
    expect(steps.lastWeek).toBe(1000);   // the day-4 spike was excluded
    expect(steps.outcome).toBe('ahead');
  });

  it('hides categories with no data either week, and flags a missing baseline', () => {
    const db: LocalDB = { '2026-01-05': { steps: '4000' } } as unknown as LocalDB;

    const r = computeBeatLastWeek(db, MON);

    expect(r.categories.map(c => c.slug)).toEqual(['cardio.steps']); // run/lift/protein hidden
    expect(r.hasLastWeek).toBe(false);
    expect(r.categories[0].outcome).toBe('ahead'); // logged this week, nothing to beat yet
  });
});
