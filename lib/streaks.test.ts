/**
 * lib/streaks.test.ts
 *
 * Locks the rest-aware streak math. The whole feature is "a marked rest day
 * BRIDGES the workout streak instead of breaking it," so these tests are built
 * to FAIL against the old gap-resets logic (each rest-bridging case asserts a
 * number the naive consecutive-workout-days count could not produce).
 */

import { describe, it, expect } from 'vitest';
import { dayStatus, streakEndingAt, maxWorkoutStreak, type StreakDay } from '@/lib/streaks';

const W: StreakDay = { exercises: JSON.stringify([{ k: 'lift', n: 'Bench' }]) };
const R: StreakDay = { restDay: true };
const NONE: StreakDay = { exercises: '' };

/** Build a localDB from a list of statuses on consecutive days ending at `end`. */
function seq(end: string, statuses: StreakDay[]): Record<string, StreakDay> {
  const db: Record<string, StreakDay> = {};
  const n = statuses.length;
  const base = Date.parse(end + 'T00:00:00Z');
  statuses.forEach((s, idx) => {
    // statuses[0] is the EARLIEST day; statuses[n-1] is `end`.
    const ds = new Date(base - (n - 1 - idx) * 86_400_000).toISOString().slice(0, 10);
    db[ds] = s;
  });
  return db;
}

const END = '2026-03-29';

describe('dayStatus', () => {
  it('workout wins even if restDay is also set', () => {
    expect(dayStatus({ exercises: JSON.stringify([{ k: 'lift' }]), restDay: true })).toBe('workout');
  });
  it('rest only when marked and no workout', () => {
    expect(dayStatus({ restDay: true })).toBe('rest');
    expect(dayStatus({ exercises: '[]' })).toBe('none'); // empty array → not a workout
    expect(dayStatus(undefined)).toBe('none');
  });
});

describe('streakEndingAt — rest bridges, monotonic', () => {
  it('counts a plain consecutive workout streak', () => {
    expect(streakEndingAt(seq(END, [W, W, W]), END)).toBe(3);
  });

  it('BRIDGES: W W W R W W W ending on a workout = 7 (old logic would give 3)', () => {
    const db = seq(END, [W, W, W, R, W, W, W]);
    expect(streakEndingAt(db, END)).toBe(7);
  });

  it('a rest day TODAY keeps the streak alive and growing (counts the rest)', () => {
    // 3 workouts then today is rest → 4 (old logic: rest day has no workout → 0)
    const db = seq(END, [W, W, W, R]);
    expect(streakEndingAt(db, END)).toBe(4);
  });

  it('trims LEADING rest (rest before the first workout does not count)', () => {
    // R R W W ending on workout → only W W (+nothing before) = 2
    const db = seq(END, [R, R, W, W]);
    expect(streakEndingAt(db, END)).toBe(2);
  });

  it('an unmarked empty day BREAKS the streak', () => {
    const db = seq(END, [W, W, NONE, W]);
    expect(streakEndingAt(db, END)).toBe(1);
  });

  it('a lone rest day (no workout anywhere in the span) is NOT a streak', () => {
    expect(streakEndingAt(seq(END, [R]), END)).toBe(0);
    expect(streakEndingAt(seq(END, [R, R, R]), END)).toBe(0);
  });

  it('returns 0 when the queried day is neither workout nor rest', () => {
    expect(streakEndingAt(seq(END, [W, W, NONE]), END)).toBe(0);
  });

  it('grows monotonically across a rest day (14 train → rest today → 15)', () => {
    const days = Array.from({ length: 14 }, () => W).concat([R]);
    expect(streakEndingAt(seq(END, days), END)).toBe(15);
  });
});

describe('maxWorkoutStreak — longest in history, trims both ends', () => {
  it('plain run', () => {
    expect(maxWorkoutStreak(seq(END, [W, W, W, W]))).toBe(4);
  });

  it('BRIDGES interior rest: W W W R W W W = 7 (old logic = 3)', () => {
    expect(maxWorkoutStreak(seq(END, [W, W, W, R, W, W, W]))).toBe(7);
  });

  it('trims TRAILING rest of a completed run (rested then quit is not credited)', () => {
    // W W W R R R then a gap → only W W W counts = 3, not 6
    const db = seq(END, [W, W, W, R, R, R]);
    expect(maxWorkoutStreak(db)).toBe(3);
  });

  it('a calendar gap (missing day) breaks the run even without a NONE record', () => {
    const db: Record<string, StreakDay> = {
      '2026-03-20': W, '2026-03-21': W,            // run A = 2
      // 03-22 absent entirely → gap
      '2026-03-23': W, '2026-03-24': W, '2026-03-25': W, // run B = 3
    };
    expect(maxWorkoutStreak(db)).toBe(3);
  });

  it('pure-rest history is 0', () => {
    expect(maxWorkoutStreak(seq(END, [R, R, R]))).toBe(0);
  });

  it('picks the longest of multiple runs', () => {
    const db: Record<string, StreakDay> = {
      ...seq('2026-03-10', [W, W]),               // run of 2
      ...seq('2026-03-29', [W, R, W, R, W]),       // bridged run of 5
    };
    expect(maxWorkoutStreak(db)).toBe(5);
  });

  it('honors a custom isWorkout predicate (lift-only, ignoring cardio)', () => {
    const cardio: StreakDay = { exercises: JSON.stringify([{ k: 'run' }]) };
    const liftOnly = (r: StreakDay | undefined | null) => {
      try { return (JSON.parse(String(r?.exercises ?? '[]')) as Array<{ k?: string }>).some(e => e.k === 'lift'); }
      catch { return false; }
    };
    // cardio day is 'none' under liftOnly → breaks the run: W (cardio) W → max 1
    const db = seq(END, [W, cardio, W]);
    expect(maxWorkoutStreak(db, liftOnly)).toBe(1);
  });
});
