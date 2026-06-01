/**
 * lib/lifting/progression.ts
 *
 * Double-progression COACH for the structured lifting program. The generator
 * (program.ts) prescribes sets × a rep RANGE; this turns that static template
 * into week-over-week guidance by reading what the user actually logged last
 * time and telling them what to do today:
 *
 *   • Hit the top of the rep range on every working set  → ADD LOAD, reset reps
 *     to the bottom of the range (the core double-progression rule).
 *   • Logged in-range but not yet at the top              → KEEP load, push reps.
 *   • Missed the bottom of the range                      → KEEP (or back off)
 *     and rebuild reps before adding weight.
 *   • Never logged before                                 → START at the
 *     PR-derived suggestion (suggestedWorkingLb) or just "log your first set".
 *
 * Pure: takes the program exercise + the user's day history, returns a typed
 * recommendation. No React, no storage — unit-tested in isolation. Weights are
 * canonical lb in and out; the UI converts for display.
 */

import type { ProgramExercise } from '@/lib/lifting/program';
import { suggestedWorkingLb } from '@/lib/lifting/program';

/** Minimal shape of a logged day we read (mirrors DayRecord.exercises JSON). */
export interface LoggedSet  { r: string; w: string }
export interface LoggedExercise {
  k?: string;
  n?: string;
  sets?: LoggedSet[];
  // legacy single-set shape
  s?: string; r?: string; w?: string;
}
export interface LoggedDay { exercises?: string; sessFeel?: number }

// 'defer_load' = reps qualified for a load increase, but the last session felt
// brutal (low sessFeel) so we hold this session and bump next time instead.
export type ProgressionAction = 'add_load' | 'defer_load' | 'push_reps' | 'hold' | 'start' | 'first_time';

export interface ProgressionAdvice {
  action:      ProgressionAction;
  /** Canonical-lb weight to use today (null = unknown / log a first set). */
  targetLb:    number | null;
  /** Reps to aim for on each set today. */
  targetReps:  number;
  /** One-line coaching message, e.g. "Hit 4×8 @ 135 — try 140". */
  message:     string;
  /** Last session, when one exists, for the "last time" line. */
  last?:       { weightLb: number; reps: number[]; date: string };
}

// Readiness thresholds on the 1–10 sessFeel scale. [heuristic] — tuned, not
// from a paper; the sensible knobs to turn if the tilt fires too eagerly.
const FEEL_LOW  = 4;  // ≤ this = "felt brutal" → defer a planned load increase
const FEEL_HIGH = 8;  // ≥ this = "felt easy"   → green-light (no change to logic, just messaging)

// Load jumps (lb) when graduating to the next weight. Lower body tolerates
// bigger jumps than upper body / isolation.
const UPPER_STEP = 5;
const LOWER_STEP = 10;
const LOWER_GROUPS = new Set(['quads', 'hamstring', 'glutes', 'calfs', 'adductors']);

function loadStep(group: string): number {
  return LOWER_GROUPS.has(group) ? LOWER_STEP : UPPER_STEP;
}

/** Parse a stored day's exercises blob into typed entries (defensive). */
function parseDayExercises(raw: string | undefined): LoggedExercise[] {
  if (!raw) return [];
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p as LoggedExercise[] : []; }
  catch { return []; }
}

/** Expand an entry to its set list (handles legacy single-set shape). */
function setsOf(e: LoggedExercise): LoggedSet[] {
  if (Array.isArray(e.sets) && e.sets.length) return e.sets;
  const count = parseInt(String(e.s ?? '1')) || 1;
  return Array.from({ length: count }, () => ({ r: String(e.r ?? ''), w: String(e.w ?? '') }));
}

/**
 * Find the most recent day (before `todayStr`, ascending dates) on which the
 * user logged a lift named `name` with at least one real set (a weight and
 * reps). Returns the parsed sets + the date, or null.
 */
export function lastLoggedSession(
  localDB: Record<string, LoggedDay>,
  name: string,
  todayStr: string,
): { date: string; sets: Array<{ reps: number; weightLb: number }> } | null {
  const dates = Object.keys(localDB).filter(d => d < todayStr).sort().reverse();
  for (const date of dates) {
    const entries = parseDayExercises(localDB[date]?.exercises);
    const match = entries.find(e => e.k === 'lift' && e.n === name);
    if (!match) continue;
    const sets = setsOf(match)
      .map(s => ({ reps: parseInt(String(s.r)) || 0, weightLb: parseFloat(String(s.w)) || 0 }))
      .filter(s => s.weightLb > 0 && s.reps > 0);
    if (sets.length) return { date, sets };
  }
  return null;
}

/**
 * The coach. Given a prescribed exercise, the user's log, today's date, and
 * their PR map (for a cold-start suggestion), return what to do today.
 */
export function progressionAdvice(
  ex: ProgramExercise,
  localDB: Record<string, LoggedDay>,
  todayStr: string,
  liftPRs: Record<string, number> = {},
): ProgressionAdvice {
  const last = lastLoggedSession(localDB, ex.name, todayStr);

  // ── Cold start: never logged this lift ──────────────────────────────────────
  if (!last) {
    const seed = suggestedWorkingLb(liftPRs[ex.name], 'hypertrophy'); // goal-neutral seed
    return seed != null
      ? { action: 'start', targetLb: seed, targetReps: ex.repLow,
          message: `Start around ${seed} lb · aim for ${ex.repLow}-${ex.repHigh} reps` }
      : { action: 'first_time', targetLb: null, targetReps: ex.repLow,
          message: `Log your first set — find a weight you can do for ${ex.repLow}-${ex.repHigh}` };
  }

  // Use the heaviest weight worked last time as the reference, and how the reps
  // landed AT that weight (people ramp; the top working weight is what matters).
  const topWeight = Math.max(...last.sets.map(s => s.weightLb));
  const atTop     = last.sets.filter(s => s.weightLb === topWeight);
  const reps      = atTop.map(s => s.reps);
  const lastInfo  = { weightLb: topWeight, reps, date: last.date };

  const everySetHitTop = atTop.length >= 1 && reps.every(r => r >= ex.repHigh);
  const missedBottom   = reps.some(r => r < ex.repLow);

  // Readiness: how the last session FELT (sessFeel 1–10, logged in the check-in).
  // 0 / undefined = not logged → no tilt.
  const feel = Number(localDB[last.date]?.sessFeel) || 0;

  // ── Graduated: every set at/above the top of the range → add load ───────────
  if (everySetHitTop) {
    const next = topWeight + loadStep(ex.group);
    // Readiness tilt: reps earned the increase, but if the last session felt
    // brutal, hold today and bump next time — don't add load onto a bad week.
    if (feel > 0 && feel <= FEEL_LOW) {
      return {
        action: 'defer_load', targetLb: topWeight, targetReps: ex.repHigh, last: lastInfo,
        message: `Earned ${next} lb, but last session felt rough — repeat ${topWeight} lb, then go up`,
      };
    }
    const easy = feel >= FEEL_HIGH ? ' (felt easy)' : '';
    return {
      action: 'add_load', targetLb: next, targetReps: ex.repLow, last: lastInfo,
      message: `Hit ${reps.length}×${ex.repHigh}+ @ ${topWeight} lb${easy} — go up to ${next} lb`,
    };
  }

  // ── Missed the bottom of the range → hold and rebuild ───────────────────────
  if (missedBottom) {
    return {
      action: 'hold', targetLb: topWeight, targetReps: ex.repHigh, last: lastInfo,
      message: `Stay at ${topWeight} lb — build back to ${ex.repHigh} reps on every set`,
    };
  }

  // ── In range, not yet at the top → keep load, push reps ─────────────────────
  return {
    action: 'push_reps', targetLb: topWeight, targetReps: ex.repHigh, last: lastInfo,
    message: `Keep ${topWeight} lb — push toward ${ex.repHigh} reps`,
  };
}
