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
/** What the athlete is optimizing for — the SPINE of the custom generator. You
 *  cannot maximize competing qualities at once (interference effect), so the
 *  priority drives the load split and intensity choices, not an afterthought. */
export type BlockPriority = 'strength' | 'endurance' | 'balanced';

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
  // Custom-generator metadata (absent on template blocks):
  priority?: BlockPriority;
  rationale?: string[];     // WHY the generator made its interference choices
  warnings?: string[];      // interference / recovery-debt cautions to surface
}

/** Length options by goal. Ironman is its OWN set: 24–52wk is a full build, so
 *  the Ironman goal only offers 12 (peak block, base assumed) / 16 / 24 — it
 *  can't silently produce a sub-12-week "race-ready" plan. Other goals keep the
 *  general short blocks. */
export const BLOCK_WEEK_OPTIONS: BlockWeeks[] = [4, 6, 8, 10, 12];
export const IRONMAN_WEEK_OPTIONS: BlockWeeks[] = [12, 16, 24];
export const CUSTOM_WEEK_OPTIONS: BlockWeeks[] = [4, 6, 8, 10, 12, 16, 24];
export function blockLengthOptions(goal: BlockGoal): BlockWeeks[] {
  if (goal === 'ironman') return IRONMAN_WEEK_OPTIONS;
  if (goal === 'custom')  return CUSTOM_WEEK_OPTIONS;
  return BLOCK_WEEK_OPTIONS;
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
  key?: string;         // explicit peak-phase key-session name (else Ironman default)
  note?: string;        // explanation surfaced on the session (e.g. interference pairing)
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

/** Build a full periodized block from a fixed goal template. daysPerWeek
 *  (clamped 3..6) selects how many template days survive. Durations scale to a
 *  weekly HOURS target (≤10%/wk); long run capped, long ride builds to 5–6h;
 *  taper holds intensity; the day after a long session is forced easy. */
export function generateBlockSkeleton(
  goal: BlockGoal,
  weeks: BlockWeeks,
  daysPerWeek: number,
  startDate: string,
  name?: string,
  opts?: BlockGenOptions,
): TrainingBlock {
  const layout = phaseLayout(weeks);
  const level = opts?.experience ?? 'intermediate';
  const days = Math.max(3, Math.min(6, Math.round(daysPerWeek)));
  const peakHours = goalPeakHours(goal, days, level);
  return buildBlock({
    goal, weeks, daysPerWeek: days, startDate, name,
    runPaces: opts?.runPaces ?? null,
    layout, peakHours,
    skeletonFor: () => templateWeek(goal), // same skeleton every week
  });
}

interface BuildBlockParams {
  goal: BlockGoal;
  weeks: BlockWeeks;
  daysPerWeek: number;
  startDate: string;
  name?: string;
  runPaces: TrainingPaces | null;
  layout: PhaseSpec[];
  peakHours: number;
  /** The skeleton PROVIDER — the only thing that differs between a fixed template
   *  (same DayDef[] every week) and the rule-driven custom generator (skeleton
   *  varies by week for the few-days emphasis-alternation lever). */
  skeletonFor: (spec: PhaseSpec, weekIndex: number) => DayDef[];
  priority?: BlockPriority;
  rationale?: string[];
  warnings?: string[];
}

/** Shared block-assembly core (reused by the Ironman/Hybrid templates AND the
 *  custom interference generator): per-week trim → session build (intensity /
 *  zone / fuel / key / pace) → scale cardio to targetHours (+caps) → recovery
 *  buffer pass. */
function buildBlock(p: BuildBlockParams): TrainingBlock {
  const { layout, peakHours, skeletonFor, runPaces } = p;
  const days = Math.max(3, Math.min(6, Math.round(p.daysPerWeek)));
  const hoursCurve = weeklyHoursPlan(layout, peakHours);

  const weeksData: BlockWeek[] = layout.map((spec, wi) => {
    const weekNumber = wi + 1;
    const targetHours = hoursCurve[wi];
    const tmpl = skeletonFor(spec, wi);

    // Trim to the top-`days` priority training days (per week — identical result
    // for a fixed template; varies for the custom emphasis-alternation lever).
    const trainingDows = new Set(
      tmpl.filter(d => d.slots.length > 0)
        .sort((a, b) => b.priority - a.priority)
        .slice(0, days)
        .map(d => d.dow),
    );

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
          const base = slot.baseMin ?? LIFT_MIN_LOAD; // template lifts omit baseMin → 45 (unchanged)
          session.durationMin = spec.isDeload ? Math.round(base * (LIFT_MIN_DELOAD / LIFT_MIN_LOAD)) : base;
        }
        if (isLong) session.fuelKcalPerHr = FUEL_KCAL_PER_HR; // fuelling rehearsal
        // Named key sessions only in the peak phase (slot.key wins; else Ironman default).
        if (spec.phase === 'peak') {
          if (slot.key) session.keySession = slot.key;
          else if (isLong) session.keySession = slot.discipline === 'bike' ? 'Race-sim ride' : 'Race-sim long run';
          else if (slot.intensity === 'tempo' && slot.discipline === 'run') session.keySession = 'Race-pace brick';
        }
        if (slot.discipline === 'run' && runPaces) {
          const pc = paceForRun(intensity, runPaces);
          if (pc) session.paceSecPerMile = pc;
        }
        if (slot.note) session.note = slot.note;
        return { session, baseMin: slot.baseMin ?? DEFAULT_BASE_MIN[slot.intensity], isLong };
      });
      return { dow, sessions: working.map(w => w.session), __working: working } as BlockDay & { __working: Working[] };
    });

    // Scale CARDIO durations so the week's endurance volume ≈ targetHours.
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
    for (const d of dayList) delete (d as BlockDay & { __working?: Working[] }).__working;

    return { weekNumber, phase: spec.phase, isDeload: spec.isDeload, targetHours, days: dayList };
  });

  // RECOVERY BUFFER — the day AFTER any long session is forced easy/recovery cardio.
  const flatDays: BlockDay[] = weeksData.flatMap(w => w.days);
  for (let i = 0; i < flatDays.length - 1; i++) {
    if (!flatDays[i].sessions.some(s => s.intensity === 'long')) continue;
    for (const s of flatDays[i + 1].sessions) {
      if (s.discipline === 'lift') continue;
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
    name: p.name ?? defaultBlockName(p.goal, p.weeks),
    goal: p.goal,
    weeks: p.weeks,
    startDate: p.startDate,
    weeksData,
    createdAt: p.startDate,
    active: false,
    ...(p.priority ? { priority: p.priority } : {}),
    ...(p.rationale ? { rationale: p.rationale } : {}),
    ...(p.warnings ? { warnings: p.warnings } : {}),
  };
}

export function defaultBlockName(goal: BlockGoal, weeks: BlockWeeks): string {
  if (goal === 'ironman') {
    return weeks <= 12 ? `${weeks}-Week Ironman Peak Block` : `${weeks}-Week Ironman Build`;
  }
  const g = goal === 'hybrid' ? 'Hybrid' : 'Custom';
  return `${weeks}-Week ${g} Block`;
}

// ═════════════════════════════════════════════════════════════════════════════
// CUSTOM INTERFERENCE-MANAGEMENT GENERATOR
//
// Generates blocks for ARBITRARY discipline combinations from interference rules
// rather than a fixed template. The spine is PRIORITY, not equality: you cannot
// maximize competing qualities at once (interference effect [evidence] — AMPK vs
// mTOR signalling), so the priority drives the load split and intensity choices.
// Reuses the Ironman engine's machinery via buildBlock (periodization, hours
// scaling, zones, recovery buffer, VDOT paces, fuelling, calendar plumbing).
//
// It is interference-MINIMIZED, not interference-free — combining maximal
// strength and maximal endurance always costs something; this optimizes the
// tradeoff per the stated priority. The rationale[]/warnings[] explain the why.
// ═════════════════════════════════════════════════════════════════════════════

export interface CustomBlockInputs {
  priority: BlockPriority;
  disciplines: Discipline[];     // e.g. ['lift','run'] — includes 'lift' and/or cardio
  daysPerWeek: number;
  weeks: BlockWeeks;
  startDate: string;             // YYYY-MM-DD
  eventDate?: string;            // present → taper into it; absent → open-ended (no taper)
  experience?: AthleteLevel;
  runPaces?: TrainingPaces | null;
  name?: string;
}

// Conditioning intensities. [evidence] short HIIT preserves lifting time/quality;
// MICT (moderate continuous) is the safer concurrent dose alongside heavy lifting.
const HIIT_MIN = 25;
const MICT_MIN = 40;
const STRENGTH_LIFT_MIN = 60;   // strength-primary lift sessions run longer [heuristic]
const LONG_BASE: Partial<Record<Discipline, number>> = { bike: 180, run: 90, swim: 50 };
// Combined quality (interval+threshold) + lifting ceiling before interference and
// recovery debt spike. [evidence] ~2–4 hard quality sessions/week is the practical ceiling.
const QUALITY_CEILING = 4;

function clampDays(d: number): number { return Math.max(3, Math.min(6, Math.round(d))); }

function pickLongDiscipline(cardio: Discipline[]): Discipline | null {
  return cardio.includes('bike') ? 'bike' : cardio.includes('run') ? 'run' : cardio.includes('swim') ? 'swim' : null;
}

/** Session-count split between lifting and conditioning, set by PRIORITY. [evidence]
 *  Strength-primary → bulk to lifting + minimal-effective conditioning; endurance-
 *  primary → bulk to endurance + ~2 supporting (injury-resistance) lifts; balanced
 *  → ~even, accepting neither maxes out. `emphasis` (few-days lever) nudges ±1. */
function splitCounts(
  priority: BlockPriority, days: number, hasLift: boolean, hasCardio: boolean,
  emphasis: 'lift' | 'cardio' | null,
): { nLift: number; nCardio: number } {
  if (!hasLift)   return { nLift: 0, nCardio: days };
  if (!hasCardio) return { nLift: days, nCardio: 0 };
  let nLift =
    priority === 'strength'  ? Math.min(4, days - 1) :
    priority === 'endurance' ? Math.min(2, Math.max(1, days - 2)) :
                               Math.max(2, Math.round(days / 2));
  let nCardio = days - nLift;
  if (emphasis === 'lift'   && nCardio > 1) { nLift++; nCardio--; }
  if (emphasis === 'cardio' && nLift   > 1) { nLift--; nCardio++; }
  return { nLift, nCardio };
}

interface CustomWeekOpts {
  priority: BlockPriority;
  days: number;
  hasLift: boolean;
  cardio: Discipline[];
  separated: boolean;                  // many-days → separate by day; few-days → combine
  emphasis: 'lift' | 'cardio' | null;
  warnings: Set<string>;
}

const SPREAD_DOWS: DayOfWeek[] = [1, 3, 5, 2, 4, 6, 0]; // Mon Wed Fri Tue Thu Sat Sun

/** Build one week's DayDef[] from the interference rules. Codifies: priority load
 *  split, lift-before-cardio sequencing, modality-aware pairing (easy cycling with
 *  lifting; never running on a leg day), cardio intensity by priority (HIIT off
 *  lift days for strength; MICT for endurance), and the days-based lever. */
function buildCustomWeek(o: CustomWeekOpts): DayDef[] {
  const { priority, days, hasLift, cardio, separated, emphasis, warnings } = o;
  const hasCardio = cardio.length > 0;
  const { nLift, nCardio } = splitCounts(priority, days, hasLift, hasCardio, separated ? null : emphasis);

  const liftSlot = (): SlotDef => ({
    discipline: 'lift', timeOfDay: 'am',
    intensity: priority === 'balanced' ? 'hypertrophy' : 'strength',
    baseMin: priority === 'strength' ? STRENGTH_LIFT_MIN : undefined,
    note: hasCardio ? 'Lift first, then cardio — strength before endurance protects force output.' : undefined,
  });

  // Conditioning specs (intensity + discipline + baseMin), ordered quality → long → easy.
  const specs: { intensity: SessionIntensity; baseMin: number; disc: Discipline }[] = [];
  if (hasCardio && nCardio > 0) {
    let remaining = nCardio;
    const longDisc = pickLongDiscipline(cardio);
    // 1 quality session: HIIT for strength-primary (preserve lifting time), MICT/threshold otherwise.
    const qual: SessionIntensity = priority === 'strength' ? 'interval' : 'threshold';
    specs.push({ intensity: qual, baseMin: priority === 'strength' ? HIIT_MIN : MICT_MIN, disc: cardio[0] });
    remaining--;
    // a long aerobic session for endurance/balanced (gets fuelling + recovery buffer).
    if (priority !== 'strength' && longDisc && remaining > 0) {
      specs.push({ intensity: 'long', baseMin: LONG_BASE[longDisc] ?? 60, disc: longDisc });
      remaining--;
    }
    let ci = 0;
    while (remaining > 0) { const d = cardio[ci++ % cardio.length]; specs.push({ intensity: 'easy', baseMin: MICT_MIN, disc: d }); remaining--; }
  }

  const dayDefs: DayDef[] = [];
  const order = [...SPREAD_DOWS];
  let oi = 0;
  const liftDows: DayOfWeek[] = [];

  // Lift days first (spread).
  for (let i = 0; i < nLift; i++) { const dow = order[oi++]; liftDows.push(dow); dayDefs.push({ dow, priority: 10 - i, slots: [liftSlot()] }); }

  // Conditioning sessions.
  const freeDows = order.slice(oi, oi + Math.max(0, days - nLift)); // dedicated cardio days
  let freeIdx = 0;
  for (const spec of specs) {
    const slot: SlotDef = { discipline: spec.disc, timeOfDay: 'am', intensity: spec.intensity, baseMin: spec.baseMin };
    if (freeIdx < freeDows.length) {
      // its own day (separated, and the preferred placement)
      const dow = freeDows[freeIdx++];
      dayDefs.push({ dow, priority: 6 - freeIdx, isLongDay: spec.intensity === 'long', slots: [slot] });
    } else if (!separated && liftDows.length > 0) {
      // few-days: pair onto a lift day (lift AM + cardio PM). Never HIIT next to a lift
      // (max interference) — downgrade to easy; prefer cycling, flag a forced run pairing.
      const dow = liftDows[(freeIdx - freeDows.length) % liftDows.length];
      const def = dayDefs.find(d => d.dow === dow)!;
      let intensity = spec.intensity;
      if (intensity === 'interval' || intensity === 'threshold') intensity = 'easy'; // no HIIT/quality on a lift day
      if (spec.disc === 'run') warnings.add('Limited days force a run on a lifting day (higher interference). Add a day or include cycling to reduce it.');
      def.slots.push({
        discipline: spec.disc, timeOfDay: 'pm', intensity, baseMin: spec.baseMin,
        note: spec.disc === 'bike' ? 'Cycling paired with lifting (lower interference than running).' : 'Easy only — same-day as lifting.',
      });
      freeIdx++;
    } else {
      // no room — drop (separated mode never hits this; counts are bounded by days)
      freeIdx++;
    }
  }

  // Few-days athletes need two-a-days to fit volume: guarantee one easy cardio
  // paired onto a lift day (lift AM, cardio PM) — exercises sequencing + modality
  // pairing. Cycling preferred (lower interference); a forced run pairing warns.
  if (!separated && hasLift && hasCardio && liftDows.length > 0) {
    const firstLift = dayDefs.find(d => d.dow === liftDows[0])!;
    if (!firstLift.slots.some(s => s.discipline !== 'lift')) {
      const pairDisc: Discipline = cardio.includes('bike') ? 'bike' : cardio[0];
      if (pairDisc === 'run') warnings.add('Limited days force a run on a lifting day (higher interference). Add a day or include cycling to reduce it.');
      firstLift.slots.push({
        discipline: pairDisc, timeOfDay: 'pm', intensity: 'easy', baseMin: MICT_MIN,
        note: pairDisc === 'bike' ? 'Cycling paired with lifting (peripheral, lower interference).' : 'Easy only — shared with lifting.',
      });
    }
  }

  return dayDefs;
}

function openEndedLayout(weeks: BlockWeeks): PhaseSpec[] {
  // No event → no taper. Convert taper weeks to a maintenance (build2) load/deload
  // rhythm so volume holds instead of bleeding down into a race.
  return phaseLayout(weeks).map(s => (s.phase === 'taper' ? { phase: 'build2' as TrainingPhase, isDeload: s.isDeload } : s));
}

function primaryEmphasis(priority: BlockPriority): 'lift' | 'cardio' {
  return priority === 'endurance' ? 'cardio' : 'lift';
}

function priorityRationale(priority: BlockPriority): string {
  if (priority === 'strength')  return 'Strength-primary: most load goes to lifting; conditioning is minimal-effective. Endurance won’t be maximized — that’s the interference tradeoff.';
  if (priority === 'endurance') return 'Endurance-primary: most load goes to conditioning; ~2 lifts support injury-resistance. Max strength isn’t the goal here.';
  return 'Balanced: both qualities are trained, accepting that neither reaches its single-sport ceiling (interference effect).';
}

function customBlockName(priority: BlockPriority, weeks: BlockWeeks): string {
  const p = priority === 'strength' ? 'Strength-primary' : priority === 'endurance' ? 'Endurance-primary' : 'Balanced';
  return `${weeks}-Week ${p} Block`;
}

/** Generate a custom interference-managed block for an arbitrary discipline mix. */
export function generateCustomBlock(inputs: CustomBlockInputs): TrainingBlock {
  const days = clampDays(inputs.daysPerWeek);
  const level = inputs.experience ?? 'intermediate';
  const disciplines = inputs.disciplines.length ? inputs.disciplines : ['lift' as Discipline];
  const hasLift = disciplines.includes('lift');
  const cardio = disciplines.filter(d => d !== 'lift');
  const separated = days >= 5; // [evidence] more days → separate strength/endurance by day;
                               // few days → combine + alternate emphasis by block.

  const warnings = new Set<string>();
  const layout = inputs.eventDate ? phaseLayout(inputs.weeks) : openEndedLayout(inputs.weeks);

  // Peak endurance hours derived from a reference week's conditioning volume (so
  // sessions keep their intended HIIT/MICT/long lengths instead of being inflated),
  // then scaled by experience. The ≤10%/wk progression still rides the hours curve.
  const refWeek = buildCustomWeek({ priority: inputs.priority, days, hasLift, cardio, separated, emphasis: primaryEmphasis(inputs.priority), warnings });
  const refCardioBase = refWeek.flatMap(d => d.slots).filter(s => s.discipline !== 'lift')
    .reduce((s, sl) => s + (sl.baseMin ?? DEFAULT_BASE_MIN[sl.intensity]), 0);
  const expFactor = ({ beginner: 0.85, intermediate: 1.0, advanced: 1.15 } as Record<AthleteLevel, number>)[level];
  const peakHours = Math.max(0.5, (refCardioBase / 60) * expFactor);

  const skeletonFor = (_spec: PhaseSpec, wi: number): DayDef[] => {
    if (separated) {
      return buildCustomWeek({ priority: inputs.priority, days, hasLift, cardio, separated: true, emphasis: null, warnings });
    }
    // Few-days lever: alternate emphasis by mesocycle (every ~4 weeks).
    const meso = Math.floor(wi / 4);
    const prim = primaryEmphasis(inputs.priority);
    const emphasis: 'lift' | 'cardio' = meso % 2 === 0 ? prim : (prim === 'lift' ? 'cardio' : 'lift');
    return buildCustomWeek({ priority: inputs.priority, days, hasLift, cardio, separated: false, emphasis, warnings });
  };

  // Frequency guardrail (evaluated on the reference week).
  const qualityCardio = refWeek.flatMap(d => d.slots).filter(s => s.intensity === 'interval' || s.intensity === 'threshold').length;
  const nLiftRef = refWeek.flatMap(d => d.slots).filter(s => s.discipline === 'lift').length;
  if (nLiftRef + qualityCardio > QUALITY_CEILING) {
    warnings.add(`High combined load: ${nLiftRef} lift + ${qualityCardio} quality cardio sessions/week exceeds the ~${QUALITY_CEILING}/week quality ceiling — watch recovery debt.`);
  }

  const rationale: string[] = [priorityRationale(inputs.priority)];
  if (hasLift && cardio.length) rationale.push('Lifting is ordered before endurance on any shared day to protect force production.');
  if (hasLift && cardio.includes('bike')) rationale.push('Easy cycling is paired with lifting days (peripheral, lower interference) rather than running with leg days.');
  if (inputs.priority === 'strength' && cardio.length) rationale.push('Conditioning is short HIIT kept OFF lifting days — HIIT + heavy lifting the same muscle is maximal interference.');
  if (inputs.priority === 'endurance' && hasLift) rationale.push('Strength is held at ~2 supporting sessions (injury-resistance), not maximized.');
  rationale.push(separated
    ? 'With 5+ days/week, strength and endurance are separated by day within the week.'
    : 'With few days/week, emphasis alternates by block — one quality favored, then the other.');
  rationale.push(inputs.eventDate ? 'A taper is scheduled into your event date.' : 'Open-ended fitness block — no taper; volume is maintained.');

  return buildBlock({
    goal: 'custom', weeks: inputs.weeks, daysPerWeek: days, startDate: inputs.startDate,
    name: inputs.name ?? customBlockName(inputs.priority, inputs.weeks),
    runPaces: inputs.runPaces ?? null, layout, peakHours, skeletonFor,
    priority: inputs.priority, rationale, warnings: [...warnings],
  });
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

/** Placeholder exercise NAME for an unlinked lift session loaded onto the calendar.
 *  Derived from intensity ONLY — never the session's note (a note is a coaching
 *  rationale like "Lift first, then cardio…", not an exercise name). When a lift
 *  session is linked to a LiftingProgram day (liftDayName), the calendar loads
 *  that day's real exercises instead and this isn't used. */
export function blockLiftPlaceholderName(s: BlockSession): string {
  return s.intensity === 'hypertrophy' ? 'Hypertrophy' : 'Strength';
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
