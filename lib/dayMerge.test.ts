/**
 * lib/dayMerge.test.ts
 *
 * The merge is the data-safety core of an offline-first multi-device app, so the
 * matrix is exhaustive about who-wins. The two most important rows:
 *
 *   1. DIFFERENT fields, same day  → both survive  (the headline bug being fixed)
 *   2. CLEARED field beats stale   → no resurrection (the row that distinguishes
 *      a correct stamp-by-key-presence impl from a stamp-by-truthiness one that
 *      passes every happy-path test — see `stampEditedFields` deletion tests).
 */

import { describe, it, expect } from 'vitest';
import {
  mergeDays, stampEditedFields, sanitizeFieldStamps, resolveIncomingDay,
  type MergeableDay,
} from '@/lib/dayMerge';

const T = {
  early: '2026-03-10T10:00:00.000Z',
  mid:   '2026-03-10T10:30:00.000Z',
  late:  '2026-03-10T11:00:00.000Z',
};
// Build a day with per-field timestamps.
const day = (fields: Record<string, unknown>, times: Record<string, string>, editedAt?: string): MergeableDay =>
  ({ ...fields, _fieldEditedAt: times, ...(editedAt ? { _editedAt: editedAt } : {}) });

describe('mergeDays — the headline cross-field bug', () => {
  it('keeps BOTH a field edited on device A and a different field edited on device B', () => {
    // Phone logged breakfast at 10:00; laptop (stale) set weight at 10:30.
    const phone  = day({ foods: '[breakfast]' },           { foods: T.early });
    const laptop = day({ foods: '[]', weight: '180' },      { foods: T.early, weight: T.mid });
    // Laptop pulls the phone's push: incoming = phone, local = laptop.
    const { merged } = mergeDays(laptop, phone);
    expect(merged.foods).toBe('[breakfast]'); // phone's foods (same time, incoming wins tie)
    expect(merged.weight).toBe('180');        // laptop's weight survives — NOT lost
  });
});

describe('mergeDays — same-field collision', () => {
  it('newer field-edit-time wins', () => {
    const a = day({ weight: '180' }, { weight: T.early });
    const b = day({ weight: '185' }, { weight: T.late });
    expect(mergeDays(a, b).merged.weight).toBe('185'); // b newer
    expect(mergeDays(b, a).merged.weight).toBe('185'); // order-independent
  });

  it('incoming wins an exact tie (cron-write propagation rule)', () => {
    const local    = day({ steps: 100 }, { steps: T.mid });
    const incoming = day({ steps: 9000 }, { steps: T.mid });
    expect(mergeDays(local, incoming).merged.steps).toBe(9000);
  });
});

describe('mergeDays — RESURRECTION guard (the critical row)', () => {
  it('a cleared field (explicit empty, newer) BEATS a stale non-empty value', () => {
    // Phone cleared a mis-logged weight at 10:30 (writes weight: 0, stamped).
    const phoneCleared = day({ weight: 0 }, { weight: T.mid });
    // Laptop still holds the old weight from 10:00.
    const laptopStale  = day({ weight: 180 }, { weight: T.early });
    const { merged } = mergeDays(laptopStale, phoneCleared);
    expect(merged.weight).toBe(0); // the clear wins — weight does NOT come back from the dead
  });

  it('a present empty value is a real value, not "no opinion"', () => {
    // foods explicitly emptied (newer) must beat a stale populated foods.
    const cleared = day({ foods: '[]' },          { foods: T.late });
    const stale   = day({ foods: '[a,b,c]' },     { foods: T.early });
    expect(mergeDays(stale, cleared).merged.foods).toBe('[]');
  });
});

describe('mergeDays — present-on-one-side (absent = no opinion)', () => {
  it('inherits a field only one side has', () => {
    const local    = day({ weight: 180 }, { weight: T.mid });
    const incoming = day({ steps: 5000 }, { steps: T.mid });
    const { merged } = mergeDays(local, incoming);
    expect(merged.weight).toBe(180);
    expect(merged.steps).toBe(5000);
  });
});

describe('mergeDays — legacy days (only whole-day _editedAt, no field map)', () => {
  it('treats a legacy day’s _editedAt as the time for every field it has', () => {
    // Legacy stored day edited at 10:00 (no _fieldEditedAt).
    const legacy = { weight: 180, _editedAt: T.early } as MergeableDay;
    // New client edits weight at 10:30 with a field map.
    const fresh  = day({ weight: 185 }, { weight: T.mid });
    expect(mergeDays(legacy, fresh).merged.weight).toBe(185); // fresh newer than legacy day-time
  });

  it('a legacy day still wins a field whose new edit is OLDER', () => {
    const legacy = { weight: 190, _editedAt: T.late } as MergeableDay;
    const fresh  = day({ weight: 185 }, { weight: T.early });
    // local = fresh (older), incoming = legacy (newer day-time) → legacy wins.
    expect(mergeDays(fresh, legacy).merged.weight).toBe(190);
  });
});

describe('mergeDays — malformed / missing timestamps', () => {
  it('a field with no timestamp loses to one with a real timestamp', () => {
    const noTime = { weight: 1 } as MergeableDay;               // no stamps at all
    const stamped = day({ weight: 2 }, { weight: T.early });
    expect(mergeDays(noTime, stamped).merged.weight).toBe(2);
  });

  it('an unparseable timestamp is treated as time 0 (loses)', () => {
    const bad  = day({ weight: 1 }, { weight: 'not-a-date' });
    const good = day({ weight: 2 }, { weight: T.early });
    expect(mergeDays(bad, good).merged.weight).toBe(2);
  });

  it('never lets _syncedAt leak into the merged data', () => {
    const local    = { weight: 1, _syncedAt: T.early, _fieldEditedAt: { weight: T.mid } } as MergeableDay;
    const incoming = { weight: 2, _syncedAt: T.late, _fieldEditedAt: { weight: T.late } } as MergeableDay;
    const { merged } = mergeDays(local, incoming);
    expect(merged._syncedAt).toBeUndefined();
  });
});

describe('mergeDays — localWonFields (conflict/preservation signal)', () => {
  it('reports a field where local beat incoming', () => {
    const local    = day({ weight: 185 }, { weight: T.late });
    const incoming = day({ weight: 180 }, { weight: T.early });
    const { localWonFields } = mergeDays(local, incoming);
    expect(localWonFields).toContain('weight');
  });

  it('is empty when incoming wins everything (no preservation needed)', () => {
    const local    = day({ weight: 180 }, { weight: T.early });
    const incoming = day({ weight: 185 }, { weight: T.late });
    expect(mergeDays(local, incoming).localWonFields).toEqual([]);
  });
});

describe('mergeDays — _editedAt rollup', () => {
  it('sets whole-day _editedAt to the latest field time', () => {
    const local    = day({ weight: 180 }, { weight: T.early });
    const incoming = day({ steps: 5000 }, { steps: T.late });
    expect(mergeDays(local, incoming).merged._editedAt).toBe(T.late);
  });
});

// ── stampEditedFields: the convention this whole module depends on ───────────
describe('stampEditedFields — stamp by KEY PRESENCE, not truthiness', () => {
  it('stamps every updated key', () => {
    const out = stampEditedFields({ weight: 1, foods: '[]' }, ['weight', 'foods'], T.mid);
    expect(out.weight).toBe(T.mid);
    expect(out.foods).toBe(T.mid);
  });

  it('GUARD: stamps a cleared/falsy field (weight:0, foods:[]) — a truthiness check would SKIP these', () => {
    // This is the test that fails against a stamp-by-truthiness implementation.
    // The keys here are exactly the ones a clear writes (0, '', '[]', false).
    const out = stampEditedFields({ weight: 0, foods: '[]', steps: 0, prBothDay: false }, ['weight', 'foods', 'steps', 'prBothDay'], T.late);
    expect(out.weight).toBe(T.late);   // would be missing if stamped only when truthy
    expect(out.foods).toBe(T.late);
    expect(out.steps).toBe(T.late);
    expect(out.prBothDay).toBe(T.late);
  });

  it('merges into a prior map, overwriting touched keys and keeping untouched ones', () => {
    const prev = { weight: 1, steps: 2, _fieldEditedAt: { weight: T.early, steps: T.early } } as MergeableDay;
    const out  = stampEditedFields(prev, ['weight'], T.late);
    expect(out.weight).toBe(T.late);  // updated
    expect(out.steps).toBe(T.early);  // preserved
  });

  it('never stamps metadata keys as data fields', () => {
    const out = stampEditedFields({ weight: 1 }, ['weight', '_editedAt', '_syncedAt'], T.mid);
    expect(out._editedAt).toBeUndefined();
    expect(out._syncedAt).toBeUndefined();
    expect(out.weight).toBe(T.mid);
  });
});

// ── Case 3: the legacy-transition inheritance bug (backfill-then-stamp) ──────
// The case-3 analogue of the resurrection guard: when a new client edits ONE
// field of a legacy day, the day's OTHER fields must keep their honest original
// time (Monday), NOT inherit the new edit's time — or a fabricated-newer stamp
// silently beats a genuine edit from another device.
describe('stampEditedFields — legacy-transition backfill', () => {
  const MON = '2026-03-09T12:00:00.000Z';
  const WED = '2026-03-11T12:00:00.000Z';

  it('backfills untouched legacy fields from the day _editedAt, not the new edit time', () => {
    // Legacy day: foods + weight, only whole-day _editedAt = Monday.
    const legacy = { foods: '[a]', weight: 180, _editedAt: MON } as MergeableDay;
    const out = stampEditedFields(legacy, ['weight'], WED);
    expect(out.weight).toBe(WED);   // touched → new time
    expect(out.foods).toBe(MON);    // untouched → ORIGINAL time, not Wednesday
  });

  it('END-TO-END: a Tuesday edit on another device beats the once-legacy untouched foods', () => {
    const MON = '2026-03-09T12:00:00.000Z';
    const TUE = '2026-03-10T12:00:00.000Z';
    const WED = '2026-03-11T12:00:00.000Z';
    // Device A: legacy day (Monday), user edits weight Wednesday → backfill-then-stamp.
    const aMap = stampEditedFields({ foods: '[old]', weight: 180, _editedAt: MON }, ['weight'], WED);
    const deviceA: MergeableDay = { foods: '[old]', weight: 190, _editedAt: WED, _fieldEditedAt: aMap };
    // Device B: genuinely edited foods Tuesday.
    const deviceB: MergeableDay = { foods: '[new]', _editedAt: TUE, _fieldEditedAt: { foods: TUE } };
    // Merge B into A: foods Tuesday (B) must beat foods Monday (A's honest backfill).
    const { merged } = mergeDays(deviceA, deviceB);
    expect(merged.foods).toBe('[new]'); // Tuesday wins — would be '[old]' if foods had inherited Wednesday
    expect(merged.weight).toBe(190);    // A's Wednesday weight untouched
  });
});

// ── sanitizeFieldStamps: per-field future-clock guard ────────────────────────
describe('sanitizeFieldStamps — per-field future clamp', () => {
  const NOW = Date.parse('2026-03-10T12:00:00.000Z');
  const TOL = 60_000;

  it('clamps a single future field stamp to now, leaving valid fields intact', () => {
    const future = new Date(NOW + 5 * 60_000).toISOString(); // 5 min ahead
    const valid  = new Date(NOW - 60_000).toISOString();
    const day: MergeableDay = { weight: 1, foods: '[]', _fieldEditedAt: { weight: future, foods: valid } };
    const out = sanitizeFieldStamps(day, NOW, TOL);
    expect(Date.parse(out._fieldEditedAt!.weight)).toBeLessThanOrEqual(NOW + TOL); // clamped
    expect(out._fieldEditedAt!.foods).toBe(valid);                                 // untouched
  });

  it('one skewed field does NOT poison the rest of the push (per-field, not all-or-nothing)', () => {
    const future = new Date(NOW + 10 * 60_000).toISOString();
    const day: MergeableDay = { weight: 1, steps: 5000, _fieldEditedAt: { weight: future, steps: new Date(NOW).toISOString() } };
    const out = sanitizeFieldStamps(day, NOW, TOL);
    expect(out.steps).toBe(5000); // value preserved
    expect(out._fieldEditedAt!.steps).toBeTruthy();
  });

  it('returns the same object when nothing is in the future', () => {
    const day: MergeableDay = { weight: 1, _fieldEditedAt: { weight: new Date(NOW - 1000).toISOString() } };
    expect(sanitizeFieldStamps(day, NOW, TOL)).toBe(day);
  });
});

// ── resolveIncomingDay: server accept = MERGE, never replace (Exposed A) ─────
describe('resolveIncomingDay — merge-on-accept, never clobber untouched stored fields', () => {
  const NOW = Date.parse('2026-03-10T12:00:00.000Z');
  const TOL = 60_000;

  it('CRITICAL: an accepted partial push must NOT wipe a stored field it never mentioned', () => {
    // Server breakfast bug: stored has foods + weight; client pushes only a newer weight.
    const stored: MergeableDay   = { foods: '[breakfast]', weight: 180, _fieldEditedAt: { foods: T.early, weight: T.early } };
    const incoming: MergeableDay = { weight: 185, _fieldEditedAt: { weight: T.late } };
    const { merged } = resolveIncomingDay(stored, incoming, NOW, TOL);
    expect(merged.weight).toBe(185);          // newer push accepted
    expect(merged.foods).toBe('[breakfast]'); // stored field SURVIVES — not clobbered
  });

  it('reports localWonFields when the stored row beats the push on a field (→ client conflict)', () => {
    const stored: MergeableDay   = { weight: 200, _fieldEditedAt: { weight: T.late } };
    const incoming: MergeableDay = { weight: 180, _fieldEditedAt: { weight: T.early } };
    const { merged, localWonFields } = resolveIncomingDay(stored, incoming, NOW, TOL);
    expect(merged.weight).toBe(200);            // stored (newer) kept
    expect(localWonFields).toContain('weight'); // signals a conflict to return
  });

  it('takes the incoming day wholesale when there is no stored row', () => {
    const incoming: MergeableDay = { weight: 180, _fieldEditedAt: { weight: T.mid } };
    const { merged, localWonFields } = resolveIncomingDay(undefined, incoming, NOW, TOL);
    expect(merged.weight).toBe(180);
    expect(localWonFields).toEqual([]);
  });

  it('sanitizes a future-stamped incoming field before merging (no future-clock win)', () => {
    const stored: MergeableDay   = { weight: 180, _fieldEditedAt: { weight: new Date(NOW).toISOString() } };
    // Incoming claims a 10-min-future edit — must be clamped so it can't auto-win.
    const incoming: MergeableDay = { weight: 999, _fieldEditedAt: { weight: new Date(NOW + 600_000).toISOString() } };
    const { merged } = resolveIncomingDay(stored, incoming, NOW, TOL);
    // After clamp to ~now, incoming (now) still >= stored (now) → incoming wins the tie,
    // but it can no longer win by FORGING a far-future time. The guard is that the
    // value is compared at a sane time, not that incoming loses.
    expect(merged.weight).toBe(999);
    expect(Date.parse(merged._fieldEditedAt!.weight)).toBeLessThanOrEqual(NOW + TOL);
  });
});
