/**
 * lib/badgeEngine.ts
 *
 * Server-side badge evaluation. Called as a side-effect of every POST /api/sync.
 * Reads synced workout data, computes which badge thresholds are met, and
 * writes newly earned badges to the Badge table. Each badge is awarded at most
 * once (@@unique [userId, slug]).
 *
 * Adding a new badge: add one entry to BADGE_DEFS — no schema changes needed.
 */

import { prisma }        from '@/lib/prisma';
import { isGoalDay, dayMaintenanceFromRecord, type PlanDirection } from '@/lib/calorie-utils';
import {
  ATHLETE_PLAN_KEY, MILLION_GROUPS_KEY, LIFT_PRS_KEY, MACRO_GOALS_KEY,
} from '@/lib/constants';
import { BADGE_CATALOG } from '@/lib/badgeCatalog';
import { maxWorkoutStreak as restAwareWorkoutStreak, type StreakDay } from '@/lib/streaks';

// ── Types ──────────────────────────────────────────────────────────────────────

interface DayRecord {
  calsEaten?: string;
  budget?:    number | string;
  tdee?:      number | string;
  burn?:      number | string;
  [key: string]:  unknown;
}

interface BadgeCheckData {
  // queLiftPRs: exercise name → all-time max weight (lbs)
  liftPRs:    Record<string, number>;
  localDB:    Record<string, DayRecord>;
  settings:   Record<string, unknown>;
  /** Count of resolved Challenge rows where this user was the winner. */
  battleWins: number;
  /** Count of successful invites (referral_sent CoinTransactions). */
  referralCount: number;
  /** Current plan direction — makes calorie-goal streaks plan-aware (matches
   *  the coin engine): under maintenance counts on a cut, over on a bulk. */
  planDirection: PlanDirection;
}

interface BadgeDef {
  slug:     string;
  label:    string;
  icon:     string;
  category: 'lift' | 'cardio' | 'nutrition';
  check:    (data: BadgeCheckData) => boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// isGoalDay lives in lib/calorie-utils (shared with the coin engine + client).

/** Plan-aware "calorie goal" for a single day (mirrors the coin engine). */
function goalDay(rec: DayRecord, direction: PlanDirection): boolean {
  return isGoalDay(rec.calsEaten, rec.budget, dayMaintenanceFromRecord(rec), direction);
}

/** Returns the longest consecutive calorie-goal streak in localDB. */
function maxStreak(localDB: Record<string, DayRecord>, direction: PlanDirection): number {
  const goalDays = Object.keys(localDB)
    .filter(d => goalDay(localDB[d], direction))
    .sort();

  if (goalDays.length === 0) return 0;

  let max = 1, cur = 1;
  for (let i = 1; i < goalDays.length; i++) {
    const prev = new Date(goalDays[i - 1] + 'T00:00:00Z');
    const curr = new Date(goalDays[i]     + 'T00:00:00Z');
    const gap  = Math.round((curr.getTime() - prev.getTime()) / 86400000);
    if (gap === 1) { cur++; max = Math.max(max, cur); }
    else           { cur = 1; }
  }
  return max;
}

/** Shared consecutive-day streak counter. */
function longestStreak(days: string[]): number {
  if (days.length === 0) return 0;
  let max = 1, cur = 1;
  for (let i = 1; i < days.length; i++) {
    const gap = Math.round(
      (new Date(days[i] + 'T00:00:00Z').getTime() - new Date(days[i - 1] + 'T00:00:00Z').getTime()) / 86400000
    );
    if (gap === 1) { cur++; max = Math.max(max, cur); }
    else           { cur = 1; }
  }
  return max;
}

/** Returns the longest workout streak in localDB. Rest days the user marked
 *  BRIDGE the streak (shared with the calendar/metrics UI via lib/streaks so
 *  the awarded badge and the displayed streak can't drift). */
function maxWorkoutStreak(localDB: Record<string, DayRecord>): number {
  // DayRecord here is index-signature typed; StreakDay reads only exercises/restDay.
  return restAwareWorkoutStreak(localDB as Record<string, StreakDay>);
}

/** Returns the longest streak where BOTH a workout was logged AND the calorie goal was hit. */
function maxCombinedStreak(localDB: Record<string, DayRecord>, direction: PlanDirection): number {
  return longestStreak(
    Object.keys(localDB).filter(d => {
      const rec = localDB[d];
      return String(rec.exercises ?? '').length > 2 && goalDay(rec, direction);
    }).sort()
  );
}

/** True if any of the given exercise name variants has a PR ≥ weight. */
function liftHit(liftPRs: Record<string, number>, exercises: string[], weight: number): boolean {
  return exercises.some(ex => (liftPRs[ex] ?? 0) >= weight);
}

/** Shorthand for creating a lift badge definition. */
function lb(slug: string, label: string, icon: string, exercises: string[], weight: number): BadgeDef {
  return {
    slug, label, icon, category: 'lift',
    check: ({ liftPRs }) => liftHit(liftPRs, exercises, weight),
  };
}

// ── Badge definitions ──────────────────────────────────────────────────────────
//
// Exercise name arrays cover common variations users might type.
// Weight thresholds are in pounds (matching queLiftPRs).
//
const BENCH = ['Bench Press', 'Barbell Bench Press', 'Flat Bench Press', 'Flat Barbell Bench'];
const SQUAT = ['Squat', 'Back Squat', 'Barbell Squat', 'Low Bar Squat', 'High Bar Squat'];
const DEAD  = ['Deadlift', 'Barbell Deadlift', 'Conventional Deadlift', 'Romanian Deadlift'];
const OHP   = ['Overhead Press', 'OHP', 'Military Press', 'Barbell OHP', 'Standing OHP', 'Barbell Overhead Press'];

/** Best PR across a set of exercise name variants. */
function bestPR(liftPRs: Record<string, number>, exercises: string[]): number {
  return exercises.reduce((max, ex) => Math.max(max, liftPRs[ex] ?? 0), 0);
}

// ── Helpers for the "fun" badges below ──────────────────────────────────────────

/** True if a day has a logged workout (mirrors the streak predicate). */
function hasWorkout(d: DayRecord): boolean {
  return String(d.exercises ?? '').length > 2;
}
/** True if a day has at least one logged LIFT (k==='lift'), not just cardio. */
function hasLift(d: DayRecord): boolean {
  try {
    const exs = JSON.parse(String(d.exercises ?? '[]'));
    return Array.isArray(exs) && exs.some(ex => (ex as { k?: string }).k === 'lift');
  } catch { return false; }
}
/** US Thanksgiving = 4th Thursday of November (the Thursday landing on Nov 22–28). */
function isThanksgiving(date: string): boolean {
  const [, m, d] = date.split('-').map(Number);
  return m === 11 && d >= 22 && d <= 28 && dow(date) === 4;
}
/** Gregorian dates of Chinese New Year (lunar — no formula). Extend the list as years pass. */
const CHINESE_NEW_YEAR = new Set([
  '2025-01-29', '2026-02-17', '2027-02-06', '2028-01-26', '2029-02-13', '2030-02-03',
  '2031-01-23', '2032-02-11', '2033-01-31', '2034-02-19', '2035-02-08',
]);
/** UTC day-of-week for a YYYY-MM-DD (0 = Sun … 6 = Sat). */
function dow(date: string): number {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}
/** Whole days from a → b (both YYYY-MM-DD). */
function dayGap(a: string, b: string): number {
  return Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86_400_000);
}
/** Monday (YYYY-MM-DD) of the week containing date. */
function weekStart(date: string): string {
  const dt  = new Date(date + 'T00:00:00Z');
  const day = dt.getUTCDay();                 // 0=Sun..6=Sat
  dt.setUTCDate(dt.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return dt.toISOString().slice(0, 10);
}
/** A day's total for a macro: prefer the pre-summed day-level field, else sum foods. */
function dayMacro(d: DayRecord, field: 'protein' | 'carbs' | 'fat'): number {
  const v = d[field];
  if (v !== undefined && v !== null && v !== '') {
    const n = parseFloat(String(v));
    if (Number.isFinite(n)) return n;
  }
  try {
    const foods = JSON.parse(String(d.foods ?? '[]'));
    if (Array.isArray(foods)) {
      return foods.reduce((s, f) => s + (parseFloat(String((f as Record<string, unknown>)[field] ?? '0')) || 0), 0);
    }
  } catch { /* corrupt day — treat as 0 */ }
  return 0;
}

const BADGE_DEFS: BadgeDef[] = [
  // ── Bench Press ──────────────────────────────────────────────────────────────
  lb('bench_135', '135 Bench',         '/Badges/135_bench_badge.png',  BENCH, 135),
  lb('bench_225', '225 Bench',         '/Badges/225_bench_badge.png',  BENCH, 225),
  lb('bench_315', '315 Bench',         '/Badges/315_bench_badge.png',  BENCH, 315),
  lb('bench_405', '405 Bench',         '/Badges/405_bench_badge.png',  BENCH, 405),
  lb('bench_495', '495 Bench',         '/Badges/495_bench_badge.png',  BENCH, 495),
  lb('bench_540', '540 Bench',         '/Badges/540_bench_badge.png',  BENCH, 540),
  lb('bench_630', '630 Bench',         '/Badges/630_bench_badge.png',  BENCH, 630),

  // ── Squat ─────────────────────────────────────────────────────────────────────
  lb('squat_135', '135 Squat',         '/Badges/135_squat_badge.png',  SQUAT, 135),
  lb('squat_225', '225 Squat',         '/Badges/225_squat_badge.png',  SQUAT, 225),
  lb('squat_315', '315 Squat',         '/Badges/315_squad_badge.png',  SQUAT, 315),
  lb('squat_405', '405 Squat',         '/Badges/405_squat_badge.png',  SQUAT, 405),
  lb('squat_495', '495 Squat',         '/Badges/495_squat_badge.png',  SQUAT, 495),
  lb('squat_540', '540 Squat',         '/Badges/540_squat_badge.png',  SQUAT, 540),
  lb('squat_630', '630 Squat',         '/Badges/630_squat_badge.png',  SQUAT, 630),

  // ── Deadlift ──────────────────────────────────────────────────────────────────
  lb('dead_135', '135 Deadlift',       '/Badges/135_deadlift_badge.png', DEAD, 135),
  lb('dead_225', '225 Deadlift',       '/Badges/225_deadlift_badge.png', DEAD, 225),
  lb('dead_315', '315 Deadlift',       '/Badges/315_deadlift_badge.png', DEAD, 315),
  lb('dead_405', '405 Deadlift',       '/Badges/405_deadlift_badge.png', DEAD, 405),
  lb('dead_495', '495 Deadlift',       '/Badges/495_deadlift_badge.png', DEAD, 495),
  lb('dead_540', '540 Deadlift',       '/Badges/540_deadlift_badge.png', DEAD, 540),
  lb('dead_630', '630 Deadlift',       '/Badges/630_deadlift_badge.png', DEAD, 630),

  // ── 1000 lb Club ─────────────────────────────────────────────────────────────
  {
    slug: 'pound_club_1000', label: '1000 lb Club', icon: '/Badges/1000_pound_club_badge.png',
    category: 'lift',
    check: ({ liftPRs }) =>
      bestPR(liftPRs, BENCH) + bestPR(liftPRs, SQUAT) + bestPR(liftPRs, DEAD) >= 1000,
  },

  // ── Overhead Press ────────────────────────────────────────────────────────────
  lb('ohp_95',  '95 OHP Club',        '🏋️', OHP, 95),
  lb('ohp_115', '115 OHP Club',       '🏋️', OHP, 115),
  lb('ohp_135', 'One Plate OHP',      '🥇', OHP, 135),
  lb('ohp_185', '185 OHP Club',       '💪', OHP, 185),
  lb('ohp_225', 'Two Plate OHP',      '👑', OHP, 225),

  // ── Running distances ─────────────────────────────────────────────────────────
  // Thresholds use the standard runner's round-number equivalents (mi):
  // 5K=3.1, 10K=6.2, 15K=9.3, half=13.1, marathon=26.2
  {
    slug: 'run_5k', label: 'First 5K', icon: '/Badges/First_5K_badge.png', category: 'cardio',
    check: ({ localDB }) => Object.values(localDB).some(d =>
      parseFloat(String(d.runDist ?? '0')) >= 3.1
    ),
  },
  {
    slug: 'run_10k', label: 'First 10K', icon: '/Badges/First_10K_badge.png', category: 'cardio',
    check: ({ localDB }) => Object.values(localDB).some(d =>
      parseFloat(String(d.runDist ?? '0')) >= 6.2
    ),
  },
  {
    slug: 'run_15k', label: 'First 15K', icon: '/Badges/First_15K_badge.png', category: 'cardio',
    check: ({ localDB }) => Object.values(localDB).some(d =>
      parseFloat(String(d.runDist ?? '0')) >= 9.3
    ),
  },
  {
    slug: 'run_half', label: 'First Half Marathon', icon: '/Badges/First_half_marathon_badge.png', category: 'cardio',
    check: ({ localDB }) => Object.values(localDB).some(d =>
      parseFloat(String(d.runDist ?? '0')) >= 13.1
    ),
  },
  {
    slug: 'run_marathon', label: 'First Marathon', icon: '/Badges/First_marathon_badge.png', category: 'cardio',
    check: ({ localDB }) => Object.values(localDB).some(d =>
      parseFloat(String(d.runDist ?? '0')) >= 26.2
    ),
  },
  {
    slug: 'run_50mi', label: '50 Miles Run', icon: '/Badges/Running_total_run_badge.png', category: 'cardio',
    check: ({ localDB }) =>
      Object.values(localDB).reduce((s, d) => s + (parseFloat(String(d.runDist ?? '0')) || 0), 0) >= 50,
  },
  {
    slug: 'run_50mi_single', label: '50 Mile Run', icon: '/Badges/Run_50miles.png', category: 'cardio',
    check: ({ localDB }) => Object.values(localDB).some(d =>
      parseFloat(String(d.runDist ?? '0')) >= 50
    ),
  },

  // ── First Meal (first time logging calories) ──────────────────────────────────
  {
    slug: 'first_meal', label: 'First Meal', icon: '/Badges/First_meal.png', category: 'nutrition',
    check: ({ localDB }) => Object.values(localDB).some(d =>
      (parseFloat(String(d.calsEaten ?? '0')) || 0) > 0
    ),
  },

  // ── Locked In (diet completion) ───────────────────────────────────────────────
  {
    slug: 'locked_in', label: 'Locked In', icon: '/Badges/Locked_in.png', category: 'nutrition',
    check: ({ localDB, settings }) => {
      const plan = settings[ATHLETE_PLAN_KEY] as {
        startDate?: string; weeksTarget?: number; goalWeight?: number; type?: string;
      } | null | undefined;
      if (!plan?.startDate || !plan.goalWeight || !plan.weeksTarget) return false;
      const endMs     = new Date(plan.startDate + 'T00:00:00Z').getTime() + plan.weeksTarget * 7 * 86_400_000;
      const endStr    = new Date(endMs).toISOString().slice(0, 10);
      const todayStr  = new Date().toISOString().slice(0, 10);
      if (todayStr < endStr) return false;
      const windowStr = new Date(endMs - 14 * 86_400_000).toISOString().slice(0, 10);
      return Object.entries(localDB).some(([date, d]) => {
        if (date < windowStr) return false;
        const w = parseFloat(String(d.weight ?? '0')) || 0;
        return w > 0 && Math.abs(w - plan.goalWeight!) <= 5;
      });
    },
  },

  // ── Triathlete (bike + run + swim same day) ────────────────────────────────────
  {
    slug: 'triathlete', label: 'Triathlete', icon: '/Badges/Triathlete_badge.png', category: 'cardio',
    check: ({ localDB }) => Object.values(localDB).some(d =>
      (parseFloat(String(d.runDist  ?? '0')) > 0) &&
      (parseFloat(String(d.bikeDist ?? '0')) > 0) &&
      (parseFloat(String(d.swimTime ?? '0')) > 0)
    ),
  },

  // ── Swimming ──────────────────────────────────────────────────────────────────
  {
    slug: 'swim_first', label: 'First Swim', icon: '/Badges/First_swim_badge.png', category: 'cardio',
    check: ({ localDB }) => Object.values(localDB).some(d =>
      parseFloat(String(d.swimTime ?? '0')) > 0
    ),
  },
  {
    slug: 'swim_15mi', label: '15 Miles Swum', icon: '/Badges/Running_total_swim_badge.png', category: 'cardio',
    check: ({ localDB }) =>
      Object.values(localDB).reduce((s, d) => s + (parseFloat(String(d.swimDist ?? '0')) || 0), 0) >= 15,
  },

  // ── Million Pounds Lifted ─────────────────────────────────────────────────────
  {
    slug: 'million_lbs', label: 'Million Pounds Lifted', icon: '/Badges/Million_pounds_lifted.png', category: 'lift',
    check: ({ settings }) => {
      const groups = settings[MILLION_GROUPS_KEY] as string[] | undefined;
      return Array.isArray(groups) && groups.length > 0;
    },
  },

  // ── Double PR Day ─────────────────────────────────────────────────────────────
  {
    slug: 'pr_both', label: 'Double PR Day', icon: '/Badges/PR_both_lift_and_cardio.png', category: 'lift',
    check: ({ localDB }) => Object.values(localDB).some(d => !!(d as { prBothDay?: boolean }).prBothDay),
  },

  // ── 1,000 Calorie Burn ────────────────────────────────────────────────────────
  {
    slug: 'cal_1000', label: '1,000 Cal Burn', icon: '/Badges/1000_calorie_burned_badge.png', category: 'cardio',
    check: ({ localDB }) => Object.values(localDB).some(d => (parseFloat(String(d.burn ?? '0')) || 0) >= 1000),
  },

  // ── Cycling ───────────────────────────────────────────────────────────────────
  {
    slug: 'bike_first', label: 'First Bike Ride', icon: '/Badges/First_bike_badge.png', category: 'cardio',
    check: ({ localDB }) => Object.values(localDB).some(d =>
      parseFloat(String(d.bikeDist ?? '0')) >= 0.1
    ),
  },
  {
    slug: 'bike_50mi', label: '50 Miles Biked', icon: '/Badges/Running_total_bike_badge.png', category: 'cardio',
    check: ({ localDB }) =>
      Object.values(localDB).reduce((s, d) => s + (parseFloat(String(d.bikeDist ?? '0')) || 0), 0) >= 50,
  },
  {
    slug: 'bike_1000mi', label: '1,000 Miles Biked', icon: '/Badges/1000_miles_biked_badge.png', category: 'cardio',
    check: ({ localDB }) =>
      Object.values(localDB).reduce((s, d) => s + (parseFloat(String(d.bikeDist ?? '0')) || 0), 0) >= 1000,
  },

  // ── Workout streak ────────────────────────────────────────────────────────────
  {
    slug: 'scholar', label: 'Scholar', icon: '/Badges/scholar_badge.png', category: 'nutrition',
    check: ({ localDB }) => maxWorkoutStreak(localDB) >= 14,
  },
  {
    slug: 'master', label: 'Master', icon: '/Badges/master_badge.png', category: 'nutrition',
    check: ({ localDB }) => maxWorkoutStreak(localDB) >= 30,
  },
  {
    slug: 'seer', label: 'Seer', icon: '/Badges/seer_badge.png', category: 'nutrition',
    check: ({ localDB }) => maxWorkoutStreak(localDB) >= 50,
  },
  {
    slug: 'stoic', label: 'Stoic', icon: '/Badges/stoic_badge.png', category: 'nutrition',
    check: ({ localDB, planDirection }) => maxCombinedStreak(localDB, planDirection) >= 50,
  },

  // ── Big eating days ───────────────────────────────────────────────────────────
  {
    slug: 'eat_5000', label: '5,000 Calories Eaten', icon: '/Badges/5000_calories_eaten.png', category: 'nutrition',
    check: ({ localDB }) => Object.values(localDB).some(d =>
      (parseFloat(String(d.calsEaten ?? '0')) || 0) >= 5000
    ),
  },
  {
    slug: 'eat_10000', label: '10,000 Calories Eaten', icon: '/Badges/10000_calories_eaten_badge.jpg', category: 'nutrition',
    check: ({ localDB }) => Object.values(localDB).some(d =>
      (parseFloat(String(d.calsEaten ?? '0')) || 0) >= 10000
    ),
  },

  // ── Nutrition streaks ─────────────────────────────────────────────────────────
  {
    slug: 'streak_3',   label: '3-Day Streak',       icon: '🔥', category: 'nutrition',
    check: ({ localDB, planDirection }) => maxStreak(localDB, planDirection) >= 3,
  },
  {
    slug: 'streak_7',   label: 'Week Warrior',        icon: '🔥', category: 'nutrition',
    check: ({ localDB, planDirection }) => maxStreak(localDB, planDirection) >= 7,
  },
  {
    slug: 'streak_14',  label: 'Two-Week Run',        icon: '⚡', category: 'nutrition',
    check: ({ localDB, planDirection }) => maxStreak(localDB, planDirection) >= 14,
  },
  {
    slug: 'streak_30',  label: 'Monthly Master',      icon: '🌟', category: 'nutrition',
    check: ({ localDB, planDirection }) => maxStreak(localDB, planDirection) >= 30,
  },
  {
    slug: 'streak_60',  label: '60-Day Domination',   icon: '💎', category: 'nutrition',
    check: ({ localDB, planDirection }) => maxStreak(localDB, planDirection) >= 60,
  },
  {
    slug: 'streak_100', label: 'Century Club',         icon: '👑', category: 'nutrition',
    check: ({ localDB, planDirection }) => maxStreak(localDB, planDirection) >= 100,
  },

  // ── Battle wins ──────────────────────────────────────────────────────────────
  // Counted from resolved Challenge rows where this user was the winner.
  // Categorised as 'nutrition' so they're never revoked — competitive
  // achievements are permanent records.
  {
    slug: 'battle_first', label: 'First Battle Win', icon: '/Badges/First_battle_win.png', category: 'nutrition',
    check: ({ battleWins }) => battleWins >= 1,
  },
  {
    slug: 'battle_5',  label: '5 Battle Wins',  icon: '/Badges/5_battle_win.png',  category: 'nutrition',
    check: ({ battleWins }) => battleWins >= 5,
  },
  {
    slug: 'battle_10', label: '10 Battle Wins', icon: '/Badges/10_battle_win.png', category: 'nutrition',
    check: ({ battleWins }) => battleWins >= 10,
  },
  {
    slug: 'battle_20', label: '20 Battle Wins', icon: '/Badges/20_battle_win.png', category: 'nutrition',
    check: ({ battleWins }) => battleWins >= 20,
  },

  // ── Referrals (invite a friend) ────────────────────────────────────────────
  // Counted from `referral_sent` CoinTransactions. 'nutrition' so they're never
  // revoked — a converted invite is a permanent achievement.
  {
    slug: 'recruit_1', label: 'Helping Hand', icon: '/Badges/First_recruit_badge.png', category: 'nutrition',
    check: ({ referralCount }) => referralCount >= 1,
  },
  {
    slug: 'recruit_3', label: 'Full Support', icon: '/Badges/3_recruit_badge.png', category: 'nutrition',
    check: ({ referralCount }) => referralCount >= 3,
  },
  {
    slug: 'recruit_5', label: 'Life Force', icon: '/Badges/5_recruit_badge.png', category: 'nutrition',
    check: ({ referralCount }) => referralCount >= 5,
  },
  {
    slug: 'recruit_10', label: 'Golden Star', icon: '/Badges/10_recruit_badge.png', category: 'nutrition',
    check: ({ referralCount }) => referralCount >= 10,
  },

  // ── Calendar / quirky (permanent — 'nutrition' so they're never revoked) ────
  {
    slug: 'new_year', label: 'New Year, New Me', icon: '/Badges/New_year_new_me.png', category: 'nutrition',
    check: ({ localDB }) => Object.keys(localDB).some(d => d.endsWith('-01-01') && hasWorkout(localDB[d])),
  },
  {
    slug: 'leap_day', label: 'Leap of Faith', icon: '/Badges/Leap_of_faith.png', category: 'nutrition',
    check: ({ localDB }) => Object.entries(localDB).some(([date, d]) =>
      date.endsWith('-02-29') && (
        hasWorkout(d) ||
        (parseFloat(String(d.calsEaten ?? '0')) || 0) > 0 ||
        (parseFloat(String(d.weight    ?? '0')) || 0) > 0
      )),
  },
  {
    slug: 'holiday_grind', label: 'No Days Off', icon: '/Badges/No_Days_Off.png', category: 'nutrition',
    check: ({ localDB }) => Object.keys(localDB).some(d => d.endsWith('-12-25') && hasWorkout(localDB[d])),
  },
  {
    slug: 'trick_or_lift', label: 'Trick-or-Lift', icon: '/Badges/Trick_or_lift.png', category: 'nutrition',
    check: ({ localDB }) => Object.keys(localDB).some(d => d.endsWith('-10-31') && hasLift(localDB[d])),
  },
  {
    slug: 'american_lift', label: 'The American Lift', icon: '/Badges/The_American_Lift.png', category: 'nutrition',
    check: ({ localDB }) => Object.keys(localDB).some(d => d.endsWith('-07-04') && hasLift(localDB[d])),
  },
  {
    slug: 'st_patricks', label: "St Patty's", icon: '/Badges/Patricks.png', category: 'nutrition',
    check: ({ localDB }) => Object.keys(localDB).some(d => d.endsWith('-03-17') && hasLift(localDB[d])),
  },
  {
    slug: 'lifts_giving', label: 'Lifts Giving', icon: '/Badges/Lifts_giving.png', category: 'nutrition',
    check: ({ localDB }) => Object.keys(localDB).some(d => isThanksgiving(d) && hasLift(localDB[d])),
  },
  {
    slug: 'red_envelope', label: 'Red Envelope', icon: '/Badges/Chinese_new_year.png', category: 'nutrition',
    check: ({ localDB }) => Object.keys(localDB).some(d => CHINESE_NEW_YEAR.has(d) && hasLift(localDB[d])),
  },
  {
    slug: 'weekend_warrior', label: 'Weekend Warrior', icon: '/Badges/Weekend_warrior.png', category: 'nutrition',
    check: ({ localDB }) => {
      const wo = new Set(Object.keys(localDB).filter(d => hasWorkout(localDB[d])));
      for (const d of wo) {
        if (dow(d) !== 6) continue;                       // Saturday
        const sun = new Date(d + 'T00:00:00Z');
        sun.setUTCDate(sun.getUTCDate() + 1);
        if (wo.has(sun.toISOString().slice(0, 10))) return true;
      }
      return false;
    },
  },
  {
    slug: 'comeback', label: 'Comeback Kid', icon: '/Badges/Comeback_kid.png', category: 'nutrition',
    check: ({ localDB }) => {
      const days = Object.keys(localDB).filter(d => hasWorkout(localDB[d])).sort();
      for (let i = 1; i < days.length; i++) {
        if (dayGap(days[i - 1], days[i]) >= 14) return true;   // logged again after 14+ days off
      }
      return false;
    },
  },

  // ── Consistency / skill ─────────────────────────────────────────────────────
  {
    slug: 'perfect_week', label: 'Flawless', icon: '/Badges/Perfect_Week.png', category: 'nutrition',
    check: ({ localDB, planDirection }) => {
      const byWeek: Record<string, number> = {};
      for (const [date, d] of Object.entries(localDB)) {
        if (goalDay(d, planDirection)) {
          const wk = weekStart(date);
          byWeek[wk] = (byWeek[wk] ?? 0) + 1;
        }
      }
      return Object.values(byWeek).some(n => n >= 7);          // all 7 days of one week
    },
  },
  {
    slug: 'workout_100', label: 'Iron Habit', icon: '/Badges/Iron_habit.png', category: 'nutrition',
    check: ({ localDB }) => maxWorkoutStreak(localDB) >= 100,
  },
  {
    slug: 'on_the_dot', label: 'Bullseye', icon: '🎯', category: 'nutrition',
    check: ({ localDB }) => Object.values(localDB).some(d => {
      const eaten  = parseFloat(String(d.calsEaten ?? '0')) || 0;
      const budget = parseFloat(String(d.budget    ?? '0')) || 0;
      return eaten > 0 && budget > 0 && Math.abs(eaten - budget) <= 10;
    }),
  },
  {
    slug: 'perfectionist', label: 'Perfectionist', icon: '/Badges/Perfectionist_badge.png', category: 'nutrition',
    check: ({ localDB, settings }) => {
      const goals = settings[MACRO_GOALS_KEY] as { protein?: number; carbs?: number; fat?: number } | null | undefined;
      if (!goals?.protein || !goals.carbs || !goals.fat) return false;
      const TOL = 2; // grams — "exact" within a tight margin (see howToGet)
      return Object.values(localDB).some(d => {
        const p = dayMacro(d, 'protein'), c = dayMacro(d, 'carbs'), f = dayMacro(d, 'fat');
        if (p <= 0 && c <= 0 && f <= 0) return false;     // ignore days with no food logged
        return Math.abs(p - goals.protein!) <= TOL
            && Math.abs(c - goals.carbs!)   <= TOL
            && Math.abs(f - goals.fat!)     <= TOL;
      });
    },
  },
  {
    slug: 'transformation', label: 'Transformation', icon: '/Badges/Transformation.png', category: 'nutrition',
    check: ({ localDB }) => {
      const w = Object.keys(localDB).filter(d => (parseFloat(String(localDB[d].weight ?? '0')) || 0) > 0).sort();
      if (w.length < 2) return false;
      const first = parseFloat(String(localDB[w[0]].weight));
      const last  = parseFloat(String(localDB[w[w.length - 1]].weight));
      return Math.abs(last - first) >= 20;
    },
  },

  // ── Endurance milestones (cardio — match existing distance badges) ──────────
  {
    slug: 'bike_century', label: 'Century Ride', icon: '/Badges/Century_Ride.png', category: 'cardio',
    check: ({ localDB }) => Object.values(localDB).some(d => (parseFloat(String(d.bikeDist ?? '0')) || 0) >= 100),
  },
  {
    slug: 'run_100mi', label: 'Hundred Miler', icon: '🏃', category: 'cardio',
    check: ({ localDB }) =>
      Object.values(localDB).reduce((s, d) => s + (parseFloat(String(d.runDist ?? '0')) || 0), 0) >= 100,
  },
  {
    slug: 'swim_channel', label: 'Channel Crossing', icon: '/Badges/Channel_Crossing.png', category: 'cardio',
    check: ({ localDB }) =>
      Object.values(localDB).reduce((s, d) => s + (parseFloat(String(d.swimDist ?? '0')) || 0), 0) >= 21,
  },
  {
    slug: 'all_rounder', label: 'All-Rounder', icon: '/Badges/All_rounder.png', category: 'cardio',
    check: ({ localDB }) => {
      const v = Object.values(localDB);
      const run  = v.some(d => (parseFloat(String(d.runDist  ?? '0')) || 0) > 0);
      const bike = v.some(d => (parseFloat(String(d.bikeDist ?? '0')) || 0) > 0);
      const swim = v.some(d => (parseFloat(String(d.swimTime ?? '0')) || 0) > 0 || (parseFloat(String(d.swimDist ?? '0')) || 0) > 0);
      return run && bike && swim;
    },
  },
  {
    slug: 'steps_20k', label: 'Step Machine', icon: '/Badges/Step_Machine.png', category: 'cardio',
    check: ({ localDB }) => Object.values(localDB).some(d => (parseFloat(String(d.steps ?? '0')) || 0) >= 20000),
  },
];

// ── Public API ─────────────────────────────────────────────────────────────────

export interface AwardedBadge {
  slug:     string;
  label:    string;
  icon:     string;
  category: string;
}

// Narrow Prisma cast — the generated client doesn't expose dayRecord at the
// top level here (different Prisma generation target than the route handlers),
// so we accept the unknown shape and re-type the one method we use.
type DayRecordRow = { date: string; data: unknown };
const dayRecordTable = (prisma as unknown as {
  dayRecord: { findMany: (args: unknown) => Promise<DayRecordRow[]> };
}).dayRecord;

/**
 * Checks all badge thresholds for a user, awards newly earned badges, and
 * revokes badges the user no longer qualifies for (e.g. after a corrected entry).
 *
 * Fetches the user's full workout history directly from the DB so checks are
 * always accurate regardless of what the sync push contained. Run this AFTER
 * DayRecord upserts so the latest data is visible.
 *
 * Safe to call on every sync. Throws only if Prisma is unavailable; callers should catch.
 */
export async function checkAndAwardBadges(
  userId:   string,
  settings: Record<string, unknown>,
): Promise<{ awarded: AwardedBadge[]; revoked: AwardedBadge[] }> {
  let liftPRs: Record<string, number> = {};
  try { liftPRs = (settings[LIFT_PRS_KEY] ?? {}) as Record<string, number>; }
  catch { /* malformed — treat as empty */ }

  // Fetch full history, existing badges, battle wins, and referral count in parallel.
  const [existing, dayRows, battleWins, referralCount] = await Promise.all([
    prisma.badge.findMany({
      where:  { userId },
      select: { slug: true, label: true, icon: true, category: true },
    }),
    dayRecordTable.findMany({ where: { userId }, select: { date: true, data: true } }),
    prisma.challenge.count({ where: { winnerId: userId, status: 'resolved' } }),
    prisma.coinTransaction.count({ where: { reason: 'referral_sent', wallet: { userId } } }),
  ]);

  const localDB: Record<string, DayRecord> = Object.fromEntries(
    dayRows.map(r => [r.date, r.data as DayRecord])
  );

  // Plan direction makes the calorie-goal streaks plan-aware (mirrors coins).
  const planType = (settings[ATHLETE_PLAN_KEY] as { type?: string } | null | undefined)?.type;
  const planDirection: PlanDirection = planType === 'cut' || planType === 'bulk' ? planType : null;

  const data: BadgeCheckData = { liftPRs, localDB, settings, battleWins, referralCount, planDirection };
  const earnedMap = new Map(existing.map(b => [b.slug, b]));

  const toAward  = BADGE_DEFS.filter(def => !earnedMap.has(def.slug) && def.check(data));
  // Revoke lift and cardio badges when thresholds are no longer met (corrected entry).
  // Nutrition streak badges are never revoked — past streaks are permanent achievements.
  const toRevoke = BADGE_DEFS.filter(def =>
    earnedMap.has(def.slug) && def.category !== 'nutrition' && !def.check(data)
  );

  if (toAward.length > 0) {
    await prisma.badge.createMany({
      data: toAward.map(def => ({
        userId,
        category: def.category,
        slug:     def.slug,
        label:    def.label,
        icon:     def.icon,
      })),
      skipDuplicates: true,
    });
  }

  if (toRevoke.length > 0) {
    await prisma.badge.deleteMany({
      where: { userId, slug: { in: toRevoke.map(d => d.slug) } },
    });
  }

  return {
    awarded: toAward.map(def => ({ slug: def.slug, label: def.label, icon: def.icon, category: def.category })),
    revoked: toRevoke.map(def => ({ slug: def.slug, label: def.label, icon: def.icon, category: def.category })),
  };
}

/**
 * Server-side wrapper around checkAndAwardBadges that fetches the user's
 * settings from WorkoutData. Use this from non-sync code paths (battle
 * resolution, cron jobs) where the caller doesn't already have settings in
 * hand. Returns the list of newly awarded badges so the caller can push-notify
 * or surface them in a response.
 */
export async function awardBadgesForUser(userId: string): Promise<AwardedBadge[]> {
  const workoutData = await prisma.workoutData.findUnique({
    where:  { userId },
    select: { settings: true },
  });
  const settings = (workoutData?.settings ?? {}) as Record<string, unknown>;
  const { awarded } = await checkAndAwardBadges(userId, settings);
  return awarded;
}

/**
 * Overrides the icon AND label stored on a Badge row with the canonical catalog
 * values. The DB snapshots whatever label/icon BADGE_DEFS had at award time, so
 * any later wording change (or a DEFS↔CATALOG drift like "First Marathon" vs
 * "Marathon") would otherwise show stale text. Making BADGE_CATALOG the single
 * display source of truth keeps the showcase's "All Badges" view and a user's
 * earned badges in agreement. (Name kept for backwards-compat with call sites.)
 */
export function normalizeBadgeIcons<T extends { slug: string; icon: string; label?: string }>(badges: T[]): T[] {
  return badges.map(b => {
    const cat = BADGE_CATALOG.find(c => c.slug === b.slug);
    if (!cat) return b;
    return { ...b, icon: cat.icon, ...(b.label !== undefined && { label: cat.label }) };
  });
}

/** Returns all badges for a user, newest first, with canonical icon paths. */
export async function getUserBadges(userId: string) {
  const rows = await prisma.badge.findMany({
    where:   { userId },
    orderBy: { earnedAt: 'desc' },
  });
  return normalizeBadgeIcons(rows);
}
