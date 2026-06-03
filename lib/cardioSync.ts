/**
 * lib/cardioSync.ts
 *
 * Single source of truth for a day's cardio. Cardio lives in two places on a
 * DayRecord: the serialized `exercises[]` array (`{k:'run', v1:dist, v2:time}`,
 * read by the calendar + day summary) AND the top-level fields (`runDist`,
 * `bikeDist`, `swimTime`, `burn`, … read by the budget, charts, badges).
 *
 * The array is AUTHORITATIVE; the top-level fields are DERIVED from it. Every
 * cardio writer (WorkoutLogger, the Metrics quick-cardio modal) must go through
 * here so the two representations can never disagree — previously the Metrics
 * modal wrote only the top-level fields, so cardio logged there was invisible on
 * the calendar and could contradict the workout log.
 *
 * Field convention (matches WorkoutLogger): run/bike → v1 = distance (canonical
 * miles), v2 = duration (min). swim → v1 = duration (min), v2 = distance (miles).
 */

import type { ExerciseEntry, UserProfile } from '@/lib/AppContext';
import { computeCardioBurn } from '@/lib/metricsTypes';

export type CardioKind = 'run' | 'bike' | 'swim';

/** Robust parse of a stored `exercises` blob (JSON, or the legacy newline-text
 *  format). Preserves lifts/text entries so a cardio edit never drops them. */
export function parseExercises(raw: unknown): ExerciseEntry[] {
  const s = String(raw ?? '');
  if (!s) return [];
  try {
    const p = JSON.parse(s);
    return Array.isArray(p) ? (p as ExerciseEntry[]) : [];
  } catch {
    return s.split('\n').filter(l => l.trim()).map(l => ({ k: 'text', n: l }));
  }
}

export interface DerivedCardioFields {
  runDist: number; runTime: number;
  bikeDist: number; bikeTime: number;
  swimTime: number; swimDist: number;
  burn: number;
}

const sum = (arr: ExerciseEntry[], key: 'v1' | 'v2'): number =>
  arr.reduce((s, e) => s + (parseFloat(String(e[key] ?? '0')) || 0), 0);

/** Derive the top-level cardio fields (+ burn) from the exercises array. This is
 *  the SAME derivation WorkoutLogger applies on every write. */
export function deriveCardioFields(entries: ExerciseEntry[], profile: UserProfile): DerivedCardioFields {
  const runs  = entries.filter(e => e.k === 'run');
  const bikes = entries.filter(e => e.k === 'bike');
  const swims = entries.filter(e => e.k === 'swim');
  const runDist  = sum(runs, 'v1'),  runTime  = sum(runs, 'v2');
  const bikeDist = sum(bikes, 'v1'), bikeTime = sum(bikes, 'v2');
  const swimTime = sum(swims, 'v1'), swimDist = sum(swims, 'v2');
  const burn = computeCardioBurn(profile, {
    steps: '0',
    runDist: String(runDist), runTime: String(runTime),
    bikeDist: String(bikeDist), bikeTime: String(bikeTime),
    swimTime: String(swimTime),
  }).activityBurn;
  return { runDist, runTime, bikeDist, bikeTime, swimTime, swimDist, burn };
}

/** Replace every entry of one cardio kind with a single aggregate entry (or none
 *  if both values are 0), preserving lifts + other cardio. The Metrics modal is
 *  an aggregate-per-kind editor, so editing there collapses multiple same-kind
 *  entries into one — consistent, and it keeps the array authoritative. */
export function setCardioOfKind(
  entries: ExerciseEntry[],
  kind: CardioKind,
  distanceMi: number,
  durationMin: number,
): ExerciseEntry[] {
  const kept = entries.filter(e => e.k !== kind);
  if (!(distanceMi > 0) && !(durationMin > 0)) return kept; // cleared → just remove the kind
  const dist = distanceMi > 0 ? String(Math.round(distanceMi * 100) / 100) : '';
  const dur  = durationMin > 0 ? String(Math.round(durationMin)) : '';
  const entry: ExerciseEntry = kind === 'swim'
    ? { k: 'swim', v1: dur, v2: dist }
    : { k: kind, v1: dist, v2: dur };
  return [...kept, entry];
}

/** Existing logged distance for a kind (canonical miles) — used to PRESERVE swim
 *  distance when the Metrics swim modal (time-only) rewrites the swim entry. */
export function existingCardioDistance(entries: ExerciseEntry[], kind: CardioKind): number {
  const arr = entries.filter(e => e.k === kind);
  return kind === 'swim' ? sum(arr, 'v2') : sum(arr, 'v1');
}
