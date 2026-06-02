/**
 * lib/trainingBlock.test.ts
 *
 * Locks the periodized training-block engine. Tests are written so wrong
 * behavior FAILS: the periodization (phase/deload pattern), the concurrent-
 * training safety rules (one rest day, AM/PM-separated two-a-days, no heavy
 * lifting on a long-endurance day, a brick for Ironman), and the calendar
 * window math (blockForDate boundaries) are all asserted, not assumed.
 */

import { describe, it, expect } from 'vitest';
import {
  phaseLayout, generateBlockSkeleton, blockForDate, weekInfoForDate,
  weekLoadIndex, trainingDayCount, isBrickDay,
  type BlockWeeks, type TrainingBlock,
} from '@/lib/trainingBlock';

const ALL_LENGTHS: BlockWeeks[] = [4, 6, 8, 10, 12];

function shift(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('phaseLayout', () => {
  it('has the right length and always tapers (+deloads) the final week', () => {
    for (const w of ALL_LENGTHS) {
      const layout = phaseLayout(w);
      expect(layout).toHaveLength(w);
      expect(layout[0].phase).toBe('base');               // always start in base
      expect(layout[w - 1].phase).toBe('taper');          // always end in taper
      expect(layout[w - 1].isDeload).toBe(true);          // taper week is a deload
    }
  });

  it('8/10/12-week blocks deload every 4th week', () => {
    for (const w of [8, 10, 12] as BlockWeeks[]) {
      const layout = phaseLayout(w);
      expect(layout[3].isDeload).toBe(true);  // week 4
      if (w >= 8) expect(layout[7].isDeload).toBe(true); // week 8
    }
  });

  it('short blocks (4/6) load straight through to the taper (no mid-block deload)', () => {
    expect(phaseLayout(4).slice(0, 3).every(p => !p.isDeload)).toBe(true);
    expect(phaseLayout(6).slice(0, 5).every(p => !p.isDeload)).toBe(true);
  });
});

describe('generateBlockSkeleton — structure', () => {
  const block = generateBlockSkeleton('ironman', 8, 6, '2026-06-07');

  it('produces `weeks` weeks, each with 7 days (dow 0..6)', () => {
    expect(block.weeksData).toHaveLength(8);
    for (const wk of block.weeksData) {
      expect(wk.days).toHaveLength(7);
      expect(wk.days.map(d => d.dow)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
  });

  it('respects daysPerWeek: exactly that many training days, ≥1 rest', () => {
    for (const dpw of [3, 4, 5, 6]) {
      const b = generateBlockSkeleton('ironman', 8, dpw, '2026-06-07');
      for (const wk of b.weeksData) {
        expect(trainingDayCount(wk)).toBe(dpw);
        expect(wk.days.filter(d => d.sessions.length === 0).length).toBe(7 - dpw);
      }
    }
  });

  it('clamps daysPerWeek to 3..6 (always leaves a rest day)', () => {
    const b = generateBlockSkeleton('ironman', 8, 9, '2026-06-07'); // 9 → clamp 6
    expect(trainingDayCount(b.weeksData[0])).toBe(6);
  });
});

describe('generateBlockSkeleton — concurrent-training safety rules', () => {
  const block = generateBlockSkeleton('ironman', 12, 6, '2026-06-07');

  it('never double-books a time-of-day (two-a-days are AM/PM separated)', () => {
    for (const wk of block.weeksData) {
      for (const day of wk.days) {
        const slots = day.sessions.map(s => s.timeOfDay);
        expect(new Set(slots).size).toBe(slots.length); // all distinct → no two AM
      }
    }
  });

  it('keeps heavy lifting OFF any day with a long endurance session', () => {
    for (const wk of block.weeksData) {
      for (const day of wk.days) {
        const hasLong = day.sessions.some(s => s.intensity === 'long');
        const hasLift = day.sessions.some(s => s.discipline === 'lift');
        expect(hasLong && hasLift).toBe(false);
      }
    }
  });

  it('schedules a weekly brick (bike + run same day) for Ironman', () => {
    for (const wk of block.weeksData) {
      expect(wk.days.some(isBrickDay)).toBe(true);
    }
  });

  it('includes 2 lift sessions/week (strength maintenance) for Ironman', () => {
    const lifts = block.weeksData[0].days
      .flatMap(d => d.sessions)
      .filter(s => s.discipline === 'lift');
    expect(lifts.length).toBe(2);
  });
});

describe('generateBlockSkeleton — periodization modulates load', () => {
  it('a deload week carries less load than the load week before it', () => {
    const b = generateBlockSkeleton('ironman', 8, 6, '2026-06-07');
    // week 4 (index 3) is a deload; week 3 (index 2) is a load week, same phase.
    expect(weekLoadIndex(b.weeksData[3])).toBeLessThan(weekLoadIndex(b.weeksData[2]));
  });

  it('base phase downgrades hard cardio (no interval work in week 1)', () => {
    const b = generateBlockSkeleton('ironman', 12, 6, '2026-06-07');
    const wk1Intensities = b.weeksData[0].days.flatMap(d => d.sessions.map(s => s.intensity));
    expect(wk1Intensities).not.toContain('interval');
  });
});

describe('generateBlockSkeleton — blank/custom', () => {
  it('produces phased weeks with NO sessions', () => {
    const b = generateBlockSkeleton('custom', 6, 5, '2026-06-07');
    expect(b.weeksData).toHaveLength(6);
    expect(b.weeksData.flatMap(w => w.days).every(d => d.sessions.length === 0)).toBe(true);
    expect(b.weeksData[5].phase).toBe('taper'); // phases still scaffolded
  });
});

describe('blockForDate — calendar window math', () => {
  const start = '2026-06-07';
  const block: TrainingBlock = generateBlockSkeleton('ironman', 8, 6, start);

  it('maps start date → week 1, dow 0 (the long-run session)', () => {
    const sessions = blockForDate(block, start);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].discipline).toBe('run');
    expect(sessions[0].intensity).toBe('long');
  });

  it('maps a mid-block date to the correct week/day', () => {
    // +8 days = week 2 (index1), dow 1 (Mon) → swim AM + lift PM
    const sessions = blockForDate(block, shift(start, 8));
    expect(sessions.map(s => s.discipline).sort()).toEqual(['lift', 'swim']);
    expect(weekInfoForDate(block, shift(start, 8))?.weekNumber).toBe(2);
  });

  it('returns [] before the block starts', () => {
    expect(blockForDate(block, shift(start, -1))).toEqual([]);
    expect(weekInfoForDate(block, shift(start, -1))).toBeNull();
  });

  it('includes the final day and excludes the day after the block ends', () => {
    const lastDay = shift(start, 8 * 7 - 1);   // last valid day
    const afterEnd = shift(start, 8 * 7);       // one past the window
    expect(weekInfoForDate(block, lastDay)?.weekNumber).toBe(8);
    expect(blockForDate(block, afterEnd)).toEqual([]);
    expect(weekInfoForDate(block, afterEnd)).toBeNull();
  });
});
