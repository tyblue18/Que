/**
 * lib/healthActivity.ts
 *
 * PURE engine for the auto-cardio import (POST /api/health/activity) — the FREE,
 * no-third-party path where the user's OWN phone (iOS Shortcut / "Auto Health
 * Export" / Tasker) pushes a completed run/bike/swim to us. No wearable API, no
 * fees, no platform data-sharing restriction: it's the user's own data, so it can
 * legitimately flow into battles / groups (unlike Strava-sourced data).
 *
 * This module only decides HOW an incoming activity merges into a day's record.
 * It writes distance + time onto the standard cardio fields; CALORIES are derived
 * client-side by the existing ACSM/METs budget engine (useBudgetMetrics) from
 * those fields + the user's profile weight — nothing to compute here.
 *
 * Kept React/Prisma-free and pure so it's unit-testable in isolation (matching
 * the lifting/battle/coin engines). The route handler does all the IO.
 */

import { stampEditedFields, type MergeableDay } from '@/lib/dayMerge';

export type ActivityType = 'run' | 'bike' | 'swim';

export interface NormalizedActivity {
  type:       ActivityType;
  /** Already converted to MILES (0 when the client sent no distance — e.g. swim). */
  distanceMi: number;
  /** Duration in MINUTES. */
  timeMin:    number;
  /** Measured ACTIVE calories from the device (already net of resting), if the
   *  source provides them (e.g. Garmin, HR/power based). Supersedes the estimate. */
  calories?:  number;
  /** Stable id of the source workout; makes re-sends idempotent. */
  externalId?: string;
}

/** The cardio field pair each activity type accumulates into — the same keys the
 *  manual logger, calorie engine, and battle engine read. Swim's calorie cost is
 *  METs × minutes (distance isn't used in the calc), but we still store swimDist
 *  when provided, for trends/completeness. */
export const FIELD_MAP: Record<ActivityType, { dist: string; time: string }> = {
  run:  { dist: 'runDist',  time: 'runTime'  },
  bike: { dist: 'bikeDist', time: 'bikeTime' },
  swim: { dist: 'swimDist', time: 'swimTime' },
};

const MI_PER_KM = 0.621371;

/** Convert a distance to canonical miles (storage is imperial). */
export function toMiles(distance: number, unit: 'mi' | 'km' | undefined): number {
  return unit === 'km' ? distance * MI_PER_KM : distance;
}

function num(v: unknown): number {
  const n = parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Merge one incoming activity into a day's `data`. PURE + non-mutating.
 *
 * - **Idempotent:** a repeated `externalId` is a no-op (`changed:false`) so an
 *   automation that re-fires the same workout never double-counts it.
 * - **Accumulates:** two DISTINCT activities of the same type in a day SUM (total
 *   daily run distance/time), matching how every reader parses these fields.
 * - **Per-field stamps:** sets `_fieldEditedAt` for the touched fields so the
 *   client's next per-field pull-merge keeps the imported values without
 *   clobbering an unrelated same-day edit (e.g. weight logged on another device).
 *
 * @param existing the day's current `data` blob (may be empty for a new day)
 * @param act      the normalized activity (distance already in miles)
 * @param nowIso   the edit timestamp to stamp the touched fields with
 */
export function applyActivity(
  existing: MergeableDay,
  act: NormalizedActivity,
  nowIso: string,
): { data: MergeableDay; changed: boolean } {
  const ids = Array.isArray(existing._importedActivityIds)
    ? (existing._importedActivityIds as string[])
    : [];
  // Per-activity active-calorie ledger, keyed by externalId. Keeping it per
  // activity (not just a running sum) is what lets a RE-SEND backfill/correct
  // calories for an already-imported workout without double-counting its
  // distance/time — the day total is always the sum of the ledger.
  const kcalById: Record<string, number> = { ...((existing._garminKcalById as Record<string, number>) ?? {}) };

  const alreadyImported = !!(act.externalId && ids.includes(act.externalId));
  const { dist: distKey, time: timeKey } = FIELD_MAP[act.type];
  const data: MergeableDay = { ...existing };
  const touched: string[] = [];
  let changed = false;

  // Distance + time: accumulate ONCE per activity (idempotent on re-send).
  if (!alreadyImported) {
    data[timeKey] = +(num(existing[timeKey]) + act.timeMin).toFixed(1);
    touched.push(timeKey);
    if (act.distanceMi > 0) {
      data[distKey] = +(num(existing[distKey]) + act.distanceMi).toFixed(2);
      touched.push(distKey);
    }
    if (act.externalId) data._importedActivityIds = [...ids, act.externalId];
    changed = true;
  }

  // Measured active calories (Garmin HR/power). Recorded per activity, so a
  // re-send updates this workout's value — enabling backfill — and `garminKcal`
  // + `burn` are recomputed as the ledger sum. burn is what the badge/battle/
  // metrics layers read; the client budget reads garminKcal (via CardioFields).
  if (act.externalId && typeof act.calories === 'number' && act.calories > 0) {
    const kcal = Math.round(act.calories);
    if (kcalById[act.externalId] !== kcal) {
      kcalById[act.externalId] = kcal;
      const total = Object.values(kcalById).reduce((s, v) => s + v, 0);
      data._garminKcalById = kcalById;
      data.garminKcal = total;
      data.burn = total;
      touched.push('garminKcal', 'burn');
      changed = true;
    }
  }

  if (!changed) return { data: existing, changed: false };

  data._fieldEditedAt = stampEditedFields(existing, touched, nowIso);
  data._editedAt = nowIso;
  return { data, changed: true };
}
