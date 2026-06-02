/**
 * lib/trainingBlock.ts
 *
 * Multi-week PERIODIZED training-block engine — the hybrid/concurrent-training
 * scheduler that sits ON TOP of the single-discipline lifting (lib/lifting) and
 * running (lib/running) engines. A block spans 4 / 6 / 8 / 10 / 12 weeks and
 * schedules lifts AND cardio together, including two-a-days (AM/PM), for an
 * athlete training for something like an Ironman.
 *
 * Pure (no React, no storage) so it can be unit-tested in isolation. The UI
 * (components/training/TrainingBlockBuilder.tsx) and the calendar read from it;
 * logging still lands in DayRecord (plan vs. actual stay separate).
 *
 * ── Periodization methodology (concurrent / hybrid training) ─────────────────
 *  • MACROCYCLE: base → build → peak → taper, with 3:1 LOADING (every 4th week
 *    is a deload at reduced volume). [evidence] Block/undulating periodization +
 *    planned deloads are standard for managing concurrent fatigue.
 *  • INTERFERENCE EFFECT [evidence]: endurance and strength adaptations compete
 *    (AMPK vs mTOR). Mitigations baked into the templates:
 *      – two daily sessions are split AM/PM (≥6h apart);
 *      – heavy lower-body lifting is kept OFF the key long-ride / long-run days;
 *      – intensity is POLARIZED (~80% easy, ~20% hard) — hard days aren't stacked;
 *      – exactly ONE full rest day per week.
 *  • IRONMAN specifics [estimate]: weekly long ride, long run, a BRICK (bike→run
 *    same day), 2–3 swims, and strength 2×/week as low-volume maintenance that
 *    tapers toward race week.
 *  • Durations here are sensible STARTING estimates [heuristic]; advanced users
 *    edit every session in the builder. The engine's job is a correct, safe
 *    skeleton, not a prescription the user can't override.
 */

import type { TrainingPhase } from '@/lib/running/types';
import { TRAINING_BLOCK_KEY } from '@/lib/constants';

export type Discipline = 'lift' | 'run' | 'bike' | 'swim';
export type TimeOfDay = 'am' | 'pm';
export type SessionIntensity =
  | 'recovery' | 'easy' | 'tempo' | 'threshold' | 'interval' | 'long' // cardio
  | 'strength' | 'hypertrophy';                                       // lift

export type BlockGoal = 'ironman' | 'hybrid' | 'custom';
export type BlockWeeks = 4 | 6 | 8 | 10 | 12;
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sun … 6 = Sat

export interface BlockSession {
  id: string;
  discipline: Discipline;
  timeOfDay: TimeOfDay;
  intensity: SessionIntensity;
  durationMin?: number;   // planned minutes (cardio or lift)
  distance?: number;      // canonical MILES (cardio only; display via useUnits)
  liftDayName?: string;   // ties a lift session to a LiftingProgram day name
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

export const BLOCK_WEEK_OPTIONS: BlockWeeks[] = [4, 6, 8, 10, 12];

// ─────────────────────────────────────────────────────────────────────────────
// PHASE LAYOUT — phase + deload per week, per supported block length.
// Explicit tables (only 5 lengths) so the periodization is predictable & testable.
// Short blocks (4/6) are too short for a mid-block deload, so they just load then
// taper; 8/10/12 deload every 4th week and always taper the final week.
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
};

export function phaseLayout(weeks: BlockWeeks): PhaseSpec[] {
  return PHASE_LAYOUTS[weeks].map(p => ({ ...p }));
}

// ─────────────────────────────────────────────────────────────────────────────
// WEEKLY TEMPLATES — a 7-day skeleton per goal. Each slot has a PRIORITY so a
// lower days/week setting drops the least-important training days (→ rest). The
// `intensity` here is the LOAD-week role; applyPhase() modulates it per phase.
// dow: 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
// ─────────────────────────────────────────────────────────────────────────────
interface SlotDef {
  discipline: Discipline;
  timeOfDay: TimeOfDay;
  intensity: SessionIntensity;
}
interface DayDef {
  dow: DayOfWeek;
  priority: number;     // higher = kept first when trimming to daysPerWeek
  isLongDay?: boolean;  // key endurance day — no heavy lifting placed here
  slots: SlotDef[];
}

// Ironman: 2 swims, 3 bikes (1 long), 3 runs (1 long + brick), 2 lifts, 1 rest.
// Heavy lifts (Mon/Fri PM) deliberately off the long days (Sat long ride, Sun long run).
const IRONMAN_WEEK: DayDef[] = [
  { dow: 0, priority: 9, isLongDay: true,  slots: [{ discipline: 'run',  timeOfDay: 'am', intensity: 'long' }] },
  { dow: 1, priority: 6, slots: [{ discipline: 'swim', timeOfDay: 'am', intensity: 'easy' },   { discipline: 'lift', timeOfDay: 'pm', intensity: 'strength' }] },
  { dow: 2, priority: 7, slots: [{ discipline: 'bike', timeOfDay: 'am', intensity: 'threshold' }] },
  { dow: 3, priority: 0, slots: [] }, // REST
  { dow: 4, priority: 5, slots: [{ discipline: 'run',  timeOfDay: 'am', intensity: 'interval' }, { discipline: 'swim', timeOfDay: 'pm', intensity: 'easy' }] },
  { dow: 5, priority: 4, slots: [{ discipline: 'bike', timeOfDay: 'am', intensity: 'easy' },     { discipline: 'lift', timeOfDay: 'pm', intensity: 'strength' }] },
  { dow: 6, priority: 10, isLongDay: true, slots: [{ discipline: 'bike', timeOfDay: 'am', intensity: 'long' }, { discipline: 'run', timeOfDay: 'pm', intensity: 'easy' }] }, // BRICK
];

// Hybrid: balanced lifting + endurance, one long run, mostly single sessions.
const HYBRID_WEEK: DayDef[] = [
  { dow: 0, priority: 8, isLongDay: true, slots: [{ discipline: 'run',  timeOfDay: 'am', intensity: 'long' }] },
  { dow: 1, priority: 9, slots: [{ discipline: 'lift', timeOfDay: 'am', intensity: 'strength' }] },
  { dow: 2, priority: 6, slots: [{ discipline: 'run',  timeOfDay: 'am', intensity: 'easy' }] },
  { dow: 3, priority: 7, slots: [{ discipline: 'lift', timeOfDay: 'am', intensity: 'hypertrophy' }] },
  { dow: 4, priority: 5, slots: [{ discipline: 'bike', timeOfDay: 'am', intensity: 'threshold' }] },
  { dow: 5, priority: 0, slots: [] }, // REST
  { dow: 6, priority: 4, slots: [{ discipline: 'lift', timeOfDay: 'am', intensity: 'strength' }, { discipline: 'bike', timeOfDay: 'pm', intensity: 'easy' }] },
];

function templateWeek(goal: BlockGoal): DayDef[] {
  if (goal === 'ironman') return IRONMAN_WEEK;
  if (goal === 'hybrid')  return HYBRID_WEEK;
  return []; // 'custom' / blank → empty scaffold (correct phases, no sessions)
}

// ─────────────────────────────────────────────────────────────────────────────
// DURATIONS — starting estimates (minutes). Long sessions grow across the block;
// quality is trimmed on deload/taper. All user-editable afterward. [heuristic]
// ─────────────────────────────────────────────────────────────────────────────
const BASE_MIN: Record<SessionIntensity, number> = {
  recovery: 30, easy: 50, tempo: 50, threshold: 45, interval: 45, long: 90,
  strength: 45, hypertrophy: 50,
};

// Rough mph for converting a cardio long duration → a distance estimate (miles).
const SPEED_MPH: Partial<Record<Discipline, number>> = { run: 6, bike: 16 };

/** Phase/deload modulation of a single slot → a concrete session. `progress` is
 *  0..1 across the whole block (drives how long the "long" sessions get). */
function applyPhase(
  slot: SlotDef,
  phase: TrainingPhase,
  isDeload: boolean,
  progress: number,
  idKey: string,
): BlockSession {
  let intensity = slot.intensity;

  // Base phase builds the aerobic engine: downgrade hard cardio to easy/tempo.
  if (phase === 'base' && (intensity === 'interval' || intensity === 'threshold')) {
    intensity = 'tempo';
  }
  // Deload & taper: pull cardio quality back to easy and lifts to lighter work.
  if (isDeload) {
    if (intensity === 'interval' || intensity === 'threshold' || intensity === 'tempo') intensity = 'easy';
  }

  let durationMin = BASE_MIN[intensity];
  // Long sessions grow ~ up to +60% by peak.
  if (slot.intensity === 'long') durationMin = Math.round(BASE_MIN.long * (1 + 0.6 * progress));
  // Deload/taper cut total time.
  if (isDeload) durationMin = Math.round(durationMin * (phase === 'taper' ? 0.5 : 0.6));

  const session: BlockSession = {
    id: idKey,
    discipline: slot.discipline,
    timeOfDay: slot.timeOfDay,
    intensity,
    durationMin,
  };
  // Cardio distance estimate (miles) for run/bike; swim stays time-only.
  const mph = SPEED_MPH[slot.discipline];
  if (mph) session.distance = Math.round((durationMin / 60) * mph * 10) / 10;
  return session;
}

// ─────────────────────────────────────────────────────────────────────────────
// SKELETON GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/** Build a full periodized block. daysPerWeek (clamped 3..6) selects how many of
 *  the template's training days survive (lowest-priority days become rest), so
 *  there is always ≥1 rest day. A 'custom'/blank goal yields empty (phased) weeks. */
export function generateBlockSkeleton(
  goal: BlockGoal,
  weeks: BlockWeeks,
  daysPerWeek: number,
  startDate: string,
  name?: string,
): TrainingBlock {
  const layout = phaseLayout(weeks);
  const tmpl = templateWeek(goal);

  // Which dows are training days? Keep the top-`daysPerWeek` by priority.
  const days = Math.max(3, Math.min(6, Math.round(daysPerWeek)));
  const trainingDows = new Set(
    tmpl.filter(d => d.slots.length > 0)
      .sort((a, b) => b.priority - a.priority)
      .slice(0, days)
      .map(d => d.dow),
  );

  const weeksData: BlockWeek[] = layout.map((spec, wi) => {
    const weekNumber = wi + 1;
    const progress = weeks > 1 ? wi / (weeks - 1) : 0;

    const dayList: BlockDay[] = ([0, 1, 2, 3, 4, 5, 6] as DayOfWeek[]).map(dow => {
      const def = tmpl.find(d => d.dow === dow);
      if (!def || def.slots.length === 0 || !trainingDows.has(dow)) {
        return { dow, sessions: [] };
      }
      const sessions = def.slots.map((slot, si) =>
        applyPhase(slot, spec.phase, spec.isDeload, progress, `w${weekNumber}-d${dow}-s${si}`),
      );
      return { dow, sessions };
    });

    return { weekNumber, phase: spec.phase, isDeload: spec.isDeload, days: dayList };
  });

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
  const g = goal === 'ironman' ? 'Ironman' : goal === 'hybrid' ? 'Hybrid' : 'Custom';
  return `${weeks}-Week ${g} Block`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR LOOKUP
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
): { weekNumber: number; phase: TrainingPhase; isDeload: boolean } | null {
  const diff = dayDiff(block.startDate, dateStr);
  if (diff < 0 || diff >= block.weeks * 7) return null;
  const wk = block.weeksData[Math.floor(diff / 7)];
  return wk ? { weekNumber: wk.weekNumber, phase: wk.phase, isDeload: wk.isDeload } : null;
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

/** Count of training days (≥1 session) in a week. */
export function trainingDayCount(week: BlockWeek): number {
  return week.days.filter(d => d.sessions.length > 0).length;
}

export const PHASE_LABEL: Record<TrainingPhase, string> = {
  base: 'Base', build1: 'Build', build2: 'Build', peak: 'Peak', taper: 'Taper',
};

export const INTENSITY_LABEL: Record<SessionIntensity, string> = {
  recovery: 'Recovery', easy: 'Easy', tempo: 'Tempo', threshold: 'Threshold',
  interval: 'Interval', long: 'Long', strength: 'Strength', hypertrophy: 'Hypertrophy',
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
// has no dependency on the client-only sync engine.
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
