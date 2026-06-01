/**
 * lib/lifting/program.ts
 *
 * Structured lifting-program generator — the lift-side analog of the running
 * VDOT engine (lib/running/). Given how many days a week the user can train
 * (plus goal + experience), it builds a split and prescribes each movement.
 *
 * ── Methodology (evidence-based variable hierarchy, 2024–2026) ──────────────
 * The generator is driven by the variables the literature ranks as primary,
 * and treats the weak-effect variables as fixed defaults the user never sees:
 *
 *  Tier 1 — primary drivers
 *   • VOLUME (sets per muscle per week) is the strongest dose-response lever
 *     (Pelland 2024, 67-study meta-regression). ~4 sets/wk minimum, 5–10 to
 *     bank most gains, more keeps helping with diminishing returns. We count
 *     FRACTIONAL sets — a bench press is 1.0 set for chest and 0.5 for triceps
 *     and front delts — so secondary movers aren't systematically under-dosed.
 *   • PROXIMITY TO FAILURE (Robinson 2024): hypertrophy rises closer to failure
 *     but failure itself isn't required. Default working sets to 1–3 RIR;
 *     isolation last sets can go 0–1 RIR (low systemic fatigue cost).
 *
 *  Tier 2 — strongly supported but flexible
 *   • LOAD / REP RANGE: no magic hypertrophy zone (growth similar ≥~30% 1RM to
 *     failure). So rep ranges are chosen for PRACTICALITY/joint stress, not
 *     because reps drive growth: ~5–10 for pressing, ~8–15 elsewhere. Strength
 *     diverges — heavy loads (>~60% 1RM) win for 1RM, so the strength goal uses
 *     low reps + higher load.
 *   • FREQUENCY is a volume-distribution tool for hypertrophy (negligible when
 *     volume is equated) but DOES help strength — so higher days/week simply
 *     spreads the weekly volume into manageable sessions, and strength biases
 *     toward hitting each lift 2+×/week.
 *
 *  Tier 3 — real but small (fixed defaults, never user-facing)
 *   • Full ROM, ~2 min rest (longer for heavy compounds). Lengthened partials
 *     are treated as an optional advanced cue, not a core prescription.
 *
 *  Engine: double progression (add reps within the range, then add load and
 *  reset) — load- and rep-progression give equivalent hypertrophy (2024 trial).
 *  Deload every ~4–8 weeks.
 *
 *  Nutrition: protein 1.6–2.2 g/kg/day across 3–6 meals of ~0.25–0.4 g/kg.
 *
 * Pure (no React, no storage) so it can be unit-tested in isolation.
 */

export type LiftGoal       = 'strength' | 'hypertrophy' | 'general';
export type LiftExperience = 'beginner' | 'intermediate' | 'advanced';
export type LiftRole       = 'compound' | 'isolation';

export interface LiftingInputs {
  daysPerWeek:   number;          // 2–6
  goal:          LiftGoal;
  experience:    LiftExperience;
  bodyweightKg?: number;          // optional — only used for the protein target
}

export interface ProgramExercise {
  name:      string;              // matches a PRESETS exercise name where possible
  group:     string;              // lowercase PRESETS muscle-group key (primary mover)
  secondary: string[];            // muscles that get 0.5 fractional-set credit
  role:      LiftRole;
  sets:      number;
  repLow:    number;
  repHigh:   number;
  rirLow:    number;              // reps-in-reserve target (proximity to failure)
  rirHigh:   number;
  restSec:   number;
}

export interface ProgramDay {
  name:      string;              // "Full Body A", "Push", "Upper" …
  focus:     string;              // short muscle subtitle
  exercises: ProgramExercise[];
}

export interface ProteinTarget {
  lowG:        number;            // g/day  (1.6 g/kg)
  highG:       number;            // g/day  (2.2 g/kg)
  perMealLowG: number;            // ~0.25 g/kg
  perMealHighG:number;            // ~0.40 g/kg
}

export interface LiftingProgram {
  daysPerWeek:    number;
  goal:           LiftGoal;
  experience:     LiftExperience;
  splitName:      string;         // "Full Body", "Upper / Lower", "Push / Pull / Legs"
  days:           ProgramDay[];
  weeklyVolume:   Record<string, number>;  // FRACTIONAL sets per muscle per week
  weeklyTarget:   number;         // target sets/wk for a major muscle (the volume anchor)
  protein:        ProteinTarget | null;
  createdAt:      string;         // YYYY-MM-DD
  cursor:         number;         // index of the NEXT day to train (advances on start)
  /** Anchor for the volume-progression mesocycle (lib/lifting/volume.ts). The
   *  current week — and thus how many sets to add this week vs. deload — is
   *  derived from this date. Optional so programs created before the volume
   *  ramp existed keep working (volume.ts falls back to createdAt). */
  mesoStartDate?: string;         // YYYY-MM-DD
  mesoWeeks?:     number;         // mesocycle length (default 5: 4 ramp + 1 deload)
}

// ─────────────────────────────────────────────────────────────────────────────
// MOVEMENT REGISTRY — single source for each lift's muscles + role. Templates
// reference these by key so the fractional set-counting metadata lives in ONE
// place and can't drift. `press` flags the joint-friendly low-rep pressing
// pattern (Tier-2 rep-range practicality).
// ─────────────────────────────────────────────────────────────────────────────
interface Movement { name: string; group: string; secondary: string[]; role: LiftRole; press?: boolean }

const M = {
  backSquat:   { name: 'Back Squat',            group: 'quads',     secondary: ['glutes', 'hamstring'], role: 'compound' },
  frontSquat:  { name: 'Front Squat',           group: 'quads',     secondary: ['glutes'],              role: 'compound' },
  legPress:    { name: 'Leg Press',             group: 'quads',     secondary: ['glutes'],              role: 'compound' },
  splitSquat:  { name: 'Bulgarian Split Squat', group: 'quads',     secondary: ['glutes'],              role: 'compound' },
  legExt:      { name: 'Leg Extension',         group: 'quads',     secondary: [],                      role: 'isolation' },
  rdl:         { name: 'Romanian Deadlift',     group: 'hamstring', secondary: ['glutes', 'back'],      role: 'compound' },
  legCurl:     { name: 'Leg Curl',              group: 'hamstring', secondary: [],                      role: 'isolation' },
  deadlift:    { name: 'Deadlift',              group: 'back',      secondary: ['hamstring', 'glutes'], role: 'compound' },
  bench:       { name: 'Bench Press',           group: 'chest',     secondary: ['tricep', 'shoulders'], role: 'compound', press: true },
  incline:     { name: 'Incline Bench Press',   group: 'chest',     secondary: ['shoulders', 'tricep'], role: 'compound', press: true },
  ohp:         { name: 'Overhead Press',        group: 'shoulders', secondary: ['tricep'],              role: 'compound', press: true },
  row:         { name: 'Barbell Row',           group: 'back',      secondary: ['bicep'],               role: 'compound' },
  pulldown:    { name: 'Lat Pulldown',          group: 'back',      secondary: ['bicep'],               role: 'compound' },
  pullup:      { name: 'Pull-ups',              group: 'back',      secondary: ['bicep'],               role: 'compound' },
  cableRow:    { name: 'Seated Cable Row',      group: 'back',      secondary: ['bicep'],               role: 'compound' },
  lateral:     { name: 'Lateral Raises',        group: 'shoulders', secondary: [],                      role: 'isolation' },
  facePull:    { name: 'Face Pulls',            group: 'shoulders', secondary: [],                      role: 'isolation' },
  pushdown:    { name: 'Tricep Pushdown',       group: 'tricep',    secondary: [],                      role: 'isolation' },
  skullcrush:  { name: 'Skull Crushers',        group: 'tricep',    secondary: [],                      role: 'isolation' },
  curl:        { name: 'Dumbbell Curl',         group: 'bicep',     secondary: [],                      role: 'isolation' },
  hammer:      { name: 'Hammer Curls',          group: 'bicep',     secondary: ['forearms'],            role: 'isolation' },
  calfStand:   { name: 'Standing Calf Raise',   group: 'calfs',     secondary: [],                      role: 'isolation' },
  calfSeat:    { name: 'Seated Calf Raise',     group: 'calfs',     secondary: [],                      role: 'isolation' },
  legRaise:    { name: 'Hanging Leg Raises',    group: 'abs',       secondary: [],                      role: 'isolation' },
  cableCrunch: { name: 'Cable Crunch',          group: 'abs',       secondary: [],                      role: 'isolation' },
} satisfies Record<string, Movement>;

type MKey = keyof typeof M;

// ── Day templates (movement-pattern lists) ─────────────────────────────────
interface Tmpl { name: string; focus: string; ex: MKey[] }

const FULL_A: Tmpl = { name: 'Full Body A', focus: 'Squat · Press · Pull', ex: ['backSquat', 'bench', 'row', 'ohp', 'legCurl', 'legRaise'] };
const FULL_B: Tmpl = { name: 'Full Body B', focus: 'Hinge · Incline · Lats', ex: ['rdl', 'incline', 'pulldown', 'lateral', 'legExt', 'cableCrunch'] };
const FULL_C: Tmpl = { name: 'Full Body C', focus: 'Deadlift · Press · Pull-up', ex: ['deadlift', 'ohp', 'pullup', 'legPress', 'curl', 'calfStand'] };

const PUSH: Tmpl = { name: 'Push', focus: 'Chest · Shoulders · Triceps', ex: ['bench', 'ohp', 'incline', 'lateral', 'pushdown', 'skullcrush'] };
const PULL: Tmpl = { name: 'Pull', focus: 'Back · Biceps · Rear Delts', ex: ['row', 'pullup', 'cableRow', 'facePull', 'curl', 'hammer'] };
const LEGS: Tmpl = { name: 'Legs', focus: 'Quads · Hamstrings · Calves', ex: ['backSquat', 'rdl', 'legPress', 'legCurl', 'calfStand', 'legRaise'] };

const UPPER_A: Tmpl = { name: 'Upper A', focus: 'Horizontal Push / Pull', ex: ['bench', 'row', 'ohp', 'pulldown', 'curl', 'pushdown'] };
const LOWER_A: Tmpl = { name: 'Lower A', focus: 'Squat-focused', ex: ['backSquat', 'rdl', 'legPress', 'legCurl', 'calfStand', 'legRaise'] };
const UPPER_B: Tmpl = { name: 'Upper B', focus: 'Vertical Push / Pull', ex: ['ohp', 'pullup', 'incline', 'cableRow', 'lateral', 'skullcrush'] };
const LOWER_B: Tmpl = { name: 'Lower B', focus: 'Hinge-focused', ex: ['deadlift', 'frontSquat', 'splitSquat', 'legExt', 'calfSeat', 'cableCrunch'] };

/** Pick the weekly split. Beginners get full-body even at 3 days (more practice
 *  per lift); everyone else gets the conventional split. Higher day counts exist
 *  to SPREAD weekly volume into smaller sessions (frequency as a distribution
 *  tool), not as an independent growth knob. */
function pickSplit(days: number, exp: LiftExperience): { splitName: string; templates: Tmpl[] } {
  switch (days) {
    case 2:  return { splitName: 'Full Body', templates: [FULL_A, FULL_B] };
    case 3:  return exp === 'beginner'
      ? { splitName: 'Full Body',            templates: [FULL_A, FULL_B, FULL_C] }
      : { splitName: 'Push / Pull / Legs',   templates: [PUSH, PULL, LEGS] };
    case 4:  return { splitName: 'Upper / Lower',       templates: [UPPER_A, LOWER_A, UPPER_B, LOWER_B] };
    case 5:  return { splitName: 'PPL + Upper / Lower', templates: [PUSH, PULL, LEGS, UPPER_A, LOWER_A] };
    default: return { splitName: 'Push / Pull / Legs ×2', templates: [
      PUSH, PULL, LEGS,
      { ...PUSH, name: 'Push B' }, { ...PULL, name: 'Pull B' }, { ...LEGS, name: 'Legs B' },
    ] };
  }
}

// ── Tier-1 volume anchor: target FRACTIONAL sets/week for a major muscle ────
// 5–10 banks the bulk of gains; trained lifters productively use more, so this
// scales with experience. The generator reports actual per-muscle volume so the
// user can see where each muscle lands against this target.
const WEEKLY_TARGET: Record<LiftGoal, Record<LiftExperience, number>> = {
  hypertrophy: { beginner: 10, intermediate: 15, advanced: 20 },
  strength:    { beginner: 8,  intermediate: 12, advanced: 16 },
  general:     { beginner: 8,  intermediate: 10, advanced: 12 },
};

interface Scheme { sets: number; repLow: number; repHigh: number; rirLow: number; rirHigh: number; restSec: number }

/** Per-exercise prescription from the variable hierarchy. Sets scale with
 *  experience (the volume lever); rep range is chosen for practicality/joint
 *  stress; RIR encodes proximity to failure; rest is a fixed Tier-3 default. */
function prescribe(goal: LiftGoal, exp: LiftExperience, role: LiftRole, press: boolean): Scheme {
  const baseCompound = exp === 'advanced' ? 5 : exp === 'beginner' ? 3 : 4;
  const baseIso      = exp === 'advanced' ? 4 : 3;
  const sets = role === 'compound' ? baseCompound : baseIso;

  if (goal === 'strength') {
    return role === 'compound'
      ? { sets, repLow: press ? 3 : 4, repHigh: press ? 5 : 6, rirLow: 2, rirHigh: 3, restSec: 180 }
      : { sets, repLow: 6, repHigh: 10, rirLow: 1, rirHigh: 3, restSec: 120 };
  }

  // hypertrophy + general share rep ranges (load doesn't drive growth); general
  // simply runs fewer total sets via WEEKLY_TARGET and a calmer RIR.
  const rir = goal === 'hypertrophy'
    ? (role === 'compound' ? { rirLow: 1, rirHigh: 3 } : { rirLow: 0, rirHigh: 2 })
    : { rirLow: 2, rirHigh: 3 };

  if (role === 'compound') {
    return press
      ? { sets, repLow: 6, repHigh: 10, ...rir, restSec: goal === 'hypertrophy' ? 150 : 120 }
      : { sets, repLow: 8, repHigh: 12, ...rir, restSec: goal === 'hypertrophy' ? 150 : 120 };
  }
  return { sets, repLow: 10, repHigh: 15, ...rir, restSec: 90 };
}

/** Tier-1 fractional set counting: a set credits its PRIMARY mover 1.0 and each
 *  SECONDARY mover 0.5, summed across every day in the week. This is the
 *  measure the whole methodology is built on. Pure + exported for testing. */
export function computeWeeklyVolume(days: ProgramDay[]): Record<string, number> {
  const vol: Record<string, number> = {};
  for (const day of days) {
    for (const ex of day.exercises) {
      vol[ex.group] = (vol[ex.group] ?? 0) + ex.sets;
      for (const sec of ex.secondary) vol[sec] = (vol[sec] ?? 0) + ex.sets * 0.5;
    }
  }
  // round to 1 decimal so the half-sets read cleanly
  for (const k of Object.keys(vol)) vol[k] = Math.round(vol[k] * 10) / 10;
  return vol;
}

/** Protein target band: 1.6–2.2 g/kg/day, plus a ~0.25–0.40 g/kg per-meal dose. */
export function proteinTargets(bodyweightKg: number): ProteinTarget {
  const kg = Math.max(1, bodyweightKg);
  return {
    lowG:         Math.round(1.6 * kg),
    highG:        Math.round(2.2 * kg),
    perMealLowG:  Math.round(0.25 * kg),
    perMealHighG: Math.round(0.40 * kg),
  };
}

/** Generate a full structured program. `daysPerWeek` is clamped to 2–6. */
export function generateProgram(inputs: LiftingInputs): LiftingProgram {
  const days = Math.max(2, Math.min(6, Math.round(inputs.daysPerWeek)));
  const { goal, experience } = inputs;
  const { splitName, templates } = pickSplit(days, experience);

  // Beginners cap at 5 exercises/session for recovery + technique focus.
  const exerciseCap = experience === 'beginner' ? 5 : 6;

  const programDays: ProgramDay[] = templates.map(t => ({
    name:  t.name,
    focus: t.focus,
    exercises: t.ex.slice(0, exerciseCap).map(key => {
      const mv = M[key] as Movement;
      const s  = prescribe(goal, experience, mv.role, mv.press ?? false);
      return {
        name: mv.name, group: mv.group, secondary: mv.secondary, role: mv.role,
        sets: s.sets, repLow: s.repLow, repHigh: s.repHigh,
        rirLow: s.rirLow, rirHigh: s.rirHigh, restSec: s.restSec,
      };
    }),
  }));

  const today = new Date().toISOString().slice(0, 10);
  return {
    daysPerWeek: days,
    goal,
    experience,
    splitName,
    days: programDays,
    weeklyVolume: computeWeeklyVolume(programDays),
    weeklyTarget: WEEKLY_TARGET[goal][experience],
    protein: inputs.bodyweightKg ? proteinTargets(inputs.bodyweightKg) : null,
    createdAt: today,
    cursor: 0,
    mesoStartDate: today,   // week 1 of the first mesocycle starts now
    mesoWeeks: 5,
  };
}

/** Suggested working weight for an exercise from the user's all-time PR, scaled
 *  to the goal's intensity (matching the prescribed rep range) and rounded to
 *  the nearest 5 lb. Returns null when no PR is known. Input/output canonical lb. */
export function suggestedWorkingLb(prLb: number | undefined, goal: LiftGoal): number | null {
  if (!prLb || prLb <= 0) return null;
  const factor = goal === 'strength' ? 0.85 : goal === 'hypertrophy' ? 0.72 : 0.75;
  return Math.max(5, Math.round((prLb * factor) / 5) * 5);
}
