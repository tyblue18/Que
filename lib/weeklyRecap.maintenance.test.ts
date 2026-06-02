/**
 * lib/weeklyRecap.maintenance.test.ts
 *
 * Locks the weekly "maintenance recalibration" beat's HONESTY logic — the part
 * that decides 'locked' vs. 'updated' vs. 'steady'. The whole point of the
 * feature is that it doesn't manufacture a weekly "updated!"; these tests prove
 * a stable estimate reads "steady" and only a real delta (or band change) reads
 * "updated". Built so wrong behavior fails (not just passes against current code).
 *
 * weeklyRecap reads localStorage (last estimate) + loadPlan, so we stub window/
 * localStorage and reset the module between tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let store: Record<string, string>;
beforeEach(() => {
  vi.resetModules();
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
  vi.stubGlobal('window', {}); // present → enables the client-only maintenance block
});
afterEach(() => { vi.unstubAllGlobals(); });

const profile = {
  weight: '180', height: '70', age: '29', sex: 'male' as const,
  deficit: '500', activityLevel: '1.55',
};

// Build a localDB ending on a Sunday, with `n` trailing days each carrying a
// weight + intake. Flat weight at `intake` → adaptive maintenance ≈ intake.
function buildDB(sundayStr: string, n: number, intake: number, lbPerDay = 0, startW = 180): Record<string, unknown> {
  const sunday = Date.parse(`${sundayStr}T00:00:00Z`);
  const db: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    const ds = new Date(sunday - i * 86_400_000).toISOString().slice(0, 10);
    db[ds] = { calsEaten: String(intake), weight: (startW + lbPerDay * (n - 1 - i)).toFixed(2), exercises: '' };
  }
  return db;
}

const SUNDAY = '2026-03-29'; // a Sunday

describe('weekly maintenance beat — honest status', () => {
  it('LOCKED when fewer than the unlock threshold of qualifying days', async () => {
    const { computeWeeklyRecap } = await import('@/lib/weeklyRecap');
    const db = buildDB(SUNDAY, 6, 2400); // only 6 qualifying days
    const r = computeWeeklyRecap(db as never, profile as never, SUNDAY);
    expect(r.maintenance?.status).toBe('locked');
    expect(r.maintenance?.qualifyingDays).toBe(6);
    expect(r.maintenance?.estimate).toBeUndefined();
  });

  it('UPDATED on first unlock (no prior baseline stored)', async () => {
    const { computeWeeklyRecap } = await import('@/lib/weeklyRecap');
    const db = buildDB(SUNDAY, 24, 2400);
    const r = computeWeeklyRecap(db as never, profile as never, SUNDAY);
    expect(r.maintenance?.status).toBe('updated'); // no previous → counts as new
    expect(r.maintenance?.estimate).toBeGreaterThan(0);
  });

  it('STEADY when this week matches the stored baseline within threshold', async () => {
    const { computeWeeklyRecap } = await import('@/lib/weeklyRecap');
    const db = buildDB(SUNDAY, 24, 2400);
    // Seed last-shown estimate equal to what this week will produce (~2400, high conf).
    const first = computeWeeklyRecap(db as never, profile as never, SUNDAY);
    expect(first.maintenance?.estimate).toBeDefined(); // assumption: this unlocks
    const baseline = first.maintenance!.estimate!;     // narrowed by the assertion above
    store['queAdaptiveTdeeLast'] = JSON.stringify({
      weekId: '2026-03-22', estimate: baseline, confidence: first.maintenance!.confidence,
    });
    const r = computeWeeklyRecap(db as never, profile as never, SUNDAY);
    expect(r.maintenance?.status).toBe('steady'); // unchanged → NOT a fake "updated"
  });

  it('UPDATED when the estimate moved more than the 50-kcal threshold', async () => {
    const { computeWeeklyRecap } = await import('@/lib/weeklyRecap');
    const db = buildDB(SUNDAY, 24, 2400);
    const cur = computeWeeklyRecap(db as never, profile as never, SUNDAY);
    expect(cur.maintenance?.estimate).toBeDefined();
    const baseline = cur.maintenance!.estimate! - 200; // 200 below current → a real change
    store['queAdaptiveTdeeLast'] = JSON.stringify({
      weekId: '2026-03-22', estimate: baseline, confidence: cur.maintenance!.confidence,
    });
    const r = computeWeeklyRecap(db as never, profile as never, SUNDAY);
    expect(r.maintenance?.status).toBe('updated');
    expect(r.maintenance?.previous).toBe(baseline);
  });

  it('does NOT fire "updated" for a sub-threshold wiggle (the anti-gimmick guard)', async () => {
    const { computeWeeklyRecap } = await import('@/lib/weeklyRecap');
    const db = buildDB(SUNDAY, 24, 2400);
    const cur = computeWeeklyRecap(db as never, profile as never, SUNDAY);
    expect(cur.maintenance?.estimate).toBeDefined();
    const baseline = cur.maintenance!.estimate! - 10; // 10 kcal off (< 50 threshold)
    store['queAdaptiveTdeeLast'] = JSON.stringify({
      weekId: '2026-03-22', estimate: baseline, confidence: cur.maintenance!.confidence,
    });
    const r = computeWeeklyRecap(db as never, profile as never, SUNDAY);
    expect(r.maintenance?.status).toBe('steady'); // 10 kcal is noise, not news
  });

  it('markRecapMaintenanceShown advances the baseline only when called', async () => {
    const { computeWeeklyRecap, markRecapMaintenanceShown } = await import('@/lib/weeklyRecap');
    const db = buildDB(SUNDAY, 24, 2400);
    const r = computeWeeklyRecap(db as never, profile as never, SUNDAY);
    expect(store['queAdaptiveTdeeLast']).toBeUndefined(); // compute alone does NOT write
    markRecapMaintenanceShown(r);
    expect(JSON.parse(store['queAdaptiveTdeeLast']).estimate).toBe(r.maintenance!.estimate);
  });
});
