/**
 * lib/weeklyRecap.ts
 *
 * Pure, client-side computation of a user's "week in review" from localDB.
 * Runs entirely on the device (which already holds the full history), so the
 * Sunday-evening push only needs to nudge the user to open the app — the rich
 * stats are derived here and rendered by components/WeeklyRecapModal.tsx.
 *
 * The week is the 7 days (Mon–Sun) ending on a given Sunday. Progress/PR stats
 * compare this week against everything logged BEFORE the week started.
 */

import type { LocalDB, DayRecord, ExerciseEntry, SetData, UserProfile } from '@/lib/AppContext';
import { loadPlan, getPlanBaseline, type AthletePlan } from '@/lib/metricsTypes';
import { isGoalDay, dayMaintenanceFromRecord, computeBaseBudget, type PlanDirection } from '@/lib/calorie-utils';
import { estimateAdaptiveTDEE, countQualifyingDays, QUALIFYING_DAYS_TO_UNLOCK, type TdeeDay, type TdeeConfidence } from '@/lib/adaptiveTdee';
import { ADAPTIVE_TDEE_LAST_KEY } from '@/lib/constants';

// ── date helpers ────────────────────────────────────────────────────────────

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Most recent Sunday on or before `now` (local). Identifies the recap week. */
export function recapSunday(now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - d.getDay()); // getDay() 0 = Sunday → no shift on Sun
  return toDateStr(d);
}

/** The 7 date strings (Mon → Sun) for the week ending on `sundayStr`. */
function weekDates(sundayStr: string): string[] {
  const sun = new Date(sundayStr + 'T00:00:00');
  const out: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(sun);
    d.setDate(sun.getDate() - i);
    out.push(toDateStr(d));
  }
  return out;
}

function fmtShort(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── parsing helpers ─────────────────────────────────────────────────────────

const num = (v: unknown): number => {
  const n = parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
};

function parseExercises(raw: unknown): ExerciseEntry[] {
  if (!raw || String(raw).length < 2) return [];
  try {
    const arr = JSON.parse(String(raw));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/** Normalise a lift entry to a SetData[] (handles the legacy s/r/w shape). */
function liftSets(ex: ExerciseEntry): SetData[] {
  if (Array.isArray(ex.sets) && ex.sets.length) return ex.sets;
  const count = Math.max(1, parseInt(String(ex.s ?? '1')) || 1);
  return Array.from({ length: count }, () => ({ r: ex.r ?? '0', w: ex.w ?? '0' }));
}

/** Estimated 1-rep-max (Epley) — a fair single number to compare progress. */
const est1RM = (weight: number, reps: number): number =>
  weight > 0 && reps > 0 ? weight * (1 + reps / 30) : weight;

// ── result shape ────────────────────────────────────────────────────────────

export interface CardioSessionHi { kind: 'run' | 'bike' | 'swim'; value: number; date: string }
export interface LiftPR        { name: string; weight: number; delta: number }
export interface LiftProgress  { name: string; kind: 'weight' | 'reps'; from: number; to: number }

export interface WeeklyRecap {
  weekId:      string;        // the Sunday this recap is for
  rangeLabel:  string;        // "Jan 6 – Jan 12"
  daysLogged:  number;        // days with ANY activity (workout or food)
  workoutDays: number;

  cardio: {
    sessions:      number;
    totalMiles:    number;
    runMiles:      number;
    bikeMiles:     number;
    swimMiles:     number;
    totalMinutes:  number;
    caloriesBurned: number;
    fastestRun?:   { pace: string; miles: number; date: string };  // best min/mi
    longest?:      { kind: 'run' | 'bike' | 'swim'; miles: number; date: string };
  };

  lifts: {
    sessions:     number;     // days with a lift logged
    totalVolume:  number;     // Σ reps × weight
    totalReps:    number;
    totalSets:    number;
    topSet?:      { name: string; weight: number; reps: number };
    prs:          LiftPR[];
    improvements: LiftProgress[];
  };

  steps:  { total: number; dailyAvg: number; bestDay?: { steps: number; date: string } };
  weight: { startVal?: number; latestVal?: number; change?: number };

  nutrition: { daysLogged: number; daysOnTarget: number; avgCalories: number; avgProtein: number };

  /** Present only when the user has an active cut/bulk plan. */
  plan?: {
    type:          'cut' | 'bulk';
    weekChange?:   number;    // weigh-in change across the week (lb)
    overallChange?: number;   // baseline → latest (lb)
    goalWeight:    number;
    daysOnTarget:  number;
    avgDailyKcal:  number;
  };

  /** Adaptive maintenance estimate (learned from logs), when enough data exists.
   *  `status` drives the honest weekly beat: 'updated' only on a meaningful
   *  delta, 'steady' otherwise, 'locked' when still unlocking. */
  maintenance?: {
    status:     'updated' | 'steady' | 'locked';
    estimate?:  number;            // current blended estimate (kcal), when unlocked
    previous?:  number;            // last shown estimate, when status === 'updated'
    confidence?: TdeeConfidence;
    qualifyingDays?: number;       // progress, when status === 'locked'
    needed?:    number;            // qualifying days needed to unlock
  };

  /** Punchy one-liners for the modal header rotation. */
  highlights: string[];
}

// Meaningful week-over-week change: > this many kcal OR a confidence-band shift.
// Below it we say "held steady" — manufacturing a weekly "updated!" when the
// number barely moved trains users to ignore the signal. [heuristic]
const MAINTENANCE_DELTA_KCAL = 50;

// ── the computation ─────────────────────────────────────────────────────────

export function computeWeeklyRecap(
  localDB: LocalDB,
  profile: UserProfile,
  sundayStr = recapSunday(),
): WeeklyRecap {
  const dates    = weekDates(sundayStr);
  const weekStart = dates[0];
  const inWeek   = (ds: string) => ds >= weekStart && ds <= sundayStr;

  // Active plan + direction — drives the plan-aware "on target" count below
  // (under maintenance on a cut / over on a bulk), matching coins + badges.
  // loadPlan() returns null server-side (no localStorage), so the cron recap
  // falls back to the ±100 band — fine, its plan block is omitted there anyway.
  const ap: AthletePlan | null = typeof window !== 'undefined' ? loadPlan() : null;
  const planDirection: PlanDirection = ap?.type === 'cut' || ap?.type === 'bulk' ? ap.type : null;

  let workoutDays = 0, daysLogged = 0;

  // Cardio
  let runMiles = 0, bikeMiles = 0, swimMiles = 0, totalMinutes = 0, caloriesBurned = 0, cardioSessions = 0;
  let fastestRun: WeeklyRecap['cardio']['fastestRun'];
  let longest:    WeeklyRecap['cardio']['longest'];
  let bestPace = Infinity, longestMiles = 0;

  // Lifts
  let totalVolume = 0, totalReps = 0, totalSets = 0, liftDays = 0;
  let topSet: WeeklyRecap['lifts']['topSet'];
  let topSetScore = 0;
  // this-week best weight + best est1RM per exercise (for PR/progress)
  const weekBestWeight = new Map<string, number>();
  const weekBest1RM    = new Map<string, { e1rm: number; weight: number; reps: number }>();

  // Steps / weight / nutrition
  let stepsTotal = 0; let bestStepDay: { steps: number; date: string } | undefined;
  let calDays = 0, onTargetDays = 0, calSum = 0, proteinSum = 0, proteinDays = 0;
  const weighIns: { date: string; w: number }[] = [];

  for (const ds of dates) {
    const rec = localDB[ds] as DayRecord | undefined;
    if (!rec) continue;

    const exs        = parseExercises(rec.exercises);
    const hasWorkout = exs.length > 0;
    const calsEaten  = num(rec.calsEaten);
    if (hasWorkout) workoutDays++;
    if (hasWorkout || calsEaten > 0) daysLogged++;

    // ── cardio (day-level totals + per-session highlights) ──
    const rMi = num(rec.runDist), bMi = num(rec.bikeDist), sMi = num(rec.swimDist);
    runMiles += rMi; bikeMiles += bMi; swimMiles += sMi;
    totalMinutes   += num(rec.runTime) + num(rec.bikeTime) + num(rec.swimTime);
    caloriesBurned += num(rec.burn);

    for (const ex of exs) {
      if (ex.k === 'run' || ex.k === 'bike' || ex.k === 'swim') {
        cardioSessions++;
        // run/bike: v1=dist v2=time · swim: v1=time v2=dist
        const dist = ex.k === 'swim' ? num(ex.v2) : num(ex.v1);
        const time = ex.k === 'swim' ? num(ex.v1) : num(ex.v2);
        if (dist > longestMiles) { longestMiles = dist; longest = { kind: ex.k, miles: dist, date: ds }; }
        if ((ex.k === 'run') && dist > 0 && time > 0) {
          const pace = time / dist; // min per mile
          if (pace < bestPace) {
            bestPace = pace;
            const mm = Math.floor(pace), ssNum = Math.round((pace - mm) * 60);
            fastestRun = { pace: `${mm}:${String(ssNum).padStart(2, '0')} /mi`, miles: dist, date: ds };
          }
        }
      } else if (ex.k === 'lift' && ex.n) {
        const sets = liftSets(ex);
        for (const s of sets) {
          const w = num(s.w), r = num(s.r);
          if (r > 0) { totalReps += r; totalSets++; totalVolume += w * r; }
          if (w > 0) {
            weekBestWeight.set(ex.n, Math.max(weekBestWeight.get(ex.n) ?? 0, w));
            const e1rm = est1RM(w, r);
            const prev = weekBest1RM.get(ex.n);
            if (!prev || e1rm > prev.e1rm) weekBest1RM.set(ex.n, { e1rm, weight: w, reps: r });
            const score = w * Math.max(1, r);
            if (score > topSetScore) { topSetScore = score; topSet = { name: ex.n, weight: w, reps: r }; }
          }
        }
      }
    }
    if (exs.some(e => e.k === 'lift')) liftDays++;

    // ── steps / weight / nutrition ──
    const st = num(rec.steps);
    stepsTotal += st;
    if (st > 0 && (!bestStepDay || st > bestStepDay.steps)) bestStepDay = { steps: st, date: ds };

    const wt = num(rec.weight);
    if (wt > 0) weighIns.push({ date: ds, w: wt });

    if (calsEaten > 0) {
      calDays++; calSum += calsEaten;
      if (isGoalDay(rec.calsEaten, rec.budget, dayMaintenanceFromRecord(rec), planDirection)) onTargetDays++;
    }
    const prot = num(rec.protein);
    if (prot > 0) { proteinSum += prot; proteinDays++; }
  }

  // ── PRs + progress: compare this week vs everything BEFORE the week ──
  const priorBestWeight = new Map<string, number>();
  const priorBest1RM    = new Map<string, number>();
  for (const [ds, rec] of Object.entries(localDB)) {
    if (ds >= weekStart) continue; // only history before this week
    for (const ex of parseExercises((rec as DayRecord).exercises)) {
      if (ex.k !== 'lift' || !ex.n) continue;
      for (const s of liftSets(ex)) {
        const w = num(s.w), r = num(s.r);
        if (w > 0) {
          priorBestWeight.set(ex.n, Math.max(priorBestWeight.get(ex.n) ?? 0, w));
          priorBest1RM.set(ex.n, Math.max(priorBest1RM.get(ex.n) ?? 0, est1RM(w, r)));
        }
      }
    }
  }

  const prs: LiftPR[] = [];
  const improvements: LiftProgress[] = [];
  for (const [name, wkWeight] of weekBestWeight) {
    const priorW = priorBestWeight.get(name) ?? 0;
    if (priorW > 0 && wkWeight > priorW) {
      prs.push({ name, weight: wkWeight, delta: Math.round((wkWeight - priorW) * 10) / 10 });
    }
    // est-1RM progress (catches rep PRs at the same weight too)
    const wk1 = weekBest1RM.get(name)?.e1rm ?? 0;
    const pr1 = priorBest1RM.get(name) ?? 0;
    if (priorW > 0 && wk1 > pr1 * 1.001 && wkWeight <= priorW) {
      // same/lower top weight but a stronger set (more reps) → rep progress
      const best = weekBest1RM.get(name)!;
      improvements.push({ name, kind: 'reps', from: Math.round(pr1), to: best.reps });
    }
  }
  prs.sort((a, b) => b.delta - a.delta);
  // Weight PRs are the headline improvements; merge a couple rep gains in after.
  const weightImprovements: LiftProgress[] = prs.slice(0, 4).map(p => ({
    name: p.name, kind: 'weight', from: (priorBestWeight.get(p.name) ?? 0), to: p.weight,
  }));
  const allImprovements = [...weightImprovements, ...improvements].slice(0, 5);

  // ── weight change ──
  weighIns.sort((a, b) => a.date.localeCompare(b.date));
  const startVal  = weighIns[0]?.w;
  const latestVal = weighIns[weighIns.length - 1]?.w;
  const weightChange = startVal != null && latestVal != null
    ? Math.round((latestVal - startVal) * 10) / 10 : undefined;

  // ── plan (if any) ── (ap + planDirection computed near the top)
  let plan: WeeklyRecap['plan'];
  if (ap) {
    const baseline = getPlanBaseline(ap, localDB);
    plan = {
      type:          ap.type,
      weekChange:    weightChange,
      overallChange: latestVal != null ? Math.round((latestVal - baseline) * 10) / 10 : undefined,
      goalWeight:    ap.goalWeight,
      daysOnTarget:  onTargetDays,
      avgDailyKcal:  calDays > 0 ? Math.round(calSum / calDays) : 0,
    };
  }

  // ── headline highlights ──
  const highlights: string[] = [];
  if (workoutDays > 0) highlights.push(`${workoutDays} workout${workoutDays !== 1 ? 's' : ''} logged`);
  if (prs.length > 0)  highlights.push(`${prs.length} new PR${prs.length !== 1 ? 's' : ''} 💪`);
  const totalMiles = Math.round((runMiles + bikeMiles + swimMiles) * 10) / 10;
  if (totalMiles > 0) highlights.push(`${totalMiles} mi of cardio`);
  if (plan && plan.weekChange != null && plan.weekChange !== 0) {
    const dir = plan.weekChange < 0 ? 'down' : 'up';
    highlights.push(`${Math.abs(plan.weekChange)} lb ${dir} this week`);
  }
  if (onTargetDays >= 5) highlights.push(`${onTargetDays}/7 days on your calorie goal 🎯`);

  // ── Adaptive maintenance — the weekly recalibration beat ───────────────────
  // Estimated from the FULL history (the engine windows internally), with the
  // Mifflin formula as the fallback/clamp anchor. Honest stability detection:
  // compare to the last estimate we showed; only call it "updated" on a real
  // delta or a confidence-band change. Skipped server-side (no localStorage).
  let maintenance: WeeklyRecap['maintenance'];
  if (typeof window !== 'undefined') {
    const tdeeDays: TdeeDay[] = Object.entries(localDB).map(([date, rec]) => ({
      date, weight: (rec as DayRecord).weight, calsEaten: (rec as DayRecord).calsEaten,
    }));
    // Reconstruct full TDEE: computeBaseBudget = round(bmr×mul) − deficit, so
    // + deficit recovers bmr×mul. ⚠️ MUST stay equal to the MaintenanceCard's
    // direct `m.tdee` read (MetricsDashboard) — both feed the SAME engine, so if
    // the budget formula ever changes, this reconstruction has to change with it
    // or the card and the recap will silently disagree on the same user's number.
    const formulaTdee = computeBaseBudget(profile) + (num(profile.deficit) || 0);
    const r = estimateAdaptiveTDEE(tdeeDays, formulaTdee > 0 ? formulaTdee : computeBaseBudget(profile));

    if (r.estimate === null) {
      maintenance = { status: 'locked', qualifyingDays: countQualifyingDays(tdeeDays), needed: QUALIFYING_DAYS_TO_UNLOCK };
    } else {
      // Read last shown estimate; decide updated vs steady.
      let prev: { weekId?: string; estimate?: number; confidence?: TdeeConfidence } | null = null;
      try { prev = JSON.parse(localStorage.getItem(ADAPTIVE_TDEE_LAST_KEY) ?? 'null'); } catch { /* ignore */ }
      const changed =
        !prev?.estimate ||
        Math.abs(r.estimate - prev.estimate) > MAINTENANCE_DELTA_KCAL ||
        prev.confidence !== r.confidence;
      maintenance = changed
        ? { status: 'updated', estimate: r.estimate, previous: prev?.estimate, confidence: r.confidence }
        : { status: 'steady',  estimate: r.estimate, confidence: r.confidence };
      // NOTE: we do NOT persist the baseline here — this function stays pure-ish
      // (a read is fine; a write isn't). The caller calls markRecapMaintenanceShown()
      // when the recap is actually SHOWN, so a background compute can't silently
      // advance the baseline and swallow a real "updated" the user never saw.
    }
  }

  return {
    weekId:     sundayStr,
    rangeLabel: `${fmtShort(weekStart)} – ${fmtShort(sundayStr)}`,
    daysLogged,
    workoutDays,
    cardio: {
      sessions:       cardioSessions,
      totalMiles,
      runMiles:       Math.round(runMiles * 10) / 10,
      bikeMiles:      Math.round(bikeMiles * 10) / 10,
      swimMiles:      Math.round(swimMiles * 10) / 10,
      totalMinutes:   Math.round(totalMinutes),
      caloriesBurned: Math.round(caloriesBurned),
      fastestRun,
      longest,
    },
    lifts: {
      sessions:     liftDays,
      totalVolume:  Math.round(totalVolume),
      totalReps,
      totalSets,
      topSet,
      prs:          prs.slice(0, 5),
      improvements: allImprovements,
    },
    steps:  { total: stepsTotal, dailyAvg: daysLogged > 0 ? Math.round(stepsTotal / 7) : 0, bestDay: bestStepDay },
    weight: { startVal, latestVal, change: weightChange },
    nutrition: {
      daysLogged:   calDays,
      daysOnTarget: onTargetDays,
      avgCalories:  calDays > 0 ? Math.round(calSum / calDays) : 0,
      avgProtein:   proteinDays > 0 ? Math.round(proteinSum / proteinDays) : 0,
    },
    plan,
    maintenance,
    highlights,
  };
}

/** True if there's enough logged this week to bother showing a recap. */
export function hasRecapData(r: WeeklyRecap): boolean {
  return r.workoutDays > 0 || r.nutrition.daysLogged > 0 || r.steps.total > 0;
}

/** Persist the maintenance estimate the user was just SHOWN, so next week's
 *  recap compares against it (updated vs. steady). Call this only when the recap
 *  is actually displayed — keeping computeWeeklyRecap free of side effects so a
 *  background compute can't advance the baseline and swallow a real change. */
export function markRecapMaintenanceShown(r: WeeklyRecap): void {
  if (typeof window === 'undefined') return;
  const m = r.maintenance;
  if (!m || m.estimate == null) return;
  try {
    localStorage.setItem(ADAPTIVE_TDEE_LAST_KEY, JSON.stringify({
      weekId: r.weekId, estimate: m.estimate, confidence: m.confidence,
    }));
  } catch { /* storage full */ }
}
