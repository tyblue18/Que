/**
 * lib/beatLastWeek.ts
 *
 * "Beat Last Week" — a solo, no-friends-needed competitive on-ramp. It races the
 * current week's numbers against the SAME elapsed portion of last week (a fair
 * pace comparison, not partial-vs-full), reusing the real battle-category
 * scorers so the metrics match what a friend battle would use.
 *
 * Pure + client-safe: battle-categories has no server imports, and this reads
 * straight from localDB. No coins, no DB, no opponent — just a motivating mirror
 * that works on day one.
 */

import {
  getCategory, type CategoryDirection, type DayRow,
} from '@/lib/battle-categories';
import type { LocalDB } from '@/lib/AppContext';

/** Curated, accumulation-style categories that read cleanly as "more is better"
 *  over a partial week. (Weight delta / calorie-band categories don't, so they
 *  are intentionally excluded from the solo race.) */
export const SOLO_CATEGORIES = [
  'cardio.steps',
  'cardio.run_miles',
  'lift.volume',
  'diet.protein',
] as const;

export interface WeekCompare {
  slug:      string;
  label:     string;
  unit:      string;
  direction: CategoryDirection;
  thisWeek:  number | null;
  lastWeek:  number | null;
  outcome:   'ahead' | 'behind' | 'tie' | 'nodata';
}

export interface BeatLastWeek {
  categories:   WeekCompare[];   // only those with data in either week
  ahead:        number;
  behind:       number;
  decided:      number;          // ahead + behind
  daysElapsed:  number;          // 1..7 — days into the current week so far
  daysLeft:     number;          // remaining days in the week (incl. none on day 7)
  hasThisWeek:  boolean;         // any data logged this week
  hasLastWeek:  boolean;         // any data logged in last week's same portion
}

// ── date helpers (UTC math on YYYY-MM-DD, matching the rest of the app) ───────
function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday (weeks start Monday). */
function weekdayMon0(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function rowsInWindow(localDB: LocalDB, start: string, end: string): DayRow[] {
  const out: DayRow[] = [];
  for (const [date, rec] of Object.entries(localDB)) {
    if (date >= start && date <= end) out.push({ date, data: rec as Record<string, unknown> });
  }
  return out;
}

function decide(a: number, b: number, dir: CategoryDirection): 'ahead' | 'behind' | 'tie' {
  if (a === b) return 'tie';
  if (dir === 'higher') return a > b ? 'ahead' : 'behind';
  return a < b ? 'ahead' : 'behind';
}

/**
 * Compare this week's progress to last week's same-elapsed portion.
 * `todayStr` is the app's local today (YYYY-MM-DD).
 */
export function computeBeatLastWeek(localDB: LocalDB, todayStr: string): BeatLastWeek {
  const daysElapsed   = weekdayMon0(todayStr) + 1;            // Mon→1 … Sun→7
  const thisWeekStart = addDays(todayStr, -(daysElapsed - 1));
  const lastWeekStart = addDays(thisWeekStart, -7);
  const lastWeekEnd   = addDays(lastWeekStart, daysElapsed - 1); // same number of days

  const thisRows = rowsInWindow(localDB, thisWeekStart, todayStr);
  const lastRows = rowsInWindow(localDB, lastWeekStart, lastWeekEnd);

  const categories: WeekCompare[] = [];
  let ahead = 0, behind = 0;

  for (const slug of SOLO_CATEGORIES) {
    const cat = getCategory(slug);
    if (!cat) continue;
    const thisWeek = cat.score(thisRows);
    const lastWeek = cat.score(lastRows);

    let outcome: WeekCompare['outcome'];
    if (thisWeek === null && lastWeek === null)      outcome = 'nodata';
    else if (lastWeek === null)                      outcome = 'ahead';   // logged this week, nothing to beat → winning
    else if (thisWeek === null)                      outcome = 'behind';  // last week had it, this week hasn't yet
    else                                             outcome = decide(thisWeek, lastWeek, cat.direction);

    if (outcome === 'nodata') continue;              // hide categories with no data either week
    if (outcome === 'ahead')  ahead++;
    else if (outcome === 'behind') behind++;

    categories.push({ slug, label: cat.label, unit: cat.unit, direction: cat.direction, thisWeek, lastWeek, outcome });
  }

  return {
    categories,
    ahead,
    behind,
    decided:     ahead + behind,
    daysElapsed,
    daysLeft:    7 - daysElapsed,
    hasThisWeek: thisRows.length > 0,
    hasLastWeek: lastRows.length > 0,
  };
}
