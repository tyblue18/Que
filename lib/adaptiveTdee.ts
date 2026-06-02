/**
 * lib/adaptiveTdee.ts
 *
 * ADAPTIVE TDEE — infers the user's *true* total daily energy expenditure from
 * observed data instead of a static formula. Cross-pillar: it reads logged
 * intake (nutrition) and the body-weight TREND (metrics), which inherently
 * reflects the user's real activity (workouts) — three pillars one single-purpose
 * app would never have together.
 *
 * ── The quantity this returns: TOTAL daily expenditure ──────────────────────
 * The conserved energy-balance identity, over a window:
 *
 *   Δbodyweight(kcal) = Σintake − Σ(total expenditure)
 *   ⇒ total_TDEE ≈ avg_daily_intake − (weight_slope_lb/day × 3500)
 *
 * This is the purest, least-assumption quantity: calories in minus calories
 * stored (from the weight trend) = calories out, total. We do NOT subtract
 * logged exercise burn — the weight trend already reflects that activity, so
 * subtracting it would double-count and produce a *resting* number that mismatches
 * the full-TDEE clamp anchor (`formulaTdee`, Mifflin BMR × activity multiplier).
 * Output, clamp anchor, doc, and field name all mean "total daily expenditure."
 *
 * ── Why this is done HONESTLY, not naively ─────────────────────────────────
 *   • Body weight is noisy (water, gut content, time of day). We regress the
 *     TREND (least-squares slope), never first-vs-last — a bad scale day, even at
 *     an endpoint, can't swing the estimate the way a delta would.
 *   • Confidence is GRADED by days carrying both a weight and an intake log, and
 *     the returned estimate is a confidence-weighted BLEND of the adaptive number
 *     and `formulaTdee`: low confidence leans on the formula, high leans on the
 *     adaptive estimate. Below ~10 valid days it returns null (truly insufficient).
 *     This enforces "never a full-strength low-confidence estimate" in one place.
 *   • The raw adaptive number is CLAMPED to ±35% of the formula before blending,
 *     so a logging gap or data glitch can't yield an absurd maintenance.
 *
 * ── Documented limitations (not bugs) ──────────────────────────────────────
 *   • [estimate] The 3500 kcal/lb constant is the WISHNOFSKY approximation. It's
 *     not physically exact (tissue lost/gained is a fat+lean+water mix with
 *     differing energy densities), but it's serviceable here BECAUSE the estimate
 *     is re-derived weekly from a rolling window — short-run error washes out;
 *     it's never integrated over months.
 *   • [estimate] During a SUSTAINED DEFICIT, adaptive thermogenesis drives true
 *     maintenance DOWN faster than body-weight change alone predicts (metabolic
 *     adaptation). A trailing-window linear fit estimates the window's AVERAGE
 *     maintenance, so during an aggressive cut the estimate LAGS the current
 *     (lower) true value by roughly half the window's drift. Expected, not fixable
 *     without modelling adaptation explicitly. See the lag test.
 *   • [estimate] Consistent intake MIS-LOGGING biases the estimate by the logging
 *     error: the number is in "logged-calorie units," not absolute truth (see the
 *     intake-bias test + its honest finding). It self-corrects at the closed-loop
 *     level (a budget set in the same units, logged against with the same bias,
 *     yields the correct real-world balance) — but the TDEE number itself is
 *     biased. Consistency matters more than logging accuracy.
 *
 * Pure (no React, no storage) → fully unit-testable with synthetic day arrays.
 */

const KCAL_PER_LB = 3500; // Wishnofsky approximation — see limitations above.

/** Minimal day shape we read. Keyed by YYYY-MM-DD in the caller's map. */
export interface TdeeDay {
  date:       string;        // YYYY-MM-DD
  weight?:    string | number;
  calsEaten?: string | number;
}

export type TdeeConfidence = 'none' | 'low' | 'medium' | 'high';

export interface AdaptiveTdeeResult {
  /** Confidence-BLENDED total daily expenditure (kcal): a weighted mix of the
   *  adaptive estimate and `formulaTdee`. null only when data is insufficient. */
  estimate:    number | null;
  /** The pure adaptive estimate (clamped, pre-blend) — exposed for transparency
   *  and so tests can pin the raw quantity. null when insufficient data. */
  adaptiveRaw: number | null;
  confidence:  TdeeConfidence;
  /** Weight given to `adaptiveRaw` in `estimate` (0..1). 0 at none, scales up. */
  blendWeight: number;
  /** Days that carried BOTH a usable weight and a usable intake log. */
  daysUsed:    number;
  /** Span of the window in days (first→last weigh-in). */
  windowDays:  number;
  /** Modelled weight change over the window (lb), from the regression. */
  weightTrendLb: number | null;
}

// ── Confidence bands + blend weights ─────────────────────────────────────────
// [estimate] The 14-day floor for a *reliable* adaptive TDEE is the research
// consensus (14–28 days for high confidence); below ~10 days there isn't enough
// signal to publish anything. The blend weights are [heuristic] — tuned so a
// low-confidence estimate still leans on the proven formula.
const NULL_FLOOR_DAYS   = 10;  // below this → null (insufficient)
const MEDIUM_FLOOR_DAYS = 14;  // 10–13 = low, 14–20 = medium
const HIGH_FLOOR_DAYS   = 21;  // 21+ = high
const BLEND_WEIGHT: Record<Exclude<TdeeConfidence, 'none'>, number> = {
  low:    0.30,  // lean on the formula
  medium: 0.60,
  high:   0.85,  // lean on adaptive, keep a formula anchor for stability
};
const CLAMP_FRACTION = 0.35; // raw adaptive clamped to ±35% of the formula TDEE

/** The number of qualifying days needed before any estimate unlocks (the
 *  null floor). Exported so the UI can show progress toward it ("6 of ~10"). */
export const QUALIFYING_DAYS_TO_UNLOCK = NULL_FLOOR_DAYS;

function num(v: unknown): number {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : NaN;
}

/** Days within the trailing `windowDays` of the latest logged date, sorted asc. */
function windowDaysSorted(days: TdeeDay[], windowDays: number): TdeeDay[] {
  if (days.length === 0) return [];
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const last = sorted[sorted.length - 1].date;
  const cutoff = addDaysISO(last, -(windowDays - 1));
  return sorted.filter(d => d.date >= cutoff);
}

function addDaysISO(dateStr: string, delta: number): string {
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  return new Date(t + delta * 86_400_000).toISOString().slice(0, 10);
}

/** Count days in the trailing window carrying BOTH a weight and an intake log —
 *  the same eligibility the estimator gates on. Exposed so the UI can show
 *  unlock progress while the estimate is still null. Pure; does not affect the
 *  estimator's logic. */
export function countQualifyingDays(days: TdeeDay[], windowDays = 28): number {
  return windowDaysSorted(days, windowDays).filter(d => {
    const w = num(d.weight), e = num(d.calsEaten);
    return Number.isFinite(w) && w > 0 && Number.isFinite(e) && e > 0;
  }).length;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Least-squares slope of weight (lb) per day across the weigh-ins. x = days
 *  since the first weigh-in, y = weight. Returns null if <2 distinct points. */
function weightSlopePerDay(points: Array<{ x: number; y: number }>): number | null {
  if (points.length < 2) return null;
  const n = points.length;
  const sx = points.reduce((s, p) => s + p.x, 0);
  const sy = points.reduce((s, p) => s + p.y, 0);
  const sxx = points.reduce((s, p) => s + p.x * p.x, 0);
  const sxy = points.reduce((s, p) => s + p.x * p.y, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  return (n * sxy - sx * sy) / denom;
}

function confidenceFor(both: number): TdeeConfidence {
  if (both < NULL_FLOOR_DAYS)   return 'none';
  if (both < MEDIUM_FLOOR_DAYS) return 'low';
  if (both < HIGH_FLOOR_DAYS)   return 'medium';
  return 'high';
}

/**
 * Estimate true total daily expenditure from logged data.
 *
 * @param days        the user's day records (any range; we window internally)
 * @param formulaTdee the Mifflin-formula total TDEE (BMR × activity), used as the
 *                    clamp anchor AND the low-confidence blend target
 * @param windowDays  trailing window to analyse (default 28 — gives headroom for
 *                    21+ days of high-confidence signal)
 */
export function estimateAdaptiveTDEE(
  days: TdeeDay[],
  formulaTdee: number,
  windowDays = 28,
): AdaptiveTdeeResult {
  const insufficient = (conf: TdeeConfidence, daysUsed = 0, span = 0): AdaptiveTdeeResult =>
    ({ estimate: null, adaptiveRaw: null, confidence: conf, blendWeight: 0, daysUsed, windowDays: span, weightTrendLb: null });

  if (!Number.isFinite(formulaTdee) || formulaTdee <= 0) return insufficient('none');

  const win = windowDaysSorted(days, windowDays);
  if (win.length === 0) return insufficient('none');

  const first = win[0].date;
  const last  = win[win.length - 1].date;
  const span  = daysBetween(first, last);

  // Weigh-ins for the trend regression (x = days since first).
  const weighIns = win
    .map(d => ({ x: daysBetween(first, d.date), y: num(d.weight) }))
    .filter(p => Number.isFinite(p.y) && p.y > 0);

  // Intake days (only days that actually logged food).
  const intakes = win
    .map(d => num(d.calsEaten))
    .filter(e => Number.isFinite(e) && e > 0);

  // Days carrying BOTH signals drive confidence.
  const both = win.filter(d => {
    const w = num(d.weight), e = num(d.calsEaten);
    return Number.isFinite(w) && w > 0 && Number.isFinite(e) && e > 0;
  }).length;

  const confidence = confidenceFor(both);
  // Insufficient data → null, let the caller use formulaTdee directly.
  if (confidence === 'none' || weighIns.length < 2 || intakes.length < NULL_FLOOR_DAYS) {
    return insufficient(confidence, both, span);
  }

  const slope = weightSlopePerDay(weighIns); // lb/day
  if (slope === null) return insufficient(confidence, both, span);

  // total_TDEE = avg_intake − (weight_slope × 3500). NO burn subtraction (see header).
  const avgIntake = intakes.reduce((s, e) => s + e, 0) / intakes.length;
  const rawUnclamped = avgIntake - slope * KCAL_PER_LB;

  // Clamp the raw adaptive number to a sane band around the formula.
  const lo = formulaTdee * (1 - CLAMP_FRACTION);
  const hi = formulaTdee * (1 + CLAMP_FRACTION);
  const adaptiveRaw = Math.round(Math.max(lo, Math.min(hi, rawUnclamped)));

  // Confidence-weighted blend: low leans on the formula, high on the adaptive.
  const blendWeight = BLEND_WEIGHT[confidence as Exclude<TdeeConfidence, 'none'>];
  const estimate = Math.round(formulaTdee * (1 - blendWeight) + adaptiveRaw * blendWeight);

  const weightTrendLb = Math.round(slope * span * 10) / 10;

  return { estimate, adaptiveRaw, confidence, blendWeight, daysUsed: both, windowDays: span, weightTrendLb };
}
