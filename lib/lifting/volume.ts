/**
 * lib/lifting/volume.ts
 *
 * VOLUME progression — the mesocycle layer on top of the static generator.
 *
 * Volume (sets per muscle per week) is the primary hypertrophy driver, but the
 * generator sets it once by experience and never moves it. The evidence-based
 * model is MEV → MAV → MRV: start near the Minimum Effective Volume, add ~1 set
 * per exercise each week toward the Maximum Adaptive Volume, then DELOAD to
 * maintenance and start the next mesocycle. Ramping volume across a block beats
 * sitting at high volume constantly, and starting at the ceiling leaves nowhere
 * to progress but down.
 *
 * This file is pure + calendar-driven: the current week is DERIVED from
 * `mesoStartDate` (no per-week writes needed), so the same program object yields
 * the right prescription whenever it's read. The generator's per-exercise set
 * count is treated as the WEEK-1 baseline; each ramp week adds sets on top.
 *
 * ── Landmarks are STARTING ESTIMATES ───────────────────────────────────────
 * The MEV/MAV/MRV numbers are population averages (largely young men) and are
 * truly individual — findable only from a user's own logged response over a few
 * mesocycles. We use them to COLOR the volume readout and warn near the ceiling,
 * not as hard rules. Same closed-loop philosophy as the load coach.
 */

import type { LiftingProgram, ProgramDay, LiftGoal } from '@/lib/lifting/program';
import { computeWeeklyVolume } from '@/lib/lifting/program';
import { progressionAdvice, type LoggedDay } from '@/lib/lifting/progression';
import { computeReadiness } from '@/lib/readiness';

export const DEFAULT_MESO_WEEKS = 5; // 4 ramp weeks + 1 deload

/** Per-muscle weekly-set landmarks (fractional sets). Starting estimates. */
export interface Landmark { mev: number; mav: number; mrv: number }
export const VOLUME_LANDMARKS: Record<string, Landmark> = {
  chest:     { mev: 10, mav: 18, mrv: 22 },
  back:      { mev: 10, mav: 20, mrv: 25 },
  shoulders: { mev: 8,  mav: 20, mrv: 26 },
  tricep:    { mev: 6,  mav: 14, mrv: 18 },
  bicep:     { mev: 8,  mav: 18, mrv: 24 },
  forearms:  { mev: 2,  mav: 10, mrv: 16 },
  abs:       { mev: 0,  mav: 20, mrv: 25 },
  quads:     { mev: 8,  mav: 16, mrv: 20 },
  hamstring: { mev: 6,  mav: 14, mrv: 20 },
  glutes:    { mev: 4,  mav: 12, mrv: 16 },
  calfs:     { mev: 8,  mav: 14, mrv: 20 },
  adductors: { mev: 0,  mav: 8,  mrv: 12 },
};

const FALLBACK_LANDMARK: Landmark = { mev: 6, mav: 14, mrv: 20 };
export function landmarkFor(muscle: string): Landmark {
  return VOLUME_LANDMARKS[muscle] ?? FALLBACK_LANDMARK;
}

export type VolumeBand = 'below' | 'building' | 'optimal' | 'over';
/** Where a muscle's CURRENT weekly volume sits relative to its landmarks. */
export function volumeBand(muscle: string, sets: number): VolumeBand {
  const { mev, mav, mrv } = landmarkFor(muscle);
  if (sets < mev) return 'below';      // under the growth threshold
  if (sets <= mav) return 'building';  // productive ramp zone
  if (sets <= mrv) return 'optimal';   // high but recoverable
  return 'over';                       // past the ceiling — back off / deload
}

// ── Mesocycle state ──────────────────────────────────────────────────────────

export interface MesoState {
  week:       number;   // 1-based week within the mesocycle (clamped to totalWeeks)
  totalWeeks: number;
  isDeload:   boolean;  // the final week of the block
  complete:   boolean;  // elapsed beyond the block → time to start a new meso
  addSets:    number;   // sets added per exercise this week (ramp weeks only)
  label:      string;   // human phase label
}

const DAY_MS = 86_400_000;
function daysBetween(fromStr: string, toStr: string): number {
  const a = Date.parse(`${fromStr}T00:00:00Z`);
  const b = Date.parse(`${toStr}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / DAY_MS);
}

/** Resolve the mesocycle anchor + length, defaulting for pre-meso programs. */
function mesoConfig(program: LiftingProgram): { start: string; weeks: number } {
  return {
    start: program.mesoStartDate ?? program.createdAt,
    weeks: program.mesoWeeks ?? DEFAULT_MESO_WEEKS,
  };
}

/** Which week of the current mesocycle today falls in, and the phase. */
export function currentMeso(program: LiftingProgram, todayStr: string): MesoState {
  const { start, weeks } = mesoConfig(program);
  const elapsedWeeks = Math.max(0, Math.floor(daysBetween(start, todayStr) / 7));
  const rawWeek = elapsedWeeks + 1;
  const complete = rawWeek > weeks;
  const week = Math.min(rawWeek, weeks);
  const isDeload = week === weeks;
  // Ramp weeks are 1..(weeks-1); week 1 adds 0, week 2 adds 1, …
  const addSets = isDeload ? 0 : week - 1;
  const label = complete
    ? 'Mesocycle complete — start a new block'
    : isDeload
      ? 'Deload week — recover, then start a new block'
      : week === 1
        ? 'Week 1 — base volume'
        : `Week ${week} — building volume (+${addSets} set${addSets === 1 ? '' : 's'}/exercise)`;
  return { week, totalWeeks: weeks, isDeload, complete, addSets, label };
}

/** This week's set count for an exercise whose week-1 baseline is `baselineSets`. */
export function weekAdjustedSets(baselineSets: number, state: MesoState): number {
  if (state.isDeload || state.complete) return Math.max(1, Math.round(baselineSets / 2));
  return baselineSets + state.addSets;
}

/** Apply the week's volume to every exercise — returns days with set counts
 *  adjusted for the current mesocycle week (baseline + ramp, or deload). */
export function weekAdjustedDays(program: LiftingProgram, todayStr: string): ProgramDay[] {
  const state = currentMeso(program, todayStr);
  return program.days.map(day => ({
    ...day,
    exercises: day.exercises.map(ex => ({ ...ex, sets: weekAdjustedSets(ex.sets, state) })),
  }));
}

/** Current-week fractional weekly volume per muscle (post-ramp). */
export function currentWeeklyVolume(program: LiftingProgram, todayStr: string): Record<string, number> {
  return computeWeeklyVolume(weekAdjustedDays(program, todayStr));
}

// ── Autoregulated deload signal ──────────────────────────────────────────────

export interface DeloadSignal {
  due:        boolean;      // fatigue markers say back off → likely at/over MRV
  missed:     number;       // distinct program lifts that regressed this week
  lifts:      string[];     // which ones (for the message)
  lowFeel:    boolean;      // 2nd marker: recent sessions felt rough (low sessFeel)
  avgFeel:    number | null;// mean recent sessFeel (null = none logged)
  /** 3rd marker: OBJECTIVE recovery (imported Garmin HRV/RHR/sleep) is low —
   *  lib/readiness tier 'low'. false when no wellness data is linked. */
  lowRecovery: boolean;
  recoveryScore: number | null; // 0–100 readiness score (null = no wellness data)
}

// A recent mean sessFeel at/below this is the "subjective fatigue" marker.
// [heuristic] — tuned, not from a paper.
const DELOAD_FEEL_THRESHOLD = 4;

/**
 * Autoregulated deload trigger, a TWO-SIGNAL inference (the MRV literature says
 * you've hit the ceiling when 2+ fatigue markers decline together):
 *
 *   1. Performance regression — the load coach's "missed the bottom of the
 *      range" flag across program lifts in the last week. One bad day is noise;
 *      a pattern across multiple lifts is signal.
 *   2. Subjective fatigue — recent mean `sessFeel` (the check-in number) at or
 *      below threshold.
 *
 *   3. Objective recovery — when Garmin wellness is linked, lib/readiness's
 *      daily assessment (HRV/resting-HR vs the athlete's own baseline, sleep,
 *      body battery) at tier 'low'. The objective twin of marker 2.
 *
 * Fires when regression is strong on its own (3+ lifts) OR when moderate
 * regression (2 lifts) is CORROBORATED by low feel OR low objective recovery —
 * so a single rough-feeling week without performance loss won't cry wolf, and
 * vice versa. Recovery data alone (without regression) never triggers it.
 *
 * ⚠️ The counts/threshold ("2 lifts", "7-day window", feel ≤ 4) are tuned
 * [heuristic]s, not literature values — the knobs to turn for sensitivity.
 */
export function deloadSignal(
  program: LiftingProgram,
  localDB: Record<string, LoggedDay>,
  todayStr: string,
): DeloadSignal {
  const recentCutoff = addDays(todayStr, -8); // within ~the last week
  const missed: string[] = [];
  for (const day of program.days) {
    for (const ex of day.exercises) {
      const advice = progressionAdvice(ex, localDB, todayStr);
      if (advice.action === 'hold' && advice.last && advice.last.date >= recentCutoff) {
        if (!missed.includes(ex.name)) missed.push(ex.name);
      }
    }
  }

  // Marker 2: mean session feel over recent logged days.
  const feels: number[] = [];
  for (const [date, rec] of Object.entries(localDB)) {
    if (date < recentCutoff || date > todayStr) continue;
    const f = Number(rec?.sessFeel) || 0;
    if (f > 0) feels.push(f);
  }
  const avgFeel = feels.length ? feels.reduce((a, b) => a + b, 0) / feels.length : null;
  const lowFeel = avgFeel != null && avgFeel <= DELOAD_FEEL_THRESHOLD;

  // Marker 3: objective recovery from imported Garmin wellness (no-op when the
  // user has no linked data — computeReadiness reports available:false).
  const readiness = computeReadiness(localDB, todayStr);
  const lowRecovery = readiness.available && readiness.tier === 'low';
  const recoveryScore = readiness.available ? readiness.score : null;

  const strongRegression   = missed.length >= 3;
  const moderateRegression = missed.length >= 2;
  const due = strongRegression || (moderateRegression && (lowFeel || lowRecovery));

  return { due, missed: missed.length, lifts: missed, lowFeel, avgFeel, lowRecovery, recoveryScore };
}

function addDays(dateStr: string, delta: number): string {
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  return new Date(t + delta * DAY_MS).toISOString().slice(0, 10);
}

/** Begin a fresh mesocycle today (resets the ramp to week 1). */
export function startNextMeso(program: LiftingProgram, todayStr: string): LiftingProgram {
  return { ...program, mesoStartDate: todayStr };
}

/** Goal-aware note: strength biases load + frequency over the volume ramp;
 *  hypertrophy leans on the ramp. Used for a one-line UI hint. */
export function volumeEmphasis(goal: LiftGoal): string {
  return goal === 'strength'
    ? 'Strength focus: prioritise adding load and hitting each lift 2+×/week over chasing volume.'
    : goal === 'general'
      ? 'Balanced: a gentle volume ramp with steady load progression.'
      : 'Hypertrophy focus: ramp weekly volume toward your peak, then deload.';
}
