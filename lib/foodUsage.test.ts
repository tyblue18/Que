/**
 * lib/foodUsage.test.ts
 *
 * Locks the per-serving normalization in recordFood. The meal log stores the
 * CONSUMED TOTAL (per-serving × servings); recents must store PER-SERVING macros
 * so re-adding 1 serving from recents doesn't replay the multi-serving total
 * (the "logged 2 protein bars → recents shows 2 bars for 1" bug).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let store: Record<string, string>;
beforeEach(() => {
  vi.resetModules();
  store = {};
  vi.stubGlobal('localStorage', {
    getItem:    (k: string) => store[k] ?? null,
    setItem:    (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
  vi.stubGlobal('window', {});
});
afterEach(() => { vi.unstubAllGlobals(); });

const load = () => import('@/lib/foodUsage');
// A "protein bar" eaten as 2 servings: the meal entry holds the doubled totals.
const twoBars = {
  name: 'Protein Bar', brand: 'Acme',
  kcal: 400, protein: 40, carbs: 30, fat: 18, // 2× a 200/20/15/9 bar
  servingDesc: '1 bar', servings: 2,
};

describe('recordFood — per-serving normalization', () => {
  it('stores per-serving macros, not the consumed total', async () => {
    const fu = await load();
    fu.recordFood(twoBars);
    const [entry] = fu.getRecent(1);
    expect(entry.kcal).toBe(200);    // 400 / 2
    expect(entry.protein).toBe(20);  // 40 / 2
    expect(entry.carbs).toBe(15);    // 30 / 2
    expect(entry.fat).toBe(9);       // 18 / 2
  });

  it('a 1-serving log is unchanged (divide-by-1)', async () => {
    const fu = await load();
    fu.recordFood({ name: 'Apple', kcal: 95, protein: 0.5, carbs: 25, fat: 0.3, servingDesc: '1 medium', servings: 1 });
    const [e] = fu.getRecent(1);
    expect(e.kcal).toBe(95);
    expect(e.carbs).toBe(25);
  });

  it('guards servings <= 0 (treats as 1, no divide-by-zero)', async () => {
    const fu = await load();
    fu.recordFood({ name: 'Weird', kcal: 100, protein: 10, carbs: 5, fat: 2, servingDesc: 'x', servings: 0 });
    const [e] = fu.getRecent(1);
    expect(e.kcal).toBe(100); // not Infinity/NaN
  });

  it('re-logging the same food bumps count and refreshes per-serving macros', async () => {
    const fu = await load();
    fu.recordFood(twoBars);                 // count 1, per-serving 200
    fu.recordFood({ ...twoBars, servings: 3, kcal: 600, protein: 60, carbs: 45, fat: 27 }); // 3× same bar
    const [e] = fu.getRecent(1);
    expect(e.count).toBe(2);
    expect(e.kcal).toBe(200);  // 600 / 3 — still the per-serving value
    expect(e.protein).toBe(20);
  });
});
