/**
 * lib/running/vdot.test.ts
 *
 * Locks the Jack Daniels VDOT math that drives the entire running-plan engine
 * (paces, race predictions). Pure functions, validated against known anchors
 * from Daniels' published tables so a future refactor can't silently shift the
 * formulas. (Tolerances are wide enough to allow rounding, tight enough to catch
 * a real regression — e.g. a flipped coefficient.)
 */

import { describe, it, expect } from 'vitest';
import {
  computeVDOT, predictRaceTime, computeTrainingPaces, vdotFromEasyPace,
  formatPace, formatTime, RACE_METERS,
} from '@/lib/running/vdot';

describe('computeVDOT — known anchors from Daniels tables', () => {
  it('a 20:00 5K is ≈ VDOT 49–50', () => {
    const v = computeVDOT(5000, 20 * 60);
    expect(v).toBeGreaterThan(48);
    expect(v).toBeLessThan(51);
  });

  it('a 25:00 5K is ≈ VDOT 38–40 (slower → lower VDOT)', () => {
    const v = computeVDOT(5000, 25 * 60);
    expect(v).toBeGreaterThan(37);
    expect(v).toBeLessThan(41);
  });

  it('a sub-3hr marathon is ≈ VDOT 53–55', () => {
    const v = computeVDOT(RACE_METERS.marathon, 2 * 3600 + 55 * 60);
    expect(v).toBeGreaterThan(52);
    expect(v).toBeLessThan(56);
  });

  it('faster time on the same distance yields a higher VDOT (monotonic)', () => {
    expect(computeVDOT(5000, 18 * 60)).toBeGreaterThan(computeVDOT(5000, 22 * 60));
  });
});

describe('predictRaceTime — inverse of computeVDOT', () => {
  it('round-trips: predict(VDOT, dist) reproduces the input time', () => {
    const time = 20 * 60;
    const vdot = computeVDOT(5000, time);
    const predicted = predictRaceTime(vdot, 5000);
    expect(Math.abs(predicted - time)).toBeLessThan(2); // within 2s after binary search
  });

  it('longer race predicts a longer finish time at the same fitness', () => {
    const vdot = computeVDOT(5000, 20 * 60);
    expect(predictRaceTime(vdot, RACE_METERS.marathon))
      .toBeGreaterThan(predictRaceTime(vdot, RACE_METERS['10k']));
  });

  it('a VDOT-50 runner finishes a 10K in a plausible ~41–43 min', () => {
    const t = predictRaceTime(50, 10_000);
    expect(t).toBeGreaterThan(40 * 60);
    expect(t).toBeLessThan(44 * 60);
  });
});

describe('computeTrainingPaces — ordering + plausibility', () => {
  it('paces get faster (fewer sec/mile) from easy → marathon → threshold → interval → rep', () => {
    const p = computeTrainingPaces(50);
    expect(p.easyHigh).toBeGreaterThan(p.marathon);   // easy is slower (more sec/mi)
    expect(p.marathon).toBeGreaterThan(p.threshold);
    expect(p.threshold).toBeGreaterThan(p.interval);
    expect(p.interval).toBeGreaterThan(p.repetition); // reps are fastest
    expect(p.easyLow).toBeGreaterThan(p.easyHigh);    // easyLow = slower end of the easy range
  });

  it('a fitter runner (higher VDOT) has faster paces across the board', () => {
    const slow = computeTrainingPaces(40);
    const fast = computeTrainingPaces(55);
    expect(fast.threshold).toBeLessThan(slow.threshold);
    expect(fast.interval).toBeLessThan(slow.interval);
  });
});

describe('vdotFromEasyPace', () => {
  it('a 9:00/mi easy pace infers a reasonable VDOT (~45–55)', () => {
    const v = vdotFromEasyPace(9 * 60);
    expect(v).toBeGreaterThan(40);
    expect(v).toBeLessThan(60);
  });
  it('a faster easy pace infers a higher VDOT', () => {
    expect(vdotFromEasyPace(7 * 60)).toBeGreaterThan(vdotFromEasyPace(10 * 60));
  });
});

describe('formatPace', () => {
  it('formats sec/mile as m:ss', () => {
    expect(formatPace(450, 'mi')).toBe('7:30');   // 450s = 7:30
    expect(formatPace(605, 'mi')).toBe('10:05');  // zero-pads seconds
  });
  it('converts to per-km when units are km (smaller number → faster shown)', () => {
    // 8:00/mi ≈ 4:58/km
    const km = formatPace(480, 'km');
    const [m] = km.split(':').map(Number);
    expect(m).toBe(4);
  });
});

describe('formatTime', () => {
  it('uses h:mm:ss past an hour, m:ss under', () => {
    expect(formatTime(20 * 60)).toBe('20:00');
    expect(formatTime(3 * 3600 + 5 * 60 + 9)).toBe('3:05:09');
    expect(formatTime(65)).toBe('1:05');
  });
});
