/**
 * lib/exerciseSerial.ts
 *
 * Pure (de)serialization for a day's exercise list. Extracted from WorkoutLogger
 * so the global rest-timer context can append a set straight to the day record
 * with the EXACT same encoding the logger reads back — no format drift between
 * the two writers of `DayRecord.exercises`.
 */

import type { ExerciseEntry } from '@/lib/AppContext';

/** Parse the stored `exercises` blob. Modern rows are a JSON array; very old
 *  rows were newline-separated free text, which we coerce into text entries. */
export function parseEx(raw: string): ExerciseEntry[] {
  if (!raw) return [];
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; }
  catch { return raw.split('\n').filter(l => l.trim()).map(l => ({ k: 'text' as const, n: l })); }
}

/** Serialize back to the stored shape. Empty list → '' so the day reads as blank. */
export function serializeEx(arr: ExerciseEntry[]): string {
  return arr.length ? JSON.stringify(arr) : '';
}

/** Normalize an entry to an array of { reps, weight } sets, expanding the legacy
 *  single-set `s`/`r`/`w` shape when the modern `sets[]` array is absent. */
export function normalizeSets(e: ExerciseEntry): Array<{ r: string; w: string }> {
  if (e.sets && Array.isArray(e.sets)) return e.sets;
  const count = parseInt(String(e.s ?? '1')) || 1;
  return Array.from({ length: count }, () => ({ r: String(e.r ?? '1'), w: String(e.w ?? '') }));
}
