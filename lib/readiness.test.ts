/**
 * lib/readiness.test.ts
 *
 * Locks the daily readiness assessment: baselines from the athlete's OWN
 * rolling history, deviation-based penalties, absolute sleep bands, tiering,
 * and the no-data / insufficient-baseline behaviors — plus the deload trigger's
 * third (objective recovery) marker corroborating moderate regression.
 */

import { describe, it, expect } from 'vitest';
import { computeReadiness, type WellnessDay } from '@/lib/readiness';

const TODAY = '2026-08-17';

/** Build a DB with `n` baseline days (ending yesterday) of steady values, plus
 *  today's reading. */
function dbWith(todayRec: WellnessDay, baseline: WellnessDay = { hrv: 60, restingHr: 50 }, n = 14): Record<string, WellnessDay> {
  const db: Record<string, WellnessDay> = {};
  for (let i = 1; i <= n; i++) {
    const d = new Date(Date.parse(`${TODAY}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10);
    db[d] = { ...baseline };
  }
  db[TODAY] = todayRec;
  return db;
}

describe('computeReadiness', () => {
  it('reports unavailable with no wellness data at all', () => {
    const r = computeReadiness({}, TODAY);
    expect(r.available).toBe(false);
  });

  it('steady readings on baseline → ready, no reasons', () => {
    const r = computeReadiness(dbWith({ hrv: 60, restingHr: 50, sleepMin: 460, sleepScore: 85, bodyBattery: 95 }), TODAY);
    expect(r.available).toBe(true);
    expect(r.tier).toBe('ready');
    expect(r.score).toBe(100);
    expect(r.reasons).toEqual([]);
    expect(r.hrvBaseline).toBeCloseTo(60, 5);
  });

  it('strong HRV suppression + elevated RHR + short sleep → low tier with reasons', () => {
    const r = computeReadiness(dbWith({ hrv: 48, restingHr: 59, sleepMin: 340, bodyBattery: 55 }), TODAY);
    // hrv 20% down (−30), rhr +9 (−20), sleep <6h (−15), battery <60 (−10) → 25
    expect(r.score).toBe(25);
    expect(r.tier).toBe('low');
    expect(r.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it('mild deviations land in the moderate band', () => {
    const r = computeReadiness(dbWith({ hrv: 54, restingHr: 55, sleepMin: 350 }), TODAY);
    // hrv 10% down (−15), rhr +5 (−10), short sleep (−15) → 60
    expect(r.score).toBe(60);
    expect(r.tier).toBe('moderate');
  });

  it('skips baseline-relative signals when history is too thin (< 5 readings)', () => {
    const r = computeReadiness(dbWith({ hrv: 40, restingHr: 70, sleepMin: 480 }, { hrv: 60, restingHr: 50 }, 3), TODAY);
    // Only 3 baseline days → HRV/RHR judged not at all; sleep fine → ready.
    expect(r.hrvBaseline).toBeNull();
    expect(r.tier).toBe('ready');
  });

  it('uses the most recent reading within the 2-day lookback (morning-data lag)', () => {
    const db = dbWith({}, { hrv: 60, restingHr: 50 }, 14);
    // No reading today; yesterday already exists as a baseline day with hrv 60.
    const r = computeReadiness(db, TODAY);
    expect(r.available).toBe(true);
    expect(r.latestDate).not.toBe(TODAY);
  });

  it('sleep score is the fallback when duration is missing', () => {
    const r = computeReadiness(dbWith({ hrv: 60, restingHr: 50, sleepScore: 50 }), TODAY);
    expect(r.score).toBe(90); // score <60 → −10
    expect(r.reasons[0]).toMatch(/sleep score/i);
  });
});

describe('deloadSignal — objective recovery as the third marker', () => {
  it('moderate regression + low recovery (no sessFeel at all) triggers the deload', async () => {
    const { deloadSignal } = await import('@/lib/lifting/volume');
    const { generateProgram } = await import('@/lib/lifting/program');
    const program = generateProgram({ daysPerWeek: 3, goal: 'hypertrophy', experience: 'intermediate' });

    // Two program lifts logged recently, both MISSING the bottom of their rep
    // range twice (progressionAdvice → 'hold'), on a body with crashed wellness.
    const [exA, exB] = program.days[0].exercises;
    const mkDay = (exs: typeof program.days[0]['exercises']) => JSON.stringify(
      exs.map(e => ({ k: 'lift', n: e.name, sets: Array.from({ length: e.sets }, () => ({ r: String(e.repLow - 2), w: '100' })) })),
    );
    const wellness = { hrv: 45, restingHr: 60, sleepMin: 320 }; // vs 60/50 baseline → low
    type Day = { hrv?: number; restingHr?: number; sleepMin?: number; exercises?: string };
    const db: Record<string, Day> = {};
    for (let i = 1; i <= 14; i++) {
      const d = new Date(Date.parse(`${TODAY}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10);
      db[d] = { hrv: 60, restingHr: 50 };
    }
    const recent = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    db[recent(6)] = { ...db[recent(6)], exercises: mkDay([exA, exB]) };
    db[recent(2)] = { ...db[recent(2)], exercises: mkDay([exA, exB]) };
    db[TODAY] = wellness;

    const sig = deloadSignal(program, db, TODAY);
    expect(sig.missed).toBeGreaterThanOrEqual(2);
    expect(sig.lowFeel).toBe(false);        // no sessFeel logged anywhere
    expect(sig.lowRecovery).toBe(true);     // objective marker fires instead
    expect(sig.due).toBe(true);
  });
});
