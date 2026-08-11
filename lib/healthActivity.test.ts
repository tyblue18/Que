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
import { applyActivity, toMiles, FIELD_MAP } from '@/lib/healthActivity';

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
  });

  it('omits garminKcal/burn when no calories are provided (estimate path)', () => {
    const { data } = applyActivity({}, { type: 'run', distanceMi: 3, timeMin: 25 }, NOW);
    expect(data.garminKcal).toBeUndefined();
    expect(data.burn).toBeUndefined();
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

describe('FIELD_MAP', () => {
  it('covers every activity type', () => {
    expect(FIELD_MAP.run).toEqual({ dist: 'runDist', time: 'runTime' });
    expect(FIELD_MAP.bike).toEqual({ dist: 'bikeDist', time: 'bikeTime' });
    expect(FIELD_MAP.swim).toEqual({ dist: 'swimDist', time: 'swimTime' });
  });
});
