/**
 * lib/readiness.ts
 *
 * Daily training readiness from imported Garmin wellness (lib/healthActivity's
 * applyWellness fields on DayRecords): overnight HRV, resting HR, last night's
 * sleep, and body battery. PURE — no React, no storage — so it's unit-testable
 * and usable by both the Recovery panel and the lifting deload trigger.
 *
 * Method (the standard HRV-guided-training framing):
 *   • HRV and resting HR are judged against the athlete's OWN rolling baseline
 *     (mean of up to 28 prior days, ≥5 readings required) — absolute values
 *     vary hugely between people, deviation from baseline is the signal.
 *     [evidence] HRV-guided programs key off suppression vs a rolling norm;
 *     an elevated morning RHR is a classic overreaching/illness marker.
 *   • Sleep and body battery are judged on absolute bands (a 5-hour night is
 *     short for everyone).
 *
 * The deviation thresholds and penalty weights are [heuristic] — sensible,
 * tuned knobs in the spirit of the lifting engine's landmarks, not literature
 * constants. The output is framed as advice, never a hard gate.
 */

// Wellness fields a day record may carry (matches applyWellness's writes).
export interface WellnessDay {
  hrv?:         number | string;
  restingHr?:   number | string;
  sleepScore?:  number | string;
  sleepMin?:    number | string;
  bodyBattery?: number | string;
}

export type ReadinessTier = 'ready' | 'moderate' | 'low';

export interface ReadinessAssessment {
  /** false = not enough wellness data to say anything (hide the banner). */
  available: boolean;
  score: number;                 // 0–100
  tier: ReadinessTier;           // ≥75 ready · ≥50 moderate · <50 low
  reasons: string[];             // human-readable drivers of any deduction
  hrvBaseline: number | null;    // rolling means, for display
  rhrBaseline: number | null;
  latestDate: string | null;     // the day the latest reading came from
}

const num = (v: unknown): number => {
  const n = parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
};

const DAY_MS = 86_400_000;
function addDays(dateStr: string, delta: number): string {
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  return new Date(t + delta * DAY_MS).toISOString().slice(0, 10);
}

/** Mean of the positive values of `field` over [from, to] (inclusive). */
function baselineOf(
  db: Record<string, WellnessDay>,
  field: keyof WellnessDay,
  from: string,
  to: string,
  minReadings: number,
): number | null {
  const vals: number[] = [];
  for (const [date, rec] of Object.entries(db)) {
    if (date < from || date > to) continue;
    const v = num(rec?.[field]);
    if (v > 0) vals.push(v);
  }
  if (vals.length < minReadings) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Most recent day ≤ todayStr (within `lookback` days) carrying `field`. */
function latestOf(
  db: Record<string, WellnessDay>,
  field: keyof WellnessDay,
  todayStr: string,
  lookback: number,
): { value: number; date: string } | null {
  for (let i = 0; i <= lookback; i++) {
    const ds = addDays(todayStr, -i);
    const v = num(db[ds]?.[field]);
    if (v > 0) return { value: v, date: ds };
  }
  return null;
}

// [heuristic] deviation bands + penalty weights. HRV suppression weighs most —
// it's the best-supported single marker; sleep next; RHR and battery corroborate.
const MIN_BASELINE_READINGS = 5;
const BASELINE_DAYS = 28;
const LOOKBACK = 2; // wellness lands in the morning — accept today or up to 2 days back

export function computeReadiness(
  db: Record<string, WellnessDay>,
  todayStr: string,
): ReadinessAssessment {
  const baseFrom = addDays(todayStr, -BASELINE_DAYS);
  const baseTo   = addDays(todayStr, -1); // baselines exclude today's reading
  const hrvBase = baselineOf(db, 'hrv',       baseFrom, baseTo, MIN_BASELINE_READINGS);
  const rhrBase = baselineOf(db, 'restingHr', baseFrom, baseTo, MIN_BASELINE_READINGS);

  const hrv   = latestOf(db, 'hrv',         todayStr, LOOKBACK);
  const rhr   = latestOf(db, 'restingHr',   todayStr, LOOKBACK);
  const sleepM = latestOf(db, 'sleepMin',    todayStr, LOOKBACK);
  const sleepS = latestOf(db, 'sleepScore',  todayStr, LOOKBACK);
  const bb    = latestOf(db, 'bodyBattery', todayStr, LOOKBACK);

  const hasAny = !!(hrv || rhr || sleepM || sleepS || bb);
  if (!hasAny) {
    return { available: false, score: 100, tier: 'ready', reasons: [],
             hrvBaseline: null, rhrBaseline: null, latestDate: null };
  }

  let penalty = 0;
  const reasons: string[] = [];

  // HRV vs own baseline: −7% mild, −15% strong suppression.
  if (hrv && hrvBase !== null) {
    const dropPct = ((hrvBase - hrv.value) / hrvBase) * 100;
    if (dropPct >= 15)     { penalty += 30; reasons.push(`HRV ${Math.round(dropPct)}% below your baseline (${hrv.value} vs ~${Math.round(hrvBase)} ms)`); }
    else if (dropPct >= 7) { penalty += 15; reasons.push(`HRV ${Math.round(dropPct)}% below your baseline`); }
  }

  // Resting HR vs own baseline: +4 bpm mild, +8 strong elevation.
  if (rhr && rhrBase !== null) {
    const rise = rhr.value - rhrBase;
    if (rise >= 8)      { penalty += 20; reasons.push(`Resting HR ${Math.round(rise)} bpm above your baseline`); }
    else if (rise >= 4) { penalty += 10; reasons.push(`Resting HR ${Math.round(rise)} bpm above your baseline`); }
  }

  // Last night's sleep: duration bands, with score as the fallback signal.
  const sleepPenalty = (() => {
    if (sleepM) {
      if (sleepM.value < 300) return { p: 25, r: 'Under 5 hours of sleep last night' };
      if (sleepM.value < 360) return { p: 15, r: 'Short sleep last night (under 6 hours)' };
    }
    if (sleepS && sleepS.value < 60) return { p: 10, r: `Low sleep score (${sleepS.value})` };
    return null;
  })();
  if (sleepPenalty) { penalty += sleepPenalty.p; reasons.push(sleepPenalty.r); }

  // Body battery morning charge.
  if (bb) {
    if (bb.value < 40)      { penalty += 20; reasons.push(`Body battery only recharged to ${bb.value}`); }
    else if (bb.value < 60) { penalty += 10; reasons.push(`Body battery recharged to just ${bb.value}`); }
  }

  const score = Math.max(0, Math.min(100, 100 - penalty));
  const tier: ReadinessTier = score >= 75 ? 'ready' : score >= 50 ? 'moderate' : 'low';
  const latestDate = hrv?.date ?? sleepM?.date ?? rhr?.date ?? bb?.date ?? sleepS?.date ?? null;

  return { available: true, score, tier, reasons, hrvBaseline: hrvBase, rhrBaseline: rhrBase, latestDate };
}
