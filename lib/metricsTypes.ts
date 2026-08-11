// Shared types, constants, and pure utility functions for MetricsDashboard.

import { useMemo } from 'react';
import type { UserProfile, LocalDB, DayRecord } from '@/lib/AppContext';

// ── Locale helpers ────────────────────────────────────────────────────────────

const MONTHS_LOCAL = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

export function ordinal(n: number): string {
  const v = n % 100; const s = ['th','st','nd','rd'];
  return n + (s[(v-20)%10] ?? s[v] ?? s[0]);
}
export function fmtDateLong(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return `${MONTHS_LOCAL[d.getMonth()]} ${ordinal(d.getDate())}, ${d.getFullYear()}`;
}
export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function parseNum(v: string | number | undefined): number {
  return parseFloat(String(v ?? '0')) || 0;
}
export function fmt(n: number): string { return Math.round(n).toLocaleString(); }

// ── Cardio fields ─────────────────────────────────────────────────────────────

export interface CardioFields {
  steps: string; runDist: string; runTime: string;
  bikeDist: string; bikeTime: string; swimTime: string;
  /** Measured ACTIVE calories from a linked Garmin sync (sum across the day's
   *  cardio). When > 0 it supersedes the distance/time estimate — Garmin's HR/
   *  power number captures grade, wind, and effort the estimate can't. */
  garminKcal?: string;
}
export const EMPTY_CARDIO: CardioFields = {
  steps: '0', runDist: '0', runTime: '0',
  bikeDist: '0', bikeTime: '0', swimTime: '0',
};

// ── Athlete plan ──────────────────────────────────────────────────────────────

export type PlanIntensity = 'slight' | 'moderate' | 'aggressive';

export const INTENSITY_KCAL: Record<PlanIntensity, number> = {
  slight: 250, moderate: 500, aggressive: 1000,
};

export const INTENSITY_LABELS: Record<'cut' | 'bulk', Record<PlanIntensity, string>> = {
  cut:  { slight: 'Slight Deficit', moderate: 'Cut',  aggressive: 'Aggressive Cut' },
  bulk: { slight: 'Lean Bulk',      moderate: 'Bulk', aggressive: 'Dirty Bulk'      },
};

/**
 * Bucket an arbitrary daily kcal target into the nearest named tier — for the
 * label/category only (the plan stores the exact `dailyKcal`). Thresholds are
 * the midpoints between the presets (250 / 500 / 1000).
 */
export function intensityForKcal(kcal: number): PlanIntensity {
  if (kcal <= 375) return 'slight';
  if (kcal <= 750) return 'moderate';
  return 'aggressive';
}

export interface AthletePlan {
  type:        'cut' | 'bulk';
  intensity:   PlanIntensity;
  /** The intensity preset value (250 / 500 / 1000). Display-only. For the
   *  rate-bearing number that progress tracking should compare against,
   *  use getEffectiveDailyKcal() — it accounts for cardio's contribution. */
  dailyKcal:   number;
  startDate:   string;
  startWeight: number;
  goalWeight:  number;
  weeksTarget: number;
  /** Snapshot of m.activityBurn at plan creation. Used by
   *  getEffectiveDailyKcal() to convert dailyKcal into an effective deficit
   *  (cut) or surplus (bulk). Optional for backwards compat with plans
   *  created before this field was added. */
  creationActivityBurn?: number;
}

import { ATHLETE_PLAN_KEY, PLAN_HISTORY_KEY, GOAL_TOLERANCE } from '@/lib/constants';
// Re-exported under the legacy PLAN_KEY name so existing imports keep working.
export const PLAN_KEY = ATHLETE_PLAN_KEY;

export function loadPlan(): AthletePlan | null {
  try { const r = localStorage.getItem(PLAN_KEY); return r ? JSON.parse(r) : null; }
  catch { return null; }
}
export function savePlanToStorage(p: AthletePlan) {
  try { localStorage.setItem(PLAN_KEY, JSON.stringify(p)); } catch { /* noop */ }
}

// ── Plan history (the journey) ───────────────────────────────────────────────
// A plan is single-active, but each time one is superseded (a cut→bulk switch,
// or an explicit "start new plan") the old one is archived here with its end
// date and final weigh-in. Read-only — past plans are never edited, only shown.

/** A past plan, frozen at the moment it was superseded. */
export interface ArchivedPlan extends AthletePlan {
  /** When the plan was archived / superseded (YYYY-MM-DD). */
  endDate:   string;
  /** Last weigh-in within [startDate, endDate], or null if none was logged. */
  endWeight: number | null;
}

const PLAN_HISTORY_MAX = 50;

export function loadPlanHistory(): ArchivedPlan[] {
  try {
    const raw = localStorage.getItem(PLAN_HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? (arr as ArchivedPlan[]) : [];
  } catch { return []; }
}

function savePlanHistory(list: ArchivedPlan[]): void {
  try { localStorage.setItem(PLAN_HISTORY_KEY, JSON.stringify(list.slice(-PLAN_HISTORY_MAX))); }
  catch { /* noop */ }
}

/** Latest logged weigh-in within [startDate, endDate], or null. */
function lastWeighInWindow(localDB: LocalDB, startDate: string, endDate: string): number | null {
  const weighed = Object.entries(localDB)
    .filter(([ds, r]) => ds >= startDate && ds <= endDate && parseFloat(String((r as DayRecord).weight ?? '0')) > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (weighed.length === 0) return null;
  return parseFloat(String((weighed[weighed.length - 1][1] as DayRecord).weight));
}

/**
 * Archive a plan into history with its end date + final weigh-in. Idempotent on
 * (startDate, type): re-archiving the same plan replaces its entry rather than
 * duplicating it (safe if the archive path runs twice). Returns the record.
 */
export function archiveCurrentPlan(plan: AthletePlan, endDate: string, localDB: LocalDB): ArchivedPlan {
  const archived: ArchivedPlan = {
    ...plan,
    endDate,
    endWeight: lastWeighInWindow(localDB, plan.startDate, endDate),
  };
  const history = loadPlanHistory().filter(p => !(p.startDate === plan.startDate && p.type === plan.type));
  history.push(archived);
  savePlanHistory(history);
  return archived;
}

/**
 * Effective daily caloric delta the plan is built around.
 *
 *   Cut:  dailyKcal + 0.4 × activityBurn   (cardio enlarges the deficit)
 *   Bulk: dailyKcal − 0.4 × activityBurn   (cardio shrinks the surplus, clamped ≥ 0)
 *
 * Why 0.4 × activityBurn: the daily budget formula adds back 60% of cardio burn,
 * so only the remaining 40% lands in actual caloric balance. This matches the
 * projection used at plan creation, so progress tracking compares against the
 * same rate the user was shown.
 *
 * Legacy plans without creationActivityBurn (introduced after the field was
 * added) fall back to raw dailyKcal — the cardio adjustment is unavailable
 * since we never captured the burn at creation time.
 */
export function getEffectiveDailyKcal(plan: AthletePlan): number {
  const cardioAdjust = (plan.creationActivityBurn ?? 0) * 0.4;
  return plan.type === 'cut'
    ? plan.dailyKcal + cardioAdjust
    : Math.max(0, plan.dailyKcal - cardioAdjust);
}

/**
 * The plan's starting weight — the single reference point for every
 * "change since start" calculation (progress tracking, chart anchoring,
 * Recent Weigh-ins delta).
 *
 * Captured ONCE at plan creation (from the value the user entered, which the
 * modal pre-fills with today's weigh-in if present, else profile weight) and
 * stored on plan.startWeight. It is intentionally STABLE: later daily weigh-ins
 * move "Current"/"Change" but never the Start, so logging your morning weight
 * can't retroactively redefine where you began. To change it, edit the plan.
 *
 * (Kept as a function — rather than reading plan.startWeight inline at call
 * sites — so all consumers route through one definition. The localDB argument
 * is no longer needed but is retained so existing call sites keep compiling.)
 */
export function getPlanBaseline(plan: AthletePlan, _localDB?: LocalDB): number {
  return plan.startWeight;
}

// ── Plan rate / projection / status (shared by every plan surface) ────────────

/** The plan's signed effective weekly rate (lb/wk). Negative for cuts. */
export function planWeeklyRate(plan: AthletePlan): number {
  const eff = getEffectiveDailyKcal(plan);
  return plan.type === 'cut' ? -(eff * 7 / 3500) : (eff * 7 / 3500);
}

/**
 * Expected weight change (signed lb) at `weeksElapsed` into the plan, CAPPED at
 * the goal delta. Without the cap, `rate × weeks` keeps growing past the goal
 * once the target date passes, which would flag a user who hit their goal and
 * is now maintaining as "behind pace" forever and make "Proj Now" overshoot the
 * goal weight. raw and goalDelta share the plan's sign, so we clamp magnitude.
 */
export function planExpectedChange(plan: AthletePlan, weeksElapsed: number): number {
  const raw       = planWeeklyRate(plan) * Math.max(0, weeksElapsed);
  const goalDelta = plan.goalWeight - getPlanBaseline(plan);
  return goalDelta >= 0 ? Math.min(raw, goalDelta) : Math.max(raw, goalDelta);
}

export type PlanStatus = 'ahead' | 'on-track' | 'behind' | 'no-data';

export interface PlanStatusResult {
  status:         PlanStatus;
  /** Exact elapsed weeks since plan.startDate. */
  weeksSince:     number;
  /** Raw last in-window weigh-in (for display — the user's real scale number). */
  latestWeight:   number | null;
  /** Mean of the last ≤3 in-window weigh-ins (used for status — water-weight
   *  noise on a single reading shouldn't flip ahead↔behind). */
  smoothedWeight: number | null;
  /** latestWeight − baseline (raw, for the "Change" stat). */
  actualChange:   number | null;
  /** Capped expected change at weeksSince (see planExpectedChange). */
  expectedChange: number;
}

/**
 * Single source of truth for "Ahead / On-track / Behind". Previously each modal
 * computed this slightly differently (smoothed vs raw weight, 3-day vs 3.5-day
 * gate), so the same plan could read differently across surfaces. All of them
 * now route through here: smoothed weight, a 3-day minimum, ±20% band around the
 * (capped) expected change.
 */
export function getPlanStatus(plan: AthletePlan, localDB: LocalDB): PlanStatusResult {
  const baseline   = getPlanBaseline(plan);
  const startMs    = new Date(plan.startDate + 'T00:00:00').getTime();
  const weeksSince = Math.max(0, (Date.now() - startMs) / (7 * 86400000));

  const inWindow = (Object.entries(localDB) as [string, DayRecord][])
    .filter(([ds, r]) => ds >= plan.startDate && parseNum(String(r.weight ?? '0')) > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, r]) => parseNum(String(r.weight)));

  const latestWeight   = inWindow.length ? inWindow[inWindow.length - 1] : null;
  const smoothCount    = Math.min(3, inWindow.length);
  const smoothedWeight = smoothCount > 0
    ? inWindow.slice(-smoothCount).reduce((s, w) => s + w, 0) / smoothCount
    : null;

  const actualChange   = latestWeight   !== null ? latestWeight   - baseline : null;
  const changeSmoothed = smoothedWeight !== null ? smoothedWeight - baseline : null;
  const expectedChange = planExpectedChange(plan, weeksSince);

  let status: PlanStatus = 'no-data';
  if (changeSmoothed !== null && weeksSince >= 3 / 7 && Math.abs(expectedChange) > 0.05) {
    const thr   = Math.abs(expectedChange) * 0.2;
    const delta = changeSmoothed - expectedChange;
    status = plan.type === 'cut'
      ? (delta < -thr ? 'ahead' : delta > thr ? 'behind' : 'on-track')
      : (delta >  thr ? 'ahead' : delta < -thr ? 'behind' : 'on-track');
  } else if (changeSmoothed !== null) {
    status = 'on-track';
  }

  return { status, weeksSince, latestWeight, smoothedWeight, actualChange, expectedChange };
}

/**
 * A logged day's TRUE maintenance (TDEE + cardio burn) — the expenditure the
 * user must eat ABOVE to gain and below to lose, independent of any goal.
 *
 * Prefers the `tdee` snapshot stored at log time (exact, deficit-proof). Days
 * logged before that field existed fall back to recovering TDEE from the stored
 * budget: budget = tdee − deficit + 0.6·burn ⇒ tdee + burn = budget + deficit +
 * 0.4·burn. That fallback is only exact if the deficit hasn't changed since the
 * day was logged — which is exactly the case the `tdee` snapshot fixes going
 * forward. Returns null when the day lacks the data to compute it.
 */
export function dayMaintenance(
  rec:            { tdee?: unknown; budget?: unknown; burn?: unknown },
  fallbackDeficit: number,
): number | null {
  const burn = parseNum(String(rec.burn ?? 0));
  const tdee = parseNum(String(rec.tdee ?? 0));
  if (tdee > 0) return tdee + burn;
  const budget = parseNum(String(rec.budget ?? 0));
  if (budget <= 0) return null;
  return budget + fallbackDeficit + burn * 0.4;
}

// ── Plan compliance (per-day caloric balance) ────────────────────────────────

export interface PlanCompliance {
  /** Whole days elapsed since plan.startDate (inclusive of today). */
  daysElapsed:           number;
  /** Days within the plan window where the user logged calsEaten. */
  daysLogged:            number;
  /** Days logged that landed inside the ±100 kcal goal band. */
  daysOnTarget:          number;
  /** Sum of (calsEaten − true maintenance) across logged days. Negative means
   *  a real caloric deficit (good for cuts, bad for bulks). */
  cumulativeBalance:     number;
  /** cumulativeBalance / daysLogged. 0 if no days logged. */
  avgDailyBalance:       number;
  /** Weight change implied by the cumulative caloric balance (lb).
   *  Calorie-based, data-driven counterpart to expectedChange. */
  calorieBasedChange:    number;
}

/**
 * Walks the plan window day-by-day and aggregates real caloric balance vs.
 * true maintenance, derived from each day's stored budget and burn.
 *
 *   budget       = tdee − profile.deficit + 0.6 × burn        (from useBudgetMetrics)
 *   ⇒ maintenance = tdee + burn = budget + profile.deficit + 0.4 × burn
 *
 * Uses the user's CURRENT profile.deficit. This is honest regardless of
 * whether the plan's intent matches the user's eating profile — if a bulk
 * user still has deficit=500, the ledger will correctly show they're in a
 * caloric deficit, prompting them to fix their config.
 *
 * Returns zeroed metrics on a missing plan or empty window.
 */
export function getPlanCompliance(
  plan:     AthletePlan,
  localDB:  LocalDB,
  profile:  UserProfile,
): PlanCompliance {
  const planStartMs = new Date(plan.startDate + 'T00:00:00').getTime();
  // LOCAL today (toDateStr) — not UTC — so the day count / window don't drift by
  // one in the evening for users behind UTC.
  const todayStr    = toDateStr(new Date());
  const daysElapsed = Math.max(
    0,
    Math.floor((new Date(todayStr + 'T00:00:00').getTime() - planStartMs) / 86400000) + 1,
  );

  let daysLogged       = 0;
  let daysOnTarget     = 0;
  let cumulativeBalance = 0;

  const profileDeficit = parseNum(profile.deficit) || 500;

  for (const [ds, rec] of Object.entries(localDB)) {
    if (ds < plan.startDate || ds > todayStr) continue;
    const calsEaten = parseNum(String(rec.calsEaten ?? '0'));
    const budget    = parseNum(String(rec.budget    ?? '0'));
    if (calsEaten <= 0 || budget <= 0) continue;

    daysLogged++;
    if (Math.abs(calsEaten - budget) <= GOAL_TOLERANCE) daysOnTarget++;

    // True maintenance (tdee + burn) from the day's snapshot, deficit-proof.
    const maintenance = dayMaintenance(rec, profileDeficit);
    if (maintenance !== null) cumulativeBalance += calsEaten - maintenance;
  }

  return {
    daysElapsed,
    daysLogged,
    daysOnTarget,
    cumulativeBalance,
    avgDailyBalance:    daysLogged > 0 ? cumulativeBalance / daysLogged : 0,
    calorieBasedChange: cumulativeBalance / 3500,
  };
}

// ── Cardio burn (pure — shared by the live budget AND the persistence paths) ──

export interface CardioBurn {
  stepMiles: number; stepBurn: number;
  runBurn: number; runPaceStr: string; runSpeed: number;
  bikeBurn: number; bikeSpeed: number;
  swimBurn: number;
  /** run + bike + swim, NET of resting energy. Steps are NOT included. */
  activityBurn: number;
}

/**
 * Pure cardio-burn calculation. Extracted from useBudgetMetrics so the stored
 * `burn` DayRecord field (written wherever cardio is logged) always matches what
 * the live budget shows — previously `burn` was only persisted on "Log Today",
 * leaving it stale/0 for cardio logged via the workout log or quick-cardio tiles
 * (which broke the 1,000-cal badge, the plan ledger's maintenance, and the burn
 * chart). NET of resting energy (gross − RMR over the same minutes).
 */
/**
 * Flat-ground cycling energy estimate (kcal, GROSS metabolic) from average speed.
 *
 * Why not METs: a single MET per speed band assumes steady, flat effort, so it
 * badly overestimates easy/flat riding — the 14 mph "10 MET" band gives an 80 kg
 * rider ~840 kcal/hr, ~2.5× a physics estimate. Running/swimming track effort
 * with pace (a MET table is fine); cycling decouples speed from work (coasting,
 * drafting, wind, gradient), so we model the actual work instead:
 *
 *   power = (rolling + aero) resistance × speed, converted to metabolic kcal at
 *   ~24% gross efficiency. rolling = Crr·m·g ; aero = ½·ρ·CdA·v².
 *
 * Limits (honest): with no GPS elevation we assume FLAT + still air, so this
 * UNDER-counts big climbs and headwinds — a linked Garmin (measured calories)
 * supersedes this. Constants are typical road-rider estimates and are tunable.
 * [estimate]
 */
const BIKE_CRR   = 0.006;   // rolling resistance coefficient (road tyre)
const BIKE_CDA   = 0.36;    // drag area (m²), hoods position
const AIR_RHO    = 1.225;   // air density (kg/m³) at ~15°C, sea level
const GRAVITY    = 9.81;
const BIKE_MASS  = 9;       // added bike mass (kg)
const GROSS_EFF  = 0.24;    // metabolic → mechanical gross efficiency
const DRIVE_EFF  = 0.97;    // drivetrain loss

export function cyclingKcalFlat(speedMph: number, minutes: number, riderKg: number): number {
  if (speedMph <= 0 || minutes <= 0) return 0;
  const v     = speedMph * 0.44704;             // m/s
  const mass  = riderKg + BIKE_MASS;
  const fRoll = BIKE_CRR * mass * GRAVITY;
  const fAir  = 0.5 * AIR_RHO * BIKE_CDA * v * v;
  const watts = ((fRoll + fAir) * v) / DRIVE_EFF;
  return (watts * minutes * 60) / GROSS_EFF / 4184;  // J → kcal metabolic
}

export function computeCardioBurn(profile: UserProfile, cardio: CardioFields): CardioBurn {
  const wLbs = parseNum(profile.weight) || 180;
  const hIn  = parseNum(profile.height) || 70;
  const age  = parseNum(profile.age)    || 29;
  const sex  = profile.sex;
  const kg   = wLbs / 2.20462;
  const cm   = hIn  * 2.54;
  const bmr  = Math.round(
    sex === 'male' ? 10 * kg + 6.25 * cm - 5 * age + 5 : 10 * kg + 6.25 * cm - 5 * age - 161
  );

  const steps     = parseNum(cardio.steps);
  const stride    = hIn * (sex === 'male' ? 0.418 : 0.415);
  const stepMiles = (steps * stride) / 63360;
  const stepBurn  = Math.round(stepMiles * 0.57 * wLbs);

  const rmrPerMin = bmr / 1440;
  const netOf = (gross: number, min: number) => Math.max(0, Math.round(gross - rmrPerMin * min));

  const rMi  = parseNum(cardio.runDist);
  const rMin = parseNum(cardio.runTime);
  let runBurn = 0, runPaceStr = '', runSpeed = 0;
  if (rMi > 0 && rMin > 0) {
    runSpeed = (rMi / rMin) * 60;
    const pace = rMin / rMi;
    const pMin = Math.floor(pace);
    const pSec = Math.round((pace - pMin) * 60).toString().padStart(2, '0');
    runPaceStr = `${pMin}:${pSec} /mi`;
    const mPerMin  = runSpeed * 26.8224;
    const vo2      = 0.2 * mPerMin + 3.5;
    const grossRun = (vo2 * kg / 1000) * 5 * rMin;
    runBurn = netOf(grossRun, rMin);
  }

  const bMi  = parseNum(cardio.bikeDist);
  const bMin = parseNum(cardio.bikeTime);
  let bikeBurn = 0, bikeSpeed = 0;
  if (bMi > 0 && bMin > 0) {
    bikeSpeed = (bMi / bMin) * 60;
    // Physics (flat-ground power) model instead of a speed→MET band — see
    // cyclingKcalFlat. NET of resting like the other activities.
    bikeBurn = netOf(cyclingKcalFlat(bikeSpeed, bMin, kg), bMin);
  }

  const sMin     = parseNum(cardio.swimTime);
  let   swimBurn = sMin > 0 ? netOf(7.0 * 3.5 * kg / 200 * sMin, sMin) : 0;

  // Measured override: a linked Garmin sync provides real ACTIVE calories (HR/
  // power based), which capture grade, wind, and effort the distance-time
  // estimate can't — this is the fix for cycling numbers reading low. Garmin
  // "active" kcal are already net of resting, so use them directly, and scale
  // the per-type breakdown to the measured total so the split still sums.
  const gKcal  = parseNum(cardio.garminKcal);
  const estSum = runBurn + bikeBurn + swimBurn;
  let activityBurn = Math.round(estSum);
  if (gKcal > 0) {
    activityBurn = Math.round(gKcal);
    if (estSum > 0) {
      const scale = gKcal / estSum;
      runBurn  = Math.round(runBurn  * scale);
      bikeBurn = Math.round(bikeBurn * scale);
      swimBurn = Math.round(swimBurn * scale);
    }
  }

  return {
    stepMiles, stepBurn,
    runBurn, runPaceStr, runSpeed: Math.round(runSpeed * 10) / 10,
    bikeBurn, bikeSpeed: Math.round(bikeSpeed * 10) / 10,
    swimBurn,
    activityBurn,
  };
}

// ── Budget metrics ────────────────────────────────────────────────────────────

export interface BudgetMetrics {
  bmr: number; tdee: number; deficit: number; multiplier: number;
  stepMiles: number; stepBurn: number;
  runBurn: number; runPaceStr: string; runSpeed: number;
  bikeBurn: number; bikeSpeed: number;
  swimBurn: number;
  activityBurn: number; eatBack: number; budget: number;
}

export function useBudgetMetrics(profile: UserProfile, cardio: CardioFields): BudgetMetrics {
  return useMemo<BudgetMetrics>(() => {
    const wLbs = parseNum(profile.weight) || 180;
    const hIn  = parseNum(profile.height) || 70;
    const age  = parseNum(profile.age)    || 29;
    const sex  = profile.sex;
    const def  = parseNum(profile.deficit) || 500;
    const mult = parseNum(profile.activityLevel) || 1.55;
    const kg   = wLbs / 2.20462;
    const cm   = hIn  * 2.54;

    const bmr = Math.round(
      sex === 'male'
        ? 10 * kg + 6.25 * cm - 5 * age + 5
        : 10 * kg + 6.25 * cm - 5 * age - 161
    );
    const tdee = Math.round(bmr * mult);

    // Cardio burn is computed by the shared pure helper so the live budget and
    // the persisted `burn` field can never drift.
    const cb       = computeCardioBurn(profile, cardio);
    const eatBack  = Math.round(cb.activityBurn * 0.60);
    const budget   = Math.max(0, (tdee - def) + eatBack);

    return {
      bmr, tdee, deficit: def, multiplier: mult,
      stepMiles: cb.stepMiles, stepBurn: cb.stepBurn,
      runBurn: cb.runBurn, runPaceStr: cb.runPaceStr, runSpeed: cb.runSpeed,
      bikeBurn: cb.bikeBurn, bikeSpeed: cb.bikeSpeed,
      swimBurn: cb.swimBurn,
      activityBurn: cb.activityBurn, eatBack, budget,
    };
  }, [profile, cardio]);
}

// ── PR flags ──────────────────────────────────────────────────────────────────

export interface PRFlags { prRun: boolean; prBike: boolean; prSwim: boolean; prLift: boolean; }
