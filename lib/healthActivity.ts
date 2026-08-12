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

/** One Garmin activity's contribution, kept per externalId in `_garminActs`. */
interface GarminAct { type: ActivityType; distMi: number; timeMin: number; kcal: number }

/**
 * Merge one incoming activity into a day's `data`. PURE + non-mutating.
 *
 * Each activity with an `externalId` is stored in a per-activity ledger
 * (`_garminActs`), and the day's cardio aggregates (`runDist`, `bikeTime`, …)
 * + `garminKcal`/`burn` are RECOMPUTED as the sum of that ledger. So a re-send
 * REPLACES a workout's contribution rather than adding to it:
 *   - **Idempotent + correction-safe:** re-sending the same workout is a no-op;
 *     re-sending it with new numbers (e.g. backfilled calories, or a corrected
 *     distance) updates it — with no double-counting. This replaced an earlier
 *     accumulate model whose dedup could fail across syncs and double distances.
 *   - **Distinct activities SUM:** two rides in a day total correctly.
 *   - **Only touches types the ledger covers**, so a manually-logged cardio of a
 *     DIFFERENT type on the same day survives.
 *   - **Per-field stamps** so the client pull-merge keeps these without clobbering
 *     an unrelated same-day edit.
 *
 * Activities without an `externalId` (rare — Garmin always sends one) fall back
 * to a one-shot accumulate.
 */
export function applyActivity(
  existing: MergeableDay,
  act: NormalizedActivity,
  nowIso: string,
): { data: MergeableDay; changed: boolean } {
  if (!act.externalId) return accumulateNoId(existing, act, nowIso);

  const ledger: Record<string, GarminAct> = { ...((existing._garminActs as Record<string, GarminAct>) ?? {}) };
  const prev = ledger[act.externalId];
  const next: GarminAct = {
    type:    act.type,
    distMi:  +act.distanceMi.toFixed(2),
    timeMin: +act.timeMin.toFixed(1),
    // Keep the prior calories if this send omits them (e.g. a plain re-sync).
    kcal:    typeof act.calories === 'number' && act.calories > 0
               ? Math.round(act.calories)
               : (prev?.kcal ?? 0),
  };

  if (prev && prev.type === next.type && prev.distMi === next.distMi
      && prev.timeMin === next.timeMin && prev.kcal === next.kcal) {
    return { data: existing, changed: false }; // nothing about this workout changed
  }
  ledger[act.externalId] = next;

  // Recompute per-type distance/time + total kcal from the WHOLE ledger.
  const agg: Record<string, number> = {};
  const seen = new Set<ActivityType>();
  let kcalTotal = 0;
  for (const a of Object.values(ledger)) {
    kcalTotal += a.kcal;
    seen.add(a.type);
    const { dist, time } = FIELD_MAP[a.type];
    agg[dist] = (agg[dist] ?? 0) + a.distMi;
    agg[time] = (agg[time] ?? 0) + a.timeMin;
  }

  const data: MergeableDay = { ...existing, _garminActs: ledger, _importedActivityIds: Object.keys(ledger) };
  const touched: string[] = [];
  // Per-TYPE measured-calorie sums, so the UI can show each activity's actual
  // Garmin number (bike card = the ride's 465) instead of scaling the day
  // total across activities by their estimates.
  const kcalByType: Record<ActivityType, number> = { run: 0, bike: 0, swim: 0 };
  for (const a of Object.values(ledger)) kcalByType[a.type] += a.kcal;
  const KCAL_FIELD: Record<ActivityType, string> = {
    run: 'garminRunKcal', bike: 'garminBikeKcal', swim: 'garminSwimKcal',
  };
  for (const t of seen) {
    const { dist, time } = FIELD_MAP[t];
    data[dist] = +(agg[dist] ?? 0).toFixed(2);
    data[time] = +(agg[time] ?? 0).toFixed(1);
    touched.push(dist, time);
    if (kcalByType[t] > 0) {
      data[KCAL_FIELD[t]] = Math.round(kcalByType[t]);
      touched.push(KCAL_FIELD[t]);
    }
  }
  if (kcalTotal > 0) {
    data.garminKcal = Math.round(kcalTotal);
    data.burn = Math.round(kcalTotal);
    touched.push('garminKcal', 'burn');
  }

  data._fieldEditedAt = stampEditedFields(existing, touched, nowIso);
  data._editedAt = nowIso;
  return { data, changed: true };
}

/** Fallback for a source with no stable id: can't dedup, so accumulate once. */
function accumulateNoId(
  existing: MergeableDay,
  act: NormalizedActivity,
  nowIso: string,
): { data: MergeableDay; changed: boolean } {
  const { dist: distKey, time: timeKey } = FIELD_MAP[act.type];
  const data: MergeableDay = { ...existing };
  const touched: string[] = [timeKey];
  data[timeKey] = +(num(existing[timeKey]) + act.timeMin).toFixed(1);
  if (act.distanceMi > 0) {
    data[distKey] = +(num(existing[distKey]) + act.distanceMi).toFixed(2);
    touched.push(distKey);
  }
  if (act.calories && act.calories > 0) {
    const total = Math.round(num(existing.garminKcal) + act.calories);
    data.garminKcal = total;
    data.burn = total;
    touched.push('garminKcal', 'burn');
  }
  data._fieldEditedAt = stampEditedFields(existing, touched, nowIso);
  data._editedAt = nowIso;
  return { data, changed: true };
}
