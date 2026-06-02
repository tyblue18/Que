/**
 * lib/trainingBlock.ts
 *
 * Multi-week PERIODIZED training-block engine — the hybrid/concurrent-training
 * scheduler that sits ON TOP of the single-discipline lifting (lib/lifting) and
 * running (lib/running) engines. It schedules lifts AND cardio together,
 * including two-a-days (AM/PM), for an athlete training for something like an
 * Ironman.
 *
 * Pure (no React, no storage) so it can be unit-tested in isolation. The UI
 * (components/training/TrainingBlockBuilder.tsx) and the calendar read from it;
 * logging still lands in DayRecord (plan vs. actual stay separate).
 *
 * ── Periodization methodology (concurrent / hybrid endurance) ────────────────
 *  • MACROCYCLE: base → build → peak → taper, 3:1 LOADING (every 4th week is a
 *    recovery deload). [evidence] Block periodization + planned deloads manage
 *    concurrent fatigue.
 *  • WEEKLY VOLUME IN HOURS, progressing ≤10%/week. [evidence] The ~10% rule is
 *    the standard ceiling on weekly endurance-load increase; recovery/taper weeks
 *    cut volume. The per-user peak-hours number is an [estimate] scaled by the
 *    days/week and experience inputs (intermediate peak ≈ 12–17h [evidence range]).
 *  • POLARIZED ~80/20 [evidence]: ~80% of weekly endurance volume is easy/aerobic
 *    (Z1/Z2). Long endurance sessions are Z2 BY DEFINITION (Ironman race intensity
 *    ≈ LT1/Zone 2) — race-specific because aerobic, not "downgraded".
 *  • LONG RUN CAP ~2.75h [evidence]: training-marathon-length runs cost more
 *    recovery than they build. Long RIDE builds toward 5–6h [evidence] (the bike
 *    is the longest Ironman discipline and tolerates the volume).
 *  • 2–3 WEEK TAPER [evidence]: final weeks drop volume to ~75/50/(25)% while
 *    MAINTAINING intensity (cutting intensity loses fitness). Peak load lands
 *    3–4 weeks out.
 *  • RECOVERY BUFFER [evidence]: a long session's recovery cost is 36–48h, so the
 *    day AFTER a key long session is forced easy/recovery (no hard/long cardio).
 *  • INTERFERENCE EFFECT [evidence] (AMPK vs mTOR): two daily sessions split
 *    AM/PM (≥6h); heavy lower-body lifting kept OFF the key long days.
 *  • IRONMAN block length is honest: full builds are 24–52 weeks [evidence]; a
 *    12-week Ironman block is valid only as a PEAK phase for an athlete who
 *    already has a base (see ironmanReadinessNote). Recommended: 16 / 24 weeks.
 *  • FUELLING REHEARSAL [evidence]: long aerobic sessions carry a ~400 kcal/hr
 *    target (≈60–90 g carbs/hr) — ties into Que's calorie/eat-back system.
 *
 * Numbers are tagged [evidence] / [estimate] / [heuristic]; every session is
 * user-editable in the builder. The engine's job is a correct, safe skeleton.
 */

import type { TrainingPhase, TrainingPaces } from '@/lib/running/types';
import { TRAINING_BLOCK_KEY } from '@/lib/constants';

export type Discipline = 'lift' | 'run' | 'bike' | 'swim';
export type TimeOfDay = 'am' | 'pm';
export type SessionIntensity =
  | 'recovery' | 'easy' | 'tempo' | 'threshold' | 'interval' | 'long' // cardio
  | 'strength' | 'hypertrophy';                                       // lift
/** Physiological zone for 80/20 polarization accounting (cardio only). */
export type IntensityZone = 'easy' | 'threshold' | 'hard';

export type BlockGoal = 'ironman' | 'hybrid' | 'custom';
export type BlockWeeks = 4 | 6 | 8 | 10 | 12 | 16 | 24;
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sun … 6 = Sat
export type AthleteLevel = 'beginner' | 'intermediate' | 'advanced';

export interface BlockSession {
  id: string;
  discipline: Discipline;
  timeOfDay: TimeOfDay;
  intensity: SessionIntensity;
  zone?: IntensityZone;       // cardio physiological zone (drives 80/20)
  durationMin?: number;       // planned minutes (cardio or lift)
  distance?: number;          // canonical MILES (cardio only; display via useUnits)
  paceSecPerMile?: number;    // run target pace from VDOT (when available)
  fuelKcalPerHr?: number;     // fuelling-rehearsal target (long aerobic sessions)
  keySession?: string;        // named race-specific session (peak phase)
  liftDayName?: string;       // ties a lift session to a LiftingProgram day name
  note?: string;
}

export interface BlockDay {
  dow: DayOfWeek;
  sessions: BlockSession[]; // empty = rest day
}

export interface BlockWeek {
  weekNumber: number;       // 1-based
  phase: TrainingPhase;
  isDeload: boolean;
  targetHours: number;      // planned weekly endurance volume (hours) — the anchor
  days: BlockDay[];         // always length 7, dow 0..6
}

export interface TrainingBlock {
  id: string;
  name: string;
  goal: BlockGoal;
  weeks: BlockWeeks;
  startDate: string;        // YYYY-MM-DD — day-0 (dow 0 / Sunday) of week 1
  weeksData: BlockWeek[];
  createdAt: string;        // YYYY-MM-DD
  active: boolean;          // only an active block feeds the calendar
}

/** Length options by goal. Ironman is its OWN set: 24–52wk is a full build, so
 *  the Ironman goal only offers 12 (peak block, base assumed) / 16 / 24 — it
 *  can't silently produce a sub-12-week "race-ready" plan. Other goals keep the
 *  general short blocks. */
export const BLOCK_WEEK_OPTIONS: BlockWeeks[] = [4, 6, 8, 10, 12];
export const IRONMAN_WEEK_OPTIONS: BlockWeeks[] = [12, 16, 24];
export function blockLengthOptions(goal: BlockGoal): BlockWeeks[] {
  return goal === 'ironman' ? IRONMAN_WEEK_OPTIONS : BLOCK_WEEK_OPTIONS;
}

/** Honest readiness framing for an Ironman block — surfaced in the UI. [evidence]
 *  A full Ironman build is 24–52 weeks; shorter blocks assume an existing base. */
export function ironmanReadinessNote(weeks: BlockWeeks): string {
  if (weeks <= 12) {
    return 'Peak/Build block — assumes you can already swim ~2.8k, ride ~3.5h, and run ~1.5h continuously. Not a full beginner Ironman build.';
  }
  if (weeks <= 16) {
    return 'Recommended build — assumes a basic aerobic base (already training ~6–8h/week). A full from-scratch Ironman build is 24+ weeks.';
  }
  return 'Full build — suitable from a modest aerobic base. The genuinely-recommended length for an Ironman.';
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE LAYOUT — phase + deload per week, per supported block length.
// Existing 4/6/8/10/12 are UNCHANGED (other goals + Ironman 12 = peak block).
// Ironman-recommended 16/24 add a proper 2–3 week taper; deloads every 4th week.
// ─────────────────────────────────────────────────────────────────────────────
type PhaseSpec = { phase: TrainingPhase; isDeload: boolean };
const L = (phase: TrainingPhase, isDeload = false): PhaseSpec => ({ phase, isDeload });

const PHASE_LAYOUTS: Record<BlockWeeks, PhaseSpec[]> = {
  4:  [L('base'), L('base'), L('base'), L('taper', true)],
  6:  [L('base'), L('base'), L('base'), L('build1'), L('build2'), L('taper', true)],
  8:  [L('base'), L('base'), L('base'), L('base', true),
       L('build1'), L('build2'), L('peak'), L('taper', true)],
  10: [L('base'), L('base'), L('base'), L('base', true),
       L('build1'), L('build2'), L('build2'), L('build2', true),
       L('peak'), L('taper', true)],
  12: [L('base'), L('base'), L('base'), L('base', true),
       L('build1'), L('build1'), L('build2'), L('build2', true),
       L('peak'), L('peak'), L('peak'), L('taper', true)],
  // 16-week: 2-week taper; peak load lands ~2 weeks out.
  16: [L('base'), L('base'), L('base'), L('base', true),
       L('build1'), L('build1'), L('build2'), L('build2', true),
       L('build2'), L('peak'), L('peak'), L('peak', true),
       L('peak'), L('peak'), L('taper', true), L('taper', true)],
  // 24-week: 3-week taper; peak load lands ~3 weeks out.
  24: [L('base'), L('base'), L('base'), L('base', true),
       L('base'), L('base'), L('base'), L('base', true),
       L('build1'), L('build1'), L('build2'), L('build2', true),
       L('build1'), L('build1'), L('build2'), L('build2', true),
       L('peak'), L('peak'), L('peak'), L('peak', true),
       L('peak'),
       L('taper', true), L('taper', true), L('taper', true)],
};

export function phaseLayout(weeks: BlockWeeks): PhaseSpec[] {
  return PHASE_LAYOUTS[weeks].map(p => ({ ...p }));
}

// ─────────────────────────────────────────────────────────────────────────────
// WEEKLY TEMPLATES — a 7-day skeleton per goal. Each slot has a PRIORITY (so a
// lower days/week setting drops the least-important training days → rest) and an
// optional baseMin (its load-week-1 baseline minutes, scaled to the weekly-hours
// target). dow: 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
// ─────────────────────────────────────────────────────────────────────────────
interface SlotDef {
  discipline: Discipline;
  timeOfDay: TimeOfDay;
  intensity: SessionIntensity;
  baseMin?: number;
}
interface DayDef {
  dow: DayOfWeek;
  priority: number;     // higher = kept first when trimming to daysPerWeek
  isLongDay?: boolean;  // key endurance day — no heavy lifting placed here
  slots: SlotDef[];
}

// Ironman week. Two big days (Tue long run, Sat long ride + race-pace brick) with
// a recovery day AFTER each (Wed after Tue; next-week Sun after Sat). 2 swims,
// 3 bikes, 3 runs, 2 maintenance lifts, 1 rest. Heavy lifts off the long days.
const IRONMAN_WEEK: DayDef[] = [
  { dow: 0, priority: 5, slots: [{ discipline: 'run', timeOfDay: 'am', intensity: 'easy', baseMin: 40 }] }, // recovery run (after Sat long ride)
  { dow: 1, priority: 7, slots: [{ discipline: 'swim', timeOfDay: 'am', intensity: 'easy', baseMin: 35 }, { discipline: 'lift', timeOfDay: 'pm', intensity: 'strength' }] },
  { dow: 2, priority: 9, isLongDay: true, slots: [{ discipline: 'run', timeOfDay: 'am', intensity: 'long', baseMin: 90 }] }, // LONG RUN
  { dow: 3, priority: 4, slots: [{ discipline: 'bike', timeOfDay: 'am', intensity: 'easy', baseMin: 50 }, { discipline: 'lift', timeOfDay: 'pm', intensity: 'strength' }] }, // recovery spin (after long run) + maintenance lift
  { dow: 4, priority: 6, slots: [{ discipline: 'bike', timeOfDay: 'am', intensity: 'threshold', baseMin: 55 }, { discipline: 'swim', timeOfDay: 'pm', intensity: 'easy', baseMin: 35 }] },
  { dow: 5, priority: 0, slots: [] }, // REST
  { dow: 6, priority: 10, isLongDay: true, slots: [{ discipline: 'bike', timeOfDay: 'am', intensity: 'long', baseMin: 200 }, { discipline: 'run', timeOfDay: 'pm', intensity: 'tempo', baseMin: 30 }] }, // BIG DAY: long ride + race-pace brick
];

// Hybrid: balanced lifting + endurance, one long run, mostly single sessions.
const HYBRID_WEEK: DayDef[] = [
  { dow: 0, priority: 8, isLongDay: true, slots: [{ discipline: 'run',  timeOfDay: 'am', intensity: 'long', baseMin: 80 }] },
  { dow: 1, priority: 9, slots: [{ discipline: 'lift', timeOfDay: 'am', intensity: 'strength' }] },
  { dow: 2, priority: 6, slots: [{ discipline: 'run',  timeOfDay: 'am', intensity: 'easy', baseMin: 45 }] },
  { dow: 3, priority: 7, slots: [{ discipline: 'lift', timeOfDay: 'am', intensity: 'hypertrophy' }] },
  { dow: 4, priority: 5, slots: [{ discipline: 'bike', timeOfDay: 'am', intensity: 'threshold', baseMin: 50 }] },
  { dow: 5, priority: 0, slots: [] }, // REST
  { dow: 6, priority: 4, slots: [{ discipline: 'lift', timeOfDay: 'am', intensity: 'strength' }, { discipline: 'bike', timeOfDay: 'pm', intensity: 'easy', baseMin: 60 }] },
];

function templateWeek(goal: BlockGoal): DayDef[] {
  if (goal === 'ironman') return IRONMAN_WEEK;
  if (goal === 'hybrid')  return HYBRID_WEEK;
  return []; // 'custom' / blank → empty scaffold (correct phases, no sessions)
}

// ─────────────────────────────────────────────────────────────────────────────
// VOLUME / INTENSITY CONSTANTS  ([evidence]/[estimate]/[heuristic] tagged)
// ─────────────────────────────────────────────────────────────────────────────
const LONG_RUN_CAP_MIN = 165;   // ~2.75h [evidence] — never a training-marathon
const LONG_RIDE_CAP_MIN = 360;  // 6h ceiling [evidence]
const FUEL_KCAL_PER_HR = 400;   // ~60–90 g carbs/hr [evidence]
const EASY_ZONE_TARGET = 0.80;  // ~80/20 polarization [evidence]

// Default load-week baseline minutes when a slot omits baseMin. [heuristic]
const DEFAULT_BASE_MIN: Record<SessionIntensity, number> = {
  recovery: 30, easy: 45, tempo: 45, threshold: 45, interval: 40, long: 90,
  strength: 45, hypertrophy: 50,
};
const LIFT_MIN_LOAD = 45;    // [heuristic]
const LIFT_MIN_DELOAD = 35;

// Rough mph for converting a cardio duration → distance estimate (miles). [estimate]
const SPEED_MPH: Partial<Record<Discipline, number>> = { run: 6, bike: 16 };

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Peak weekly endurance hours, scaled by days/week + experience. Intermediate
 *  peak ≈ 14h (mid of the 12–17h [evidence] range); [estimate] factors below. */
function goalPeakHours(goal: BlockGoal, daysPerWeek: number, level: AthleteLevel): number {
  const basePeak = goal === 'ironman' ? 14 : goal === 'hybrid' ? 7 : 8; // [estimate]
  const dayFactor = ({ 3: 0.6, 4: 0.75, 5: 0.88, 6: 1.0 } as Record<number, number>)[
    Math.max(3, Math.min(6, Math.round(daysPerWeek)))
  ] ?? 1.0; // [estimate]
  const expFactor = ({ beginner: 0.8, intermediate: 1.0, advanced: 1.15 } as Record<AthleteLevel, number>)[level]; // [estimate]
  return Math.max(6, Math.min(20, basePeak * dayFactor * expFactor));
}

/** Per-week target endurance HOURS following the ≤10% rule. Load weeks rise ≤9%
 *  from the previous load week (capped at a per-phase ceiling); recovery deloads
 *  drop to 60%; taper weeks descend (~75/50/25% of peak) — volume only, intensity
 *  is preserved in applyIntensity(). */
function weeklyHoursPlan(layout: PhaseSpec[], peakHours: number): number[] {
  const n = layout.length;
  let taperN = 0;
  for (let i = n - 1; i >= 0 && layout[i].phase === 'taper'; i--) taperN++;
  const CEIL: Record<TrainingPhase, number> = { base: 0.78, build1: 0.88, build2: 0.95, peak: 1.0, taper: 1.0 };
  const taperFrac = (seen: number, total: number): number => {
    const table: Record<number, number[]> = { 1: [0.5], 2: [0.6, 0.4], 3: [0.7, 0.5, 0.3] };
    return (table[total] ?? [0.5])[seen] ?? 0.4;
  };
  const out: number[] = new Array(n);
  let lastLoad: number | null = null;
  let taperSeen = 0;
  for (let i = 0; i < n; i++) {
    const s = layout[i];
    if (s.phase === 'taper') {
      out[i] = round1(peakHours * taperFrac(taperSeen, taperN));
      taperSeen++;
    } else if (s.isDeload) {
      out[i] = round1((lastLoad ?? peakHours * 0.6) * 0.6);
    } else {
      const ceil = CEIL[s.phase] * peakHours;
      const next = lastLoad == null ? peakHours * 0.6 : Math.min(lastLoad * 1.09, ceil);
      out[i] = round1(Math.max(next, lastLoad ?? 0));
      lastLoad = out[i];
    }
  }
  return out;
}

/** Maps a session intensity → physiological zone (cardio only). */
export function zoneFor(intensity: SessionIntensity): IntensityZone | undefined {
  switch (intensity) {
    case 'recovery': case 'easy': case 'long': return 'easy';
    case 'tempo': case 'threshold': return 'threshold';
    case 'interval': return 'hard';
    default: return undefined; // strength / hypertrophy → no cardio zone
  }
}

/** Phase/deload modulation of INTENSITY (not volume). Base downgrades hard cardio
 *  to build the aerobic engine; a RECOVERY deload downgrades quality to easy; a
 *  TAPER week PRESERVES intensity (its volume is cut via the hours plan). */
function applyIntensity(intensity: SessionIntensity, phase: TrainingPhase, isDeload: boolean): SessionIntensity {
  let r = intensity;
  if (phase === 'base' && (r === 'interval' || r === 'threshold')) r = 'tempo';
  if (isDeload && phase !== 'taper' && (r === 'interval' || r === 'threshold' || r === 'tempo')) r = 'easy';
  return r;
}

/** Run target pace (sec/mile) for an intensity, from VDOT-derived paces. */
function paceForRun(intensity: SessionIntensity, paces: TrainingPaces): number | undefined {
  switch (intensity) {
    case 'recovery': case 'easy': case 'long': return paces.easyHigh;
    case 'tempo': return paces.marathon;
    case 'threshold': return paces.threshold;
    case 'interval': return paces.interval;
    default: return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SKELETON GENERATION
// ─────────────────────────────────────────────────────────────────────────────

export interface BlockGenOptions {
  experience?: AthleteLevel;
  runPaces?: TrainingPaces | null;
}

/** Build a full periodized block. daysPerWeek (clamped 3..6) selects how many of
 *  the template's training days survive. Session durations are scaled to a weekly
 *  HOURS target that progresses ≤10%/week; long run is capped, long ride builds
 *  to 5–6h; taper holds intensity; the day after a long session is forced easy. */
export function generateBlockSkeleton(
  goal: BlockGoal,
  weeks: BlockWeeks,
  daysPerWeek: number,
  startDate: string,
  name?: string,
  opts?: BlockGenOptions,
): TrainingBlock {
  const layout = phaseLayout(weeks);
  const tmpl = templateWeek(goal);
  const level = opts?.experience ?? 'intermediate';
  const runPaces = opts?.runPaces ?? null;

  const days = Math.max(3, Math.min(6, Math.round(daysPerWeek)));
  const trainingDows = new Set(
    tmpl.filter(d => d.slots.length > 0)
      .sort((a, b) => b.priority - a.priority)
      .slice(0, days)
      .map(d => d.dow),
  );

  const peakHours = goalPeakHours(goal, days, level);
  const hoursCurve = weeklyHoursPlan(layout, peakHours);

  const weeksData: BlockWeek[] = layout.map((spec, wi) => {
    const weekNumber = wi + 1;
    const targetHours = hoursCurve[wi];

    // 1) Build each day's sessions with intensity/zone/flags + a working baseMin.
    type Working = { session: BlockSession; baseMin: number; isLong: boolean };
    const dayList: BlockDay[] = ([0, 1, 2, 3, 4, 5, 6] as DayOfWeek[]).map(dow => {
      const def = tmpl.find(d => d.dow === dow);
      if (!def || def.slots.length === 0 || !trainingDows.has(dow)) {
        return { dow, sessions: [] };
      }
      const working: Working[] = def.slots.map((slot, si) => {
        const intensity = applyIntensity(slot.intensity, spec.phase, spec.isDeload);
        const isLong = slot.intensity === 'long';
        const session: BlockSession = {
          id: `w${weekNumber}-d${dow}-s${si}`,
          discipline: slot.discipline,
          timeOfDay: slot.timeOfDay,
          intensity,
          zone: zoneFor(intensity),
        };
        if (slot.discipline === 'lift') {
          session.durationMin = spec.isDeload ? LIFT_MIN_DELOAD : LIFT_MIN_LOAD;
        }
        if (isLong) session.fuelKcalPerHr = FUEL_KCAL_PER_HR; // fuelling rehearsal
        // Race-specific named sessions only in the peak phase.
        if (spec.phase === 'peak') {
          if (isLong) session.keySession = slot.discipline === 'bike' ? 'Race-sim ride' : 'Race-sim long run';
          else if (slot.intensity === 'tempo' && slot.discipline === 'run') session.keySession = 'Race-pace brick';
        }
        if (slot.discipline === 'run' && runPaces) {
          const p = paceForRun(intensity, runPaces);
          if (p) session.paceSecPerMile = p;
        }
        return { session, baseMin: slot.baseMin ?? DEFAULT_BASE_MIN[slot.intensity], isLong };
      });
      return { dow, sessions: working.map(w => w.session), __working: working } as BlockDay & { __working: Working[] };
    });

    // 2) Scale CARDIO durations so the week's endurance volume ≈ targetHours.
    //    (Lifts are fixed and excluded from the endurance-hours pool.)
    const allWorking = dayList.flatMap(d => (d as BlockDay & { __working?: Working[] }).__working ?? []);
    const cardio = allWorking.filter(w => w.session.discipline !== 'lift');
    const baseSum = cardio.reduce((s, w) => s + w.baseMin, 0);
    if (baseSum > 0) {
      const scale = (targetHours * 60) / baseSum;
      for (const w of cardio) {
        let dur = Math.round(w.baseMin * scale);
        if (w.isLong && w.session.discipline === 'run')  dur = Math.min(dur, LONG_RUN_CAP_MIN);
        if (w.isLong && w.session.discipline === 'bike') dur = Math.min(dur, LONG_RIDE_CAP_MIN);
        w.session.durationMin = dur;
        const mph = SPEED_MPH[w.session.discipline];
        if (mph) w.session.distance = Math.round((dur / 60) * mph * 10) / 10;
      }
    }
    // strip the working scratch field
    for (const d of dayList) delete (d as BlockDay & { __working?: Working[] }).__working;

    return { weekNumber, phase: spec.phase, isDeload: spec.isDeload, targetHours, days: dayList };
  });

  // 3) RECOVERY BUFFER — the day AFTER any long session is forced easy/recovery
  //    cardio (36–48h recovery cost). Walk the block chronologically (week, dow).
  const flatDays: BlockDay[] = weeksData.flatMap(w => w.days);
  for (let i = 0; i < flatDays.length - 1; i++) {
    const hadLong = flatDays[i].sessions.some(s => s.intensity === 'long');
    if (!hadLong) continue;
    for (const s of flatDays[i + 1].sessions) {
      if (s.discipline === 'lift') continue; // maintenance lift on an easy day is fine
      if (s.intensity === 'threshold' || s.intensity === 'interval' || s.intensity === 'tempo' || s.intensity === 'long') {
        s.intensity = 'easy';
        s.zone = 'easy';
        s.note = s.note ? `${s.note} · recovery (day after long)` : 'recovery (day after long)';
        delete s.keySession;
      }
    }
  }

  return {
    id: `block-${Date.now()}`,
    name: name ?? defaultBlockName(goal, weeks),
    goal,
    weeks,
    startDate,
    weeksData,
    createdAt: startDate,
    active: false,
  };
}

export function defaultBlockName(goal: BlockGoal, weeks: BlockWeeks): string {
  if (goal === 'ironman') {
    return weeks <= 12 ? `${weeks}-Week Ironman Peak Block` : `${weeks}-Week Ironman Build`;
  }
  const g = goal === 'hybrid' ? 'Hybrid' : 'Custom';
  return `${weeks}-Week ${g} Block`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR LOOKUP  (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Days between two YYYY-MM-DD strings (b − a), pure UTC date math. */
function dayDiff(aStr: string, bStr: string): number {
  return Math.round(
    (Date.parse(bStr + 'T00:00:00Z') - Date.parse(aStr + 'T00:00:00Z')) / DAY_MS,
  );
}

/** Planned sessions for a given calendar day, or [] if the date is outside the
 *  block window. startDate is week-1 dow-0. */
export function blockForDate(block: TrainingBlock, dateStr: string): BlockSession[] {
  const diff = dayDiff(block.startDate, dateStr);
  if (diff < 0 || diff >= block.weeks * 7) return [];
  const week = Math.floor(diff / 7);
  const dow = (diff % 7) as DayOfWeek;
  const wk = block.weeksData[week];
  if (!wk) return [];
  return wk.days.find(d => d.dow === dow)?.sessions ?? [];
}

/** The calendar week index (0-based) and phase for a date, or null if outside. */
export function weekInfoForDate(
  block: TrainingBlock,
  dateStr: string,
): { weekNumber: number; phase: TrainingPhase; isDeload: boolean; targetHours: number } | null {
  const diff = dayDiff(block.startDate, dateStr);
  if (diff < 0 || diff >= block.weeks * 7) return null;
  const wk = block.weeksData[Math.floor(diff / 7)];
  return wk ? { weekNumber: wk.weekNumber, phase: wk.phase, isDeload: wk.isDeload, targetHours: wk.targetHours } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// METRICS / DISPLAY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** A simple weekly load index (Σ planned minutes) for the per-week bar. */
export function weekLoadIndex(week: BlockWeek): number {
  return week.days.reduce(
    (sum, d) => sum + d.sessions.reduce((s, x) => s + (x.durationMin ?? 0), 0),
    0,
  );
}

/** Actual planned endurance+strength hours this week (Σ durations / 60). */
export function weekActualHours(week: BlockWeek): number {
  return round1(weekLoadIndex(week) / 60);
}

/** Fraction of weekly CARDIO minutes spent in the easy zone (the 80/20 axis). */
export function easyZoneFraction(week: BlockWeek): number {
  let easy = 0, total = 0;
  for (const d of week.days) {
    for (const s of d.sessions) {
      if (!s.zone) continue; // lifts excluded
      const m = s.durationMin ?? 0;
      total += m;
      if (s.zone === 'easy') easy += m;
    }
  }
  return total > 0 ? easy / total : 0;
}

export const EASY_ZONE_TARGET_FRACTION = EASY_ZONE_TARGET;

/** Count of training days (≥1 session) in a week. */
export function trainingDayCount(week: BlockWeek): number {
  return week.days.filter(d => d.sessions.length > 0).length;
}

/** Total planned fuelling kcal for a session (target/hr × duration). */
export function sessionFuelKcal(s: BlockSession): number {
  if (!s.fuelKcalPerHr || !s.durationMin) return 0;
  return Math.round((s.fuelKcalPerHr * s.durationMin) / 60);
}

export const PHASE_LABEL: Record<TrainingPhase, string> = {
  base: 'Base', build1: 'Build', build2: 'Build', peak: 'Peak', taper: 'Taper',
};

export const INTENSITY_LABEL: Record<SessionIntensity, string> = {
  recovery: 'Recovery', easy: 'Easy', tempo: 'Tempo', threshold: 'Threshold',
  interval: 'Interval', long: 'Long', strength: 'Strength', hypertrophy: 'Hypertrophy',
};

export const ZONE_LABEL: Record<IntensityZone, string> = {
  easy: 'Z2 Easy', threshold: 'Threshold', hard: 'Hard',
};

export const DISCIPLINE_LABEL: Record<Discipline, string> = {
  lift: 'Lift', run: 'Run', bike: 'Bike', swim: 'Swim',
};

/** Short human label for a session chip, e.g. "Bike · Long · 144 min". */
export function sessionSummary(s: BlockSession): string {
  return `${DISCIPLINE_LABEL[s.discipline]} · ${INTENSITY_LABEL[s.intensity]}${
    s.durationMin ? ` · ${s.durationMin} min` : ''
  }`;
}

/** True if a day is a brick (a bike and a run on the same day). */
export function isBrickDay(day: BlockDay): boolean {
  const set = new Set(day.sessions.map(s => s.discipline));
  return set.has('bike') && set.has('run');
}

let _sid = 0;
/** Stable-ish unique id for a user-added session (builder runtime only). */
export function newSessionId(): string {
  _sid += 1;
  return `s-${Date.now().toString(36)}-${_sid}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE (window-guarded; SSR-safe). The builder triggers queueSync + dispatches
// `que-training-block-changed` after writing — kept out of here so this module
// has no dependency on the client-only sync engine.  (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

export const TRAINING_BLOCK_CHANGED_EVENT = 'que-training-block-changed';

export function loadTrainingBlock(): TrainingBlock | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(TRAINING_BLOCK_KEY);
    return raw ? (JSON.parse(raw) as TrainingBlock) : null;
  } catch {
    return null;
  }
}

/** Returns the block only if it exists AND is active (the calendar's read path). */
export function loadActiveTrainingBlock(): TrainingBlock | null {
  const b = loadTrainingBlock();
  return b && b.active ? b : null;
}

export function writeTrainingBlock(block: TrainingBlock | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (block) localStorage.setItem(TRAINING_BLOCK_KEY, JSON.stringify(block));
    else localStorage.removeItem(TRAINING_BLOCK_KEY);
  } catch {
    /* quota */
  }
}
