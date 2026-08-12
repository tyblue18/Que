/**
 * lib/units.test.ts
 *
 * Locks the duration parsing/formatting (h:mm:ss ↔ decimal minutes) and the
 * swim-specific distance units (yards / meters ↔ stored miles) added for the
 * cardio-input overhaul. Storage stays decimal minutes + miles — these are
 * UI-edge conversions only.
 */

import { describe, it, expect } from 'vitest';
import {
  parseDurationToMin, fmtDuration,
  ydToMi, miToYd, mToMi, miToM,
  fromStoredSwimDistance, toStoredSwimDistance, fmtSwimDistance, swimDistanceUnit,
} from '@/lib/units';

describe('parseDurationToMin', () => {
  it('parses h:mm:ss', () => {
    expect(parseDurationToMin('1:02:30')).toBeCloseTo(62.5, 6);
    expect(parseDurationToMin('2:00:00')).toBe(120);
  });
  it('parses mm:ss', () => {
    expect(parseDurationToMin('42:30')).toBeCloseTo(42.5, 6);
    expect(parseDurationToMin('0:45')).toBeCloseTo(0.75, 6);
  });
  it('parses plain minutes (decimals allowed)', () => {
    expect(parseDurationToMin('90')).toBe(90);
    expect(parseDurationToMin('27.5')).toBe(27.5);
  });
  it('rejects garbage, negatives, and out-of-range fields', () => {
    expect(parseDurationToMin('')).toBeNull();
    expect(parseDurationToMin('abc')).toBeNull();
    expect(parseDurationToMin('-5')).toBeNull();
    expect(parseDurationToMin('1:75')).toBeNull();      // 75 s invalid
    expect(parseDurationToMin('1:61:00')).toBeNull();   // 61 min invalid
    expect(parseDurationToMin('1:2:3:4')).toBeNull();   // too many parts
    expect(parseDurationToMin('1::30')).toBeNull();
  });
});

describe('fmtDuration', () => {
  it('formats under an hour as m:ss', () => {
    expect(fmtDuration(27)).toBe('27:00');
    expect(fmtDuration(42.5)).toBe('42:30');
  });
  it('formats an hour+ as h:mm:ss', () => {
    expect(fmtDuration(62.5)).toBe('1:02:30');
    expect(fmtDuration(230)).toBe('3:50:00');
  });
  it('rounds fractional seconds and handles zero', () => {
    expect(fmtDuration(31.9)).toBe('31:54');
    expect(fmtDuration(0)).toBe('0:00');
  });
  it('round-trips through the parser', () => {
    for (const min of [27, 42.5, 62.5, 230, 31.9]) {
      expect(parseDurationToMin(fmtDuration(min))).toBeCloseTo(min, 2);
    }
  });
});

describe('swim distance units', () => {
  it('imperial = yards, metric = meters', () => {
    expect(swimDistanceUnit('imperial')).toBe('yd');
    expect(swimDistanceUnit('metric')).toBe('m');
  });
  it('converts stored miles to pool units and back', () => {
    expect(fromStoredSwimDistance(0.5, 'imperial')).toBeCloseTo(880, 3);   // 0.5 mi = 880 yd
    expect(fromStoredSwimDistance(1, 'metric')).toBeCloseTo(1609.344, 2);
    expect(toStoredSwimDistance(880, 'imperial')).toBeCloseTo(0.5, 6);
    expect(toStoredSwimDistance(1500, 'metric')).toBeCloseTo(0.932, 3);    // 1500 m ≈ 0.932 mi
  });
  it('raw converters are exact inverses', () => {
    expect(ydToMi(miToYd(0.54))).toBeCloseTo(0.54, 10);
    expect(mToMi(miToM(0.54))).toBeCloseTo(0.54, 10);
  });
  it('formats whole pool units', () => {
    expect(fmtSwimDistance(0.54, 'imperial')).toBe('950 yd');
    expect(fmtSwimDistance(0.54, 'metric')).toBe('869 m');
  });
});
