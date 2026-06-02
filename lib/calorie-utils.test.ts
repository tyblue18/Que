/**
 * lib/calorie-utils.test.ts
 *
 * Locks the shared calorie/coin math — the predicate that decides whether a day
 * earns a coin/badge and counts toward a streak. It runs on BOTH the client UI
 * and the server engines (coinEngine, badgeEngine, weekly-recap), so a drift or
 * regression here silently mis-awards in-app currency. These tests pin the
 * contract, including the plan-aware cut/bulk bands and the legacy-day fallback.
 */

import { describe, it, expect } from 'vitest';
import {
  computeBaseBudget, hitGoal, isGoalDay, dayMaintenanceFromRecord,
  type PlanDirection,
} from '@/lib/calorie-utils';
import type { UserProfile } from '@/lib/AppContext';
import { GOAL_TOLERANCE } from '@/lib/constants';

const profile = (o: Partial<UserProfile> = {}): UserProfile => ({
  weight: '180', height: '70', age: '29', sex: 'male',
  deficit: '500', activityLevel: '1.55', ...o,
});

describe('computeBaseBudget (Mifflin-St Jeor × activity − deficit)', () => {
  it('computes a male budget from the standard inputs', () => {
    // kg=81.65, cm=177.8 → BMR ≈ 10*81.65 + 6.25*177.8 − 5*29 + 5 ≈ 1788
    // × 1.55 ≈ 2772 − 500 deficit ≈ 2272 (allow rounding slack)
    const b = computeBaseBudget(profile());
    expect(b).toBeGreaterThan(2200);
    expect(b).toBeLessThan(2350);
  });

  it('female formula is lower than male for identical inputs (−161 vs +5)', () => {
    expect(computeBaseBudget(profile({ sex: 'female' })))
      .toBeLessThan(computeBaseBudget(profile({ sex: 'male' })));
  });

  it('a bulk (negative deficit) yields a SURPLUS — budget above maintenance', () => {
    const cut  = computeBaseBudget(profile({ deficit: '500'  }));
    const bulk = computeBaseBudget(profile({ deficit: '-500' }));
    expect(bulk).toBe(cut + 1000); // flipping −500→+500 of intake = +1000 swing
  });

  it('never returns negative (clamped at 0)', () => {
    expect(computeBaseBudget(profile({ deficit: '99999' }))).toBe(0);
  });

  it('falls back to safe defaults on blank/garbage inputs', () => {
    const b = computeBaseBudget(profile({ weight: '', height: 'abc', age: '', activityLevel: '' }));
    expect(b).toBeGreaterThan(0);
    expect(Number.isFinite(b)).toBe(true);
  });
});

describe('hitGoal (precise ±100 band)', () => {
  it('true within GOAL_TOLERANCE of budget on either side', () => {
    expect(hitGoal(2000, 2000)).toBe(true);
    expect(hitGoal(2000 + GOAL_TOLERANCE, 2000)).toBe(true);   // edge inclusive
    expect(hitGoal(2000 - GOAL_TOLERANCE, 2000)).toBe(true);
  });
  it('false just outside the band', () => {
    expect(hitGoal(2000 + GOAL_TOLERANCE + 1, 2000)).toBe(false);
    expect(hitGoal(2000 - GOAL_TOLERANCE - 1, 2000)).toBe(false);
  });
  it('false when either side is 0 / missing (no false positive on an empty day)', () => {
    expect(hitGoal(0, 2000)).toBe(false);
    expect(hitGoal(2000, 0)).toBe(false);
    expect(hitGoal(undefined, 2000)).toBe(false);
    expect(hitGoal('2000', '2000')).toBe(true); // string inputs (form values) coerce
  });
});

describe('isGoalDay — plan-aware bands', () => {
  // No plan → falls back to the precise ±100 band.
  it('no plan: uses the ±100 band (ignores maintenance)', () => {
    expect(isGoalDay(2000, 2000, 2800, null)).toBe(true);   // in band
    expect(isGoalDay(1223, 2000, 2800, null)).toBe(false);  // far from budget → NOT a goal
  });

  // Cut: at/below maintenance counts (a real deficit), with a 40%-of-maintenance floor.
  describe('cut', () => {
    const M = 2400; // maintenance
    it('counts a day at or under maintenance', () => {
      expect(isGoalDay(2400, 2000, M, 'cut')).toBe(true);   // exactly maintenance
      expect(isGoalDay(1800, 2000, M, 'cut')).toBe(true);   // comfortably under
    });
    it('does NOT count eating above maintenance (no deficit)', () => {
      expect(isGoalDay(2600, 2000, M, 'cut')).toBe(false);
    });
    it('floors near-zero logs (40% of maintenance) to stop coin farming', () => {
      expect(isGoalDay(M * 0.4, 2000, M, 'cut')).toBe(true);      // at the floor
      expect(isGoalDay(M * 0.4 - 1, 2000, M, 'cut')).toBe(false); // below floor → rejected
    });
  });

  // Bulk: at/above maintenance counts (a real surplus).
  describe('bulk', () => {
    const M = 2400;
    it('counts a day at or above maintenance', () => {
      expect(isGoalDay(2400, 2900, M, 'bulk')).toBe(true);
      expect(isGoalDay(3000, 2900, M, 'bulk')).toBe(true);
    });
    it('does NOT count eating below maintenance (no surplus)', () => {
      expect(isGoalDay(2000, 2900, M, 'bulk')).toBe(false);
    });
  });

  // Legacy days with no stored tdee → maintenance is null → fall back to the band.
  it('falls back to the ±100 band when maintenance is null even on a plan', () => {
    expect(isGoalDay(2000, 2000, null, 'cut')).toBe(true);   // in band
    expect(isGoalDay(1500, 2000, null, 'cut')).toBe(false);  // band miss, no maintenance to use
  });

  it('an unlogged day (0 eaten) is never a goal, regardless of plan', () => {
    for (const d of [null, 'cut', 'bulk'] as PlanDirection[]) {
      expect(isGoalDay(0, 2000, 2400, d)).toBe(false);
    }
  });
});

describe('dayMaintenanceFromRecord', () => {
  it('returns tdee + burn when tdee is present', () => {
    expect(dayMaintenanceFromRecord({ tdee: 2200, burn: 300 })).toBe(2500);
    expect(dayMaintenanceFromRecord({ tdee: '2200', burn: '0' })).toBe(2200);
  });
  it('returns null for a legacy day with no tdee (consumers then use the band)', () => {
    expect(dayMaintenanceFromRecord({ burn: 300 })).toBeNull();
    expect(dayMaintenanceFromRecord({ tdee: 0 })).toBeNull();
    expect(dayMaintenanceFromRecord({})).toBeNull();
  });
});
