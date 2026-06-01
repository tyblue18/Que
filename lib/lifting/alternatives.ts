/**
 * lib/lifting/alternatives.ts
 *
 * The movement-pattern / muscle-mapping layer. Each prescribed exercise belongs
 * to a FAMILY of variations that train the same primary muscle from the same
 * pattern (e.g. the horizontal-press family: Bench Press, Dumbbell Bench Press,
 * Machine Chest Press…). This is the connective tissue the program was missing:
 *
 *   • Substitutions link — swap Bench Press → Dumbbell Bench Press and the
 *     program keeps tracking it (the coach + volume read the new movement).
 *   • Volume counting stays correct — a swapped variation carries the same
 *     primary + secondary muscles, so fractional-set credit doesn't drift.
 *   • Intentional rotation between mesocycles becomes a feature, not a bug —
 *     same-muscle variations from a different angle are evidence-based.
 *
 * Families are ROLE-CONSISTENT (all compound or all isolation) so swapping never
 * invalidates the prescription (sets / reps / RIR / rest are preserved; only the
 * movement's identity + muscle mapping change).
 */

import type { LiftRole } from '@/lib/lifting/program';

/** A swappable movement: its name + the muscles it trains (for volume credit). */
export interface AltMovement {
  name:      string;
  group:     string;        // primary mover (lowercase PRESETS muscle key)
  secondary: string[];      // 0.5-credit muscles
  role:      LiftRole;
}

interface Family {
  group:     string;
  secondary: string[];
  role:      LiftRole;
  names:     string[];      // first = the generator's canonical pick
}

// Each family shares one muscle mapping across its variations (same-pattern
// movements train roughly the same muscles). Names are real, loggable exercises.
const FAMILIES: Family[] = [
  // ── Lower: squat pattern ──────────────────────────────────────────────────
  { group: 'quads', secondary: ['glutes', 'hamstring'], role: 'compound',
    names: ['Back Squat', 'Front Squat', 'Leg Press', 'Hack Squat', 'Goblet Squat', 'Smith Machine Squat'] },
  { group: 'quads', secondary: ['glutes'], role: 'compound',
    names: ['Bulgarian Split Squat', 'Walking Lunges', 'Lunges', 'Step-ups'] },
  { group: 'quads', secondary: [], role: 'isolation',
    names: ['Leg Extension', 'Sissy Squat'] },

  // ── Lower: hinge pattern ──────────────────────────────────────────────────
  { group: 'hamstring', secondary: ['glutes', 'back'], role: 'compound',
    names: ['Romanian Deadlift', 'Stiff-Leg Deadlift', 'Good Mornings', 'Dumbbell RDL'] },
  { group: 'hamstring', secondary: [], role: 'isolation',
    names: ['Leg Curl', 'Seated Leg Curl', 'Lying Leg Curl', 'Nordic Curl'] },
  { group: 'back', secondary: ['hamstring', 'glutes'], role: 'compound',
    names: ['Deadlift', 'Sumo Deadlift', 'Trap Bar Deadlift', 'Rack Pull'] },

  // ── Push: horizontal / incline / overhead press ───────────────────────────
  { group: 'chest', secondary: ['tricep', 'shoulders'], role: 'compound',
    names: ['Bench Press', 'Dumbbell Bench Press', 'Machine Chest Press', 'Smith Machine Press', 'Push-ups'] },
  { group: 'chest', secondary: ['shoulders', 'tricep'], role: 'compound',
    names: ['Incline Bench Press', 'Incline Dumbbell Press', 'Incline Smith Press'] },
  { group: 'shoulders', secondary: ['tricep'], role: 'compound',
    names: ['Overhead Press', 'Dumbbell Shoulder Press', 'Arnold Press', 'Machine Shoulder Press'] },

  // ── Pull: row / vertical pull ─────────────────────────────────────────────
  { group: 'back', secondary: ['bicep'], role: 'compound',
    names: ['Barbell Row', 'Dumbbell Row', 'Seated Cable Row', 'T-Bar Row', 'Single-Arm Row', 'Chest-Supported Row'] },
  { group: 'back', secondary: ['bicep'], role: 'compound',
    names: ['Pull-ups', 'Chin-ups', 'Lat Pulldown', 'Assisted Pull-ups'] },

  // ── Shoulders: lateral / rear delt isolation ──────────────────────────────
  { group: 'shoulders', secondary: [], role: 'isolation',
    names: ['Lateral Raises', 'Cable Lateral Raise', 'Machine Lateral Raise'] },
  { group: 'shoulders', secondary: [], role: 'isolation',
    names: ['Face Pulls', 'Rear Delt Flyes', 'Reverse Pec Deck'] },

  // ── Arms isolation ────────────────────────────────────────────────────────
  { group: 'tricep', secondary: [], role: 'isolation',
    names: ['Tricep Pushdown', 'Overhead Tricep Extension', 'Skull Crushers', 'Dips', 'Cable Tricep Kickback'] },
  { group: 'bicep', secondary: [], role: 'isolation',
    names: ['Dumbbell Curl', 'Barbell Curl', 'Hammer Curls', 'Cable Curl', 'Preacher Curl', 'Incline Curl'] },

  // ── Calves / abs isolation ────────────────────────────────────────────────
  { group: 'calfs', secondary: [], role: 'isolation',
    names: ['Standing Calf Raise', 'Seated Calf Raise', 'Leg Press Calf Raise'] },
  { group: 'abs', secondary: [], role: 'isolation',
    names: ['Hanging Leg Raises', 'Cable Crunch', 'Crunches', 'Ab Wheel Rollout', 'Plank'] },
];

// Reverse index: any exercise name → the family it belongs to.
const NAME_TO_FAMILY = new Map<string, Family>();
for (const fam of FAMILIES) for (const n of fam.names) NAME_TO_FAMILY.set(n, fam);

/**
 * All same-muscle variations a given exercise can be swapped for, INCLUDING the
 * exercise itself (so the current pick can be shown selected). Empty when the
 * exercise isn't in any known family (no swap offered).
 */
export function alternativesFor(name: string): AltMovement[] {
  const fam = NAME_TO_FAMILY.get(name);
  if (!fam) return [];
  return fam.names.map(n => ({ name: n, group: fam.group, secondary: fam.secondary, role: fam.role }));
}

/** True iff the exercise has ≥1 alternative to swap to. */
export function hasAlternatives(name: string): boolean {
  const fam = NAME_TO_FAMILY.get(name);
  return !!fam && fam.names.length > 1;
}
