/**
 * lib/cyclingKcal.test.ts
 *
 * Locks the flat-ground cycling energy model that replaced the speed→MET band:
 * monotonic in speed, physically plausible magnitudes, and — the whole point —
 * dramatically lower than the old MET estimate for easy/flat riding.
 */

import { describe, it, expect } from 'vitest';
import { cyclingKcalFlat, computeCardioBurn } from '@/lib/metricsTypes';
import type { UserProfile } from '@/lib/AppContext';

const P80: UserProfile = {
  weight: '176', height: '70', age: '29', sex: 'male',
  deficit: '500', activityLevel: '1.55',
};

const bike = (dist: number, time: number) =>
  computeCardioBurn(P80, {
    steps: '0', runDist: '0', runTime: '0',
    bikeDist: String(dist), bikeTime: String(time), swimTime: '0',
  });

describe('cyclingKcalFlat', () => {
  it('is zero for non-positive inputs', () => {
    expect(cyclingKcalFlat(0, 60, 80)).toBe(0);
    expect(cyclingKcalFlat(15, 0, 80)).toBe(0);
  });

  it('increases with speed (aero term dominates)', () => {
    const easy = cyclingKcalFlat(8, 60, 80);
    const mod  = cyclingKcalFlat(14.5, 60, 80);
    const fast = cyclingKcalFlat(20, 60, 80);
    expect(mod).toBeGreaterThan(easy);
    expect(fast).toBeGreaterThan(mod);
  });

  it('gives a physically plausible ~300 kcal/hr at 14.5 mph flat (not ~840)', () => {
    const kcal = cyclingKcalFlat(14.5, 60, 80);
    expect(kcal).toBeGreaterThan(250);
    expect(kcal).toBeLessThan(420);
  });

  it('scales with duration', () => {
    expect(cyclingKcalFlat(16, 60, 80)).toBeCloseTo(cyclingKcalFlat(16, 30, 80) * 2, 3);
  });
});

describe('computeCardioBurn — bike', () => {
  it('reports the average speed', () => {
    expect(bike(14.5, 60).bikeSpeed).toBeCloseTo(14.5, 1);
  });

  it('is far lower than the old 10-MET band for an easy flat hour', () => {
    // Old model: 10 MET ⇒ ~766 kcal net. New physics model should be well under.
    expect(bike(14.5, 60).bikeBurn).toBeLessThan(400);
    expect(bike(14.5, 60).bikeBurn).toBeGreaterThan(150);
  });

  it('a hard fast effort still costs meaningfully more than an easy one', () => {
    expect(bike(21, 60).bikeBurn).toBeGreaterThan(bike(11, 60).bikeBurn);
  });

  it('no bike distance ⇒ no bike burn', () => {
    expect(bike(0, 0).bikeBurn).toBe(0);
  });
});
