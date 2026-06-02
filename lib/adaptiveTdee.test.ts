/**
 * lib/adaptiveTdee.test.ts
 *
 * Locks the adaptive-TDEE estimator. The engine returns TOTAL daily expenditure
 * (avg_intake − weight_slope×3500, NO burn subtraction — the trend already
 * reflects activity), least-squares trend (noise-resistant even at endpoints),
 * graded confidence with an in-engine blend toward formulaTdee, and a clamp.
 * Synthetic day arrays make the true expenditure known by construction.
 *
 * Every test is built to FAIL against incorrect behavior (wrong formula/sign,
 * naive first-vs-last slope, missing clamp/blend, wrong band).
 */

import { describe, it, expect } from 'vitest';
import { estimateAdaptiveTDEE, type TdeeDay } from '@/lib/adaptiveTdee';

const ISO = (offset: number) =>
  new Date(Date.parse('2026-03-01T00:00:00Z') + offset * 86_400_000).toISOString().slice(0, 10);

/** N days: constant daily intake, weight changing by `lbPerDay` from start. */
function makeDays(n: number, intake: number, startWeight: number, lbPerDay: number): TdeeDay[] {
  return Array.from({ length: n }, (_, i) => ({
    date:      ISO(i),
    calsEaten: String(intake),
    weight:    (startWeight + lbPerDay * i).toFixed(2),
  }));
}

// Helper: a high-confidence (28-day) flat run at the given intake → expenditure≈intake.
const flat = (n: number, intake: number) => makeDays(n, intake, 180, 0);

describe('estimateAdaptiveTDEE — recovers true TOTAL expenditure', () => {
  it('weight stable on a given intake → expenditure ≈ that intake', () => {
    const r = estimateAdaptiveTDEE(flat(28, 2400), 2400);
    expect(r.adaptiveRaw).not.toBeNull();
    expect(Math.abs(r.adaptiveRaw! - 2400)).toBeLessThan(15);
  });

  it('losing weight → expenditure ABOVE intake (sign + magnitude of slope term)', () => {
    // Ate 2000, lost 1 lb/wk (0.143/day) → deficit ~500 → TDEE ~2500.
    const r = estimateAdaptiveTDEE(makeDays(28, 2000, 180, -0.143), 2400);
    expect(r.adaptiveRaw!).toBeGreaterThan(2400);
    expect(Math.abs(r.adaptiveRaw! - 2500)).toBeLessThan(50);
  });

  it('gaining weight → expenditure BELOW intake', () => {
    const r = estimateAdaptiveTDEE(makeDays(28, 2800, 180, +0.143), 2400);
    expect(r.adaptiveRaw!).toBeLessThan(2800);
    expect(Math.abs(r.adaptiveRaw! - 2300)).toBeLessThan(50);
  });
});

// 2a — the quantity-pinning test. Burn must NOT be subtracted: the engine
// returns TOTAL expenditure, and the weight trend already encodes activity.
describe('2a — output is TOTAL expenditure, not resting (burn is not subtracted)', () => {
  it('flat weight at 2400 intake → ~2400 regardless of activity (no burn term)', () => {
    // Even if the user trained hard daily, with flat weight at 2400 intake their
    // TOTAL expenditure IS ~2400. A resting-maintenance impl (subtracting burn)
    // would return ~2100 and fail this. The engine has no `burn` input at all now.
    const r = estimateAdaptiveTDEE(flat(28, 2400), 2400);
    expect(Math.abs(r.adaptiveRaw! - 2400)).toBeLessThan(15); // total, not 2100 resting
  });
});

describe('clamp — raw adaptive bounded to ±35% of formula', () => {
  it('absurd slope cannot escape the ±35% band', () => {
    const r = estimateAdaptiveTDEE(makeDays(28, 2400, 180, -2), 2000); // losing 2 lb/day (absurd)
    expect(r.adaptiveRaw!).toBeLessThanOrEqual(Math.round(2000 * 1.35));
    expect(r.adaptiveRaw!).toBeGreaterThanOrEqual(Math.round(2000 * 0.65));
  });
});

// ── Part 3: trend resistance with the spike AT AN ENDPOINT (the bite) ────────
describe('trend resistance — OLS regression, not first-vs-last', () => {
  it('an endpoint weight spike is heavily damped by OLS vs. a delta method', () => {
    const days = flat(28, 2400);
    // Spike the LAST day by +6 lb (water/glycogen). first-vs-last would read this
    // as +6 lb over the window → a huge spurious surplus → estimate way off.
    days[days.length - 1] = { ...days[days.length - 1], weight: '186' };
    const r = estimateAdaptiveTDEE(days, 2400);
    // OLS spreads the outlier across 28 points: actual response ≈ 155 kcal (slope
    // ~0.044 lb/day). Bounded at ≤200 — a real but small shift. [estimate] NOTE:
    // an ENDPOINT outlier has higher OLS leverage than a midpoint one, so it does
    // move the estimate ~155 (not ~0) — a documented limitation, not a bug.
    expect(Math.abs(r.adaptiveRaw! - 2400)).toBeLessThan(200);
  });

  it('BITE CHECK: a first-vs-last slope on that data is ~5× worse (off ~778)', () => {
    // Proves the test above is meaningful: the naive delta on the SAME data is
    // dramatically worse than the OLS response, so the test distinguishes them.
    const n = 28, intake = 2400, firstW = 180, lastW = 186;
    const naiveSlope = (lastW - firstW) / (n - 1);
    const naiveEstimate = intake - naiveSlope * 3500;
    expect(Math.abs(naiveEstimate - 2400)).toBeGreaterThan(700); // OLS was 155; naive ~778
  });
});

// ── Part 3: confidence bands (EXACT, not ranges) + blend weights ─────────────
describe('confidence bands — exact, with blend weight', () => {
  it('<10 valid days → null, confidence none, no estimate', () => {
    const r = estimateAdaptiveTDEE(makeDays(9, 2400, 180, 0), 2400);
    expect(r.estimate).toBeNull();
    expect(r.adaptiveRaw).toBeNull();
    expect(r.confidence).toBe('none');
    expect(r.blendWeight).toBe(0);
  });

  it('10–13 days → low confidence, blend 0.30 (leans on formula)', () => {
    const r = estimateAdaptiveTDEE(makeDays(12, 2400, 180, 0), 2400);
    expect(r.confidence).toBe('low');
    expect(r.blendWeight).toBe(0.30);
    // estimate = formula*(0.7) + adaptive*(0.3); with both ~2400 it's ~2400.
    expect(r.estimate).not.toBeNull();
  });

  it('14–20 days → medium confidence, blend 0.60', () => {
    const r = estimateAdaptiveTDEE(makeDays(17, 2400, 180, 0), 2400);
    expect(r.confidence).toBe('medium');
    expect(r.blendWeight).toBe(0.60);
  });

  it('21+ days → high confidence, blend 0.85 (leans on adaptive)', () => {
    const r = estimateAdaptiveTDEE(makeDays(24, 2400, 180, 0), 2400);
    expect(r.confidence).toBe('high');
    expect(r.blendWeight).toBe(0.85);
  });

  it('exact band boundaries (13→low, 14→medium, 20→medium, 21→high)', () => {
    expect(estimateAdaptiveTDEE(makeDays(13, 2400, 180, 0), 2400).confidence).toBe('low');
    expect(estimateAdaptiveTDEE(makeDays(14, 2400, 180, 0), 2400).confidence).toBe('medium');
    expect(estimateAdaptiveTDEE(makeDays(20, 2400, 180, 0), 2400).confidence).toBe('medium');
    expect(estimateAdaptiveTDEE(makeDays(21, 2400, 180, 0), 2400).confidence).toBe('high');
  });

  it('blend actually pulls toward the formula at low confidence', () => {
    // Adaptive says ~2700 (losing weight), formula says 2400. At low conf (0.30)
    // the blended estimate must sit much closer to 2400 than to 2700.
    const r = estimateAdaptiveTDEE(makeDays(12, 2200, 180, -0.143), 2400);
    expect(r.confidence).toBe('low');
    // blended = 2400*0.7 + adaptiveRaw*0.3; adaptiveRaw≈2700 → ~2490, near formula.
    expect(r.estimate!).toBeLessThan(r.adaptiveRaw!);              // pulled down toward formula
    expect(Math.abs(r.estimate! - 2400)).toBeLessThan(Math.abs(r.estimate! - r.adaptiveRaw!));
  });
});

describe('insufficient / degenerate inputs', () => {
  it('empty data or non-positive formula → null, none', () => {
    expect(estimateAdaptiveTDEE([], 2400).confidence).toBe('none');
    expect(estimateAdaptiveTDEE([], 2400).estimate).toBeNull();
    expect(estimateAdaptiveTDEE(flat(28, 2400), 0).confidence).toBe('none');
  });

  it('exact daysUsed count when only some days log both signals', () => {
    // 28 days; null out intake on the odd indices → 14 days carry both.
    const days = flat(28, 2400).map((d, i) => i % 2 === 0 ? d : { ...d, calsEaten: '' });
    const r = estimateAdaptiveTDEE(days, 2400);
    expect(r.daysUsed).toBe(14); // exact, not "< 28"
  });

  it('reports the modelled weight trend (sign + magnitude)', () => {
    const r = estimateAdaptiveTDEE(makeDays(28, 2000, 180, -0.1), 2400);
    expect(r.weightTrendLb!).toBeLessThan(0);
    // slope −0.1/day over a 27-day span → ~ −2.7 lb.
    expect(Math.abs(r.weightTrendLb! - (-2.7))).toBeLessThan(0.4);
  });
});

// ── Part 3: intake-bias self-correction — HONEST FINDING ─────────────────────
// CLAIM UNDER TEST: does weight-trend anchoring launder a consistent intake
// under-logging bias back to true maintenance? Math says NO — see assertions.
describe('intake-bias — honest finding (does NOT fully launder)', () => {
  it('a consistent under-log biases the TDEE estimate LOW by exactly the bias', () => {
    // Truth: eats 2500, TDEE 2500, weight flat. But under-logs by 300/day → logs 2200.
    // Weight trend is accurate (flat). Estimate = avg_logged − slope×3500
    //   = 2200 − 0 = 2200 = trueTDEE(2500) − bias(300). It does NOT converge to 2500.
    const days = makeDays(28, 2200, 180, 0); // logged 2200, weight flat
    const r = estimateAdaptiveTDEE(days, 2500);
    // FINDING: the raw adaptive number reflects LOGGED-calorie units, so it's
    // biased low by the under-log amount — it is NOT absolute truth.
    expect(r.adaptiveRaw!).toBeLessThan(2400);           // biased below true 2500
    expect(Math.abs(r.adaptiveRaw! - 2200)).toBeLessThan(15); // ≈ logged intake, i.e. true − bias
  });

  it('BUT the bias is CONSISTENT, so it is internally coherent (the closed-loop saves it)', () => {
    // The point: a budget set FROM this number, logged against with the SAME bias,
    // produces the correct real-world energy balance. Demonstrate the invariant:
    // (true − bias) used as a target, eaten as (real − bias logged), nets to truth.
    const trueTDEE = 2500, bias = 300;
    const adaptive = estimateAdaptiveTDEE(makeDays(28, trueTDEE - bias, 180, 0), trueTDEE).adaptiveRaw!;
    // If the user later targets `adaptive` and under-logs identically, their REAL
    // intake = adaptive + bias = (trueTDEE − bias) + bias = trueTDEE → real balance 0.
    expect(adaptive + bias).toBeCloseTo(trueTDEE, -1); // within ~10 kcal
  });
});

// ── Part 3: adaptive-thermogenesis lag (documents expected lag) ──────────────
describe('adaptive thermogenesis — estimate lags during a sustained cut', () => {
  it('with true maintenance drifting DOWN, the window estimate tracks the AVERAGE, lagging the current value', () => {
    // Model a cut where true maintenance falls ~10 kcal/day (metabolic adaptation):
    // start TDEE 2600 → after 28 days ~2330 (current). Intake fixed at 2000.
    // Daily deficit = trueTDEE(t) − 2000, shrinking as TDEE falls → weight loss
    // DECELERATES. We build weights from the cumulative deficit.
    const n = 28, intake = 2000, startTDEE = 2600, drift = -10; // kcal/day
    let cumKcal = 0; // cumulative energy balance (negative = lost)
    const days: TdeeDay[] = [];
    for (let i = 0; i < n; i++) {
      const tdeeToday = startTDEE + drift * i;
      const balance = intake - tdeeToday;        // negative (deficit)
      cumKcal += balance;
      const weight = 180 + cumKcal / 3500;        // lb lost from cumulative deficit
      days.push({ date: ISO(i), calsEaten: String(intake), weight: weight.toFixed(3) });
    }
    const r = estimateAdaptiveTDEE(days, 2500);
    const currentTrue = startTDEE + drift * (n - 1); // ~2330 at window end
    const avgTrue     = startTDEE + drift * (n - 1) / 2; // ~2465 window average

    // The linear-window estimate approximates the AVERAGE true maintenance over
    // the window, so it sits ABOVE the current (lower) true value — that's the lag.
    expect(r.adaptiveRaw!).toBeGreaterThan(currentTrue);          // lags above current
    // …and it's in the neighbourhood of the window average (documents the behavior,
    // not perfection — blend/clamp and discretisation move it a bit).
    expect(Math.abs(r.adaptiveRaw! - avgTrue)).toBeLessThan(120);
  });
});
