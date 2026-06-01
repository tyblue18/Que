/**
 * lib/lifting/progression.test.ts
 *
 * Locks the double-progression coach: it reads the most recent logged session
 * of a prescribed lift and decides what to do today —
 *   • every set at/above the top of the range → add load, reset reps
 *   • in range but below the top              → hold load, push reps
 *   • missed the bottom of the range          → hold and rebuild
 *   • never logged                            → start at the PR seed (or prompt)
 * plus the lower-body-gets-a-bigger-jump rule and the most-recent-day lookup.
 */

import { describe, it, expect } from 'vitest';
import { progressionAdvice, lastLoggedSession, type LoggedDay } from '@/lib/lifting/progression';
import type { ProgramExercise } from '@/lib/lifting/program';

const TODAY = '2026-02-01';

// A bench-press prescription: 4 sets, 6–10 reps.
const bench = (over: Partial<ProgramExercise> = {}): ProgramExercise => ({
  name: 'Bench Press', group: 'chest', secondary: ['tricep', 'shoulders'], role: 'compound',
  sets: 4, repLow: 6, repHigh: 10, rirLow: 1, rirHigh: 3, restSec: 150, ...over,
});

// Build a localDB with one prior day logging `name` at the given sets.
const dayWith = (date: string, name: string, sets: Array<{ r: string; w: string }>, group = 'chest'): Record<string, LoggedDay> => ({
  [date]: { exercises: JSON.stringify([{ k: 'lift', n: name, g: group, sets }]) },
});

describe('lastLoggedSession', () => {
  it('returns the most recent day before today with real sets', () => {
    const db: Record<string, LoggedDay> = {
      '2026-01-10': { exercises: JSON.stringify([{ k: 'lift', n: 'Bench Press', sets: [{ r: '8', w: '135' }] }]) },
      '2026-01-20': { exercises: JSON.stringify([{ k: 'lift', n: 'Bench Press', sets: [{ r: '9', w: '140' }] }]) },
    };
    const r = lastLoggedSession(db, 'Bench Press', TODAY);
    expect(r?.date).toBe('2026-01-20');
    expect(r?.sets).toEqual([{ reps: 9, weightLb: 140 }]);
  });

  it('ignores today and future days, and placeholder/empty sets', () => {
    const db: Record<string, LoggedDay> = {
      [TODAY]: { exercises: JSON.stringify([{ k: 'lift', n: 'Bench Press', sets: [{ r: '9', w: '999' }] }]) },
      '2026-03-01': { exercises: JSON.stringify([{ k: 'lift', n: 'Bench Press', sets: [{ r: '5', w: '200' }] }]) },
      '2026-01-15': { exercises: JSON.stringify([{ k: 'lift', n: 'Bench Press', sets: [{ r: '1', w: '' }] }]) }, // placeholder
    };
    expect(lastLoggedSession(db, 'Bench Press', TODAY)).toBeNull();
  });

  it('returns null when the lift was never logged', () => {
    expect(lastLoggedSession(dayWith('2026-01-10', 'Squat', [{ r: '5', w: '225' }]), 'Bench Press', TODAY)).toBeNull();
  });
});

describe('progressionAdvice — double progression', () => {
  it('adds load when every set hit the top of the range', () => {
    const db = dayWith('2026-01-25', 'Bench Press', [{ r: '10', w: '135' }, { r: '10', w: '135' }, { r: '10', w: '135' }]);
    const a = progressionAdvice(bench(), db, TODAY);
    expect(a.action).toBe('add_load');
    expect(a.targetLb).toBe(140);          // +5 lb upper body
    expect(a.targetReps).toBe(6);          // reset to bottom of range
    expect(a.message).toMatch(/140/);
  });

  it('holds load and pushes reps when in range but below the top', () => {
    const db = dayWith('2026-01-25', 'Bench Press', [{ r: '8', w: '135' }, { r: '7', w: '135' }]);
    const a = progressionAdvice(bench(), db, TODAY);
    expect(a.action).toBe('push_reps');
    expect(a.targetLb).toBe(135);
    expect(a.targetReps).toBe(10);
  });

  it('holds and rebuilds when a set missed the bottom of the range', () => {
    const db = dayWith('2026-01-25', 'Bench Press', [{ r: '6', w: '135' }, { r: '4', w: '135' }]);
    const a = progressionAdvice(bench(), db, TODAY);
    expect(a.action).toBe('hold');
    expect(a.targetLb).toBe(135);
  });

  it('uses the heaviest worked weight as the reference (ignores warm-up sets)', () => {
    // ramp: 95×10, 115×10, then top set 135×10 → graduate off 135
    const db = dayWith('2026-01-25', 'Bench Press', [{ r: '10', w: '95' }, { r: '10', w: '115' }, { r: '10', w: '135' }]);
    const a = progressionAdvice(bench(), db, TODAY);
    expect(a.action).toBe('add_load');
    expect(a.last?.weightLb).toBe(135);
    expect(a.targetLb).toBe(140);
  });

  it('gives lower-body lifts a bigger load jump (+10)', () => {
    const db = dayWith('2026-01-25', 'Back Squat', [{ r: '12', w: '225' }], 'quads');
    const squat = bench({ name: 'Back Squat', group: 'quads', repLow: 8, repHigh: 12 });
    const a = progressionAdvice(squat, db, TODAY);
    expect(a.action).toBe('add_load');
    expect(a.targetLb).toBe(235);          // +10 lb lower body
  });
});

describe('progressionAdvice — readiness tilt (sessFeel)', () => {
  // graduated reps (every set at the top) on a day that also carries a feel score
  const dbGraduatedWithFeel = (feel: number): Record<string, LoggedDay> => ({
    '2026-01-25': {
      exercises: JSON.stringify([{ k: 'lift', n: 'Bench Press', g: 'chest', sets: [{ r: '10', w: '135' }, { r: '10', w: '135' }] }]),
      sessFeel: feel,
    },
  });

  it('defers the load increase when the last session felt brutal', () => {
    const a = progressionAdvice(bench(), dbGraduatedWithFeel(3), TODAY); // feel 3 ≤ 4
    expect(a.action).toBe('defer_load');
    expect(a.targetLb).toBe(135);          // hold, don't bump
    expect(a.message).toMatch(/felt rough/i);
  });

  it('adds load normally when the session felt easy', () => {
    const a = progressionAdvice(bench(), dbGraduatedWithFeel(9), TODAY); // feel 9 ≥ 8
    expect(a.action).toBe('add_load');
    expect(a.targetLb).toBe(140);
    expect(a.message).toMatch(/felt easy/i);
  });

  it('adds load normally when no feel was logged (no tilt)', () => {
    const db = dayWith('2026-01-25', 'Bench Press', [{ r: '10', w: '135' }, { r: '10', w: '135' }]);
    const a = progressionAdvice(bench(), db, TODAY);
    expect(a.action).toBe('add_load');
    expect(a.targetLb).toBe(140);
  });
});

describe('progressionAdvice — cold start', () => {
  it('seeds from the PR map when available', () => {
    const a = progressionAdvice(bench(), {}, TODAY, { 'Bench Press': 200 });
    expect(a.action).toBe('start');
    expect(a.targetLb).toBe(145);          // 200 × 0.72 → 144 → round 145
    expect(a.targetReps).toBe(6);
  });

  it('prompts for a first set when there is no PR and no history', () => {
    const a = progressionAdvice(bench(), {}, TODAY, {});
    expect(a.action).toBe('first_time');
    expect(a.targetLb).toBeNull();
    expect(a.message).toMatch(/first set/i);
  });
});
