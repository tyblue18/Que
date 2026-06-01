/**
 * lib/lifting/volume.test.ts
 *
 * Locks the volume-progression mesocycle: the week is derived from
 * mesoStartDate, sets ramp +1/week toward the deload, the final week halves
 * volume, "complete" is detected past the block, landmark bands classify a
 * muscle's weekly volume, and the autoregulated deload signal fires only when
 * 2+ lifts regressed within the last week.
 */

import { describe, it, expect } from 'vitest';
import { generateProgram, type LiftingProgram } from '@/lib/lifting/program';
import {
  currentMeso, weekAdjustedSets, weekAdjustedDays, currentWeeklyVolume,
  volumeBand, landmarkFor, deloadSignal, startNextMeso,
} from '@/lib/lifting/volume';
import type { LoggedDay } from '@/lib/lifting/progression';

// A program anchored to a known meso start so week math is deterministic.
const prog = (mesoStartDate: string): LiftingProgram => ({
  ...generateProgram({ daysPerWeek: 4, goal: 'hypertrophy', experience: 'intermediate' }),
  mesoStartDate, mesoWeeks: 5,
});

const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe('currentMeso', () => {
  const start = '2026-01-05';
  it('week 1 on the start date — base volume, no added sets', () => {
    const m = currentMeso(prog(start), start);
    expect(m.week).toBe(1);
    expect(m.addSets).toBe(0);
    expect(m.isDeload).toBe(false);
  });

  it('ramps +1 set/week through the block', () => {
    expect(currentMeso(prog(start), addDays(start, 7)).addSets).toBe(1);  // week 2
    expect(currentMeso(prog(start), addDays(start, 14)).addSets).toBe(2); // week 3
    expect(currentMeso(prog(start), addDays(start, 21)).addSets).toBe(3); // week 4
  });

  it('final week is a deload (no added sets)', () => {
    const m = currentMeso(prog(start), addDays(start, 28)); // week 5
    expect(m.week).toBe(5);
    expect(m.isDeload).toBe(true);
    expect(m.addSets).toBe(0);
  });

  it('detects a completed mesocycle past the block', () => {
    const m = currentMeso(prog(start), addDays(start, 35)); // week 6 → beyond 5
    expect(m.complete).toBe(true);
    expect(m.week).toBe(5); // clamped
  });

  it('falls back to createdAt when mesoStartDate is absent (legacy program)', () => {
    const base = generateProgram({ daysPerWeek: 3, goal: 'general', experience: 'beginner' });
    const legacy = { ...base, mesoStartDate: undefined } as LiftingProgram;
    const m = currentMeso(legacy, base.createdAt);
    expect(m.week).toBe(1);
  });
});

describe('weekAdjustedSets', () => {
  const start = '2026-01-05';
  it('adds the ramp sets on top of the week-1 baseline', () => {
    const wk3 = currentMeso(prog(start), addDays(start, 14)); // +2
    expect(weekAdjustedSets(4, wk3)).toBe(6);
  });
  it('halves (rounded, min 1) on the deload week', () => {
    const wk5 = currentMeso(prog(start), addDays(start, 28));
    expect(weekAdjustedSets(4, wk5)).toBe(2);
    expect(weekAdjustedSets(3, wk5)).toBe(2); // round(1.5)=2
    expect(weekAdjustedSets(1, wk5)).toBe(1); // floor at 1
  });
});

describe('weekAdjustedDays / currentWeeklyVolume', () => {
  it('week-3 volume exceeds week-1 volume (the ramp moves the primary driver)', () => {
    const start = '2026-01-05';
    const p = prog(start);
    const wk1 = currentWeeklyVolume(p, start);
    const wk3 = currentWeeklyVolume(p, addDays(start, 14));
    // every trained muscle should have at least as much, and the total more.
    const sum = (v: Record<string, number>) => Object.values(v).reduce((a, b) => a + b, 0);
    expect(sum(wk3)).toBeGreaterThan(sum(wk1));
  });

  it('deload week volume is below week 1', () => {
    const start = '2026-01-05';
    const p = prog(start);
    const sum = (v: Record<string, number>) => Object.values(v).reduce((a, b) => a + b, 0);
    expect(sum(currentWeeklyVolume(p, addDays(start, 28)))).toBeLessThan(sum(currentWeeklyVolume(p, start)));
  });
});

describe('volumeBand', () => {
  it('classifies against MEV / MAV / MRV', () => {
    const { mev, mav, mrv } = landmarkFor('chest'); // 10 / 18 / 22
    expect(volumeBand('chest', mev - 1)).toBe('below');
    expect(volumeBand('chest', mev + 1)).toBe('building');
    expect(volumeBand('chest', mav + 1)).toBe('optimal');
    expect(volumeBand('chest', mrv + 1)).toBe('over');
  });
});

describe('deloadSignal (autoregulated)', () => {
  const today = '2026-02-01';
  // Build a localDB where N program lifts logged a recent "missed the bottom"
  // session (reps below the prescribed range) → each yields a 'hold' advice.
  // Optional sessFeel stamps the recent day for the readiness marker.
  function dbMissing(program: LiftingProgram, n: number, feel?: number): Record<string, LoggedDay> {
    const lifts = [...new Set(program.days.flatMap(d => d.exercises))].slice(0, n);
    const day = addDays(today, -3);
    return {
      [day]: {
        exercises: JSON.stringify(lifts.map(ex => ({
          k: 'lift', n: ex.name, g: ex.group,
          sets: [{ r: String(ex.repLow - 2), w: '100' }], // below range → miss
        }))),
        ...(feel != null && { sessFeel: feel }),
      },
    };
  }

  it('fires on STRONG regression alone (3+ lifts), no feel needed', () => {
    const p = prog('2026-01-05');
    const sig = deloadSignal(p, dbMissing(p, 3), today);
    expect(sig.due).toBe(true);
    expect(sig.missed).toBeGreaterThanOrEqual(3);
  });

  it('does NOT fire on MODERATE regression (2 lifts) without corroborating low feel', () => {
    const p = prog('2026-01-05');
    const sig = deloadSignal(p, dbMissing(p, 2), today);
    expect(sig.due).toBe(false);
    expect(sig.missed).toBe(2);
  });

  it('FIRES on moderate regression (2 lifts) WHEN sessions also felt rough', () => {
    const p = prog('2026-01-05');
    const sig = deloadSignal(p, dbMissing(p, 2, 3), today); // feel 3 ≤ threshold
    expect(sig.due).toBe(true);
    expect(sig.lowFeel).toBe(true);
    expect(sig.avgFeel).toBe(3);
  });

  it('does NOT fire for a single regressed lift even with low feel', () => {
    const p = prog('2026-01-05');
    const sig = deloadSignal(p, dbMissing(p, 1, 2), today);
    expect(sig.due).toBe(false);
  });

  it('does NOT fire on stale misses outside the recent window', () => {
    const p = prog('2026-01-05');
    const lifts = [...new Set(p.days.flatMap(d => d.exercises))].slice(0, 3);
    const old = addDays(today, -30);
    const db: Record<string, LoggedDay> = {
      [old]: { exercises: JSON.stringify(lifts.map(ex => ({ k: 'lift', n: ex.name, g: ex.group, sets: [{ r: String(ex.repLow - 2), w: '100' }] }))) },
    };
    expect(deloadSignal(p, db, today).due).toBe(false);
  });

  it('reports avgFeel as null when no feel was logged', () => {
    const p = prog('2026-01-05');
    expect(deloadSignal(p, dbMissing(p, 3), today).avgFeel).toBeNull();
  });
});

describe('startNextMeso', () => {
  it('resets the mesocycle anchor to today (back to week 1)', () => {
    const p = prog('2026-01-05');
    const next = startNextMeso(p, '2026-02-10');
    expect(next.mesoStartDate).toBe('2026-02-10');
    expect(currentMeso(next, '2026-02-10').week).toBe(1);
  });
});
