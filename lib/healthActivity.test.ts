/**
 * lib/healthActivity.test.ts
 *
 * Locks the pure merge behaviour of the auto-cardio import: correct field
 * mapping per activity type, km→mi conversion, ACCUMULATION of distinct
 * activities in a day, IDEMPOTENT re-sends (same externalId is a no-op), and
 * per-field edit stamps so the sync merge keeps imported values without
 * clobbering unrelated same-day edits.
 */

import { describe, it, expect } from 'vitest';
import { applyActivity, applyWellness, toMiles, FIELD_MAP } from '@/lib/healthActivity';

const NOW = '2026-08-06T12:00:00.000Z';

describe('toMiles', () => {
  it('passes miles through and converts km', () => {
    expect(toMiles(3.1, 'mi')).toBeCloseTo(3.1, 5);
    expect(toMiles(3.1, undefined)).toBeCloseTo(3.1, 5); // default = mi
    expect(toMiles(5, 'km')).toBeCloseTo(3.106855, 5);
  });
});

describe('applyActivity — field mapping', () => {
  it('writes run distance/time to runDist/runTime', () => {
    const { data, changed } = applyActivity({}, { type: 'run', distanceMi: 3.1, timeMin: 27 }, NOW);
    expect(changed).toBe(true);
    expect(data.runDist).toBe(3.1);
    expect(data.runTime).toBe(27);
  });

  it('writes bike distance/time to bikeDist/bikeTime', () => {
    const { data } = applyActivity({}, { type: 'bike', distanceMi: 12, timeMin: 40 }, NOW);
    expect(data.bikeDist).toBe(12);
    expect(data.bikeTime).toBe(40);
  });

  it('writes swim as time-only (no distance field) when no distance given', () => {
    const { data } = applyActivity({}, { type: 'swim', distanceMi: 0, timeMin: 30 }, NOW);
    expect(data.swimTime).toBe(30);
    expect(data.swimDist).toBeUndefined();
    // and only swimTime is stamped
    expect(Object.keys(data._fieldEditedAt ?? {})).toEqual(['swimTime']);
  });

  it('stores swimDist when a swim distance is provided', () => {
    const { data } = applyActivity({}, { type: 'swim', distanceMi: 1.2, timeMin: 40 }, NOW);
    expect(data.swimDist).toBe(1.2);
    expect(data.swimTime).toBe(40);
  });
});

describe('applyActivity — accumulation', () => {
  it('sums distinct activities of the same type in a day', () => {
    const first  = applyActivity({}, { type: 'run', distanceMi: 3, timeMin: 25, externalId: 'a' }, NOW).data;
    const second = applyActivity(first, { type: 'run', distanceMi: 2, timeMin: 18, externalId: 'b' }, NOW).data;
    expect(second.runDist).toBe(5);
    expect(second.runTime).toBe(43);
    expect(second._importedActivityIds).toEqual(['a', 'b']);
  });

  it('rounds distance to 2dp and time to 1dp', () => {
    const { data } = applyActivity({}, { type: 'run', distanceMi: 3.10604, timeMin: 26.98 }, NOW);
    expect(data.runDist).toBe(3.11);
    expect(data.runTime).toBe(27);
  });
});

describe('applyActivity — idempotency', () => {
  it('is a no-op when the same externalId is re-sent', () => {
    const first  = applyActivity({}, { type: 'run', distanceMi: 3, timeMin: 25, externalId: 'dup' }, NOW).data;
    const resend = applyActivity(first, { type: 'run', distanceMi: 3, timeMin: 25, externalId: 'dup' }, NOW);
    expect(resend.changed).toBe(false);
    expect(resend.data).toBe(first);          // unchanged reference
    expect(resend.data.runDist).toBe(3);      // NOT doubled
  });

  it('without an externalId it cannot dedup — accumulates (documented trade-off)', () => {
    const first  = applyActivity({}, { type: 'run', distanceMi: 3, timeMin: 25 }, NOW).data;
    const second = applyActivity(first, { type: 'run', distanceMi: 3, timeMin: 25 }, NOW).data;
    expect(second.runDist).toBe(6);
  });
});

describe('applyActivity — measured calories', () => {
  it('accumulates active calories into garminKcal and sets the persisted burn', () => {
    const first = applyActivity({}, { type: 'bike', distanceMi: 10, timeMin: 40, calories: 465, externalId: 'a' }, NOW).data;
    expect(first.garminKcal).toBe(465);
    expect(first.burn).toBe(465);
    const second = applyActivity(first, { type: 'run', distanceMi: 3, timeMin: 25, calories: 300, externalId: 'b' }, NOW).data;
    expect(second.garminKcal).toBe(765);
    expect(second.burn).toBe(765);
    // Per-type sums so each card can show its own Garmin number.
    expect(second.garminBikeKcal).toBe(465);
    expect(second.garminRunKcal).toBe(300);
  });

  it('supports a distance-less indoor ride (time + calories only)', () => {
    const { data } = applyActivity({}, { type: 'bike', distanceMi: 0, timeMin: 32, calories: 184, externalId: 'indoor' }, NOW);
    expect(data.bikeTime).toBe(32);
    expect(data.bikeDist).toBe(0);
    expect(data.garminBikeKcal).toBe(184);
    expect(data.burn).toBe(184);
  });

  it('omits garminKcal/burn when no calories are provided (estimate path)', () => {
    const { data } = applyActivity({}, { type: 'run', distanceMi: 3, timeMin: 25 }, NOW);
    expect(data.garminKcal).toBeUndefined();
    expect(data.burn).toBeUndefined();
  });

  it('BACKFILLS calories on re-send without double-counting distance/time', () => {
    // First import carried no calories (pre-fix behaviour).
    const first = applyActivity({}, { type: 'bike', distanceMi: 20, timeMin: 60, externalId: 'x' }, NOW).data;
    expect(first.garminKcal).toBeUndefined();
    expect(first.bikeDist).toBe(20);

    // Re-send the SAME activity, now WITH calories → backfill.
    const res = applyActivity(first, { type: 'bike', distanceMi: 20, timeMin: 60, calories: 465, externalId: 'x' }, NOW);
    expect(res.changed).toBe(true);
    expect(res.data.garminKcal).toBe(465);
    expect(res.data.burn).toBe(465);
    expect(res.data.bikeDist).toBe(20);   // NOT doubled
    expect(res.data.bikeTime).toBe(60);

    // Re-send again, identical → true no-op.
    const again = applyActivity(res.data, { type: 'bike', distanceMi: 20, timeMin: 60, calories: 465, externalId: 'x' }, NOW);
    expect(again.changed).toBe(false);
  });

  it('re-send does NOT double distance/time (idempotent aggregates)', () => {
    const first = applyActivity({}, { type: 'bike', distanceMi: 50.24, timeMin: 230, calories: 1331, externalId: 'g' }, NOW).data;
    expect(first.bikeDist).toBe(50.24);
    expect(first.bikeTime).toBe(230);
    expect(first.garminKcal).toBe(1331);
    const second = applyActivity(first, { type: 'bike', distanceMi: 50.24, timeMin: 230, calories: 1331, externalId: 'g' }, NOW);
    expect(second.changed).toBe(false);
    expect(second.data.bikeDist).toBe(50.24); // NOT 100.48
  });

  it('re-send with a corrected value REPLACES (fixes a doubled distance)', () => {
    const doubled = applyActivity({}, { type: 'bike', distanceMi: 100, timeMin: 400, externalId: 'h' }, NOW).data;
    expect(doubled.bikeDist).toBe(100);
    const fixed = applyActivity(doubled, { type: 'bike', distanceMi: 50, timeMin: 200, externalId: 'h' }, NOW).data;
    expect(fixed.bikeDist).toBe(50);   // corrected, not 150
    expect(fixed.bikeTime).toBe(200);
  });

  it('leaves a manually-logged cardio of a different type untouched', () => {
    const existing = { runDist: '5', runTime: '40' }; // manual run
    const { data } = applyActivity(existing, { type: 'bike', distanceMi: 20, timeMin: 60, externalId: 'b1' }, NOW);
    expect(data.runDist).toBe('5');   // manual run survives
    expect(data.bikeDist).toBe(20);
  });
});

describe('applyActivity — schema-evolution resend (the Aug-10 regression)', () => {
  it('an identical resend still writes derived fields the day is missing', () => {
    // A day imported under an OLDER engine: ledger + totals exist, but the
    // later-added per-type kcal fields and exercises mirror do not.
    const legacyDay = {
      _garminActs: { g: { type: 'bike', distMi: 15.02, timeMin: 62, kcal: 465 } },
      _importedActivityIds: ['g'],
      bikeDist: 15.02, bikeTime: 62, garminKcal: 465, burn: 465,
    };
    const res = applyActivity(legacyDay, { type: 'bike', distanceMi: 15.02, timeMin: 62, calories: 465, externalId: 'g' }, NOW);
    expect(res.changed).toBe(true);                 // input unchanged, but derived state incomplete
    expect(res.data.garminBikeKcal).toBe(465);      // newly-added field materializes
    expect(res.data.exercises).toBeTruthy();        // calendar mirror materializes
    // And once complete, a further identical resend IS a no-op.
    const again = applyActivity(res.data, { type: 'bike', distanceMi: 15.02, timeMin: 62, calories: 465, externalId: 'g' }, NOW);
    expect(again.changed).toBe(false);
  });
});

describe('applyActivity — exercises[] mirroring (calendar visibility)', () => {
  it('writes an imported ride into the exercises array with a gid marker', () => {
    const { data } = applyActivity({}, { type: 'bike', distanceMi: 6.47, timeMin: 31.9, calories: 184, externalId: 'g1' }, NOW);
    const ex = JSON.parse(String(data.exercises)) as Array<Record<string, string>>;
    expect(ex).toEqual([{ k: 'bike', v1: '6.47', v2: '31.9', gid: 'g1' }]);
  });

  it('preserves manual entries (lifts + unmarked cardio) and replaces on re-send', () => {
    const existing = { exercises: JSON.stringify([
      { k: 'lift', g: 'Chest', n: 'Bench Press', sets: [{ r: '10', w: '135' }] },
      { k: 'run', v1: '3', v2: '25' }, // manual run — no gid
    ]) };
    const first = applyActivity(existing, { type: 'bike', distanceMi: 20, timeMin: 60, externalId: 'g2' }, NOW).data;
    // Corrected re-send replaces the gid entry rather than appending a second one.
    const second = applyActivity(first, { type: 'bike', distanceMi: 21, timeMin: 62, externalId: 'g2' }, NOW).data;
    const ex = JSON.parse(String(second.exercises)) as Array<Record<string, unknown>>;
    expect(ex).toHaveLength(3);
    expect(ex.filter(e => e.gid)).toHaveLength(1);
    expect(ex.find(e => e.gid)).toMatchObject({ k: 'bike', v1: '21', v2: '62' });
    expect(ex.find(e => e.k === 'lift')).toBeTruthy();
    expect(ex.find(e => e.k === 'run' && !e.gid)).toBeTruthy();
  });

  it('swim entries use the v1=time, v2=dist convention', () => {
    const { data } = applyActivity({}, { type: 'swim', distanceMi: 0.54, timeMin: 19.6, calories: 149, externalId: 'g3' }, NOW);
    const ex = JSON.parse(String(data.exercises)) as Array<Record<string, string>>;
    expect(ex[0]).toEqual({ k: 'swim', v1: '19.6', v2: '0.54', gid: 'g3' });
  });

  it('leaves a legacy newline-text exercises blob untouched', () => {
    const existing = { exercises: 'Bench 3x10\nSquat 5x5' };
    const { data } = applyActivity(existing, { type: 'run', distanceMi: 3, timeMin: 25, externalId: 'g4' }, NOW);
    expect(data.exercises).toBe('Bench 3x10\nSquat 5x5'); // not destroyed
    expect(data.runDist).toBe(3); // top-level fields still written
  });
});

describe('applyActivity — manual-duplicate absorption', () => {
  it('absorbs a hand-logged copy of the same workout and adopts its distance', () => {
    // The Aug-5 scenario: user manually logged an indoor ride (16mi/80min)
    // because sync hadn't run; the import arrives later, time-only (80.1min).
    const existing = { exercises: JSON.stringify([
      { k: 'lift', n: 'Bench', sets: [{ r: '10', w: '135' }] },
      { k: 'bike', v1: '16', v2: '80' },       // manual duplicate
    ]) };
    const { data } = applyActivity(existing, { type: 'bike', distanceMi: 0, timeMin: 80.1, calories: 400, externalId: 'g5' }, NOW);
    const ex = JSON.parse(String(data.exercises)) as Array<Record<string, unknown>>;
    expect(ex).toHaveLength(2);                               // lift + ONE bike (imported)
    expect(ex.filter(e => e.k === 'bike')).toHaveLength(1);
    expect(ex.find(e => e.k === 'bike')).toMatchObject({ gid: 'g5', v1: '16' }); // distance adopted
    expect(data.bikeDist).toBe(16);                            // aggregates use it
    expect(data.garminBikeKcal).toBe(400);
  });

  it('a clearly different manual workout of the same type is kept', () => {
    const existing = { exercises: JSON.stringify([{ k: 'run', v1: '2', v2: '18' }]) };
    const { data } = applyActivity(existing, { type: 'run', distanceMi: 6, timeMin: 55, externalId: 'g6' }, NOW);
    const ex = JSON.parse(String(data.exercises)) as Array<Record<string, unknown>>;
    expect(ex).toHaveLength(2);                                // both survive
    expect(ex.find(e => !e.gid)).toMatchObject({ k: 'run', v2: '18' });
  });

  it('absorbs at most one manual entry per imported activity', () => {
    const existing = { exercises: JSON.stringify([
      { k: 'swim', v1: '20', v2: '0.5' },
      { k: 'swim', v1: '21', v2: '0.5' },
    ]) };
    const { data } = applyActivity(existing, { type: 'swim', distanceMi: 0.5, timeMin: 20, externalId: 'g7' }, NOW);
    const ex = JSON.parse(String(data.exercises)) as Array<Record<string, unknown>>;
    expect(ex.filter(e => e.k === 'swim')).toHaveLength(2);    // one absorbed, one kept
    expect(ex.filter(e => e.k === 'swim' && e.gid)).toHaveLength(1);
  });

  it('a distance-less resend never erases an adopted distance (stable no-op)', () => {
    const existing = { exercises: JSON.stringify([{ k: 'bike', v1: '16', v2: '80' }]) };
    const first = applyActivity(existing, { type: 'bike', distanceMi: 0, timeMin: 80.1, calories: 400, externalId: 'g8' }, NOW).data;
    expect(first.bikeDist).toBe(16);
    const resend = applyActivity(first, { type: 'bike', distanceMi: 0, timeMin: 80.1, calories: 400, externalId: 'g8' }, NOW);
    expect(resend.changed).toBe(false);                        // true no-op
    expect(resend.data.bikeDist).toBe(16);                     // adopted distance stable
  });
});

describe('applyActivity — merge safety', () => {
  it('stamps only the touched fields and preserves unrelated same-day data', () => {
    const existing = { weight: '180', foods: '[]', _editedAt: '2026-08-06T06:00:00.000Z' };
    const { data } = applyActivity(existing, { type: 'run', distanceMi: 3.1, timeMin: 27 }, NOW);
    // unrelated fields survive
    expect(data.weight).toBe('180');
    expect(data.foods).toBe('[]');
    // touched fields get the fresh stamp; backfilled fields keep the day's prior time
    expect(data._fieldEditedAt?.runDist).toBe(NOW);
    expect(data._fieldEditedAt?.runTime).toBe(NOW);
    expect(data._fieldEditedAt?.weight).toBe('2026-08-06T06:00:00.000Z');
    expect(data._editedAt).toBe(NOW);
  });
});

describe('applyWellness', () => {
  it('writes provided metrics, weight as a lb string, and stamps them', () => {
    const { data, changed } = applyWellness({}, {
      steps: 9200, weightLb: 180.44, restingHr: 47.4, hrv: 62, sleepScore: 81, sleepMin: 442, bodyBattery: 88,
    }, NOW);
    expect(changed).toBe(true);
    expect(data.steps).toBe(9200);
    expect(data.weight).toBe('180.4');          // string, matches the manual weigh-in shape
    expect(data.restingHr).toBe(47);
    expect(data.hrv).toBe(62);
    expect(data.sleepScore).toBe(81);
    expect(data.sleepMin).toBe(442);
    expect(data.bodyBattery).toBe(88);
    expect(data._fieldEditedAt?.weight).toBe(NOW);
    expect(data._fieldEditedAt?.hrv).toBe(NOW);
  });

  it('is a no-op when nothing changed (stamps preserved for the merge)', () => {
    const first = applyWellness({}, { steps: 9200, restingHr: 47 }, NOW).data;
    const again = applyWellness(first, { steps: 9200, restingHr: 47 }, '2026-08-06T18:00:00.000Z');
    expect(again.changed).toBe(false);
    expect(again.data).toBe(first);             // unchanged reference, no stamp refresh
  });

  it('updates only the fields that changed and leaves the rest untouched', () => {
    const first = applyWellness({ foods: '[]' }, { steps: 5000, hrv: 60 }, NOW).data;
    const later = applyWellness(first, { steps: 9200, hrv: 60 }, '2026-08-06T18:00:00.000Z').data;
    expect(later.steps).toBe(9200);
    expect(later._fieldEditedAt?.steps).toBe('2026-08-06T18:00:00.000Z');
    expect(later._fieldEditedAt?.hrv).toBe(NOW); // unchanged → original stamp kept
    expect(later.foods).toBe('[]');
  });

  it('ignores absent, zero-steps, and implausible values', () => {
    const { changed } = applyWellness({}, { steps: 0, weightLb: 5 }, NOW);
    expect(changed).toBe(false);
  });
});

describe('FIELD_MAP', () => {
  it('covers every activity type', () => {
    expect(FIELD_MAP.run).toEqual({ dist: 'runDist', time: 'runTime' });
    expect(FIELD_MAP.bike).toEqual({ dist: 'bikeDist', time: 'bikeTime' });
    expect(FIELD_MAP.swim).toEqual({ dist: 'swimDist', time: 'swimTime' });
  });
});
