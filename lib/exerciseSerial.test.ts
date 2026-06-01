/**
 * lib/exerciseSerial.test.ts
 *
 * Locks the rest-timer "Log set" placeholder-fill rule (and parse/serialize
 * round-trip). The form commits N sets at reps=1; logging a set should FILL the
 * first still-at-1 set, only appending once all are filled — so committing 3
 * sets and logging 3 yields 3 sets, not 6.
 */

import { describe, it, expect } from 'vitest';
import { applyLoggedSet, parseEx, serializeEx } from '@/lib/exerciseSerial';

describe('applyLoggedSet', () => {
  it('fills the first placeholder set (reps still "1") instead of appending', () => {
    const sets = [{ r: '1', w: '135' }, { r: '1', w: '135' }, { r: '1', w: '135' }];
    const out = applyLoggedSet(sets, '8', '135');
    expect(out).toHaveLength(3);                       // no new set
    expect(out[0]).toEqual({ r: '8', w: '135' });      // first placeholder filled
    expect(out[1]).toEqual({ r: '1', w: '135' });      // rest untouched
  });

  it('walks through placeholders set by set', () => {
    let sets = [{ r: '1', w: '100' }, { r: '1', w: '100' }];
    sets = applyLoggedSet(sets, '10', '100');
    sets = applyLoggedSet(sets, '8',  '105');
    expect(sets).toEqual([{ r: '10', w: '100' }, { r: '8', w: '105' }]);
  });

  it('appends once every set is filled', () => {
    const sets = [{ r: '10', w: '100' }, { r: '8', w: '100' }];
    const out = applyLoggedSet(sets, '6', '110');
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ r: '6', w: '110' });
  });

  it('preserves non-placeholder sets and only fills the reps=1 one', () => {
    const sets = [{ r: '12', w: '95' }, { r: '1', w: '95' }];
    const out = applyLoggedSet(sets, '9', '95');
    expect(out).toEqual([{ r: '12', w: '95' }, { r: '9', w: '95' }]);
  });

  it('defaults empty reps to 1 and does not mutate the input', () => {
    const sets = [{ r: '5', w: '50' }];
    const out = applyLoggedSet(sets, '', '60');
    expect(out).toEqual([{ r: '5', w: '50' }, { r: '1', w: '60' }]);
    expect(sets).toEqual([{ r: '5', w: '50' }]); // input untouched
  });
});

describe('parseEx / serializeEx round-trip', () => {
  it('round-trips a serialized exercise list', () => {
    const arr = [{ k: 'lift' as const, n: 'Bench', sets: [{ r: '8', w: '135' }] }];
    expect(parseEx(serializeEx(arr))).toEqual(arr);
  });
  it('empty list serializes to "" and parses back to []', () => {
    expect(serializeEx([])).toBe('');
    expect(parseEx('')).toEqual([]);
  });
});
