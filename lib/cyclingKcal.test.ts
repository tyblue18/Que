/**
 * lib/cyclingKcal.test.ts
 *
 * Locks the flat-ground cycling energy model that replaced the speed→MET band:
 * monotonic in speed, physically plausible magnitudes, and — the whole point —
 * dramatically lower than the old MET estimate for easy/flat riding.
 */

import { describe, it, expect } from 'vitest';
import { cyclingKcalFlat, computeCardioBurn, swimMet } from '@/lib/metricsTypes';
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

describe('computeCardioBurn — measured Garmin calories override', () => {
  const withKcal = (bikeDist: number, bikeTime: number, garminKcal: string) =>
    computeCardioBurn(P80, {
      steps: '0', runDist: '0', runTime: '0',
      bikeDist: String(bikeDist), bikeTime: String(bikeTime), swimTime: '0', garminKcal,
    });

  it('uses the measured active calories as the activity burn (not the estimate)', () => {
    const est = bike(12, 40).activityBurn;              // physics estimate
    const m   = withKcal(12, 40, '465');                // Garmin says 465 active
    expect(m.activityBurn).toBe(465);
    expect(m.activityBurn).not.toBe(est);
  });

  it('legacy day-total scales the per-type breakdown', () => {
    expect(withKcal(12, 40, '465').bikeBurn).toBe(465); // bike-only ⇒ all of it
  });

  it('falls back to the estimate when garminKcal is 0', () => {
    expect(withKcal(12, 40, '0').activityBurn).toBe(bike(12, 40).activityBurn);
  });

  it('PER-TYPE measured calories show each activity its exact Garmin number', () => {
    // A triple day: run + bike + swim, each with its own measured value.
    const m = computeCardioBurn(P80, {
      steps: '0', runDist: '2.3', runTime: '20',
      bikeDist: '15', bikeTime: '62', swimTime: '20',
      garminKcal: '835', garminRunKcal: '221', garminBikeKcal: '465', garminSwimKcal: '149',
    });
    expect(m.runBurn).toBe(221);
    expect(m.bikeBurn).toBe(465);   // the ride's real number — NOT a scaled share
    expect(m.swimBurn).toBe(149);
    expect(m.activityBurn).toBe(835);
  });

  it('mixes measured and estimated per type (only bike measured)', () => {
    const m = computeCardioBurn(P80, {
      steps: '0', runDist: '3', runTime: '25',
      bikeDist: '0', bikeTime: '30', swimTime: '0',
      garminBikeKcal: '184', // indoor ride: no distance, measured calories
    });
    expect(m.bikeBurn).toBe(184);           // measured wins despite no distance
    expect(m.runBurn).toBeGreaterThan(0);   // run still estimated
    expect(m.activityBurn).toBe(m.runBurn + 184);
  });
});

describe('swimMet — pace-derived swim intensity', () => {
  it('falls back to the 7.0 moderate average without a distance', () => {
    expect(swimMet(0, 30)).toBe(7.0);
    expect(swimMet(0.5, 0)).toBe(7.0);
  });

  it('is monotonic in pace and clamped at the anchor ends', () => {
    const easy = swimMet(0.5, 45);   // 880yd in 45min ≈ 19.6 yd/min → clamps to 4.8
    const mod  = swimMet(0.625, 20); // exactly 55 yd/min (~1:49/100yd) → 7.0 anchor
    const fast = swimMet(1.0, 20);   // 88 yd/min → clamps to 9.8
    expect(easy).toBe(4.8);
    expect(mod).toBeCloseTo(7.0, 1);
    expect(fast).toBe(9.8);
    expect(mod).toBeGreaterThan(easy);
    expect(fast).toBeGreaterThan(mod);
  });

  it('interpolates between anchors (no cliff jumps)', () => {
    const met = swimMet(0.568, 20); // ≈ 50 yd/min — halfway between 45 and 55 anchors
    expect(met).toBeGreaterThan(5.8);
    expect(met).toBeLessThan(7.0);
  });

  it('an easy swim now costs less than the old flat model, a hard one more', () => {
    const P = P80;
    const base = { steps: '0', runDist: '0', runTime: '0', bikeDist: '0', bikeTime: '0' };
    const easy = computeCardioBurn(P, { ...base, swimTime: '45', swimDist: '0.5' }).swimBurn;
    const flat = computeCardioBurn(P, { ...base, swimTime: '45' }).swimBurn; // no dist → 7.0
    const hard = computeCardioBurn(P, { ...base, swimTime: '45', swimDist: '1.7' }).swimBurn;
    expect(easy).toBeLessThan(flat);
    expect(hard).toBeGreaterThan(flat);
  });
});
