/**
 * lib/exerciseSerial.ts
 *
 * Pure (de)serialization for a day's exercise list. Extracted from WorkoutLogger
 * so the global rest-timer context can append a set straight to the day record
 * with the EXACT same encoding the logger reads back — no format drift between
 * the two writers of `DayRecord.exercises`.
 */

import type { ExerciseEntry, SetData } from '@/lib/AppContext';

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

/**
 * Apply a set logged from the rest timer to an exercise's set list. The workout
 * form commits N sets at the placeholder reps `1`; the user does each set then
 * logs its real reps as they go — so this OVERWRITES the first set still at the
 * placeholder `1`, and only appends a new set once every set is filled. Pure +
 * non-mutating; shared by WorkoutLogger and the rest-timer context so both write
 * paths behave identically.
 */
export function applyLoggedSet(
  sets: ReadonlyArray<{ r: string; w: string }>,
  reps: string,
  weight: string,
): SetData[] {
  const next: SetData[] = sets.map(s => ({ r: s.r, w: s.w }));
  const logged: SetData = { r: reps || '1', w: weight };
  const placeholder = next.findIndex(s => String(s.r) === '1');
  if (placeholder >= 0) next[placeholder] = logged;
  else next.push(logged);
  return next;
}
