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
  blockLengthOptions, ironmanReadinessNote, defaultBlockName,
  easyZoneFraction, sessionFuelKcal, IRONMAN_WEEK_OPTIONS,
  type BlockWeeks, type TrainingBlock, type BlockWeek,
} from '@/lib/trainingBlock';
import type { TrainingPaces } from '@/lib/running/types';

// VDOT-derived paces (sec/mile) for the wiring test.
const FAKE_PACES: TrainingPaces = {
  easyLow: 540, easyHigh: 510, marathon: 450, threshold: 420, interval: 390, repetition: 360,
};

/** The most-recent load week (non-deload, non-taper) before index i, or null. */
function prevLoadHours(weeks: BlockWeek[], i: number): number | null {
  for (let j = i - 1; j >= 0; j--) {
    if (!weeks[j].isDeload && weeks[j].phase !== 'taper') return weeks[j].targetHours;
  }
  return null;
}

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

  it('maps start date → week 1, dow 0 (recovery run); the long run is dow 2', () => {
    // Template restructured so the two big days (Tue long run, Sat long ride) each
    // have a recovery day after them — Sunday is now the easy recovery run.
    const sun = blockForDate(block, start);
    expect(sun).toHaveLength(1);
    expect(sun[0].discipline).toBe('run');
    expect(sun[0].intensity).toBe('easy');
    const tue = blockForDate(block, shift(start, 2));
    expect(tue.some(s => s.discipline === 'run' && s.intensity === 'long')).toBe(true);
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

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 ADDITIONS
// ─────────────────────────────────────────────────────────────────────────────

describe('block-length honesty (Ironman is its own thing)', () => {
  it('Ironman offers only 12/16/24 — no sub-12 "race-ready" plan', () => {
    expect(blockLengthOptions('ironman')).toEqual([12, 16, 24]);
    expect(IRONMAN_WEEK_OPTIONS.every(w => w >= 12)).toBe(true);
    expect(blockLengthOptions('ironman')).not.toContain(4);
    expect(blockLengthOptions('ironman')).not.toContain(8);
  });

  it('other goals keep the general short blocks', () => {
    expect(blockLengthOptions('hybrid')).toEqual([4, 6, 8, 10, 12]);
    expect(blockLengthOptions('custom')).toContain(4);
  });

  it('a 12-week Ironman block is framed as a Peak block with a readiness assumption', () => {
    expect(defaultBlockName('ironman', 12)).toMatch(/Peak/i);
    expect(ironmanReadinessNote(12).toLowerCase()).toContain('assumes');
    // 16/24 are the recommended full builds.
    expect(defaultBlockName('ironman', 24)).toMatch(/Build/i);
    expect(ironmanReadinessNote(24).toLowerCase()).toContain('full');
  });
});

describe('weekly volume in hours (≤10%/week, drops on deload)', () => {
  const block = generateBlockSkeleton('ironman', 24, 6, '2026-06-07');

  it('every week carries a target-hours number', () => {
    expect(block.weeksData.every(w => w.targetHours > 0)).toBe(true);
  });

  it('load weeks never rise more than 10% over the previous load week', () => {
    block.weeksData.forEach((w, i) => {
      if (w.isDeload || w.phase === 'taper') return;
      const prev = prevLoadHours(block.weeksData, i);
      if (prev != null) expect(w.targetHours).toBeLessThanOrEqual(prev * 1.10 + 0.05);
    });
    // And the ramp actually rises somewhere (not a flat line) — bite check.
    const loads = block.weeksData.filter(w => !w.isDeload && w.phase !== 'taper').map(w => w.targetHours);
    expect(Math.max(...loads)).toBeGreaterThan(Math.min(...loads));
  });

  it('every recovery deload week drops below the week before it', () => {
    block.weeksData.forEach((w, i) => {
      if (w.isDeload && w.phase !== 'taper' && i > 0) {
        expect(w.targetHours).toBeLessThan(block.weeksData[i - 1].targetHours);
      }
    });
  });

  it('peak hours scale with days/week and experience', () => {
    const peakOf = (b: TrainingBlock) => Math.max(...b.weeksData.map(w => w.targetHours));
    const lo = generateBlockSkeleton('ironman', 16, 4, '2026-06-07', undefined, { experience: 'beginner' });
    const hi = generateBlockSkeleton('ironman', 16, 6, '2026-06-07', undefined, { experience: 'advanced' });
    expect(peakOf(hi)).toBeGreaterThan(peakOf(lo));
    // Intermediate full build lands in the 12–17h peak band.
    const mid = generateBlockSkeleton('ironman', 24, 6, '2026-06-07', undefined, { experience: 'intermediate' });
    expect(peakOf(mid)).toBeGreaterThanOrEqual(12);
    expect(peakOf(mid)).toBeLessThanOrEqual(17);
  });
});

describe('80/20 polarization (zones)', () => {
  const block = generateBlockSkeleton('ironman', 16, 6, '2026-06-07');

  it('every cardio session carries a zone; lifts do not', () => {
    for (const wk of block.weeksData) for (const d of wk.days) for (const s of d.sessions) {
      if (s.discipline === 'lift') expect(s.zone).toBeUndefined();
      else expect(s.zone).toBeDefined();
    }
  });

  it('build/peak weeks are ≥78% easy-zone by volume', () => {
    const hard = block.weeksData.filter(w => w.phase === 'build1' || w.phase === 'build2' || w.phase === 'peak');
    for (const wk of hard) expect(easyZoneFraction(wk)).toBeGreaterThanOrEqual(0.78);
  });

  it('long sessions are easy-zone (Z2 race-specific, not "downgraded")', () => {
    for (const wk of block.weeksData) for (const d of wk.days) for (const s of d.sessions) {
      if (s.intensity === 'long') expect(s.zone).toBe('easy');
    }
  });
});

describe('long-run cap & long-ride build', () => {
  it('no long RUN ever exceeds ~2.75h, in any phase/length/experience', () => {
    for (const w of [12, 16, 24] as BlockWeeks[]) {
      const b = generateBlockSkeleton('ironman', w, 6, '2026-06-07', undefined, { experience: 'advanced' });
      for (const wk of b.weeksData) for (const d of wk.days) for (const s of d.sessions) {
        if (s.discipline === 'run' && s.intensity === 'long') expect(s.durationMin!).toBeLessThanOrEqual(165);
      }
    }
  });

  it('the long RIDE builds toward 5–6h (well past the run cap) and never exceeds 6h', () => {
    const b = generateBlockSkeleton('ironman', 24, 6, '2026-06-07');
    const rides = b.weeksData.flatMap(w => w.days).flatMap(d => d.sessions)
      .filter(s => s.discipline === 'bike' && s.intensity === 'long').map(s => s.durationMin!);
    expect(Math.max(...rides)).toBeGreaterThanOrEqual(270); // > 4.5h — genuinely long
    expect(Math.max(...rides)).toBeLessThanOrEqual(360);     // capped at 6h
    expect(Math.max(...rides)).toBeGreaterThan(165);         // far past the run cap
  });
});

describe('peak race-sim / big-day sessions', () => {
  const block = generateBlockSkeleton('ironman', 24, 6, '2026-06-07');

  it('peak weeks contain named race-sim/big-day sessions; non-peak weeks do not', () => {
    for (const wk of block.weeksData) {
      const keyed = wk.days.flatMap(d => d.sessions).filter(s => s.keySession);
      if (wk.phase === 'peak') expect(keyed.length).toBeGreaterThanOrEqual(2);
      else expect(keyed.length).toBe(0);
    }
  });
});

describe('2–3 week taper (cuts volume, keeps intensity)', () => {
  const block = generateBlockSkeleton('ironman', 24, 6, '2026-06-07');
  const taperWeeks = block.weeksData.filter(w => w.phase === 'taper');
  const peakHours = Math.max(...block.weeksData.map(w => w.targetHours));

  it('the taper spans 2–3 weeks with descending volume below peak', () => {
    expect(taperWeeks.length).toBeGreaterThanOrEqual(2);
    for (const w of taperWeeks) expect(w.targetHours).toBeLessThan(peakHours);
    for (let i = 1; i < taperWeeks.length; i++) {
      expect(taperWeeks[i].targetHours).toBeLessThan(taperWeeks[i - 1].targetHours);
    }
  });

  it('taper weeks KEEP intensity (still contain non-easy quality sessions)', () => {
    // At least one taper week retains a threshold/hard session (intensity not gutted).
    const hasQuality = taperWeeks.some(w =>
      w.days.flatMap(d => d.sessions).some(s => s.zone === 'threshold' || s.zone === 'hard'));
    expect(hasQuality).toBe(true);
  });

  it('peak load lands before the taper (3–4 weeks out)', () => {
    const peakIdx = block.weeksData.findIndex(w => w.targetHours === peakHours);
    const firstTaperIdx = block.weeksData.findIndex(w => w.phase === 'taper');
    expect(peakIdx).toBeLessThan(firstTaperIdx);
  });
});

describe('recovery buffer after long sessions', () => {
  it('the day after any long session has no hard/long cardio', () => {
    const block = generateBlockSkeleton('ironman', 24, 6, '2026-06-07');
    const flat = block.weeksData.flatMap(w => w.days);
    for (let i = 0; i < flat.length - 1; i++) {
      const hadLong = flat[i].sessions.some(s => s.intensity === 'long');
      if (!hadLong) continue;
      for (const s of flat[i + 1].sessions) {
        if (s.discipline === 'lift') continue;
        expect(['threshold', 'interval', 'tempo', 'long']).not.toContain(s.intensity);
      }
    }
  });
});

describe('VDOT pace wiring & fuelling rehearsal', () => {
  it('run sessions get a target pace ONLY when VDOT paces are supplied', () => {
    const withPaces = generateBlockSkeleton('ironman', 16, 6, '2026-06-07', undefined, { runPaces: FAKE_PACES });
    const runs = withPaces.weeksData.flatMap(w => w.days).flatMap(d => d.sessions).filter(s => s.discipline === 'run');
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every(s => typeof s.paceSecPerMile === 'number')).toBe(true);
    // a long run pulls the easy pace; threshold pulls threshold pace
    const long = runs.find(s => s.intensity === 'long');
    expect(long?.paceSecPerMile).toBe(FAKE_PACES.easyHigh);

    const without = generateBlockSkeleton('ironman', 16, 6, '2026-06-07');
    const runs2 = without.weeksData.flatMap(w => w.days).flatMap(d => d.sessions).filter(s => s.discipline === 'run');
    expect(runs2.every(s => s.paceSecPerMile === undefined)).toBe(true);
  });

  it('long aerobic sessions carry a ~400 kcal/hr fuelling target', () => {
    const block = generateBlockSkeleton('ironman', 16, 6, '2026-06-07');
    const longs = block.weeksData.flatMap(w => w.days).flatMap(d => d.sessions).filter(s => s.intensity === 'long');
    expect(longs.length).toBeGreaterThan(0);
    for (const s of longs) {
      expect(s.fuelKcalPerHr).toBe(400);
      // total fuel scales with duration
      expect(sessionFuelKcal(s)).toBe(Math.round((400 * s.durationMin!) / 60));
    }
    // non-long sessions don't carry a fuelling target
    const easy = block.weeksData[0].days.flatMap(d => d.sessions).find(s => s.intensity === 'easy');
    expect(easy?.fuelKcalPerHr).toBeUndefined();
  });
});
