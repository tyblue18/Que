'use client';

/**
 * lib/AppContext.tsx
 *
 * Global React context for Que. Wrap the authenticated shell with <AppProvider>
 * and consume anywhere with useApp().
 *
 * Storage key map:
 *   ironmanCoreDB_v2          → localDB
 *   ironmanProfileSettings_v2 → profile
 *   ironmanTemplatesPool      → getTemplatePool() / saveTemplatePool()
 *   queExerciseUsage          → getUsage() / bumpUsage()
 *   queLastStreak             → getLastStreak() / setLastStreak()
 *   queWorkoutPresets         → getWorkoutPresets() / saveWorkoutPresets()
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { queueSync, pushNow, flushPending, pullFromCloud, restoreSettings } from '@/lib/syncEngine';
import { DB_KEY, PROFILE_KEY } from '@/lib/constants';
import { mergeDays, stampEditedFields, type MergeableDay } from '@/lib/dayMerge';
import { reclaimBadgeCacheQuota } from '@/components/AutoCropImage';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type ViewMode = 'day' | 'week' | 'month';
export type MuscleGroup =
  | 'chest' | 'back' | 'shoulders' | 'tricep' | 'bicep'
  | 'forearms' | 'abs' | 'quads' | 'hamstring' | 'glutes'
  | 'calfs' | 'adductors';

/** One set's reps + weight, mirrors pendingSetData entries */
export interface SetData {
  r: string; // reps
  w: string; // weight (optional, free-text e.g. "135 lbs")
}

/** A single logged exercise or cardio entry */
export interface ExerciseEntry {
  k: 'lift' | 'text' | 'run' | 'bike' | 'swim';
  g?: string;       // primary muscle group (lift only)
  g2?: string;      // secondary muscle group
  g3?: string;      // tertiary muscle group
  n?: string;       // exercise name
  sets?: SetData[]; // per-set data (lift only, new format)
  s?: string;       // legacy: set count
  r?: string;       // legacy: reps
  w?: string;       // legacy: weight
  v1?: string;      // cardio field 1 (distance / duration)
  v2?: string;      // cardio field 2 (time)
  note?: string;    // cardio notes
}

/** One day's persisted data record */
export interface FoodEntry {
  id: string;
  name: string;
  brand?: string;
  kcal: number;
  protein: number;   // grams
  carbs: number;     // grams
  fat: number;       // grams
  servingDesc: string;
  servings: number;
  meal: string;      // 'breakfast' | 'lunch' | 'dinner' | 'snack-{timestamp}'
  barcode?: string;
  loggedAt: number;
}

export interface DayRecord {
  steps?:    string | number;
  runDist?:  string | number;
  runTime?:  string | number;
  bikeDist?: string | number;
  bikeTime?: string | number;
  swimTime?: string | number;
  swimDist?: string | number;
  exercises?: string;  // JSON-serialised ExerciseEntry[]
  notes?:    string;
  /** Post-session self-report captured on Commit Session (1–10). Used for
   *  Metrics trends — training quality + how the athlete felt. */
  sessRating?: number; // session quality, 1–10
  sessFeel?:   number; // how they felt, 1–10
  weight?:   string;
  /** Body measurements logged per day. Circumferences stored CANONICAL in
   *  inches (converted to cm for metric users at the UI edge, like height);
   *  bodyFat is a unit-less percentage. */
  waist?:   number;   // inches
  chest?:   number;   // inches
  arms?:    number;   // inches
  thighs?:  number;   // inches
  hips?:    number;   // inches
  bodyFat?: number;   // %
  burn?:     number;
  /** Measured ACTIVE calories summed from a linked Garmin sync (see
   *  lib/healthActivity). When present it supersedes the distance/time cardio
   *  estimate in the budget, and `burn` is set to match. */
  garminKcal?: number;
  /** Per-type measured ACTIVE calories — preferred over the day total so each
   *  activity card shows its own Garmin number. */
  garminRunKcal?:  number;
  garminBikeKcal?: number;
  garminSwimKcal?: number;
  budget?:   number;
  /** TDEE (BMR × activity multiplier) snapshotted at log time. Deficit- and
   *  cardio-independent, so plan-progress maintenance reconstructs exactly as
   *  `tdee + burn` regardless of later deficit/profile changes. Absent on days
   *  logged before this field existed — consumers fall back to the legacy
   *  `budget + deficit + 0.4·burn` reconstruction for those. */
  tdee?:     number;
  calsEaten?: string;
  protein?:  number;       // grams — day total, summed from foods (used by battles)
  carbs?:    number;       // grams — day total, summed from foods (used by battles)
  fat?:      number;       // grams — day total, summed from foods (used by battles)
  foods?: string;          // JSON-serialised FoodEntry[]
  foodMealOrder?: string;  // JSON-serialised string[] — ordered list of section IDs
  /** Set client-side when a lift PR and a run PR occur on the same day. */
  prBothDay?: boolean;
  /** User intentionally marked this as a rest/recovery day. Bridges the workout
   *  streak (a planned rest doesn't read as a missed day) without counting as a
   *  workout. See lib/streaks.ts. A logged workout takes precedence over it. */
  restDay?: boolean;
  /** Server-provided sync timestamp — stripped on every local edit so the server
   *  always accepts the client's dirty writes without triggering a false conflict. */
  _syncedAt?: string;
  /** ISO time this day was last edited (whole-day; ordering + legacy fallback). */
  _editedAt?: string;
  /** Per-field edit times powering field-level merge (lib/dayMerge). Absent on
   *  days created before field-level merge existed — merge falls back to _editedAt. */
  _fieldEditedAt?: Record<string, string>;
}

/** Keyed by "YYYY-MM-DD" */
export type LocalDB = Record<string, DayRecord>;

/** User's metabolic profile (mirrors ironmanProfileSettings_v2) */
export interface UserProfile {
  weight:        string; // lbs
  height:        string; // inches
  age:           string;
  sex:           'male' | 'female';
  deficit:       string; // kcal/day goal
  activityLevel: string; // multiplier string e.g. "1.45"
}

export interface WorkoutTemplate {
  id:    string;
  title: string;
  text:  string;
}

export interface WorkoutPreset {
  id:          string;
  name:        string;
  exercises:   string; // JSON-serialised ExerciseEntry[]
  isRecurring: boolean;
  daysOfWeek:  number[];
  everyNWeeks: number;
  createdAt:   string; // YYYY-MM-DD
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS  (immutable — not stored in React state)
// ─────────────────────────────────────────────────────────────────────────────

export const MONTHS: string[] = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

export const PRESETS: Record<MuscleGroup, string[]> = {
  chest:     ['Bench Press','Incline Bench Press','Decline Bench Press','Chest Flyes','Cable Crossover','Push-ups','Machine Chest Press','Pec Deck','Smith Machine Press','Dumbbell Pullover'],
  back:      ['Pull-ups','Chin-ups','Lat Pulldown','T-Bar Row','Barbell Row','Seated Cable Row','Single-Arm Row','Face Pulls','Shrugs','Deadlift','Sumo Deadlift','Rack Pull','Straight-Arm Pulldown'],
  tricep:    ['Tricep Pushdown','Overhead Tricep Extension','Skull Crushers','Close-Grip Bench','Dips','Cable Tricep Kickback','Diamond Push-ups','Tricep Machine'],
  bicep:     ['Barbell Curl','Dumbbell Curl','Hammer Curls','Preacher Curl','Incline Curl','Cable Curl','Concentration Curl','Spider Curl','21s'],
  forearms:  ['Wrist Curls','Reverse Wrist Curls','Reverse Curl','Farmer Carries','Dead Hang','Plate Pinch'],
  shoulders: ['Overhead Press','Arnold Press','Lateral Raises','Front Raises','Rear Delt Flyes','Cable Lateral Raise','Face Pulls','Upright Row','Machine Shoulder Press'],
  abs:       ['Plank','Side Plank','Crunches','Bicycle Crunches','Dead Bug','Russian Twists','Hanging Leg Raises','Cable Crunch','Ab Wheel Rollout','V-ups','Pallof Press','Dragon Flag'],
  quads:     ['Back Squat','Front Squat','Leg Press','Leg Extension','Lunges','Bulgarian Split Squat','Pendulum Squat','Hack Squat','Step-ups'],
  hamstring: ['Romanian Deadlift','Stiff-Leg Deadlift','Leg Curl','Seated Leg Curl','Nordic Curl','Good Mornings','Glute-Ham Raise'],
  glutes:    ['Hip Thrust','Glute Bridge','Glute Kickback','Cable Pull-Through','Frog Pump','Donkey Kicks'],
  calfs:     ['Standing Calf Raise','Seated Calf Raise','Single-Leg Calf Raise','Donkey Calf Raise','Leg Press Calf Raise'],
  adductors: ['Hip Adduction Machine','Copenhagen Plank','Wide-Stance Squat','Side Lunges','Cable Hip Adduction','Sumo Squat'],
};

/** Secondary/tertiary muscle groups for compound lifts.
 *  Keys match exercise names in PRESETS exactly.
 *  Values use the same lowercase group keys as PRESETS. */
export const SECONDARY_MUSCLES: Record<string, { g2?: string; g3?: string }> = {
  // ── Chest ──────────────────────────────────────────────────────
  'Bench Press':            { g2: 'tricep',    g3: 'shoulders' },
  'Incline Bench Press':    { g2: 'tricep',    g3: 'shoulders' },
  'Decline Bench Press':    { g2: 'tricep',    g3: 'shoulders' },
  'Machine Chest Press':    { g2: 'tricep' },
  'Smith Machine Press':    { g2: 'tricep',    g3: 'shoulders' },
  'Push-ups':               { g2: 'tricep',    g3: 'shoulders' },
  'Dumbbell Pullover':      { g2: 'back' },

  // ── Back ───────────────────────────────────────────────────────
  'Deadlift':               { g2: 'hamstring', g3: 'glutes'    },
  'Sumo Deadlift':          { g2: 'hamstring', g3: 'glutes'    },
  'Rack Pull':              { g2: 'hamstring', g3: 'glutes'    },
  'Pull-ups':               { g2: 'bicep' },
  'Chin-ups':               { g2: 'bicep' },
  'Lat Pulldown':           { g2: 'bicep' },
  'T-Bar Row':              { g2: 'bicep' },
  'Barbell Row':            { g2: 'bicep' },
  'Seated Cable Row':       { g2: 'bicep' },
  'Single-Arm Row':         { g2: 'bicep' },
  'Straight-Arm Pulldown':  { g2: 'bicep' },
  'Shrugs':                 { g2: 'forearms' },
  'Face Pulls':             { g2: 'shoulders' },

  // ── Triceps ────────────────────────────────────────────────────
  'Dips':                   { g2: 'chest',     g3: 'shoulders' },
  'Close-Grip Bench':       { g2: 'chest' },

  // ── Shoulders ──────────────────────────────────────────────────
  'Overhead Press':         { g2: 'tricep' },
  'Arnold Press':           { g2: 'tricep' },
  'Upright Row':            { g2: 'bicep',    g3: 'back'       },

  // ── Quads ──────────────────────────────────────────────────────
  'Back Squat':             { g2: 'glutes',   g3: 'hamstring'  },
  'Front Squat':            { g2: 'glutes',   g3: 'hamstring'  },
  'Leg Press':              { g2: 'glutes',   g3: 'hamstring'  },
  'Lunges':                 { g2: 'glutes',   g3: 'hamstring'  },
  'Bulgarian Split Squat':  { g2: 'glutes',   g3: 'hamstring'  },
  'Pendulum Squat':         { g2: 'glutes' },
  'Hack Squat':             { g2: 'glutes' },
  'Step-ups':               { g2: 'glutes',   g3: 'hamstring'  },

  // ── Hamstrings ─────────────────────────────────────────────────
  'Romanian Deadlift':      { g2: 'glutes',   g3: 'back'       },
  'Stiff-Leg Deadlift':     { g2: 'glutes',   g3: 'back'       },
  'Good Mornings':          { g2: 'back' },

  // ── Glutes ─────────────────────────────────────────────────────
  'Hip Thrust':             { g2: 'hamstring' },
  'Glute Bridge':           { g2: 'hamstring' },
  'Glute Kickback':         { g2: 'hamstring' },
  'Cable Pull-Through':     { g2: 'hamstring', g3: 'back'      },

  // ── Forearms ───────────────────────────────────────────────────
  'Farmer Carries':         { g2: 'shoulders', g3: 'back'      },
};

export const DEFAULT_TEMPLATES: WorkoutTemplate[] = [
  { id:'1', title:'Day 1: Upper Body HIT + Swim',   text:'Incline Bench Smith: 2x failure\nChest Flyes: 2x\nT-Bar Rows: 2x\nWeighted Pullups: 2x\nShrugs: 2x\nTricep Ext: 3x\nPreacher + Curls: 4x\nLateral Raises: 3x\nFarmer Carries: 2x\n[Swim 1: 45m Drills]' },
  { id:'2', title:'Day 2: Legs (Hams/Glutes)',       text:'Stiff Legged Deadlifts (RDL): 3x failure\nGlute Squats/Bridges: 2x\nHamstring Curls: 2x\nHip Adduction: 2x\nAbs Core Setup: 2x\n[NO CARDIO RECOVERY]' },
  { id:'3', title:'Day 3: Aerobic Flush',            text:'[Bike Z2 Spin: 60m @ 85-90 RPM]\n[Run Easy Base: 30m]' },
  { id:'4', title:'Day 4: Upper Repeat',             text:'Incline Bench Smith: 2x failure\nChest Flyes: 2x\nT-Bar Rows: 2x\nWeighted Pullups: 2x\nShrugs: 2x\nTricep Ext: 3x\nPreacher + Curls: 4x\nLateral Raises: 3x\nFarmer Carries: 2x\n[Swim 2: 45m Laps]' },
  { id:'5', title:'Day 5: Legs (Quads/Calf)',        text:'Pendulum Squat: 3x failure\nQuad Extensions: 2x\nHip Abduction: 2x\nCalf Raises: 2x\nAbs Core Setup: 2x' },
  { id:'6', title:'Day 6: Metabolic Clearance',      text:'[Run: 30-45m Slow Flush Jog]' },
  { id:'7', title:'Day 7: Endurance Peak',           text:'[Long Bike: Z2 Aero position]\n[Long Run: Z2 Conversational]' },
  { id:'8', title:'Day 8: Systemic Reset',           text:'[TOTAL REST - CNS DOWNREGULATION]' },
];

const DEFAULT_PROFILE: UserProfile = {
  weight:        '180',
  height:        '70',
  age:           '29',
  sex:           'male',
  deficit:       '500',
  activityLevel: '1.45',
};

// Storage-key constants (DB_KEY, PROFILE_KEY) are imported from lib/constants.
// Stateless helpers (getUsage / getWorkoutPresets / etc.) live in lib/storage.

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — safe date string
// ─────────────────────────────────────────────────────────────────────────────

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT INTERFACE
// ─────────────────────────────────────────────────────────────────────────────

export interface AppContextValue {
  // ── Derived from _today (read-only, never changes) ──────────────────────
  today:    Date;
  todayStr: string;

  // ── 1. localDBInstance ──────────────────────────────────────────────────
  localDB:    LocalDB;
  setLocalDB: React.Dispatch<React.SetStateAction<LocalDB>>;

  // ── 2. activeDayFocusString ─────────────────────────────────────────────
  activeDayFocus:    string;
  setActiveDayFocus: (dateStr: string) => void;

  // ── 3. currentDisplayDate ───────────────────────────────────────────────
  currentDisplayDate:    Date;
  setCurrentDisplayDate: React.Dispatch<React.SetStateAction<Date>>;

  // ── 4. activeViewMode ───────────────────────────────────────────────────
  viewMode:    ViewMode;
  setViewMode: React.Dispatch<React.SetStateAction<ViewMode>>;

  // ── 5. currentGroup ─────────────────────────────────────────────────────
  currentGroup:    string;
  setCurrentGroup: React.Dispatch<React.SetStateAction<string>>;

  // ── 6 & 7. lastBurn / lastBudget (cached calculation results) ───────────
  lastBurn:    number;
  setLastBurn: React.Dispatch<React.SetStateAction<number>>;
  lastBudget:    number;
  setLastBudget: React.Dispatch<React.SetStateAction<number>>;

  // ── 8 & 9. pendingSetsCount / pendingSetData ─────────────────────────────
  pendingSetsCount:    number;
  setPendingSetsCount: React.Dispatch<React.SetStateAction<number>>;
  pendingSetData:    SetData[];
  setPendingSetData: React.Dispatch<React.SetStateAction<SetData[]>>;

  // ── 10. UserProfile (was split across 6 bio-* inputs) ───────────────────
  profile:    UserProfile;
  setProfile: (updates: Partial<UserProfile>) => void;

  // ── Loading gate (false during the initial localStorage hydration) ───────
  isLoaded: boolean;

  // ── High-level storage actions ───────────────────────────────────────────

  /** Merge `updates` into a day record and persist to localStorage. */
  updateDayRecord: (dateStr: string, updates: Partial<DayRecord>) => void;

  /** Read a day record (returns empty object if not found). */
  getDayRecord: (dateStr: string) => DayRecord;

  /** Persist the current localDB snapshot to localStorage immediately. */
  persistDB: (db?: LocalDB) => void;

  /** Persist the user profile to localStorage (full or partial update). */
  persistProfile: (updates: Partial<UserProfile>) => void;

  /** Most recent weight on or before dateStr (mirrors vanilla getLastKnownWeight). */
  getLastKnownWeight: (dateStr: string) => string;

  /** Re-pull the cloud snapshot and merge it in (per-field newer-wins). Call
   *  after a server-side write — e.g. a Garmin sync — to surface it without a reload. */
  refreshFromCloud: () => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT
// ─────────────────────────────────────────────────────────────────────────────

const AppContext = createContext<AppContextValue | null>(null);

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER
// ─────────────────────────────────────────────────────────────────────────────

export function AppProvider({ children }: { children: React.ReactNode }) {
  // ── Today — state so the hydration effect can correct it to the client's
  //    local clock (useRef captures the server's UTC time during SSR).
  const [today, setTodayInternal] = useState<Date>(() => new Date());
  const todayStr = toDateStr(today);

  // ── Loading gate — becomes true after localStorage is hydrated ───────────
  const [isLoaded, setIsLoaded] = useState(false);

  // ── 1. localDB ─────────────────────────────────────────────────────────────
  const [localDB, setLocalDB] = useState<LocalDB>({});

  // ── 2. activeDayFocusString ────────────────────────────────────────────────
  const [activeDayFocus, setActiveDayFocusRaw] = useState<string>(todayStr);

  // ── 3. currentDisplayDate ──────────────────────────────────────────────────
  const [currentDisplayDate, setCurrentDisplayDate] = useState<Date>(
    () => new Date(today.getFullYear(), today.getMonth(), today.getDate())
  );

  // ── 4. activeViewMode (defaults to week on mobile, month on desktop) ───────
  const [viewMode, setViewMode] = useState<ViewMode>('month');

  // ── 5. currentGroup ────────────────────────────────────────────────────────
  const [currentGroup, setCurrentGroup] = useState<string>('chest');

  // ── 6 & 7. lastBurn / lastBudget ───────────────────────────────────────────
  const [lastBurn,   setLastBurn]   = useState<number>(0);
  const [lastBudget, setLastBudget] = useState<number>(0);

  // ── 8 & 9. pendingSetsCount / pendingSetData ───────────────────────────────
  const [pendingSetsCount, setPendingSetsCount] = useState<number>(3);
  const [pendingSetData,   setPendingSetData]   = useState<SetData[]>([
    { r: '1', w: '' },
    { r: '1', w: '' },
    { r: '1', w: '' },
  ]);

  // ── 10. UserProfile ────────────────────────────────────────────────────────
  const [profile, setProfileState] = useState<UserProfile>(DEFAULT_PROFILE);

  // Pull the cloud snapshot and merge it into local state + localStorage. Runs
  // on mount, and can be called again — e.g. after a Garmin sync pushes new
  // cardio server-side — to surface remote changes without a reload. Per-field
  // newer-wins (lib/dayMerge); days edited THIS session (dirtyDaysRef) are never
  // overwritten. Failures are silent (localStorage stays the fallback).
  const refreshFromCloud = useCallback(async () => {
    const remote = await pullFromCloud().catch(() => null);
    if (!remote) return;

    if (remote.localDB && typeof remote.localDB === 'object') {
      const remoteDB = remote.localDB as Record<string, unknown>;
      const mergeRemote = (
        local: Record<string, unknown> | undefined,
        remoteRec: Record<string, unknown>,
      ): Record<string, unknown> =>
        local
          ? (mergeDays(local as MergeableDay, remoteRec as MergeableDay).merged as Record<string, unknown>)
          : remoteRec;
      setLocalDB(prev => {
        const next: Record<string, DayRecord> = { ...prev };
        for (const [date, remoteData] of Object.entries(remoteDB)) {
          if (dirtyDaysRef.current.has(date)) continue;
          next[date] = mergeRemote(
            prev[date] as Record<string, unknown> | undefined,
            remoteData as Record<string, unknown>,
          ) as DayRecord;
        }
        return next;
      });
      try {
        const local = JSON.parse(localStorage.getItem(DB_KEY) ?? '{}') as Record<string, unknown>;
        const merged: Record<string, unknown> = { ...local };
        for (const [date, remoteData] of Object.entries(remoteDB)) {
          if (dirtyDaysRef.current.has(date)) continue;
          merged[date] = mergeRemote(
            local[date] as Record<string, unknown> | undefined,
            remoteData as Record<string, unknown>,
          );
        }
        localStorage.setItem(DB_KEY, JSON.stringify(merged));
      } catch { /* storage full — skip */ }
    }

    if (remote.profile && typeof remote.profile === 'object') {
      const p = remote.profile as Record<string, string>;
      if (Object.keys(p).length > 0) {
        setProfileState({
          weight:        p.w || '180',
          height:        p.h || '70',
          age:           p.a || '29',
          sex:           (p.s as 'male' | 'female') || 'male',
          deficit:       p.b || '500',
          activityLevel: p.l || '1.45',
        });
        try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch { /* noop */ }
      }
    }
    if (remote.settings && typeof remote.settings === 'object') {
      restoreSettings(remote.settings as Record<string, unknown>);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─────────────────────────────────────────────────────────────────────────
  // HYDRATION — runs once on mount (client only, never on SSR)
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    // ── Reclaim badge-cache quota BEFORE any write ─────────────────────────
    //    The legacy `queBadgeCropCache` grew to ~5 MB in the wild and exhausted
    //    the per-origin localStorage quota, silently breaking every other write
    //    (food logging, custom foods). Purge it eagerly on boot — removeItem
    //    never throws on quota — so the first food add of the session succeeds.
    reclaimBadgeCacheQuota();

    // ── Correct SSR timezone mismatch ─────────────────────────────────────
    //    The server runs UTC; the client has the user's actual local date.
    //    Re-derive today from the client clock and reset navigation state.
    const clientNow = new Date();
    const clientStr = toDateStr(clientNow);
    setTodayInternal(clientNow);
    setActiveDayFocusRaw(clientStr);
    setCurrentDisplayDate(
      new Date(clientNow.getFullYear(), clientNow.getMonth(), clientNow.getDate())
    );

    // ── Load user profile ─────────────────────────────────────────────────
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (raw) {
        const p = JSON.parse(raw) as Record<string, string>;
        // Vanilla JS stored single-char keys: w/h/a/s/b/l
        setProfileState({
          weight:        p.w || DEFAULT_PROFILE.weight,
          height:        p.h || DEFAULT_PROFILE.height,
          age:           p.a || DEFAULT_PROFILE.age,
          sex:           (p.s as 'male' | 'female') || DEFAULT_PROFILE.sex,
          deficit:       p.b || DEFAULT_PROFILE.deficit,
          activityLevel: p.l || DEFAULT_PROFILE.activityLevel,
        });
      }
    } catch {
      // Corrupted storage — fall through to defaults
    }

    // ── Load workout DB ───────────────────────────────────────────────────
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (raw) setLocalDB(JSON.parse(raw) as LocalDB);
    } catch {
      // Corrupted storage — start with empty DB
    }

    // ── Default to week view on mobile ────────────────────────────────────
    if (typeof window !== 'undefined' && window.innerWidth <= 768) {
      setViewMode('week');
    }

    setIsLoaded(true);

    // ── Pull from cloud and merge (per-field newer-wins) ───────────────────
    // Extracted to refreshFromCloud so a Garmin sync can re-run it. Fire-and-
    // forget — failures are silent, localStorage is the fallback.
    void refreshFromCloud();
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // ACTIONS
  // ─────────────────────────────────────────────────────────────────────────

  /** setActiveDayFocus also keeps currentDisplayDate in sync. */
  const setActiveDayFocus = useCallback((dateStr: string) => {
    setActiveDayFocusRaw(dateStr);
    const [y, m, d] = dateStr.split('-').map(Number);
    setCurrentDisplayDate(new Date(y, m - 1, d));
  }, []);

  // ── Keep "today" honest on long-lived sessions ─────────────────────────────
  //    today/todayStr are derived once at mount (above). A mobile PWA is frozen
  //    and resumed rather than remounted, so without this the app's notion of
  //    "today" stays pinned to the day the tab was first opened — which breaks
  //    the morning prompt, streak windows, the calendar's "today" marker, and any
  //    "yesterday" recap. On every foreground we recompute the local date; if it
  //    rolled over we advance today, and we only move the user's calendar focus
  //    when they were already sitting on the old "today" — so we never yank
  //    someone out of a past day they navigated to on purpose. Refs keep the
  //    listener stable while always reading the latest values.
  const todayStrRef         = useRef(todayStr);
  todayStrRef.current       = todayStr;
  const activeDayFocusRef   = useRef(activeDayFocus);
  activeDayFocusRef.current = activeDayFocus;

  useEffect(() => {
    const refreshToday = () => {
      if (document.visibilityState !== 'visible') return;
      const n  = new Date();
      const ns = toDateStr(n);
      if (ns === todayStrRef.current) return;        // same calendar day — nothing to do
      const wasOnToday = activeDayFocusRef.current === todayStrRef.current;
      setTodayInternal(n);
      if (wasOnToday) {
        setActiveDayFocusRaw(ns);
        setCurrentDisplayDate(new Date(n.getFullYear(), n.getMonth(), n.getDate()));
      }
    };
    document.addEventListener('visibilitychange', refreshToday);
    return () => document.removeEventListener('visibilitychange', refreshToday);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Merge server-won days back into React state when the sync engine detects a conflict.
  useEffect(() => {
    const handler = (e: Event) => {
      const conflicts = (e as CustomEvent<Array<{ date: string; data: unknown; deferred?: boolean }>>).detail;
      if (!Array.isArray(conflicts) || conflicts.length === 0) return;
      setLocalDB(prev => {
        const next = { ...prev };
        let changed = false;
        for (const { date, data, deferred } of conflicts) {
          if (deferred) {
            // DEFERRED (CAS exhausted): the user's pending edit must survive and
            // re-send. Do NOT adopt server state (it would overwrite that edit and
            // re-send server data) and do NOT delete the dirty flag — leaving the
            // date dirty is exactly what makes the next debounced sync retry the
            // still-honestly-stamped edit. So: touch nothing here.
            continue;
          }
          // MERGE conflict: server reconciled fields → adopt the merged day and
          // drop the dirty flag so we don't re-push what the server just resolved.
          next[date] = data as DayRecord;
          dirtyDaysRef.current.delete(date);
          changed = true;
        }
        if (changed) { try { localStorage.setItem(DB_KEY, JSON.stringify(next)); } catch { /* noop */ } }
        return next;
      });
    };
    window.addEventListener('que-conflict', handler);
    return () => window.removeEventListener('que-conflict', handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // After a successful push, stamp _syncedAt on those dates so subsequent pushes
  // in the same session don't trigger false server-wins-conflict.
  useEffect(() => {
    const handler = (e: Event) => {
      const { dates, syncedAt } = (e as CustomEvent<{ dates: string[]; syncedAt: string }>).detail;
      if (!Array.isArray(dates) || dates.length === 0) return;
      setLocalDB(prev => {
        const next = { ...prev };
        for (const date of dates) {
          if (next[date]) next[date] = { ...next[date], _syncedAt: syncedAt } as DayRecord;
        }
        try { localStorage.setItem(DB_KEY, JSON.stringify(next)); } catch { /* noop */ }
        return next;
      });
    };
    window.addEventListener('que-sync-ack', handler);
    return () => window.removeEventListener('que-sync-ack', handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Tracks which dates were written since the last sync — only those are pushed.
  const dirtyDaysRef    = useRef<Set<string>>(new Set());
  const syncSkipCountRef = useRef(2); // skip first 2 fires (mount + cloud-pull merge)
  useEffect(() => {
    if (syncSkipCountRef.current > 0) {
      syncSkipCountRef.current -= 1;
      return;
    }
    const dirty = dirtyDaysRef.current;
    if (dirty.size === 0) return;
    const partial: Record<string, unknown> = {};
    for (const d of dirty) partial[d] = localDB[d] as unknown;
    dirty.clear();
    queueSync({ localDB: partial });
  }, [localDB]); // eslint-disable-line react-hooks/exhaustive-deps

  // Always-current ref so the visibilitychange handler sees the latest localDB
  const localDBRef = useRef<LocalDB>({});
  localDBRef.current = localDB;

  // Flush any pending debounced sync when the user closes/hides the tab
  useEffect(() => {
    const handleHide = () => {
      if (document.visibilityState !== 'hidden') return;
      const dirty = dirtyDaysRef.current;
      if (dirty.size === 0) { flushPending(); return; }
      const partial: Record<string, unknown> = {};
      for (const d of dirty) partial[d] = localDBRef.current[d] as unknown;
      dirty.clear();
      pushNow({ localDB: partial });
    };
    document.addEventListener('visibilitychange', handleHide);
    return () => document.removeEventListener('visibilitychange', handleHide);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Merge a partial update into one day's record and immediately persist. */
  const updateDayRecord = useCallback(
    (dateStr: string, updates: Partial<DayRecord>) => {
      dirtyDaysRef.current.add(dateStr);
      setLocalDB(prev => {
        // Strip _syncedAt so the server always accepts this dirty write.
        // Keeping it would let a stale timestamp (e.g. from a server-side cron
        // step update) trick the conflict check into returning server data and
        // deleting the user's in-progress edits.
        const { _syncedAt: _, ...prevDay } = prev[dateStr] ?? {};
        const nowIso = new Date().toISOString();
        // Per-FIELD edit stamps drive field-level merge (lib/dayMerge): only the
        // keys this edit touched advance, so two devices editing DIFFERENT fields
        // of the same day both survive. stampEditedFields stamps by key PRESENCE
        // (so a cleared field — weight:0, foods:'[]' — gets a fresh stamp and
        // beats a stale value) and BACKFILLS a once-legacy day's untouched fields
        // from its old whole-day _editedAt first, so they keep their honest time.
        const fieldEditedAt = stampEditedFields(
          prevDay as MergeableDay,
          Object.keys(updates),
          nowIso,
        );
        const next = {
          ...prev,
          // Whole-day _editedAt retained for ordering + legacy-client fallback.
          [dateStr]: { ...prevDay, ...updates, _editedAt: nowIso, _fieldEditedAt: fieldEditedAt },
        };
        try {
          localStorage.setItem(DB_KEY, JSON.stringify(next));
        } catch { /* storage quota exceeded */ }
        return next;
      });
    },
    []
  );

  /** Read a single day's record without triggering a re-render. */
  const getDayRecord = useCallback(
    (dateStr: string): DayRecord => localDB[dateStr] ?? {},
    [localDB]
  );

  /** Flush the current (or supplied) DB snapshot to localStorage + cloud. */
  const persistDB = useCallback(
    (db?: LocalDB) => {
      const target = db ?? localDB;
      try {
        localStorage.setItem(DB_KEY, JSON.stringify(target));
      } catch { /* storage quota exceeded */ }
      if (db) {
        // Only push the newly supplied days, not the entire DB
        const partial: Record<string, unknown> = {};
        for (const d of Object.keys(db)) partial[d] = db[d] as unknown;
        setLocalDB(db);
        queueSync({ localDB: partial });
      }
    },
    [localDB]
  );

  /** Persist profile — merges partial updates, writes to localStorage + cloud. */
  const persistProfile = useCallback(
    (updates: Partial<UserProfile>) => {
      setProfileState(prev => {
        const next = { ...prev, ...updates };
        const payload = {
          w: next.weight,
          h: next.height,
          a: next.age,
          s: next.sex,
          b: next.deficit,
          l: next.activityLevel,
        };
        try {
          localStorage.setItem(PROFILE_KEY, JSON.stringify(payload));
        } catch { /* storage quota exceeded */ }
        // Sync profile to cloud
        queueSync({ profile: payload });
        return next;
      });
    },
    []
  );

  // Convenience wrapper that accepts a partial UserProfile
  const setProfile = useCallback(
    (updates: Partial<UserProfile>) => persistProfile(updates),
    [persistProfile]
  );

  // Stateless localStorage helpers (getUsage, bumpUsage, getTemplatePool,
  // saveTemplatePool, getWorkoutPresets, saveWorkoutPresets, getLastStreak,
  // saveLastStreak) live in lib/storage.ts — they're imported directly by
  // callers to keep this context value (and its memo deps) small.

  const getLastKnownWeight = useCallback(
    (dateStr: string): string => {
      const hit = Object.keys(localDB)
        .filter(ds => ds <= dateStr && !!localDB[ds]?.weight)
        .sort((a, b) => b.localeCompare(a))[0];
      return hit ? String(localDB[hit].weight ?? '') : '';
    },
    [localDB]
  );

  // ─────────────────────────────────────────────────────────────────────────
  // CONTEXT VALUE — memoised to prevent unnecessary re-renders in consumers
  // ─────────────────────────────────────────────────────────────────────────

  const value = useMemo<AppContextValue>(
    () => ({
      // ── Stable refs ─────────────────────────────────────────────────────
      today,
      todayStr,

      // ── React state ─────────────────────────────────────────────────────
      localDB,         setLocalDB,
      activeDayFocus,  setActiveDayFocus,
      currentDisplayDate, setCurrentDisplayDate,
      viewMode,        setViewMode,
      currentGroup,    setCurrentGroup,
      lastBurn,        setLastBurn,
      lastBudget,      setLastBudget,
      pendingSetsCount, setPendingSetsCount,
      pendingSetData,  setPendingSetData,
      profile,         setProfile,
      isLoaded,

      // ── Actions ──────────────────────────────────────────────────────────
      updateDayRecord,
      getDayRecord,
      persistDB,
      persistProfile,
      getLastKnownWeight,
      refreshFromCloud,
    }),
    [
      today, todayStr,
      localDB, activeDayFocus, currentDisplayDate,
      viewMode, currentGroup,
      lastBurn, lastBudget,
      pendingSetsCount, pendingSetData,
      profile, isLoaded,
      setActiveDayFocus, updateDayRecord, getDayRecord,
      persistDB, persistProfile, setProfile,
      getLastKnownWeight, refreshFromCloud,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// ─────────────────────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * useApp() — consume the global app context from any client component.
 *
 * @example
 * const { localDB, activeDayFocus, updateDayRecord } = useApp();
 */
export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp() must be called inside <AppProvider>. Wrap your layout with it.');
  }
  return ctx;
}
