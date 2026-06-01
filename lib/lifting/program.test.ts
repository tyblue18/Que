/**
 * lib/lifting/program.test.ts
 *
 * Locks the evidence-based lifting-program generator:
 *   • split selection by days/week and experience
 *   • Tier-1 VOLUME: fractional set counting (0.5 to secondary movers) and the
 *     experience-scaled weekly target
 *   • Tier-1 PROXIMITY TO FAILURE: every set carries an RIR target in 0–3
 *   • Tier-2 LOAD/REPS: practicality-based ranges; strength uses heavy/low reps
 *   • protein band (1.6–2.2 g/kg) + per-meal dose
 *   • day clamping and the PR-based working-weight suggestion
 */

import { describe, it, expect } from 'vitest';
import {
  generateProgram, suggestedWorkingLb, computeWeeklyVolume, proteinTargets,
  type LiftingInputs,
} from '@/lib/lifting/program';

const make = (o: Partial<LiftingInputs> = {}) =>
  generateProgram({ daysPerWeek: 3, goal: 'hypertrophy', experience: 'intermediate', ...o });

describe('generateProgram — split selection', () => {
  it('2 days → full body, 2 days', () => {
    const p = make({ daysPerWeek: 2 });
    expect(p.splitName).toBe('Full Body');
    expect(p.days).toHaveLength(2);
  });

  it('3 days intermediate → PPL', () => {
    const p = make({ daysPerWeek: 3, experience: 'intermediate' });
    expect(p.splitName).toBe('Push / Pull / Legs');
    expect(p.days.map(d => d.name)).toEqual(['Push', 'Pull', 'Legs']);
  });

  it('3 days beginner → full body (more practice per lift)', () => {
    const p = make({ daysPerWeek: 3, experience: 'beginner' });
    expect(p.splitName).toBe('Full Body');
    expect(p.days).toHaveLength(3);
  });

  it('4 days → upper/lower; 6 days → 6 distinct days', () => {
    expect(make({ daysPerWeek: 4 }).days).toHaveLength(4);
    const six = make({ daysPerWeek: 6 });
    expect(six.days).toHaveLength(6);
    expect(new Set(six.days.map(d => d.name)).size).toBe(6);
  });

  it('clamps out-of-range day counts to 2–6', () => {
    expect(make({ daysPerWeek: 1 }).daysPerWeek).toBe(2);
    expect(make({ daysPerWeek: 9 }).daysPerWeek).toBe(6);
  });
});

describe('Tier 1 — volume (fractional set counting)', () => {
  it('credits a compound 1.0 to its primary and 0.5 to each secondary mover', () => {
    // One bench (3×, say) → chest full, triceps + shoulders half.
    const days = [{
      name: 'T', focus: '', exercises: [{
        name: 'Bench Press', group: 'chest', secondary: ['tricep', 'shoulders'],
        role: 'compound' as const, sets: 4, repLow: 6, repHigh: 10, rirLow: 1, rirHigh: 3, restSec: 150,
      }],
    }];
    const vol = computeWeeklyVolume(days);
    expect(vol.chest).toBe(4);
    expect(vol.tricep).toBe(2);     // 4 × 0.5
    expect(vol.shoulders).toBe(2);
  });

  it('a generated program reports per-muscle weekly volume summed across days', () => {
    const p = make({ daysPerWeek: 4, goal: 'hypertrophy', experience: 'intermediate' });
    // chest is trained directly + assisted by overhead pressing across the week
    expect(p.weeklyVolume.chest).toBeGreaterThan(0);
    // direct chest work should clear the ~4-set growth minimum
    expect(p.weeklyVolume.chest).toBeGreaterThanOrEqual(4);
  });

  it('weekly target scales with experience and is higher for hypertrophy than general', () => {
    expect(make({ experience: 'beginner' }).weeklyTarget)
      .toBeLessThan(make({ experience: 'advanced' }).weeklyTarget);
    expect(make({ goal: 'hypertrophy' }).weeklyTarget)
      .toBeGreaterThan(make({ goal: 'general' }).weeklyTarget);
  });

  it('advanced adds a set to every movement (the volume lever)', () => {
    const adv = make({ experience: 'advanced', goal: 'hypertrophy' });
    const int = make({ experience: 'intermediate', goal: 'hypertrophy' });
    const advCompound = adv.days[0].exercises.find(e => e.role === 'compound')!;
    const intCompound = int.days[0].exercises.find(e => e.role === 'compound')!;
    expect(advCompound.sets).toBe(intCompound.sets + 1);
  });
});

describe('Tier 1 — proximity to failure (RIR)', () => {
  it('every set carries an RIR target within 0–3', () => {
    const p = make({ daysPerWeek: 6, goal: 'hypertrophy', experience: 'advanced' });
    for (const d of p.days) for (const e of d.exercises) {
      expect(e.rirLow).toBeGreaterThanOrEqual(0);
      expect(e.rirHigh).toBeLessThanOrEqual(3);
      expect(e.rirLow).toBeLessThanOrEqual(e.rirHigh);
    }
  });

  it('hypertrophy pushes isolation closer to failure than compounds', () => {
    const p = make({ goal: 'hypertrophy' });
    const iso = p.days.flatMap(d => d.exercises).find(e => e.role === 'isolation')!;
    const comp = p.days.flatMap(d => d.exercises).find(e => e.role === 'compound')!;
    expect(iso.rirLow).toBeLessThanOrEqual(comp.rirLow);
  });
});

describe('Tier 2 — load / rep ranges', () => {
  it('strength uses heavy, low-rep compounds', () => {
    const p = make({ goal: 'strength', daysPerWeek: 3, experience: 'intermediate' });
    const compound = p.days[0].exercises.find(e => e.role === 'compound')!;
    expect(compound.repHigh).toBeLessThanOrEqual(6);
  });

  it('hypertrophy uses practicality-based ranges (pressing lower-rep than isolation)', () => {
    const p = make({ goal: 'hypertrophy' });
    const press = p.days.flatMap(d => d.exercises).find(e => e.name === 'Bench Press' || e.name === 'Overhead Press')!;
    const iso = p.days.flatMap(d => d.exercises).find(e => e.role === 'isolation')!;
    expect(press.repHigh).toBeLessThanOrEqual(10);
    expect(iso.repHigh).toBeGreaterThanOrEqual(12);
  });

  it('every exercise has a valid group, positive sets, and rest prescribed', () => {
    const p = make({ daysPerWeek: 6 });
    for (const d of p.days) for (const e of d.exercises) {
      expect(e.group).toBeTruthy();
      expect(e.sets).toBeGreaterThan(0);
      expect(e.repHigh).toBeGreaterThanOrEqual(e.repLow);
      expect(e.restSec).toBeGreaterThan(0);
    }
  });
});

describe('nutrition — protein band', () => {
  it('computes 1.6–2.2 g/kg/day and a 0.25–0.40 g/kg per-meal dose', () => {
    const t = proteinTargets(80);
    expect(t.lowG).toBe(128);  // 1.6 × 80
    expect(t.highG).toBe(176); // 2.2 × 80
    expect(t.perMealLowG).toBe(20);  // 0.25 × 80
    expect(t.perMealHighG).toBe(32); // 0.40 × 80
  });

  it('only attaches a protein target when bodyweight is provided', () => {
    expect(make().protein).toBeNull();
    expect(make({ bodyweightKg: 80 }).protein).not.toBeNull();
  });
});

describe('suggestedWorkingLb', () => {
  it('scales the PR by goal intensity, rounded to nearest 5 lb', () => {
    expect(suggestedWorkingLb(200, 'strength')).toBe(170);    // 0.85 → 170
    expect(suggestedWorkingLb(200, 'hypertrophy')).toBe(145); // 0.72 → 144 → 145
    expect(suggestedWorkingLb(200, 'general')).toBe(150);     // 0.75 → 150
  });

  it('returns null when no PR is known', () => {
    expect(suggestedWorkingLb(undefined, 'strength')).toBeNull();
    expect(suggestedWorkingLb(0, 'strength')).toBeNull();
  });
});

describe('regression — starts with cursor at the first day', () => {
  it('cursor 0', () => { expect(make().cursor).toBe(0); });
});
