/**
 * lib/foodUsage.ts — Recent + frequent food tracking
 *
 * Records every food the user adds to a meal so the picker can surface their
 * habitual eats without re-searching USDA every time. Mirrors the
 * exerciseUsage pattern but stores enough payload to recreate the food in
 * one tap (USDA/OFF round-trip not required).
 *
 * Storage budget: cap at 200 entries (LRU eviction by lastUsedAt). Each
 * entry is ~100 bytes → ~20 KB ceiling. Comfortable inside localStorage.
 */

import type { FoodEntry } from '@/lib/AppContext';

const KEY        = 'queFoodUsage';
const MAX_ENTRIES = 200;

export interface FoodUsageEntry {
  /** Composite key (name + brand) — identifies "the same food" across logs. */
  key:         string;
  name:        string;
  brand?:      string;
  kcal:        number;
  protein:     number;
  carbs:       number;
  fat:         number;
  servingDesc: string;
  /** How many times the user has added this food. */
  count:       number;
  /** ms epoch of the most recent add. */
  lastUsedAt:  number;
  /** If the food came from a barcode scan, preserved for the detail sheet. */
  barcode?:    string;
}

/** Hash-style identity. Same food added twice (even with different servings)
 *  collapses to one entry. Lowercase + trim guards against minor formatting. */
function buildKey(name: string, brand?: string): string {
  return `${(name ?? '').trim().toLowerCase()}|${(brand ?? '').trim().toLowerCase()}`;
}

function load(): Record<string, FoodUsageEntry> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function save(map: Record<string, FoodUsageEntry>): void {
  // LRU evict if over cap — drop the oldest lastUsedAt first.
  const entries = Object.values(map);
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    map = Object.fromEntries(entries.slice(0, MAX_ENTRIES).map(e => [e.key, e]));
  }
  try { localStorage.setItem(KEY, JSON.stringify(map)); }
  catch { /* quota exceeded — drop silently */ }
}

/**
 * Record a food the user just added. Called from CalorieTracker.addFood so
 * every successful log (search, scan, my-foods) feeds the recents list.
 */
export function recordFood(
  food: Omit<FoodEntry, 'id' | 'loggedAt' | 'meal'>,
  barcode?: string,
): void {
  if (typeof window === 'undefined') return;
  if (!food.name) return;
  const key = buildKey(food.name, food.brand);
  const map = load();
  const prev = map[key];
  // food.kcal/protein/... arrive ALREADY multiplied by food.servings (the meal
  // log stores the consumed total). Recents must store PER-SERVING macros: the
  // picker re-adds via usageToOFF → perServing, which re-multiplies by the
  // servings the user picks. Storing the total here double-counts (log 2 bars,
  // re-add 1 → shows 2 bars' macros). Divide back out by servings (guard ≤0).
  const per = food.servings && food.servings > 0 ? food.servings : 1;
  map[key] = {
    key,
    name:        food.name,
    brand:       food.brand,
    kcal:        Math.round(food.kcal / per),
    protein:     Math.round((food.protein / per) * 10) / 10,
    carbs:       Math.round((food.carbs   / per) * 10) / 10,
    fat:         Math.round((food.fat     / per) * 10) / 10,
    servingDesc: food.servingDesc,
    count:       (prev?.count ?? 0) + 1,
    lastUsedAt:  Date.now(),
    ...(barcode && { barcode }),
  };
  save(map);
}

/** Top N most-recent (regardless of frequency). */
export function getRecent(n = 12): FoodUsageEntry[] {
  return Object.values(load())
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, n);
}

/** Top N most-used. Ties broken by recency. */
export function getFrequent(n = 12): FoodUsageEntry[] {
  return Object.values(load())
    .sort((a, b) => (b.count - a.count) || (b.lastUsedAt - a.lastUsedAt))
    .slice(0, n);
}

/** Delete a recents entry (e.g. user no longer wants a one-off snack
 *  cluttering their list). */
export function forgetFood(key: string): void {
  if (typeof window === 'undefined') return;
  const map = load();
  if (!map[key]) return;
  delete map[key];
  save(map);
}
