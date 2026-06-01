/**
 * lib/lifting/alternatives.test.ts
 *
 * Locks the movement-family / muscle-mapping layer that powers exercise swaps:
 *   • an exercise's alternatives share its primary + secondary muscles and role
 *     (so a swap preserves volume credit and the prescription)
 *   • the canonical movement lists its own variations (incl. itself)
 *   • the motivating case — Bench Press ↔ Dumbbell Bench Press — links
 *   • unknown / single-member movements offer no swap
 */

import { describe, it, expect } from 'vitest';
import { alternativesFor, hasAlternatives } from '@/lib/lifting/alternatives';

describe('alternativesFor', () => {
  it('links Bench Press and Dumbbell Bench Press (the motivating case)', () => {
    const alts = alternativesFor('Bench Press').map(a => a.name);
    expect(alts).toContain('Bench Press');           // includes itself (shown selected)
    expect(alts).toContain('Dumbbell Bench Press');
  });

  it('every alternative shares the source exercise’s muscle mapping + role', () => {
    const alts = alternativesFor('Bench Press');
    for (const a of alts) {
      expect(a.group).toBe('chest');
      expect(a.secondary).toEqual(['tricep', 'shoulders']);
      expect(a.role).toBe('compound');
    }
  });

  it('keeps isolation families isolation (no role drift on swap)', () => {
    for (const a of alternativesFor('Dumbbell Curl')) {
      expect(a.group).toBe('bicep');
      expect(a.role).toBe('isolation');
    }
  });

  it('returns [] for an unknown exercise', () => {
    expect(alternativesFor('Tibialis Raise')).toEqual([]);
  });
});

describe('hasAlternatives', () => {
  it('true for a movement with variations', () => {
    expect(hasAlternatives('Back Squat')).toBe(true);
  });
  it('false for an unknown movement', () => {
    expect(hasAlternatives('Tibialis Raise')).toBe(false);
  });
});
