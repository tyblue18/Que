/**
 * lib/lifting/loadDay.ts
 *
 * Builds the ExerciseEntry[] for a program day to drop into a workout log, with
 * each set pre-filled by the progression COACH (what to lift today), not a flat
 * estimate. Extracted so BOTH surfaces that load a program day — the Protocol-tab
 * builder and the calendar's "add today's plan workout" button — produce
 * identical entries from one source, instead of duplicating the mapping (and
 * drifting on the swapped-secondary-muscle handling).
 *
 * Pure: takes the day + the user's log/PRs, returns entries. The caller fires the
 * `que-load-program-day` event and advances the program cursor.
 */

import { SECONDARY_MUSCLES, type ExerciseEntry } from '@/lib/AppContext';
import { progressionAdvice, type LoggedDay } from '@/lib/lifting/progression';
import type { ProgramDay } from '@/lib/lifting/program';

export function buildProgramDayEntries(
  day: ProgramDay,
  localDB: Record<string, LoggedDay>,
  todayStr: string,
  liftPRs: Record<string, number>,
): ExerciseEntry[] {
  return day.exercises.map(ex => {
    // Prefer the program exercise's own secondary muscles (set correctly even for
    // swapped-in / custom variations not in the global SECONDARY_MUSCLES map);
    // fall back to the map otherwise.
    const fallback = SECONDARY_MUSCLES[ex.name] ?? {};
    const g2 = ex.secondary?.[0] ?? fallback.g2;
    const g3 = ex.secondary?.[1] ?? fallback.g3;
    const advice = progressionAdvice(ex, localDB, todayStr, liftPRs);
    const w = advice.targetLb != null ? String(advice.targetLb) : ''; // canonical lb
    return {
      k: 'lift',
      n: ex.name,
      g: ex.group,
      ...(g2 ? { g2 } : {}),
      ...(g3 ? { g3 } : {}),
      sets: Array.from({ length: ex.sets }, () => ({ r: '1', w })),
    };
  });
}

/** Read the lift-PR map from localStorage (shared by both load surfaces). */
export function loadLiftPRs(key: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch { return {}; }
}
