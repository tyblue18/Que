/**
 * lib/units.test.ts
 *
 * Locks the imperial↔metric conversions. Storage is canonical imperial, so a
 * display→stored→display round-trip must return the user's number unchanged —
 * otherwise a metric user's logged weight would drift every edit.
 */

import { describe, it, expect } from 'vitest';
import {
  kgToLb, lbToKg, kmToMi, miToKm, cmToIn, inToCm,
  fromStoredWeight, toStoredWeight, fromStoredDistance, toStoredDistance,
  fromStoredHeight, toStoredHeight, fmtWeight, fmtDistance, dispWeight,
} from '@/lib/units';

describe('unit conversions', () => {
  it('round-trips weight kg → lb → kg', () => {
    expect(lbToKg(kgToLb(80))).toBeCloseTo(80, 6);
  });
  it('round-trips distance km → mi → km and height cm → in → cm', () => {
    expect(miToKm(kmToMi(10))).toBeCloseTo(10, 6);
    expect(inToCm(cmToIn(178))).toBeCloseTo(178, 6);
  });

  it('uses the standard factors', () => {
    expect(kgToLb(100)).toBeCloseTo(220.462, 2);
    expect(miToKm(1)).toBeCloseTo(1.609344, 6);
    expect(inToCm(1)).toBeCloseTo(2.54, 6);
  });
});

describe('stored ↔ display (metric)', () => {
  it('a typed metric value survives the storage round-trip', () => {
    // user types 82.5 kg → we store lb → we display kg again
    const stored = toStoredWeight(82.5, 'metric');
    expect(fromStoredWeight(stored, 'metric')).toBeCloseTo(82.5, 6);
  });
  it('distance + height round-trip in metric', () => {
    expect(fromStoredDistance(toStoredDistance(8.4, 'metric'), 'metric')).toBeCloseTo(8.4, 6);
    expect(fromStoredHeight(toStoredHeight(178, 'metric'), 'metric')).toBeCloseTo(178, 6);
  });
});

describe('imperial is a pass-through (existing users untouched)', () => {
  it('does not transform imperial values', () => {
    expect(toStoredWeight(185, 'imperial')).toBe(185);
    expect(fromStoredWeight(185, 'imperial')).toBe(185);
    expect(toStoredDistance(5, 'imperial')).toBe(5);
    expect(fromStoredHeight(70, 'imperial')).toBe(70);
  });
});

describe('formatting', () => {
  it('formats weight in the chosen system with the right unit', () => {
    expect(fmtWeight(180, 'imperial')).toBe('180 lb');
    expect(fmtWeight(80, 'metric')).toBe(`${(80 / 2.2046226218).toFixed(1).replace(/\.?0+$/, '')} kg`);
  });
  it('formats distance and trims trailing zeros', () => {
    expect(fmtDistance(5, 'imperial')).toBe('5 mi');
    expect(dispWeight(180, 'imperial')).toBe('180'); // 180.0 → "180"
  });
});
