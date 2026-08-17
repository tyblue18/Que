/**
 * lib/cardioSync.test.ts
 *
 * Locks the single-source-of-truth contract for cardio: the exercises[] array is
 * authoritative and the top-level fields are derived from it. Built so the old
 * bug (cardio written only to top-level fields → invisible on the calendar)
 * would fail: every write goes through the array, and the derived fields match.
 */

import { describe, it, expect } from 'vitest';
import { parseExercises, deriveCardioFields, setCardioOfKind, existingCardioDistance } from '@/lib/cardioSync';
import type { ExerciseEntry, UserProfile } from '@/lib/AppContext';

const profile: UserProfile = {
  weight: '180', height: '70', age: '29', sex: 'male', deficit: '500', activityLevel: '1.55',
} as UserProfile;

describe('parseExercises', () => {
  it('parses JSON arrays and tolerates the legacy newline format + empty', () => {
    expect(parseExercises(JSON.stringify([{ k: 'run', v1: '5' }]))).toEqual([{ k: 'run', v1: '5' }]);
    expect(parseExercises('')).toEqual([]);
    expect(parseExercises('bench\nsquat')).toEqual([{ k: 'text', n: 'bench' }, { k: 'text', n: 'squat' }]);
  });
});

describe('setCardioOfKind — array stays authoritative', () => {
  it('adds a run entry the calendar would see (k:run with distance/time)', () => {
    const next = setCardioOfKind([], 'run', 5, 40);
    const run = next.find(e => e.k === 'run')!;
    expect(run).toBeTruthy();              // detectActivity keys off k==='run'
    expect(run.v1).toBe('5');              // v1 = distance (mi)
    expect(run.v2).toBe('40');             // v2 = time (min)
  });

  it('preserves lifts and OTHER cardio, replaces only the edited kind', () => {
    const start: ExerciseEntry[] = [
      { k: 'lift', n: 'Bench' },
      { k: 'bike', v1: '10', v2: '30' },
      { k: 'run', v1: '3', v2: '25' },
    ];
    const next = setCardioOfKind(start, 'run', 6, 50);
    expect(next.filter(e => e.k === 'lift')).toHaveLength(1);        // lift kept
    expect(next.filter(e => e.k === 'bike')).toHaveLength(1);        // other cardio kept
    expect(next.filter(e => e.k === 'run')).toHaveLength(1);        // collapsed to one
    expect(next.find(e => e.k === 'run')!.v1).toBe('6');
  });

  it('removes the kind entirely when cleared (0/0)', () => {
    const start: ExerciseEntry[] = [{ k: 'run', v1: '5', v2: '40' }, { k: 'lift', n: 'Squat' }];
    const next = setCardioOfKind(start, 'run', 0, 0);
    expect(next.some(e => e.k === 'run')).toBe(false);
    expect(next.some(e => e.k === 'lift')).toBe(true);
  });

  it('swim stores time in v1, distance in v2', () => {
    const next = setCardioOfKind([], 'swim', 0.5, 30);
    const swim = next.find(e => e.k === 'swim')!;
    expect(swim.v1).toBe('30');    // time
    expect(swim.v2).toBe('0.5');   // distance
  });
});

describe('deriveCardioFields — top-level matches the array', () => {
  it('sums per kind and the derived fields equal what was written to the array', () => {
    const entries = setCardioOfKind(setCardioOfKind([], 'run', 5, 40), 'bike', 10, 30);
    const d = deriveCardioFields(entries, profile);
    expect(d.runDist).toBe(5);
    expect(d.runTime).toBe(40);
    expect(d.bikeDist).toBe(10);
    expect(d.bikeTime).toBe(30);
    expect(Number.isFinite(d.burn)).toBe(true);
    expect(d.burn).toBeGreaterThan(0); // a 40-min run + 30-min ride burns something
  });

  it('a cleared kind zeroes its derived fields', () => {
    const entries = setCardioOfKind([{ k: 'run', v1: '5', v2: '40' }], 'run', 0, 0);
    const d = deriveCardioFields(entries, profile);
    expect(d.runDist).toBe(0);
    expect(d.runTime).toBe(0);
  });

  it('preserves measured Garmin calories in burn when editing an imported day', () => {
    // Day imported from Garmin: bike 15mi/62min with MEASURED 465 kcal. The user
    // edits (any cardio write re-derives) — burn must stay 465, not revert to
    // the flat-physics estimate (~260).
    const entries: ExerciseEntry[] = [{ k: 'bike', v1: '15', v2: '62' }];
    const withMeasured = deriveCardioFields(entries, profile, { garminBikeKcal: 465 });
    expect(withMeasured.burn).toBe(465);
    const withoutMeasured = deriveCardioFields(entries, profile);
    expect(withoutMeasured.burn).not.toBe(465); // estimate path still works
  });
});

describe('existingCardioDistance — preserves swim distance on a time-only edit', () => {
  it('reads the swim distance from v2', () => {
    const entries: ExerciseEntry[] = [{ k: 'swim', v1: '30', v2: '0.75' }];
    expect(existingCardioDistance(entries, 'swim')).toBeCloseTo(0.75);
    expect(existingCardioDistance(entries, 'run')).toBe(0);
  });
});
