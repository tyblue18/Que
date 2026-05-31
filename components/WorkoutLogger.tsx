'use client';

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  AnimatePresence, motion, Reorder,
  useDragControls, useMotionValue, useTransform, animate,
} from 'framer-motion';
import { useSpotlightBorder } from '@/hooks/useSpotlightBorder';
import {
  Check, ChevronDown, Dumbbell, Edit3, Flame, GripVertical,
  Layers, Plus, Save, Timer, Trash2, X,
} from 'lucide-react';
import {
  useApp, PRESETS, SECONDARY_MUSCLES,
  type ExerciseEntry, type SetData,
  type WorkoutPreset,
  type DayRecord,
} from '@/lib/AppContext';
import {
  getUsage, bumpUsage, getCustomExercises, saveCustomExercise,
  getWorkoutPresets, saveWorkoutPresets,
} from '@/lib/storage';
import {
  LIFT_PRS_KEY, MILLION_GROUPS_KEY, SHOWN_BADGES_KEY,
} from '@/lib/constants';
import { computeCardioBurn, loadPlan } from '@/lib/metricsTypes';
import { isGoalDay, dayMaintenanceFromRecord, type PlanDirection } from '@/lib/calorie-utils';
import { ActivityIcon, PRLiveBadge } from '@/components/ActivityIcon';
import { AutoCropImage } from '@/components/AutoCropImage';
import { ExerciseHistoryModal } from '@/components/ExerciseHistory';
import { parseEx, serializeEx, normalizeSets } from '@/lib/exerciseSerial';
import { useUnits } from '@/lib/units';
import { useRestTimer, DEFAULT_REST_MS } from '@/lib/RestTimerContext';
import { trackEvent } from '@/lib/telemetry';
import { queueSync, pushNow, gatherSettings } from '@/lib/syncEngine';
import Lottie from 'lottie-react';
import celebrateAnim from '@/public/Celebrate_animation.json';

// ─────────────────────────────────────────────────────────────────────────────
// BADGE HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const BENCH_NAMES = new Set(['Bench Press','Barbell Bench Press','Flat Bench Press','Flat Barbell Bench']);
const SQUAT_NAMES = new Set(['Squat','Back Squat','Barbell Squat','Low Bar Squat','High Bar Squat']);
const DEAD_NAMES  = new Set(['Deadlift','Barbell Deadlift','Conventional Deadlift','Romanian Deadlift']);
const OHP_NAMES   = new Set(['Overhead Press','OHP','Military Press','Barbell OHP','Standing OHP','Barbell Overhead Press']);
const BADGE_WEIGHTS = [135, 225, 315, 405, 495, 540, 630];

type EarnedBadge = { slug: string; label: string; icon: string; category: string };

// Client-side mirror of badgeEngine BADGE_DEFS (lift only) — lets us show the
// popup instantly on commit without waiting for the server round-trip.
const LIFT_CLIENT_BADGES: Array<EarnedBadge & { names: Set<string>; weight: number }> = [
  { slug: 'bench_135', label: '135 Bench',      icon: '/Badges/135_bench_badge.png',     category: 'lift', names: BENCH_NAMES, weight: 135 },
  { slug: 'bench_225', label: '225 Bench',      icon: '/Badges/225_bench_badge.png',     category: 'lift', names: BENCH_NAMES, weight: 225 },
  { slug: 'bench_315', label: '315 Bench',      icon: '/Badges/315_bench_badge.png',     category: 'lift', names: BENCH_NAMES, weight: 315 },
  { slug: 'bench_405', label: '405 Bench',      icon: '/Badges/405_bench_badge.png',     category: 'lift', names: BENCH_NAMES, weight: 405 },
  { slug: 'bench_495', label: '495 Bench',      icon: '/Badges/495_bench_badge.png',     category: 'lift', names: BENCH_NAMES, weight: 495 },
  { slug: 'bench_540', label: '540 Bench',      icon: '/Badges/540_bench_badge.png',     category: 'lift', names: BENCH_NAMES, weight: 540 },
  { slug: 'bench_630', label: '630 Bench',      icon: '/Badges/630_bench_badge.png',     category: 'lift', names: BENCH_NAMES, weight: 630 },
  { slug: 'squat_135', label: '135 Squat',      icon: '/Badges/135_squat_badge.png',     category: 'lift', names: SQUAT_NAMES, weight: 135 },
  { slug: 'squat_225', label: '225 Squat',      icon: '/Badges/225_squat_badge.png',     category: 'lift', names: SQUAT_NAMES, weight: 225 },
  { slug: 'squat_315', label: '315 Squat',      icon: '/Badges/315_squad_badge.png',     category: 'lift', names: SQUAT_NAMES, weight: 315 },
  { slug: 'squat_405', label: '405 Squat',      icon: '/Badges/405_squat_badge.png',     category: 'lift', names: SQUAT_NAMES, weight: 405 },
  { slug: 'squat_495', label: '495 Squat',      icon: '/Badges/495_squat_badge.png',     category: 'lift', names: SQUAT_NAMES, weight: 495 },
  { slug: 'squat_540', label: '540 Squat',      icon: '/Badges/540_squat_badge.png',     category: 'lift', names: SQUAT_NAMES, weight: 540 },
  { slug: 'squat_630', label: '630 Squat',      icon: '/Badges/630_squat_badge.png',     category: 'lift', names: SQUAT_NAMES, weight: 630 },
  { slug: 'dead_135',  label: '135 Deadlift',   icon: '/Badges/135_deadlift_badge.png',  category: 'lift', names: DEAD_NAMES,  weight: 135 },
  { slug: 'dead_225',  label: '225 Deadlift',   icon: '/Badges/225_deadlift_badge.png',  category: 'lift', names: DEAD_NAMES,  weight: 225 },
  { slug: 'dead_315',  label: '315 Deadlift',   icon: '/Badges/315_deadlift_badge.png',  category: 'lift', names: DEAD_NAMES,  weight: 315 },
  { slug: 'dead_405',  label: '405 Deadlift',   icon: '/Badges/405_deadlift_badge.png',  category: 'lift', names: DEAD_NAMES,  weight: 405 },
  { slug: 'dead_495',  label: '495 Deadlift',   icon: '/Badges/495_deadlift_badge.png',  category: 'lift', names: DEAD_NAMES,  weight: 495 },
  { slug: 'dead_540',  label: '540 Deadlift',   icon: '/Badges/540_deadlift_badge.png',  category: 'lift', names: DEAD_NAMES,  weight: 540 },
  { slug: 'dead_630',  label: '630 Deadlift',   icon: '/Badges/630_deadlift_badge.png',  category: 'lift', names: DEAD_NAMES,  weight: 630 },
  { slug: 'ohp_95',    label: '95 OHP Club',    icon: '🏋️',                              category: 'lift', names: OHP_NAMES,   weight: 95  },
  { slug: 'ohp_115',   label: '115 OHP Club',   icon: '🏋️',                              category: 'lift', names: OHP_NAMES,   weight: 115 },
  { slug: 'ohp_135',   label: 'One Plate OHP',  icon: '🥇',                              category: 'lift', names: OHP_NAMES,   weight: 135 },
  { slug: 'ohp_185',   label: '185 OHP Club',   icon: '💪',                              category: 'lift', names: OHP_NAMES,   weight: 185 },
  { slug: 'ohp_225',   label: 'Two Plate OHP',  icon: '👑',                              category: 'lift', names: OHP_NAMES,   weight: 225 },
];

function bestPRFor(prs: Record<string, number>, names: Set<string>): number {
  let best = 0;
  for (const [ex, w] of Object.entries(prs)) { if (names.has(ex) && w > best) best = w; }
  return best;
}

// Returns badges newly earned and slugs newly lost based on a PR diff.
function diffLiftBadges(
  oldPRs: Record<string, number>,
  newPRs: Record<string, number>,
): { earned: EarnedBadge[]; revokedSlugs: string[] } {
  const earned: EarnedBadge[] = [];
  const revokedSlugs: string[] = [];
  for (const def of LIFT_CLIENT_BADGES) {
    const had = bestPRFor(oldPRs, def.names) >= def.weight;
    const has = bestPRFor(newPRs, def.names) >= def.weight;
    if (!had && has) earned.push({ slug: def.slug, label: def.label, icon: def.icon, category: def.category });
    if (had && !has) revokedSlugs.push(def.slug);
  }
  return { earned, revokedSlugs };
}

// Run distance milestones — ordered descending so we surface the highest one earned.
const RUN_MILESTONES = [
  { threshold: 50,   icon: '/Badges/Run_50miles.png' },
  { threshold: 26.2, icon: '/Badges/First_marathon_badge.png' },
  { threshold: 13.1, icon: '/Badges/First_half_marathon_badge.png' },
  { threshold: 9.3,  icon: '/Badges/First_15K_badge.png' },
  { threshold: 6.2,  icon: '/Badges/First_10K_badge.png' },
  { threshold: 3.1,  icon: '/Badges/First_5K_badge.png' },
];

const BIKE_MILESTONES = [
  { threshold:  0.1, icon: '/Badges/First_bike_badge.png'          },
  { threshold: 50,   icon: '/Badges/Running_total_bike_badge.png'  },
  { threshold: 1000, icon: '/Badges/1000_miles_biked_badge.png'    },
];

const STREAK_BADGES = [
  { slug: 'scholar', label: 'Scholar', icon: '/Badges/scholar_badge.png', threshold: 14 },
  { slug: 'master',  label: 'Master',  icon: '/Badges/master_badge.png',  threshold: 30 },
  { slug: 'seer',    label: 'Seer',    icon: '/Badges/seer_badge.png',    threshold: 50 },
] as const;

const CAL_EAT_BADGES = [
  { slug: 'eat_5000',  icon: '/Badges/5000_calories_eaten.png',       threshold: 5000  },
  { slug: 'eat_10000', icon: '/Badges/10000_calories_eaten_badge.jpg', threshold: 10000 },
] as const;

function liftBadgeIcon(exerciseName: string, prWeight: number): string | null {
  let key: string | null = null;
  if (BENCH_NAMES.has(exerciseName)) key = 'bench';
  else if (SQUAT_NAMES.has(exerciseName)) key = 'squat';
  else if (DEAD_NAMES.has(exerciseName))  key = 'deadlift';
  if (!key) return null;
  let highest = 0;
  for (const w of BADGE_WEIGHTS) { if (prWeight >= w) highest = w; }
  if (!highest) return null;
  if (key === 'squat' && highest === 315) return '/Badges/315_squad_badge.png';
  return `/Badges/${highest}_${key}_badge.png`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────
type CardioKind = 'run' | 'bike' | 'swim';
interface NormalizedLift extends ExerciseEntry {
  sets: Array<{ r: string; w: string }>;
  _idx: number;
  _key: string;
}
interface CardioItem extends ExerciseEntry { k: CardioKind; _idx: number; }
interface SwmState {
  name: string; isPreset: boolean; isRecurring: boolean;
  days: number[]; freq: 1 | 2;
}

const MUSCLE_GROUPS = Object.keys(PRESETS) as Array<keyof typeof PRESETS>;
const DAY_LABELS = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

const CARDIO_CFG: Record<CardioKind, {
  code: string; label: string;
  f1: string; f1ph: string; f1mode: React.HTMLInputTypeAttribute;
  f2: string; f2ph: string; f2mode: React.HTMLInputTypeAttribute;
  notePh: string;
}> = {
  swim: { code: 'SWIM', label: 'Swimming', f1: 'DURATION / MIN', f1ph: '45',  f1mode: 'numeric', f2: 'DIST / MI', f2ph: '1.0',      f2mode: 'decimal', notePh: 'drills, laps, style…' },
  run:  { code: 'RUN',  label: 'Running',  f1: 'DISTANCE / MI', f1ph: '5.2', f1mode: 'decimal', f2: 'TIME / MIN', f2ph: '45',       f2mode: 'numeric', notePh: 'pace, route, effort…' },
  bike: { code: 'BIKE', label: 'Cycling',  f1: 'DISTANCE / MI', f1ph: '20',  f1mode: 'decimal', f2: 'TIME / MIN', f2ph: '60',       f2mode: 'numeric', notePh: 'route, watts, HR zone…' },
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
// parseEx / serializeEx / normalizeSets now live in lib/exerciseSerial.ts so the
// global rest-timer context appends sets with the exact same encoding.
function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

/** Compare two serialised exercise lists by identity (kind + group + name),
 *  ignoring sets/reps/weight. Returns true if they represent the same workout. */
function isSameWorkout(jsonA: string, jsonB: string): boolean {
  const sig = (json: string) =>
    parseEx(json).map(e => `${e.k}|${e.g ?? ''}|${e.n ?? ''}`).join(',');
  return sig(jsonA) === sig(jsonB);
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT — FormatSets / SetBadge
// ─────────────────────────────────────────────────────────────────────────────
function FormatSets({ sets }: { sets: Array<{ r: string; w: string }> }) {
  if (!sets.length) return <span className="text-[var(--ink-3)]">—</span>;
  const n = sets.length;
  const allSameReps   = sets.every(s => s.r === sets[0].r);
  const allSameWeight = sets.every(s => s.w === sets[0].w);

  if (allSameReps && allSameWeight) {
    return (
      <span className="flex items-baseline gap-2">
        <span className="font-display tabular text-[22px] leading-none text-[var(--ink-0)]">
          {n}×{sets[0].r || '—'}
        </span>
        {sets[0].w && (
          <span className="font-mono text-[11px] text-[var(--accent)]">@ {sets[0].w}</span>
        )}
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="font-mono text-[9px] font-bold text-[var(--ink-3)] tracking-[1px] mr-1">{n} SETS</span>
      {sets.map((s, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 font-mono bg-[var(--bg-2)] border border-[var(--line)] rounded-sm px-2 py-0.5 whitespace-nowrap"
        >
          <span className="text-[9px] text-[var(--ink-3)]">{i + 1}</span>
          <span className="font-display text-[15px] leading-none text-[var(--ink-0)]">{s.r || '—'}</span>
          {s.w && <span className="text-[10px] text-[var(--accent)]">@{s.w}</span>}
        </span>
      ))}
    </span>
  );
}

function SetBadge({ sets, onSave }: {
  sets: Array<{ r: string; w: string }>;
  onSave: (updated: Array<{ r: string; w: string }>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editSets, setEditSets] = useState<Array<{ r: string; w: string }>>([]);
  const wrapRef = useRef<HTMLDivElement>(null);

  const startEdit = () => {
    setEditSets(sets.map(s => ({ ...s })));
    setEditing(true);
    setTimeout(() => wrapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 350);
  };
  const commit = useCallback(() => { onSave(editSets); setEditing(false); }, [editSets, onSave]);

  const updateSet = (i: number, field: 'r' | 'w', val: string) => {
    setEditSets(prev => { const next = [...prev]; next[i] = { ...next[i], [field]: val }; return next; });
  };

  return (
    <AnimatePresence mode="wait" initial={false}>
      {editing ? (
        <motion.div
          key="editor"
          ref={wrapRef}
          initial={{ opacity: 0, scale: 0.96, y: -6 }}
          animate={{ opacity: 1, scale: 1,    y: 0  }}
          exit={{    opacity: 0, scale: 0.96, y: -6 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col gap-1.5 p-2 bg-[var(--bg-2)] border border-[var(--accent)] rounded-sm"
          onBlur={e => { if (!wrapRef.current?.contains(e.relatedTarget as Node)) commit(); }}
        >
          {editSets.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-[var(--ink-3)] min-w-[14px] text-right">{i + 1}</span>
              <input
                autoFocus={i === 0}
                type="text" inputMode="numeric" value={s.r} placeholder="reps"
                className="w-12 rounded-sm px-1.5 py-1 font-mono text-[12px] bg-[var(--bg-1)] border border-[var(--line-2)] text-[var(--ink-0)] outline-none focus:border-[var(--accent)]"
                onChange={e => updateSet(i, 'r', e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') commit(); }}
                onFocus={e => { const el = e.target; setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 350); }}
              />
              <span className="text-[var(--ink-3)] text-[11px]">@</span>
              <input
                type="text" inputMode="decimal" value={s.w} placeholder="wt"
                className="w-20 rounded-sm px-1.5 py-1 font-mono text-[12px] bg-[var(--bg-1)] border border-[var(--line-2)] text-[var(--ink-0)] outline-none focus:border-[var(--accent)]"
                onChange={e => updateSet(i, 'w', e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') commit(); }}
                onFocus={e => { const el = e.target; setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 350); }}
              />
            </div>
          ))}
          <motion.button
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}
            onMouseDown={e => { e.preventDefault(); commit(); }}
            className="flex items-center justify-center gap-1 font-mono text-[10px] font-bold text-[var(--accent)] mt-1 hover:text-[var(--accent-hi)] transition-colors tracking-[1px] uppercase"
          >
            <Check size={10} /> Save
          </motion.button>
        </motion.div>
      ) : (
        <motion.button
          key="display"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{    opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={startEdit}
          className="inline-flex flex-wrap items-center gap-1.5 text-left cursor-pointer rounded-sm px-2.5 py-1.5 border border-[var(--line)] bg-[var(--bg-2)] hover:border-[var(--accent)] transition-all group"
          title="Click to edit sets"
        >
          <FormatSets sets={sets} />
          <Edit3 size={9} className="text-[var(--ink-3)] group-hover:text-[var(--accent)] ml-1" />
        </motion.button>
      )}
    </AnimatePresence>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT — ReorderableExerciseItem
// Drag handle (≡) → vertical reorder via Reorder.Item
// Swipe right     → reveals DELETE; release past 120px deletes the entry
// ─────────────────────────────────────────────────────────────────────────────
function ReorderableExerciseItem({
  entry, numIdx, isPR, earnedBadgeIcon: badgeIcon, onDelete, onUpdateName, onUpdateSets, onViewHistory,
}: {
  entry: NormalizedLift; numIdx: number; isPR?: boolean; earnedBadgeIcon?: string | null;
  onDelete: (idx: number) => void;
  onUpdateName: (idx: number, name: string) => void;
  onUpdateSets: (idx: number, sets: Array<{ r: string; w: string }>) => void;
  onViewHistory?: () => void;
}) {
  const dragControls  = useDragControls();
  const x             = useMotionValue(0);
  const deleteOpacity = useTransform(x, [40, 110], [0, 1]);

  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal]         = useState(entry.n ?? '');
  const nameInputRef = useRef<HTMLInputElement>(null);

  const startNameEdit = () => {
    setNameVal(entry.n ?? ''); setEditingName(true);
    setTimeout(() => nameInputRef.current?.select(), 10);
  };
  const commitName = () => {
    const v = nameVal.trim();
    if (v && v !== entry.n) onUpdateName(entry._idx, v);
    setEditingName(false);
  };

  const handleDragEnd = (_: unknown, info: { offset: { x: number } }) => {
    if (info.offset.x > 120) {
      animate(x, 220, { duration: 0.18 }).then(() => onDelete(entry._idx));
    } else {
      animate(x, 0, { type: 'spring', stiffness: 400, damping: 35 });
    }
  };

  return (
    <Reorder.Item
      value={entry}
      dragListener={false}
      dragControls={dragControls}
      className="relative select-none"
      layout
    >
      {/* Delete indicator — revealed on swipe right */}
      <motion.div
        className="absolute inset-0 rounded border border-[var(--danger)]/40 bg-[var(--danger-12)] flex items-center justify-end pr-4 pointer-events-none"
        style={{ opacity: deleteOpacity }}
        aria-hidden
      >
        <span className="flex items-center gap-1.5 font-mono text-[10px] font-bold tracking-[2px] text-[var(--danger)] uppercase">
          <Trash2 size={13} /> Delete
        </span>
      </motion.div>

      {/* Swipeable card */}
      <motion.div
        drag="x"
        dragConstraints={{ left: 0, right: 160 }}
        dragElastic={{ left: 0, right: 0.05 }}
        dragMomentum={false}
        style={{ x, touchAction: 'pan-y' }}
        onDragEnd={handleDragEnd}
        className="group flex items-center gap-3 bg-[var(--bg-2)] border border-[var(--line)] rounded px-3 py-3 relative overflow-hidden z-10"
      >
        {/* Accent stripe */}
        <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-[var(--accent)] opacity-30 group-hover:opacity-100 transition-opacity" />

        {/* Reorder grip — touch here to drag vertically */}
        <div
          className="touch-none cursor-grab active:cursor-grabbing text-[var(--ink-3)] hover:text-[var(--ink-1)] transition-colors flex-shrink-0"
          onPointerDown={e => { e.preventDefault(); dragControls.start(e); }}
        >
          <GripVertical size={15} />
        </div>

        <span className="font-display tabular text-[16px] leading-none text-[var(--ink-3)] min-w-[20px] text-right flex-shrink-0">
          {String(numIdx + 1).padStart(2, '0')}
        </span>

        {entry.k === 'lift' && entry.g && (
          <span className="font-mono text-[9px] font-bold tracking-[2px] text-[var(--accent)] uppercase flex-shrink-0 w-14 truncate">
            {entry.g}
          </span>
        )}

        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          {editingName ? (
            <input
              ref={nameInputRef} autoFocus type="text" value={nameVal}
              className="text-[14px] text-[var(--ink-0)] font-semibold bg-transparent border-b border-[var(--accent)] outline-none pb-0.5 w-full"
              onChange={e => setNameVal(e.target.value)}
              onBlur={commitName}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); nameInputRef.current?.blur(); }
                if (e.key === 'Escape') setEditingName(false);
              }}
            />
          ) : (
            <div className="flex items-start gap-1.5 min-w-0">
              <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span
                    onClick={startNameEdit}
                    className="text-[14px] text-[var(--ink-0)] font-semibold cursor-text hover:text-[var(--accent)] transition-colors truncate"
                  >
                    {entry.n ?? entry.k}
                  </span>
                  {badgeIcon && (
                    <img src={badgeIcon} alt="badge" className="w-5 h-5 object-contain flex-shrink-0" />
                  )}
                </span>
                {(entry.g2 || entry.g3) && (
                  <div className="flex items-center gap-1">
                    {([entry.g2, entry.g3].filter(Boolean) as string[]).map((g, i) => (
                      <span key={g} className="font-mono text-[8px] font-bold tracking-[0.8px] uppercase text-[var(--ink-3)] border border-[var(--line)] rounded-sm px-1 py-px">
                        {i === 0 ? '2°' : '3°'} {g}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <PRLiveBadge active={!!isPR} size={26} />
              {onViewHistory && (
                <button
                  type="button"
                  onClick={onViewHistory}
                  className="text-[var(--ink-3)] hover:text-[var(--accent)] transition-colors flex-shrink-0"
                  title="View history"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                  </svg>
                </button>
              )}
            </div>
          )}

          {entry.k === 'lift' && entry.sets && (
            <SetBadge sets={entry.sets} onSave={updated => onUpdateSets(entry._idx, updated)} />
          )}
        </div>

        {/* Desktop-only X button (hover reveals) */}
        <button
          onClick={() => onDelete(entry._idx)}
          className="flex-shrink-0 w-8 h-8 hidden md:flex items-center justify-center rounded text-transparent group-hover:text-[var(--ink-2)] hover:!text-[var(--danger)] hover:bg-[var(--danger-12)] transition-all"
          title="Remove"
        >
          <X size={15} />
        </button>
      </motion.div>
    </Reorder.Item>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT — CardioEntryCard
// ─────────────────────────────────────────────────────────────────────────────
function CardioEntryCard({
  entry, onDelete, onUpdateField, onCommit, firstBadgeIcon, badgeMilesLabel, burnBadgeIcon, burnCalLabel,
}: {
  entry: CardioItem;
  onDelete: (idx: number) => void;
  onUpdateField: (idx: number, field: 'v1' | 'v2' | 'note', val: string) => void;
  /** Persists the in-progress cardio (called on input blur) so a cardio-only
   *  session isn't lost when the user navigates away without "Commit Session". */
  onCommit: () => void;
  firstBadgeIcon?: string | null;
  badgeMilesLabel?: string | null;
  burnBadgeIcon?: string | null;
  burnCalLabel?: string | null;
}) {
  const cfg = CARDIO_CFG[entry.k];
  const u = useUnits();

  // The DISTANCE field stays canonical (miles) in entry. We render it from local
  // display state so metric users can type decimals (km) without round-trip jank,
  // and write canonical miles back to the entry live so persist/commit always
  // has the real value. swim's distance is f2/v2; run & bike use f1/v1.
  const distField: 'v1' | 'v2' = entry.k === 'swim' ? 'v2' : 'v1';
  const distStored = entry[distField] ?? '';
  const [distInput, setDistInput] = useState('');
  const lastDistWrite = useRef<string | null>(null);
  // Reseed on EXTERNAL change (preset load, undo) — but not our own live write.
  useEffect(() => {
    if (distStored === (lastDistWrite.current ?? '')) return;
    setDistInput(distStored ? u.dispDistance(parseFloat(String(distStored))) : '');
  }, [distStored]); // eslint-disable-line react-hooks/exhaustive-deps
  // Always reseed when the unit system flips (canonical entry is unchanged).
  useEffect(() => {
    setDistInput(distStored ? u.dispDistance(parseFloat(String(distStored))) : '');
    lastDistWrite.current = distStored ? String(distStored) : null;
  }, [u.system]); // eslint-disable-line react-hooks/exhaustive-deps
  const onDistChange = (val: string) => {
    setDistInput(val);
    const mi = val.trim() ? String(u.toStoredDistance(parseFloat(val) || 0)) : '';
    lastDistWrite.current = mi;
    onUpdateField(entry._idx, distField, mi);
  };
  /** Cardio field label with MI swapped for the user's distance unit. */
  const unitLabel = (raw: string) => raw.replace(/MI$/i, u.distanceUnit.toUpperCase());
  const f1IsDist = distField === 'v1';
  const f2IsDist = distField === 'v2';

  return (
    <div className="rounded border border-[var(--line)] bg-[var(--bg-2)] px-4 py-4 relative overflow-hidden">
      <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-[var(--accent)]" />

      <div className="flex items-center gap-3 mb-4">
        <span className="text-[var(--accent)] flex-shrink-0">
          <ActivityIcon kind={entry.k} active={true} size={22} />
        </span>
        <span className="font-mono text-[10px] font-bold tracking-[2px] text-[var(--accent)] uppercase">{cfg.code}</span>
        <span className="text-[14px] font-semibold text-[var(--ink-0)] flex-1">{cfg.label}</span>
        {firstBadgeIcon && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <AutoCropImage src={firstBadgeIcon} alt="first milestone" className="w-6 h-6 object-contain" />
            {badgeMilesLabel && (
              <span className="font-mono text-[10px] font-bold tracking-[1px] text-[var(--accent)]">{badgeMilesLabel}</span>
            )}
          </div>
        )}
        {burnBadgeIcon && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <AutoCropImage src={burnBadgeIcon} alt="1000 cal burn" className="w-6 h-6 object-contain" />
            {burnCalLabel && (
              <span className="font-mono text-[10px] font-bold tracking-[1px] text-[var(--accent)]">{burnCalLabel}</span>
            )}
          </div>
        )}
        <button
          onClick={() => onDelete(entry._idx)}
          className="w-7 h-7 flex items-center justify-center rounded text-[var(--ink-3)] hover:text-[var(--danger)] hover:bg-[var(--danger-12)] transition-all"
        >
          <X size={15} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="que-label">{f1IsDist ? unitLabel(cfg.f1) : cfg.f1}</label>
          <input
            type="text" inputMode={cfg.f1mode as React.HTMLAttributes<HTMLInputElement>['inputMode']}
            className="que-input" value={f1IsDist ? distInput : (entry.v1 ?? '')} placeholder={cfg.f1ph}
            onChange={e => f1IsDist ? onDistChange(e.target.value) : onUpdateField(entry._idx, 'v1', e.target.value)}
            onBlur={onCommit}
          />
        </div>
        <div>
          <label className="que-label">{f2IsDist ? unitLabel(cfg.f2) : cfg.f2}</label>
          <input
            type="text" inputMode={cfg.f2mode as React.HTMLAttributes<HTMLInputElement>['inputMode']}
            className="que-input" value={f2IsDist ? distInput : (entry.v2 ?? '')} placeholder={cfg.f2ph}
            onChange={e => f2IsDist ? onDistChange(e.target.value) : onUpdateField(entry._idx, 'v2', e.target.value)}
            onBlur={onCommit}
          />
        </div>
      </div>
      <div>
        <label className="que-label">Notes</label>
        <input type="text" className="que-input" value={entry.note ?? ''} placeholder={cfg.notePh}
          onChange={e => onUpdateField(entry._idx, 'note', e.target.value)}
          onBlur={onCommit} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT — PresetModal
// ─────────────────────────────────────────────────────────────────────────────
function PresetModal({
  open, presets, currentCount, onLoad, onClose,
}: {
  open: boolean; presets: WorkoutPreset[];
  currentCount: number;
  onLoad: (preset: WorkoutPreset, replace: boolean) => void;
  onClose: () => void;
}) {
  const [pending, setPending] = React.useState<WorkoutPreset | null>(null);

  // Reset pending choice whenever the modal closes
  React.useEffect(() => { if (!open) setPending(null); }, [open]);

  function handleSelect(preset: WorkoutPreset) {
    if (currentCount > 0) {
      setPending(preset); // show the merge-or-replace screen
    } else {
      onLoad(preset, false);
      onClose();
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start md:items-center justify-center backdrop-blur-sm pt-[60px] md:pt-0 px-3 md:px-0"
          style={{ background: 'rgba(7,8,10,0.85)' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={e => { if (e.target === e.currentTarget) onClose(); }}
        >
          <motion.div
            className="w-full md:max-w-[600px] max-h-[calc(100dvh-68px)] md:max-h-[88vh] overflow-y-auto rounded-lg border border-[var(--line-2)] bg-[var(--bg-1)] p-4 md:p-6"
            initial={{ opacity: 0, y: 32, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.97 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            style={{ boxShadow: '0 0 0 1px var(--line-2), 0 -2px 0 0 var(--accent), 0 40px 80px rgba(0,0,0,0.6)' }}
          >
            {pending ? (
              /* ── Merge-or-replace screen ── */
              <>
                {/* Header */}
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <p className="font-mono text-[9px] font-bold tracking-[3px] text-[var(--ink-3)] uppercase mb-1">
                      Session In Progress
                    </p>
                    <p className="font-display text-[18px] md:text-[22px] tracking-[2px] uppercase text-[var(--ink-0)] leading-none truncate max-w-[220px] md:max-w-none">
                      {pending.name}
                    </p>
                  </div>
                  <button onClick={onClose} className="text-[var(--ink-2)] hover:text-[var(--accent)] transition-colors p-1.5 flex-shrink-0 ml-3 -mt-1">
                    <X size={20} />
                  </button>
                </div>

                {/* Context line */}
                <p className="font-mono text-[10px] text-[var(--ink-2)] tracking-[0.5px] mb-4 pb-4 border-b border-[var(--line)]">
                  You have{' '}
                  <span className="text-[var(--ink-0)] font-bold">
                    {currentCount} exercise{currentCount !== 1 ? 's' : ''}
                  </span>{' '}
                  logged — how do you want to load this?
                </p>

                {/* Side-by-side action cards */}
                <div className="grid grid-cols-2 gap-2.5 mb-4">
                  <button
                    onClick={() => { onLoad(pending, false); onClose(); }}
                    className="group flex flex-col gap-3 rounded border border-[var(--line-2)] bg-[var(--bg-2)] p-3 md:p-4 text-left hover:border-[var(--accent)] active:bg-[var(--accent-12)] transition-all min-h-[120px]"
                  >
                    <span
                      className="block w-8 h-[2px] bg-[var(--accent)] rounded-full flex-shrink-0"
                      style={{ boxShadow: '0 0 6px var(--accent-40)' }}
                    />
                    <div>
                      <p className="font-display text-[15px] md:text-[16px] tracking-[1px] uppercase text-[var(--ink-0)] group-hover:text-[var(--accent)] transition-colors leading-tight mb-1.5">
                        Add On Top
                      </p>
                      <p className="font-mono text-[9px] text-[var(--ink-2)] tracking-[0.3px] leading-[1.5]">
                        Keep current &amp; stack preset below
                      </p>
                    </div>
                  </button>

                  <button
                    onClick={() => { onLoad(pending, true); onClose(); }}
                    className="group flex flex-col gap-3 rounded border border-[var(--line-2)] bg-[var(--bg-2)] p-3 md:p-4 text-left hover:border-[var(--warn)] active:bg-[var(--bg-3)] transition-all min-h-[120px]"
                  >
                    <span className="block w-8 h-[2px] bg-[var(--warn)] rounded-full flex-shrink-0" />
                    <div>
                      <p className="font-display text-[15px] md:text-[16px] tracking-[1px] uppercase text-[var(--ink-0)] group-hover:text-[var(--warn)] transition-colors leading-tight mb-1.5">
                        Start Fresh
                      </p>
                      <p className="font-mono text-[9px] text-[var(--ink-2)] tracking-[0.3px] leading-[1.5]">
                        Clear session, load preset only
                      </p>
                    </div>
                  </button>
                </div>

                <button
                  onClick={() => setPending(null)}
                  className="que-btn-ghost w-full"
                >
                  ← Back to Presets
                </button>
              </>
            ) : (
              /* ── Preset list ── */
              <>
                <div className="flex justify-between items-center mb-4">
                  <h3 className="font-display text-[22px] md:text-[28px] tracking-[2px] uppercase text-[var(--ink-0)]">Load Preset</h3>
                  <button onClick={onClose} className="text-[var(--ink-2)] hover:text-[var(--accent)] transition-colors p-1">
                    <X size={20} />
                  </button>
                </div>

                {presets.length === 0 ? (
                  <div className="text-center py-8 border border-dashed border-[var(--line-2)] rounded">
                    <p className="font-mono text-[11px] tracking-[1px] text-[var(--ink-3)] uppercase">No presets saved yet</p>
                    <p className="font-mono text-[10px] text-[var(--ink-3)] mt-1.5 tracking-[0.5px]">Log a workout and hit "Save as Preset"</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {presets.map(preset => {
                      const entries = parseEx(preset.exercises);
                      const lifts   = entries.filter(e => e.k === 'lift' || e.k === 'text');
                      const cardios = entries.filter(e => ['run','bike','swim'].includes(e.k));
                      const names   = lifts.slice(0, 3).map(e => e.n ?? e.k);
                      const more    = lifts.length - names.length;
                      return (
                        <button
                          key={preset.id}
                          onClick={() => handleSelect(preset)}
                          className="text-left rounded border border-[var(--line)] bg-[var(--bg-2)] px-3 py-2.5 md:px-4 md:py-3 hover:border-[var(--accent)] hover:bg-[var(--bg-3)] transition-all group"
                        >
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <p className="font-display text-[14px] md:text-[16px] tracking-[1px] uppercase text-[var(--ink-0)] group-hover:text-[var(--accent)] transition-colors truncate">
                              {preset.name}
                            </p>
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              {lifts.length > 0 && (
                                <span className="font-mono text-[9px] font-bold tracking-[1px] text-[var(--accent-ink)] bg-[var(--accent)] px-1.5 py-0.5 rounded-sm uppercase">
                                  {lifts.length} EX
                                </span>
                              )}
                              {cardios.length > 0 && (
                                <span className="font-mono text-[9px] font-bold tracking-[1px] text-[var(--ink-0)] bg-[var(--bg-3)] border border-[var(--line-2)] px-1.5 py-0.5 rounded-sm uppercase">
                                  {cardios.length} CARDIO
                                </span>
                              )}
                            </div>
                          </div>
                          <p className="font-mono text-[9px] md:text-[10px] text-[var(--ink-2)] tracking-[0.5px] truncate">
                            {names.join(' · ')}{more > 0 ? ` · +${more} more` : ''}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                )}

                <button onClick={onClose} className="que-btn-ghost mt-3 w-full">CANCEL</button>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT — SaveWorkoutModal
// ─────────────────────────────────────────────────────────────────────────────
function SaveWorkoutModal({
  open, swm, lifts, dupWarning, onClose, onSave,
  onChangeName, onTogglePreset, onToggleRecurring,
  onToggleDay, onSetFreq,
}: {
  open: boolean; swm: SwmState; lifts: NormalizedLift[];
  dupWarning: boolean;
  onClose: () => void; onSave: () => void;
  onChangeName: (v: string) => void;
  onTogglePreset: () => void;
  onToggleRecurring: () => void;
  onToggleDay: (d: number) => void;
  onSetFreq: (n: 1 | 2) => void;
}) {
  const Toggle = ({ on }: { on: boolean }) => (
    <div className={`relative w-[40px] h-[22px] rounded-sm border transition-all flex-shrink-0 ${
      on ? 'bg-[var(--accent)] border-[var(--accent)]' : 'bg-[var(--bg-2)] border-[var(--line-2)]'
    }`}>
      <span className={`absolute top-[2px] w-4 h-4 rounded-sm transition-all ${
        on ? 'left-[20px] bg-[var(--accent-ink)]' : 'left-[2px] bg-[var(--ink-2)]'
      }`} />
    </div>
  );

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start md:items-center justify-center backdrop-blur-sm pt-[60px] md:pt-0 px-3 md:px-0"
          style={{ background: 'rgba(7,8,10,0.85)' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={e => { if (e.target === e.currentTarget) onClose(); }}
        >
          <motion.div
            className="w-full md:max-w-[600px] max-h-[calc(100dvh-68px)] md:max-h-[88vh] overflow-y-auto rounded-lg border border-[var(--line-2)] bg-[var(--bg-1)] p-4 md:p-6"
            initial={{ opacity: 0, y: 32, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.97 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            style={{ boxShadow: '0 0 0 1px var(--line-2), 0 -2px 0 0 var(--accent), 0 40px 80px rgba(0,0,0,0.6)' }}
          >
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-display text-[22px] md:text-[28px] tracking-[2px] uppercase text-[var(--ink-0)]">Save Workout</h3>
              <button onClick={onClose} className="text-[var(--ink-2)] hover:text-[var(--accent)] transition-colors p-1">
                <X size={20} />
              </button>
            </div>

            <div className="mb-4">
              <label className="que-label">Workout Name</label>
              <input
                autoFocus type="text" className="que-input"
                value={swm.name} placeholder="e.g. Chest Day"
                onChange={e => onChangeName(e.target.value)}
              />
              {dupWarning && (
                <div className="mt-2 flex items-center gap-2 rounded border border-[var(--danger)] bg-[var(--danger-12)] px-3 py-2">
                  <span className="font-mono text-[11px] font-bold text-[var(--danger)] tracking-[0.5px]">
                    Preset Already Saved — this exact workout is already in your presets
                  </span>
                </div>
              )}
            </div>

            <div className="flex flex-col divide-y divide-[var(--line)]">
              <button onClick={onTogglePreset} className="flex items-center gap-3 py-3 hover:opacity-90 transition-opacity text-left w-full">
                <div className="flex-1">
                  <p className="text-[13px] md:text-[14px] font-semibold text-[var(--ink-0)]">Save to Presets</p>
                  <p className="font-mono text-[10px] text-[var(--ink-2)] mt-0.5 tracking-[0.5px]">load this workout from the preset picker</p>
                </div>
                <Toggle on={swm.isPreset} />
              </button>

              <button onClick={onToggleRecurring} className="flex items-center gap-3 py-3 hover:opacity-90 transition-opacity text-left w-full">
                <div className="flex-1">
                  <p className="text-[13px] md:text-[14px] font-semibold text-[var(--ink-0)]">Recurring Schedule</p>
                  <p className="font-mono text-[10px] text-[var(--ink-2)] mt-0.5 tracking-[0.5px]">auto-suggest on selected days</p>
                </div>
                <Toggle on={swm.isRecurring} />
              </button>
            </div>

            {swm.isRecurring && (
              <div className="mt-3 p-3 bg-[var(--bg-2)] rounded border border-[var(--line)]">
                <p className="que-label mb-2">Days of Week</p>
                <div className="grid grid-cols-7 gap-1 mb-3">
                  {DAY_LABELS.map((d, i) => (
                    <button
                      key={d} onClick={() => onToggleDay(i)}
                      className={[
                        'py-2 rounded-sm font-mono text-[9px] md:text-[10px] font-bold tracking-[0.5px] border transition-all text-center',
                        swm.days.includes(i)
                          ? 'bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-ink)]'
                          : 'bg-[var(--bg-1)] border-[var(--line-2)] text-[var(--ink-2)] hover:text-[var(--ink-0)]',
                      ].join(' ')}
                    >
                      {d.slice(0, 2)}
                    </button>
                  ))}
                </div>

                <p className="que-label mb-2">Frequency</p>
                <div className="flex gap-2">
                  {([1, 2] as const).map(n => (
                    <button
                      key={n} onClick={() => onSetFreq(n)}
                      className={[
                        'flex-1 py-2 rounded-sm font-mono text-[10px] md:text-[11px] font-bold tracking-[1px] border transition-all uppercase',
                        swm.freq === n
                          ? 'bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-ink)]'
                          : 'bg-[var(--bg-1)] border-[var(--line-2)] text-[var(--ink-2)] hover:text-[var(--ink-0)]',
                      ].join(' ')}
                    >
                      {n === 1 ? 'Weekly' : 'Bi-weekly'}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={onSave}
              disabled={!swm.name.trim() || lifts.length === 0}
              className="que-btn-primary mt-4 w-full"
            >
              SAVE WORKOUT
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function WorkoutLogger() {
  const {
    today, todayStr,
    activeDayFocus,
    localDB, updateDayRecord, profile,
    currentGroup, setCurrentGroup,
    pendingSetsCount, setPendingSetsCount,
    pendingSetData, setPendingSetData,
    isLoaded,
  } = useApp();

  const [exercises, setExercisesRaw] = useState<ExerciseEntry[]>([]);
  const [notes, setNotesRaw] = useState('');
  const [selectedEx,    setSelectedEx]    = useState('');
  const [isCustomEx,    setIsCustomEx]    = useState(false);
  const [customName,    setCustomName]    = useState('');
  const [customG2,      setCustomG2]      = useState('');
  const [customG3,      setCustomG3]      = useState('');
  const [exSearch,      setExSearch]      = useState('');
  // Bumped on each commit so the exercise picker re-reads usage + custom-exercise
  // stores from localStorage (a freshly-added custom exercise shows immediately).
  const [exListVersion, setExListVersion] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<{ entry: ExerciseEntry; key: string } | null>(null);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveFlash, setSaveFlash] = useState(false);
  const [loggedFlash, setLoggedFlash] = useState(false);
  const [templateModal, setTemplateModal] = useState(false);
  const [saveModal, setSaveModal] = useState(false);
  const [historyEx, setHistoryEx] = useState<string | null>(null);
  const [recurringPreset, setRecurringPreset] = useState<WorkoutPreset | null>(null);
  const [swm, setSwm] = useState<SwmState>({ name: '', isPreset: true, isRecurring: false, days: [], freq: 1 });
  const [dupWarning, setDupWarning] = useState(false);
  const [activeSection, setActiveSection] = useState<'lifting' | 'cardio'>('lifting');
  const [confirmClear, setConfirmClear] = useState(false);
  const [earnedBadges, setEarnedBadges] = useState<EarnedBadge[]>([]);
  // Persisted across refreshes so badge popups never re-fire for already-earned badges.
  // Cleared per-slug only when a badge is revoked, enabling re-earn popups.
  const optimisticallyShownRef = useRef<Set<string>>((() => {
    try { return new Set(JSON.parse(localStorage.getItem(SHOWN_BADGES_KEY) ?? '[]') as string[]); }
    catch { return new Set<string>(); }
  })());

  const markShown = useCallback((slug: string) => {
    optimisticallyShownRef.current.add(slug);
    try {
      const all = new Set(JSON.parse(localStorage.getItem(SHOWN_BADGES_KEY) ?? '[]') as string[]);
      all.add(slug);
      localStorage.setItem(SHOWN_BADGES_KEY, JSON.stringify([...all]));
    } catch { /* noop */ }
  }, []);

  const unmarkShown = useCallback((slug: string) => {
    optimisticallyShownRef.current.delete(slug);
    try {
      const all = new Set(JSON.parse(localStorage.getItem(SHOWN_BADGES_KEY) ?? '[]') as string[]);
      all.delete(slug);
      localStorage.setItem(SHOWN_BADGES_KEY, JSON.stringify([...all]));
    } catch { /* noop */ }
  }, []);

  // Stable keys for Reorder (parallel to exercises array, never derived)
  const exerciseKeysRef = useRef<string[]>([]);
  const keyCounterRef   = useRef(0);
  const nextKey = useCallback(() => `k${++keyCounterRef.current}`, []);

  const pillsRowRef = useRef<HTMLDivElement>(null);
  const dragState = useRef({ dragging: false, startX: 0, scrollLeft: 0, moved: false });
  const repsRefs = useRef<Array<HTMLInputElement | null>>([]);
  const weightRefs = useRef<Array<HTMLInputElement | null>>([]);
  const notesFlashRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── persist & derive
  const persistExercises = useCallback(
    (arr: ExerciseEntry[], notesTxt = notes) => {
      const raw   = serializeEx(arr);
      // Mark this as our own write so the external-change detector ignores it.
      lastOwnWriteRef.current = raw;
      const runs  = arr.filter(e => e.k === 'run');
      const bikes = arr.filter(e => e.k === 'bike');
      const swims = arr.filter(e => e.k === 'swim');
      const runDist  = runs.reduce((s, e)  => s + (parseFloat(e.v1 ?? '0') || 0), 0);
      const runTime  = runs.reduce((s, e)  => s + (parseFloat(e.v2 ?? '0') || 0), 0);
      const bikeDist = bikes.reduce((s, e) => s + (parseFloat(e.v1 ?? '0') || 0), 0);
      const bikeTime = bikes.reduce((s, e) => s + (parseFloat(e.v2 ?? '0') || 0), 0);
      const swimTime = swims.reduce((s, e) => s + (parseFloat(e.v1 ?? '0') || 0), 0);
      const swimDist = swims.reduce((s, e) => s + (parseFloat(e.v2 ?? '0') || 0), 0);
      // Store `burn` here too — it's a pure function of profile + this day's
      // cardio, so it must be kept in sync wherever cardio is written (not only
      // on the Calories tab's "Log Today"). Steps live on the day record
      // separately and don't affect activityBurn.
      const burn = computeCardioBurn(profile, {
        steps: '0',
        runDist:  String(runDist),  runTime:  String(runTime),
        bikeDist: String(bikeDist), bikeTime: String(bikeTime),
        swimTime: String(swimTime),
      }).activityBurn;
      updateDayRecord(activeDayFocus, {
        exercises: raw, notes: notesTxt,
        runDist, runTime, bikeDist, bikeTime, swimTime, swimDist, burn,
      });
      // Recompute all-time PRs from the full localDB so corrections flow back down.
      // Scan every OTHER day for historical maxes, then overlay today's arr.
      // This means editing today's entry can only reduce queLiftPRs if no other
      // day has a higher weight — which is the correct behaviour for mistake corrections.
      const prRecs: Record<string, number> = {};
      for (const [date, rec] of Object.entries(localDBRef.current)) {
        if (date === activeDayFocus) continue; // today overlaid below from arr
        parseEx((rec as { exercises?: string }).exercises ?? '')
          .filter(e => e.k === 'lift' && e.n)
          .forEach(ex => {
            normalizeSets(ex).forEach(s => {
              const w = parseFloat(String(s.w ?? '0')) || 0;
              if (w > 0) prRecs[ex.n!] = Math.max(prRecs[ex.n!] ?? 0, w);
            });
          });
      }
      arr.filter(e => e.k === 'lift' && e.n && e.sets).forEach(ex => {
        normalizeSets(ex).forEach(s => {
          const w = parseFloat(String(s.w ?? '0')) || 0;
          if (w > 0) prRecs[ex.n!] = Math.max(prRecs[ex.n!] ?? 0, w);
        });
      });
      const curr = prBaselineRef.current ?? {};
      const prChanged = Object.keys({ ...curr, ...prRecs }).some(
        k => (curr[k] ?? 0) !== (prRecs[k] ?? 0)
      );
      if (prChanged) {
        const oldPRs = prBaselineRef.current ?? {};
        prBaselineRef.current = prRecs;
        localStorage.setItem(LIFT_PRS_KEY, JSON.stringify(prRecs));

        const { earned, revokedSlugs } = diffLiftBadges(oldPRs, prRecs);
        // Clear revoked slugs so re-earning them later shows the popup again.
        for (const slug of revokedSlugs) unmarkShown(slug);
        if (earned.length > 0) {
          setEarnedBadges(prev => [...prev, ...earned]);
          navigator.vibrate?.([0, 60, 80, 120, 80, 60]);
          for (const b of earned) markShown(b.slug);
        }

        // Still push to server so badges are persisted in the DB.
        pushNow({ settings: gatherSettings() });
      }

      setSaveFlash(true);
      if (notesFlashRef.current) clearTimeout(notesFlashRef.current);
      notesFlashRef.current = setTimeout(() => setSaveFlash(false), 2000);
    },
    [activeDayFocus, notes, updateDayRecord, profile]
  );
  const setExercises = useCallback((arr: ExerciseEntry[]) => {
    setExercisesRaw(arr); persistExercises(arr);
  }, [persistExercises]);

  useEffect(() => {
    const rec    = localDB[activeDayFocus] ?? {};
    const loaded = parseEx(rec.exercises ?? '');
    setExercisesRaw(loaded);
    exerciseKeysRef.current = loaded.map(() => nextKey());
    setNotesRaw(rec.notes ?? '');
    // Seed lastOwnWriteRef so the external-change detector has a baseline.
    lastOwnWriteRef.current = rec.exercises ?? '';
    const dow = new Date(activeDayFocus + 'T00:00:00').getDay();
    const all = getWorkoutPresets();
    const match = all.find(p => p.isRecurring && p.daysOfWeek.includes(dow));
    const hasLifts = parseEx(rec.exercises ?? '').some(e => e.k === 'lift');
    setRecurringPreset(match && !hasLifts ? match : null);
  }, [activeDayFocus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Detects edits made by TodaysWorkoutSummary (or any external source) and
  // reloads exercises state so WorkoutLogger doesn't overwrite them on next save.
  useEffect(() => {
    if (lastOwnWriteRef.current === null) return; // not yet initialized
    const raw = (localDB[activeDayFocus] as DayRecord | undefined)?.exercises ?? '';
    if (raw === lastOwnWriteRef.current) return; // our own write — skip
    // External change detected — reload and update baseline.
    const loaded = parseEx(raw);
    setExercisesRaw(loaded);
    exerciseKeysRef.current = loaded.map((_, i) => exerciseKeysRef.current[i] ?? nextKey());
    lastOwnWriteRef.current = raw;
    try { prBaselineRef.current = JSON.parse(localStorage.getItem(LIFT_PRS_KEY) ?? '{}'); }
    catch { prBaselineRef.current = {}; }
  }, [localDB]); // eslint-disable-line react-hooks/exhaustive-deps

  const lifts = useMemo<NormalizedLift[]>(() =>
    exercises
      .map((e, i) => ({ ...e, sets: normalizeSets(e), _idx: i, _key: exerciseKeysRef.current[i] ?? `fallback-${i}` }))
      .filter(e => e.k === 'lift' || e.k === 'text') as NormalizedLift[],
    [exercises]
  );
  const cardios = useMemo<CardioItem[]>(() =>
    exercises.map((e, i) => ({ ...e, _idx: i }))
      .filter(e => ['run','bike','swim'].includes(e.k)) as CardioItem[],
    [exercises]
  );

  const exerciseOptions = useMemo(() => {
    const grp = currentGroup as keyof typeof PRESETS;
    const presets = PRESETS[grp] ?? [];

    // Candidate names for this group = built-in presets + the user's saved
    // custom exercises + ANYTHING they've logged here (usage). Including usage
    // names is the bulletproof guarantee behind "if I logged it, it stays in the
    // list": `bumpUsage` runs on every commit and `queExerciseUsage` is a small,
    // long-synced store, so a name survives even if the richer custom-exercise
    // write (which also stores muscles) didn't persist for some reason.
    const usage       = isLoaded ? (getUsage()[currentGroup] ?? {}) : {};
    const customNames = isLoaded ? Object.keys(getCustomExercises()[currentGroup] ?? {}) : [];
    const usageNames  = Object.keys(usage);
    const known       = Array.from(new Set([...presets, ...customNames, ...usageNames]));

    // Most-recent logged date per exercise for THIS group — the workout log is
    // the source of truth for "recently done", so the dropdown can lead with it.
    const lastDone: Record<string, string> = {};
    for (const [date, rec] of Object.entries(localDB)) {
      const raw = (rec as { exercises?: string }).exercises;
      if (!raw) continue;
      let exs: unknown;
      try { exs = JSON.parse(String(raw)); } catch { continue; }
      if (!Array.isArray(exs)) continue;
      for (const ex of exs) {
        const e = ex as { k?: string; g?: string; n?: string };
        if (e.k !== 'lift' || e.g !== currentGroup || !e.n) continue;
        if (!lastDone[e.n] || date > lastDone[e.n]) lastDone[e.n] = date;
      }
    }

    // Order: exercises you've actually done, MOST RECENT first (usage frequency
    // breaks same-day ties); then everything else (presets / saved customs not
    // yet logged) in natural order.
    const done    = known.filter(n => lastDone[n]).sort((a, b) =>
      lastDone[a] !== lastDone[b]
        ? lastDone[b].localeCompare(lastDone[a])
        : (usage[b] ?? 0) - (usage[a] ?? 0));
    const notDone = known.filter(n => !lastDone[n]);
    const primary = [...done, ...notDone];

    // Secondary exercises — preset exercises from OTHER groups whose g2/g3 hits
    // this group. Skip any already surfaced in `primary` so they don't double up.
    const secondary: Array<{ n: string; fromGroup: string }> = [];
    (Object.keys(PRESETS) as Array<keyof typeof PRESETS>).forEach(g => {
      if (g === grp) return;
      PRESETS[g].forEach(name => {
        const m = SECONDARY_MUSCLES[name];
        if ((m?.g2 === currentGroup || m?.g3 === currentGroup) && !known.includes(name)) {
          secondary.push({ n: name, fromGroup: capitalize(String(g)) });
        }
      });
    });

    return { primary, secondary };
  }, [currentGroup, isLoaded, exListVersion, localDB]);

  useEffect(() => {
    setSelectedEx(exerciseOptions.primary[0] ?? '');
    setIsCustomEx(false); setCustomName(''); setCustomG2(''); setCustomG3('');
  }, [currentGroup]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cloud pull restores synced settings (usage + custom exercises) AFTER mount.
  // The picker memo won't otherwise recompute, so a custom exercise saved on
  // another device wouldn't appear until a group switch. Bump the version so the
  // freshly-restored names show up immediately.
  useEffect(() => {
    const onRestored = () => setExListVersion(v => v + 1);
    window.addEventListener('que-settings-restored', onRestored);
    return () => window.removeEventListener('que-settings-restored', onRestored);
  }, []);

  // ── pill drag
  const onPillsMouseDown = useCallback((e: React.MouseEvent) => {
    const row = pillsRowRef.current; if (!row) return;
    dragState.current = { dragging: true, startX: e.pageX, scrollLeft: row.scrollLeft, moved: false };
    row.style.cursor = 'grabbing'; row.style.userSelect = 'none';
  }, []);
  const onPillsMouseMove = useCallback((e: React.MouseEvent) => {
    const row = pillsRowRef.current; if (!row || !dragState.current.dragging) return;
    const dx = e.pageX - dragState.current.startX;
    if (Math.abs(dx) > 3) dragState.current.moved = true;
    if (dragState.current.moved) row.scrollLeft = dragState.current.scrollLeft - dx;
  }, []);
  const onPillsMouseUp = useCallback(() => {
    const row = pillsRowRef.current; if (!row) return;
    dragState.current.dragging = false;
    row.style.cursor = 'grab'; row.style.userSelect = '';
  }, []);
  const onPillsWheel = useCallback((e: React.WheelEvent) => {
    const row = pillsRowRef.current; if (!row) return;
    e.preventDefault();
    row.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
  }, []);
  const handlePillClick = useCallback((g: string, e: React.MouseEvent) => {
    if (dragState.current.moved) { e.stopPropagation(); dragState.current.moved = false; return; }
    setCurrentGroup(g);
    const pill = pillsRowRef.current?.querySelector(`[data-group="${g}"]`) as HTMLElement | null;
    pill?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [setCurrentGroup]);

  // ── sets form
  const adjustSets = useCallback((delta: number) => {
    setPendingSetsCount(prev => {
      const next = Math.max(1, Math.min(20, prev + delta));
      setPendingSetData(d => {
        const copy = [...d];
        while (copy.length < next) copy.push({ r: '1', w: '' });
        copy.length = next;
        return copy;
      });
      return next;
    });
  }, [setPendingSetsCount, setPendingSetData]);

  const updatePendingSet = useCallback((i: number, field: 'r' | 'w', val: string) => {
    setPendingSetData(prev => { const next = [...prev]; next[i] = { ...next[i], [field]: val }; return next; });
  }, [setPendingSetData]);

  const incrementAllWeights = useCallback((delta: number) => {
    setPendingSetData(prev => prev.map(s => {
      const w = parseFloat(s.w) || 0;
      const next = Math.max(0, w + delta);
      return { ...s, w: next % 1 === 0 ? String(next) : next.toFixed(1) };
    }));
  }, [setPendingSetData]);

  const handleRepsKeyDown = useCallback((e: React.KeyboardEvent, idx: number) => {
    if (e.key === 'Enter') { e.preventDefault(); weightRefs.current[idx]?.focus(); }
  }, []);

  // Outlier confirmation: if a set's weight is wildly higher than the user's
  // current PR for this exercise (typo signal — 135 vs 1350), require a
  // second click before logging. Reset when inputs change.
  const [outlierPending, setOutlierPending] = useState<{ name: string; weight: number; pr: number } | null>(null);

  // The floating rest bar now lives in a global context (lib/RestTimerContext)
  // so it follows the user across tabs and survives an app restart. WorkoutLogger
  // just starts it on commit and provides the set-appender for the active day.
  const { startRest, registerLogSetHandler, canReopen, reopen } = useRestTimer();
  const u = useUnits();

  // Quick-log a set from the rest bar straight into the exercise the timer
  // belongs to (matched by stable key). Reuses setExercises so persistence +
  // PR recompute + badge popups all fire; the context restarts the rest clock.
  const logRestSet = useCallback((exKey: string, reps: string, weight: string) => {
    const idx = exerciseKeysRef.current.indexOf(exKey);
    if (idx < 0) return;
    setExercises(exercises.map((e, i) => {
      if (i !== idx || e.k !== 'lift') return e;
      const sets = Array.isArray(e.sets) && e.sets.length ? [...e.sets] : normalizeSets(e);
      sets.push({ r: reps || '1', w: weight });
      return { ...e, sets };
    }));
  }, [exercises, setExercises]);

  // Register the appender for the day we're showing, so the global bar's "Log
  // set" delegates here (full PR/badge logic) while we're mounted on this day.
  useEffect(() => {
    registerLogSetHandler(activeDayFocus, logRestSet);
    return () => registerLogSetHandler(activeDayFocus, null);
  }, [activeDayFocus, logRestSet, registerLogSetHandler]);

  const commitLift = useCallback(() => {
    const name = isCustomEx ? customName.trim() : selectedEx;
    if (!name || name === '__custom__') return;
    const snappedSets = pendingSetData.map((s, i) => ({
      r: repsRefs.current[i]?.value.trim()   || s.r || '1',
      w: weightRefs.current[i]?.value.trim() || s.w || '',
    }));

    // ── Outlier check ────────────────────────────────────────────────────────
    // 1.3× of existing PR is a generous ceiling — a legit PR jump is usually
    // under ~10%, so this only fires on suspected typos. We compare against
    // prBaselineRef so corrections within the same session don't double-warn.
    const maxWeight  = Math.max(0, ...snappedSets.map(s => parseFloat(s.w) || 0));
    const currentPR  = prBaselineRef.current?.[name] ?? 0;
    const isOutlier  = currentPR > 0 && maxWeight > currentPR * 1.3;
    if (isOutlier) {
      const matchesPending = outlierPending
        && outlierPending.name === name
        && outlierPending.weight === maxWeight;
      if (!matchesPending) {
        setOutlierPending({ name, weight: maxWeight, pr: currentPR });
        return;
      }
      trackEvent('lift_outlier_confirmed', { ratio: +(maxWeight / currentPR).toFixed(2) });
    }
    setOutlierPending(null);
    trackEvent('lift_logged', { sets: pendingSetsCount, hasWeight: maxWeight > 0 });
    bumpUsage(currentGroup, name);

    // Resolve the muscles this exercise trains. Custom: the user's explicit
    // selectors. Preset: the built-in map, falling back to a previously-saved
    // custom exercise of the same name so re-selecting it keeps its muscles.
    const muscles = isCustomEx
      ? { g2: customG2 || undefined, g3: customG3 || undefined }
      : (SECONDARY_MUSCLES[name] ?? getCustomExercises()[currentGroup]?.[name] ?? {});

    // Persist a custom exercise (name + the muscles it hits) so it stays in the
    // picker next time. Preset exercises already live in code. Push immediately
    // so it survives the next-day reload even if the debounced sync never fired
    // (e.g. the tab was closed within the 4 s debounce window).
    if (isCustomEx) {
      saveCustomExercise(currentGroup, name, { g2: customG2 || undefined, g3: customG3 || undefined });
      pushNow({ settings: gatherSettings() });
    }

    const entry: ExerciseEntry = {
      k: 'lift', g: currentGroup, n: name, sets: snappedSets,
      ...(muscles.g2 && { g2: muscles.g2 }),
      ...(muscles.g3 && { g3: muscles.g3 }),
    };
    const next = [...exercises, entry];
    exerciseKeysRef.current = [...exerciseKeysRef.current, nextKey()];
    setExercises(next);
    setPendingSetData(Array.from({ length: pendingSetsCount }, () => ({ r: '1', w: '' })));
    if (isCustomEx) {
      // Drop out of custom-input mode and select the exercise we just saved, so
      // the user actually SEES it persist into the picker (and can log it again
      // with one tap). Previously the form stayed on a blank custom input, which
      // made it look like the custom exercise hadn't been stored.
      setIsCustomEx(false);
      setSelectedEx(name);
      setCustomName(''); setCustomG2(''); setCustomG3('');
    }
    // Re-read usage + custom stores so the picker reflects this commit immediately.
    setExListVersion(v => v + 1);
    // Start the rest timer fresh each commit. Replacing any existing one means
    // "I just did another set, restart the clock" — the more useful behavior
    // than letting a stale timer expire mid-set. Carry the just-logged exercise's
    // key + last set so the bar can quick-log the next set into the right entry.
    const lastSet = snappedSets[snappedSets.length - 1] ?? { r: '1', w: '' };
    startRest({
      startMs:    Date.now(),
      durationMs: DEFAULT_REST_MS,
      date:       activeDayFocus,
      exIndex:    next.length - 1,
      exKey:      exerciseKeysRef.current[exerciseKeysRef.current.length - 1] ?? '',
      reps:       lastSet.r,
      weight:     lastSet.w,
    });
  }, [
    isCustomEx, customName, customG2, customG3, selectedEx, pendingSetData,
    currentGroup, exercises, pendingSetsCount, outlierPending, activeDayFocus,
    setPendingSetData, setExercises, startRest,
  ]);

  // Clear the pending outlier confirm whenever the exercise or any set value
  // changes — the user is reconsidering, don't trap them in a stale warning.
  useEffect(() => { setOutlierPending(null); }, [selectedEx, customName, pendingSetData]);

  const handleWeightKeyDown = useCallback((e: React.KeyboardEvent, idx: number) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (idx < pendingSetsCount - 1) repsRefs.current[idx + 1]?.focus();
    else commitLift();
  }, [pendingSetsCount, commitLift]);

  // Tracks the source of a successful pre-fill so the UI can show a
  // "Last session" hint instead of silently dropping values into the inputs.
  // Cleared whenever pre-fill finds nothing or the user picks a new exercise.
  const [prefillSource, setPrefillSource] = useState<{ date: string; topWeight: number; topReps: number } | null>(null);

  // Pre-fill sets from the most recent logged session for this exercise
  const prefillFromHistory = useCallback((name: string) => {
    if (!name) return;
    const days = Object.keys(localDB).sort().reverse().slice(0, 60); // newest 60 days
    for (const ds of days) {
      // Skip the currently-active day — we'd just re-fill from the in-progress
      // workout, defeating the purpose of "last session" guidance.
      if (ds === activeDayFocus) continue;
      const raw = localDB[ds]?.exercises;
      if (!raw) continue;
      try {
        const exs = parseEx(String(raw));
        const match = exs.find(e => e.k === 'lift' && e.n === name);
        if (match) {
          const raw = normalizeSets(match);
          if (raw.length > 0) {
            // The "Last Session" hint reflects what the user ACTUALLY did last
            // time (real reps), computed from the unmodified history.
            const topSet = raw.reduce((acc, s) => {
              const w = parseFloat(String(s.w)) || 0;
              return w > acc.w ? { w, r: parseInt(String(s.r)) || 0 } : acc;
            }, { w: 0, r: 0 });
            // Pre-fill the WEIGHTS from last session, but reset every rep count
            // to 1 on purpose: the user should consciously enter today's reps
            // rather than silently carrying stale numbers forward.
            const sets = raw.map(s => ({ r: '1', w: String(s.w || '') }));
            setPendingSetsCount(sets.length);
            setPendingSetData(sets);
            setPrefillSource({ date: ds, topWeight: topSet.w, topReps: topSet.r });
            return;
          }
        }
      } catch { /* skip corrupt records */ }
    }
    setPrefillSource(null);
  }, [localDB, activeDayFocus, setPendingSetsCount, setPendingSetData]);

  /** "Today" / "Yesterday" / "3 days ago" / "Jan 15" for a YYYY-MM-DD date.
   *  Used by the Last Session hint so the user sees how stale the pre-fill is. */
  const fmtRelative = useCallback((ds: string): string => {
    const target = new Date(ds + 'T00:00:00');
    const today  = new Date(activeDayFocus + 'T00:00:00');
    const diff   = Math.round((today.getTime() - target.getTime()) / 86400000);
    if (diff === 0) return 'today';
    if (diff === 1) return 'yesterday';
    if (diff > 1 && diff <= 7) return `${diff} days ago`;
    return target.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }, [activeDayFocus]);

  // Trigger pre-fill when the dropdown selection changes
  useEffect(() => {
    if (!isCustomEx && selectedEx && selectedEx !== '__custom__') {
      prefillFromHistory(selectedEx);
    }
  }, [selectedEx, isCustomEx]); // eslint-disable-line react-hooks/exhaustive-deps

  // Trigger pre-fill for custom names when an exact history match exists
  useEffect(() => {
    if (isCustomEx && customName.trim().length > 1) {
      prefillFromHistory(customName.trim());
    }
  }, [customName, isCustomEx]); // eslint-disable-line react-hooks/exhaustive-deps

  const addCardioEntry = useCallback((kind: CardioKind) => {
    exerciseKeysRef.current = [...exerciseKeysRef.current, nextKey()];
    setExercisesRaw([...exercises, { k: kind, v1: '', v2: '', note: '' }]);
  }, [exercises, nextKey]);

  const deleteEntry = useCallback((idx: number) => {
    const entry = exercises[idx];
    if (!entry) return;
    const key = exerciseKeysRef.current[idx] ?? `del-${Date.now()}`;

    // Optimistically remove from list immediately
    exerciseKeysRef.current = exerciseKeysRef.current.filter((_, i) => i !== idx);
    setExercises(exercises.filter((_, i) => i !== idx));

    // Cancel any previous pending-delete timer
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    setPendingDelete({ entry, key });

    // After 5 s with no undo, the deletion is already persisted (setExercises calls persistExercises)
    deleteTimerRef.current = setTimeout(() => setPendingDelete(null), 5000);
  }, [exercises, setExercises]);

  const undoDelete = useCallback(() => {
    if (!pendingDelete) return;
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    exerciseKeysRef.current = [...exerciseKeysRef.current, pendingDelete.key];
    setExercises([...exercises, pendingDelete.entry]);
    setPendingDelete(null);
  }, [pendingDelete, exercises, setExercises]);

  const updateCardioField = useCallback(
    (idx: number, field: 'v1' | 'v2' | 'note', val: string) => {
      setExercisesRaw(exercises.map((e, i) => i === idx ? { ...e, [field]: val } : e));
    },
    [exercises]
  );

  const updateExerciseName = useCallback((idx: number, name: string) => {
    setExercisesRaw(exercises.map((e, i) => i === idx ? { ...e, n: name } : e));
  }, [exercises]);

  const updateExerciseSets = useCallback((idx: number, sets: Array<{ r: string; w: string }>) => {
    setExercises(exercises.map((e, i) => i === idx ? { ...e, sets } : e));
  }, [exercises, setExercises]);

  const clearWorkout = useCallback(() => {
    exerciseKeysRef.current = [];
    setExercisesRaw([]); setNotesRaw('');
    updateDayRecord(activeDayFocus, {
      exercises: '', notes: '', steps: 0,
      runDist: 0, runTime: 0, bikeDist: 0, bikeTime: 0, swimTime: 0, swimDist: 0, burn: 0,
    });
  }, [activeDayFocus, updateDayRecord]);

  const handleLiftReorder = useCallback((reorderedLifts: NormalizedLift[]) => {
    const cardios    = exercises.filter(e => ['run','bike','swim'].includes(e.k));
    const cardioKeys = exercises
      .map((e, i) => (['run','bike','swim'].includes(e.k) ? exerciseKeysRef.current[i] ?? nextKey() : null))
      .filter(Boolean) as string[];
    const liftEntries: ExerciseEntry[] = reorderedLifts.map(({ _idx, _key, ...rest }) => rest as ExerciseEntry);
    const liftKeys = reorderedLifts.map(l => l._key);
    exerciseKeysRef.current = [...liftKeys, ...cardioKeys];
    setExercisesRaw([...liftEntries, ...cardios]);
  }, [exercises, nextKey]);

  const logWorkout = useCallback(() => {
    persistExercises(exercises, notes);
    setLoggedFlash(true);
    setTimeout(() => setLoggedFlash(false), 2200);
  }, [exercises, notes, persistExercises]);

  const loadPreset = useCallback((preset: WorkoutPreset, replace: boolean) => {
    const incoming = parseEx(preset.exercises);
    const next     = replace ? incoming : [...exercises, ...incoming];
    const inKeys   = incoming.map(() => nextKey());
    exerciseKeysRef.current = replace
      ? inKeys
      : [...exerciseKeysRef.current, ...inKeys];
    setExercises(next);
  }, [exercises, setExercises, nextKey]);

  const [presets, setPresets] = useState<WorkoutPreset[]>([]);
  useEffect(() => {
    if (templateModal) setPresets(getWorkoutPresets());
  }, [templateModal]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── PR detection ────────────────────────────────────────────────────────────
  // queLiftPRs (localStorage) = all-time max per exercise, recomputed from the
  //   full localDB on every persistExercises call. Can go UP or DOWN.
  // prBaselineRef = last computed value, used for the inline badge icon.
  // sessionMaxRef = highest weight entered THIS session per exercise.
  //   Persists across delete-and-re-add so a re-added lower weight doesn't
  //   clear the "PR" indicator for the current session.

  // Always-current ref so persistExercises (a stale closure) sees latest localDB.
  const localDBRef = useRef(localDB);
  localDBRef.current = localDB;

  // Tracks the last raw exercises string WorkoutLogger itself wrote to localDB.
  // Used to distinguish our own writes from external changes (e.g. TodaysWorkoutSummary).
  const lastOwnWriteRef = useRef<string | null>(null);

  const prBaselineRef = useRef<Record<string, number> | null>(null);
  if (!prBaselineRef.current) {
    try { prBaselineRef.current = JSON.parse(localStorage.getItem(LIFT_PRS_KEY) ?? '{}'); }
    catch { prBaselineRef.current = {}; }
  }
  const sessionMaxRef = useRef<Record<string, number>>({});

  useEffect(() => {
    sessionMaxRef.current = {};
  }, [activeDayFocus]);

  const prLiftNames = useMemo((): Set<string> => {
    const baseline = prBaselineRef.current ?? {};
    const session  = sessionMaxRef.current;
    const prs      = new Set<string>();

    lifts.forEach(ex => {
      if (!ex.n || !ex.sets) return;
      const trueMax = Math.max(baseline[ex.n!] ?? 0, session[ex.n!] ?? 0);
      let exMax = 0;
      ex.sets.forEach(s => {
        const w = parseFloat(s.w ?? '0') || 0;
        if (w > 0 && w >= trueMax) prs.add(ex.n!);
        if (w > exMax) exMax = w;
      });
      // Update session memory so a lower re-entry won't show PR
      if (exMax > (session[ex.n!] ?? 0)) session[ex.n!] = exMax;
    });
    return prs;
  }, [lifts]);

  // Haptic feedback when a new PR is first detected this session
  const prevPRRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const newPRs = [...prLiftNames].filter(n => !prevPRRef.current.has(n));
    if (newPRs.length > 0) navigator.vibrate?.([30, 20, 60, 20, 30]);
    prevPRRef.current = new Set(prLiftNames);
  }, [prLiftNames]);

  // ── Run badges ───────────────────────────────────────────────────────────────
  // historicalMaxRunDist: highest single-day run total on any day OTHER than today.
  // historicalTotalRunDist: lifetime cumulative run miles excluding today.
  const { historicalMaxRunDist, historicalTotalRunDist } = useMemo(() => {
    let max = 0, total = 0;
    for (const [date, rec] of Object.entries(localDB)) {
      if (date === activeDayFocus) continue;
      const d = parseFloat(String(rec.runDist ?? '0')) || 0;
      if (d > max) max = d;
      total += d;
    }
    return { historicalMaxRunDist: max, historicalTotalRunDist: total };
  }, [localDB, activeDayFocus]);

  // Total run distance entered in today's session (live, sums all run entries).
  const todayRunDist = useMemo(
    () => cardios.filter(e => e.k === 'run').reduce((s, e) => s + (parseFloat(e.v1 ?? '0') || 0), 0),
    [cardios],
  );

  // Badge for highest single-session milestone crossed for the first time today.
  const runFirstBadgeIcon = useMemo((): string | null => {
    for (const { threshold, icon } of RUN_MILESTONES) {
      if (todayRunDist >= threshold && historicalMaxRunDist < threshold) return icon;
    }
    return null;
  }, [todayRunDist, historicalMaxRunDist]);

  // Badge for crossing 50 lifetime miles for the first time this session.
  const runTotalBadgeIcon = useMemo((): string | null => {
    const lifetimeTotal = historicalTotalRunDist + todayRunDist;
    if (lifetimeTotal >= 50 && historicalTotalRunDist < 50) return '/Badges/Running_total_run_badge.png';
    return null;
  }, [todayRunDist, historicalTotalRunDist]);

  const runMilesLabel = useMemo((): string | null => {
    if (!runTotalBadgeIcon) return null;
    return u.fmtDistance(historicalTotalRunDist + todayRunDist);
  }, [runTotalBadgeIcon, historicalTotalRunDist, todayRunDist, u]);

  // Haptic pulse when any new run badge is first crossed this session.
  const prevRunBadgeRef = useRef<string | null>(null);
  useEffect(() => {
    const active = runFirstBadgeIcon ?? runTotalBadgeIcon;
    if (active && active !== prevRunBadgeRef.current) {
      navigator.vibrate?.([30, 20, 60, 20, 30]);
      pushNow({ settings: gatherSettings() });
    }
    prevRunBadgeRef.current = active;
  }, [runFirstBadgeIcon, runTotalBadgeIcon]);

  // ── Double PR Day badge ──────────────────────────────────────────────────────
  const prevPrBothRef = useRef(false);
  // Reset tracking when the focused day changes; initialise from stored flag.
  useEffect(() => {
    prevPrBothRef.current = !!(localDB[activeDayFocus] as { prBothDay?: boolean } | undefined)?.prBothDay;
  }, [activeDayFocus]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (prLiftNames.size === 0) return;
    if (todayRunDist === 0 || todayRunDist <= historicalMaxRunDist) return;
    if (prevPrBothRef.current) return;
    if (optimisticallyShownRef.current.has('pr_both')) return;

    prevPrBothRef.current = true;
    markShown('pr_both');
    setEarnedBadges(prev => [...prev, {
      slug: 'pr_both', label: 'Double PR Day', icon: '/Badges/PR_both_lift_and_cardio.png', category: 'lift',
    }]);
    navigator.vibrate?.([0, 60, 80, 120, 80, 60]);
    updateDayRecord(activeDayFocus, { prBothDay: true });
    pushNow({ settings: gatherSettings() });
  }, [prLiftNames, todayRunDist, historicalMaxRunDist]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Bike badges ──────────────────────────────────────────────────────────────
  const { historicalMaxBikeDist, historicalTotalBikeDist } = useMemo(() => {
    let max = 0, total = 0;
    for (const [date, rec] of Object.entries(localDB)) {
      if (date === activeDayFocus) continue;
      const d = parseFloat(String(rec.bikeDist ?? '0')) || 0;
      if (d > max) max = d;
      total += d;
    }
    return { historicalMaxBikeDist: max, historicalTotalBikeDist: total };
  }, [localDB, activeDayFocus]);

  const todayBikeDist = useMemo(
    () => cardios.filter(e => e.k === 'bike').reduce((s, e) => s + (parseFloat(e.v1 ?? '0') || 0), 0),
    [cardios],
  );

  const bikeBadgeIcon = useMemo((): string | null => {
    const lifetimeTotal = historicalTotalBikeDist + todayBikeDist;
    if (lifetimeTotal >= 1000 && historicalTotalBikeDist < 1000) return '/Badges/1000_miles_biked_badge.png';
    if (lifetimeTotal >= 50  && historicalTotalBikeDist < 50)   return '/Badges/Running_total_bike_badge.png';
    if (todayBikeDist >= 0.1 && historicalMaxBikeDist < 0.1)    return '/Badges/First_bike_badge.png';
    return null;
  }, [todayBikeDist, historicalMaxBikeDist, historicalTotalBikeDist]);

  const bikeMilesLabel = useMemo((): string | null => {
    if (bikeBadgeIcon !== '/Badges/Running_total_bike_badge.png') return null;
    return u.fmtDistance(historicalTotalBikeDist + todayBikeDist);
  }, [bikeBadgeIcon, historicalTotalBikeDist, todayBikeDist, u]);

  const prevBikeBadgeRef = useRef<string | null>(null);
  useEffect(() => {
    if (bikeBadgeIcon && bikeBadgeIcon !== prevBikeBadgeRef.current) {
      navigator.vibrate?.([30, 20, 60, 20, 30]);
      pushNow({ settings: gatherSettings() });
    }
    prevBikeBadgeRef.current = bikeBadgeIcon;
  }, [bikeBadgeIcon]);

  // ── Swim badges ───────────────────────────────────────────────────────────────
  const { historicalMaxSwimTime, historicalTotalSwimDist } = useMemo(() => {
    let maxTime = 0, totalDist = 0;
    for (const [date, rec] of Object.entries(localDB)) {
      if (date === activeDayFocus) continue;
      const t = parseFloat(String(rec.swimTime ?? '0')) || 0;
      const d = parseFloat(String(rec.swimDist ?? '0')) || 0;
      if (t > maxTime) maxTime = t;
      totalDist += d;
    }
    return { historicalMaxSwimTime: maxTime, historicalTotalSwimDist: totalDist };
  }, [localDB, activeDayFocus]);

  const todaySwimTime = useMemo(
    () => cardios.filter(e => e.k === 'swim').reduce((s, e) => s + (parseFloat(e.v1 ?? '0') || 0), 0),
    [cardios],
  );
  const todaySwimDist = useMemo(
    () => cardios.filter(e => e.k === 'swim').reduce((s, e) => s + (parseFloat(e.v2 ?? '0') || 0), 0),
    [cardios],
  );

  const swimFirstBadgeIcon = useMemo((): string | null => {
    if (todaySwimTime > 0 && historicalMaxSwimTime === 0) return '/Badges/First_swim_badge.png';
    return null;
  }, [todaySwimTime, historicalMaxSwimTime]);

  const swimTotalBadgeIcon = useMemo((): string | null => {
    const lifetimeTotal = historicalTotalSwimDist + todaySwimDist;
    if (lifetimeTotal >= 15 && historicalTotalSwimDist < 15) return '/Badges/Running_total_swim_badge.png';
    return null;
  }, [todaySwimDist, historicalTotalSwimDist]);

  const swimMilesLabel = useMemo((): string | null => {
    if (!swimTotalBadgeIcon) return null;
    return u.fmtDistance(historicalTotalSwimDist + todaySwimDist);
  }, [swimTotalBadgeIcon, historicalTotalSwimDist, todaySwimDist, u]);

  const prevSwimBadgeRef = useRef<string | null>(null);
  useEffect(() => {
    const active = swimFirstBadgeIcon ?? swimTotalBadgeIcon;
    if (active && active !== prevSwimBadgeRef.current) {
      navigator.vibrate?.([30, 20, 60, 20, 30]);
      pushNow({ settings: gatherSettings() });
    }
    prevSwimBadgeRef.current = active;
  }, [swimFirstBadgeIcon, swimTotalBadgeIcon]);

  // ── Triathlete badge (bike + run + swim same day) ─────────────────────────────
  const prevTriathleteRef = useRef(false);
  useEffect(() => {
    const rec = localDB[activeDayFocus] ?? {};
    prevTriathleteRef.current =
      parseFloat(String(rec.runDist  ?? '0')) > 0 &&
      parseFloat(String(rec.bikeDist ?? '0')) > 0 &&
      parseFloat(String(rec.swimTime ?? '0')) > 0;
  }, [activeDayFocus]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (todayRunDist === 0 || todayBikeDist === 0 || todaySwimTime === 0) return;
    if (prevTriathleteRef.current) return;
    if (optimisticallyShownRef.current.has('triathlete')) return;

    prevTriathleteRef.current = true;
    markShown('triathlete');
    setEarnedBadges(prev => [...prev, {
      slug: 'triathlete', label: 'Triathlete', icon: '/Badges/Triathlete_badge.png', category: 'cardio',
    }]);
    navigator.vibrate?.([0, 60, 80, 120, 80, 60]);
    pushNow({ settings: gatherSettings() });
  }, [todayRunDist, todayBikeDist, todaySwimTime]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 1,000 Calorie Burn badge ──────────────────────────────────────────────────
  const todayBurn = useMemo(
    () => parseFloat(String(localDB[activeDayFocus]?.burn ?? '0')) || 0,
    [localDB, activeDayFocus],
  );

  const historicalMaxBurn = useMemo(() => {
    let max = 0;
    for (const [date, rec] of Object.entries(localDB)) {
      if (date === activeDayFocus) continue;
      const b = parseFloat(String(rec.burn ?? '0')) || 0;
      if (b > max) max = b;
    }
    return max;
  }, [localDB, activeDayFocus]);

  const burnBadgeIcon = useMemo((): string | null => {
    if (todayBurn >= 1000 && historicalMaxBurn < 1000) return '/Badges/1000_calorie_burned_badge.png';
    return null;
  }, [todayBurn, historicalMaxBurn]);

  const burnCalLabel = useMemo((): string | null => {
    if (!burnBadgeIcon) return null;
    return `${Math.round(todayBurn)} kcal`;
  }, [burnBadgeIcon, todayBurn]);

  const prevBurnRef = useRef<number | null>(null);
  useEffect(() => {
    if (prevBurnRef.current === null) { prevBurnRef.current = todayBurn; return; }
    if (todayBurn >= 1000 && prevBurnRef.current < 1000 && historicalMaxBurn < 1000) {
      if (!optimisticallyShownRef.current.has('cal_1000')) {
        markShown('cal_1000');
        setEarnedBadges(prev => [...prev, {
          slug: 'cal_1000', label: '1,000 Cal Burn', icon: '/Badges/1000_calorie_burned_badge.png', category: 'cardio' as const,
        }]);
        navigator.vibrate?.([0, 60, 80, 120, 80, 60]);
        pushNow({ settings: gatherSettings() });
      }
    }
    prevBurnRef.current = todayBurn;
  }, [todayBurn]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Calorie eating badges (5k / 10k) ─────────────────────────────────────────
  const todayCalsEaten = useMemo(
    () => parseFloat(String(localDB[activeDayFocus]?.calsEaten ?? '0')) || 0,
    [localDB, activeDayFocus],
  );

  const historicalMaxCalsEaten = useMemo(() => {
    let max = 0;
    for (const [date, rec] of Object.entries(localDB)) {
      if (date === activeDayFocus) continue;
      const c = parseFloat(String(rec.calsEaten ?? '0')) || 0;
      if (c > max) max = c;
    }
    return max;
  }, [localDB, activeDayFocus]);

  const prevCalsEatenRef = useRef<number | null>(null);
  useEffect(() => {
    if (prevCalsEatenRef.current === null) { prevCalsEatenRef.current = todayCalsEaten; return; }
    for (const def of CAL_EAT_BADGES) {
      if (todayCalsEaten >= def.threshold && prevCalsEatenRef.current < def.threshold) {
        if (!optimisticallyShownRef.current.has(def.slug)) {
          markShown(def.slug);
          const maxEver = Math.max(todayCalsEaten, historicalMaxCalsEaten);
          setEarnedBadges(prev => [...prev, {
            slug:     def.slug,
            label:    `${def.threshold.toLocaleString()} Cal Day · ${Math.round(maxEver).toLocaleString()} kcal`,
            icon:     def.icon,
            category: 'nutrition' as const,
          }]);
          navigator.vibrate?.([0, 60, 80, 120, 80, 60]);
          pushNow({ settings: gatherSettings() });
        }
      }
    }
    prevCalsEatenRef.current = todayCalsEaten;
  }, [todayCalsEaten]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Million Pounds Lifted ─────────────────────────────────────────────────────
  // Scans full localDB to compute cumulative volume (reps × weight) per muscle group.
  const groupVolumeTotals = useMemo((): Record<string, number> => {
    const vol: Record<string, number> = {};
    for (const [, rec] of Object.entries(localDB)) {
      for (const ex of parseEx(String(rec.exercises ?? ''))) {
        if (ex.k !== 'lift' || !ex.g) continue;
        for (const s of normalizeSets(ex)) {
          vol[ex.g] = (vol[ex.g] ?? 0) + (parseFloat(s.r) || 0) * (parseFloat(s.w) || 0);
        }
      }
    }
    return vol;
  }, [localDB]);

  const millionGroups = useMemo(
    () => Object.entries(groupVolumeTotals).filter(([, v]) => v >= 1_000_000).map(([g]) => g),
    [groupVolumeTotals],
  );

  // Initialised from localStorage so popup only fires for NEW crossings.
  const knownMillionGroupsRef = useRef<Set<string>>((() => {
    try { return new Set(JSON.parse(localStorage.getItem(MILLION_GROUPS_KEY) ?? '[]') as string[]); }
    catch { return new Set<string>(); }
  })());

  useEffect(() => {
    if (millionGroups.length === 0) return;
    const newGroups = millionGroups.filter(g => !knownMillionGroupsRef.current.has(g));
    if (newGroups.length === 0) return;

    for (const g of newGroups) knownMillionGroupsRef.current.add(g);
    try { localStorage.setItem(MILLION_GROUPS_KEY, JSON.stringify([...knownMillionGroupsRef.current])); } catch { /* noop */ }

    markShown('million_lbs');
    setEarnedBadges(prev => [...prev, {
      slug:     'million_lbs',
      label:    `Million Lbs — ${newGroups.map(g => capitalize(g)).join(', ')}`,
      icon:     '/Badges/Million_pounds_lifted.png',
      category: 'lift' as const,
    }]);
    navigator.vibrate?.([0, 60, 80, 120, 80, 60]);
    pushNow({ settings: gatherSettings() });
  }, [millionGroups]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Workout streak badges (scholar 14d / master 30d / seer 50d) ──────────────
  const maxWorkoutStreak = useMemo((): number => {
    const days = Object.keys(localDB)
      .filter(d => String(localDB[d].exercises ?? '').length > 2)
      .sort();
    if (days.length === 0) return 0;
    let max = 1, cur = 1;
    for (let i = 1; i < days.length; i++) {
      const prev = new Date(days[i - 1] + 'T00:00:00Z');
      const curr = new Date(days[i]     + 'T00:00:00Z');
      const gap  = Math.round((curr.getTime() - prev.getTime()) / 86400000);
      if (gap === 1) { cur++; max = Math.max(max, cur); }
      else           { cur = 1; }
    }
    return max;
  }, [localDB]);

  const maxCombinedStreak = useMemo((): number => {
    // Plan-aware calorie goal (matches the coin + badge engines).
    const direction = (loadPlan()?.type ?? null) as PlanDirection;
    const days = Object.keys(localDB)
      .filter(d => {
        const rec   = localDB[d];
        const hasEx = String(rec.exercises ?? '').length > 2;
        return hasEx && isGoalDay(rec.calsEaten, rec.budget, dayMaintenanceFromRecord(rec), direction);
      })
      .sort();
    if (days.length === 0) return 0;
    let max = 1, cur = 1;
    for (let i = 1; i < days.length; i++) {
      const prev = new Date(days[i - 1] + 'T00:00:00Z');
      const curr = new Date(days[i]     + 'T00:00:00Z');
      const gap  = Math.round((curr.getTime() - prev.getTime()) / 86400000);
      if (gap === 1) { cur++; max = Math.max(max, cur); }
      else           { cur = 1; }
    }
    return max;
  }, [localDB]);

  const prevMaxWorkoutStreakRef = useRef<number | null>(null);
  useEffect(() => {
    if (prevMaxWorkoutStreakRef.current === null) {
      prevMaxWorkoutStreakRef.current = maxWorkoutStreak;
      return;
    }
    for (const def of STREAK_BADGES) {
      if (maxWorkoutStreak >= def.threshold && prevMaxWorkoutStreakRef.current < def.threshold) {
        if (!optimisticallyShownRef.current.has(def.slug)) {
          markShown(def.slug);
          setEarnedBadges(prev => [...prev, { slug: def.slug, label: def.label, icon: def.icon, category: 'nutrition' as const }]);
          navigator.vibrate?.([0, 60, 80, 120, 80, 60]);
          pushNow({ settings: gatherSettings() });
        }
      }
    }
    prevMaxWorkoutStreakRef.current = maxWorkoutStreak;
  }, [maxWorkoutStreak]); // eslint-disable-line react-hooks/exhaustive-deps

  const prevMaxCombinedStreakRef = useRef<number | null>(null);
  useEffect(() => {
    if (prevMaxCombinedStreakRef.current === null) {
      prevMaxCombinedStreakRef.current = maxCombinedStreak;
      return;
    }
    if (maxCombinedStreak >= 50 && prevMaxCombinedStreakRef.current < 50) {
      if (!optimisticallyShownRef.current.has('stoic')) {
        markShown('stoic');
        setEarnedBadges(prev => [...prev, {
          slug: 'stoic', label: 'Stoic', icon: '/Badges/stoic_badge.png', category: 'nutrition' as const,
        }]);
        navigator.vibrate?.([0, 60, 80, 120, 80, 60]);
        pushNow({ settings: gatherSettings() });
      }
    }
    prevMaxCombinedStreakRef.current = maxCombinedStreak;
  }, [maxCombinedStreak]); // eslint-disable-line react-hooks/exhaustive-deps

  // Server-confirmed badge popups (que-badge-earned) are handled by the
  // always-mounted <BadgeCelebration> host so they fire on any tab — not just
  // when this component is mounted. The optimistic on-tab popups below still
  // render here via setEarnedBadges; the shared queShownBadgePopups dedup set
  // keeps the host from re-showing anything already celebrated optimistically.

  const loadRecurringWorkout = useCallback((preset: WorkoutPreset) => {
    const newEntries = parseEx(preset.exercises);
    exerciseKeysRef.current = [...exerciseKeysRef.current, ...newEntries.map(() => nextKey())];
    setExercisesRaw([...exercises, ...newEntries]);
    setRecurringPreset(null);
  }, [exercises, nextKey]);

  const openSaveModal = useCallback(() => {
    const groups = [...new Set(lifts.map(e => e.g ?? 'other'))];
    const autoName = groups.map(capitalize).join(' + ') + ' Workout';
    setSwm({ name: autoName, isPreset: true, isRecurring: false, days: [], freq: 1 });
    setDupWarning(false);
    setSaveModal(true);
  }, [lifts]);

  const confirmSave = useCallback(() => {
    const baseName = swm.name.trim();
    if (!baseName || lifts.length === 0) return;

    const existing   = getWorkoutPresets();
    const currentEx  = JSON.stringify(lifts.map(({ _idx: _, ...e }) => e));

    // Block if the exact same exercises are already saved (content duplicate)
    if (existing.some(p => isSameWorkout(p.exercises, currentEx))) {
      setDupWarning(true);
      return;
    }
    setDupWarning(false);

    // If the name is taken (but exercises differ), auto-version: "Name v2", "Name v3", …
    let finalName = baseName;
    if (existing.some(p => p.name.toLowerCase() === baseName.toLowerCase())) {
      let v = 2;
      while (existing.some(p => p.name.toLowerCase() === `${baseName} v${v}`.toLowerCase())) {
        v++;
      }
      finalName = `${baseName} v${v}`;
    }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const preset: WorkoutPreset = {
      id, name: finalName,
      exercises:   currentEx,
      isRecurring: swm.isRecurring,
      daysOfWeek:  swm.isRecurring ? [...swm.days] : [],
      everyNWeeks: swm.freq,
      createdAt:   activeDayFocus,
    };
    saveWorkoutPresets([...existing, preset]);
    queueSync({});
    setSaveModal(false);
  }, [swm, lifts, activeDayFocus, getWorkoutPresets, saveWorkoutPresets]);

  const handleNotesChange = useCallback((val: string) => {
    setNotesRaw(val); persistExercises(exercises, val);
  }, [exercises, persistExercises]);

  // ── render
  const isTodayFocus = activeDayFocus === todayStr;
  const spotlight = useSpotlightBorder({ color: '79,195,247', size: 280, opacity: 0.45 });

  const today2   = new Date();
  const d        = new Date(activeDayFocus + 'T00:00:00');
  const todayMid = new Date(today2.getFullYear(), today2.getMonth(), today2.getDate());
  const diff     = Math.round((todayMid.getTime() - d.getTime()) / 86400000);
  const dayLabel = diff === 0 ? 'TODAY' : diff === 1 ? 'YESTERDAY'
    : `${['SUN','MON','TUE','WED','THU','FRI','SAT'][d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;

  return (
    <>
      <PresetModal
        open={templateModal} presets={presets}
        currentCount={exercises.length}
        onLoad={loadPreset} onClose={() => setTemplateModal(false)}
      />

      {/* The rest-timer bar itself is rendered globally by RestTimerProvider so
          it follows the user across tabs — see lib/RestTimerContext.tsx. */}

      {/* ── Clear session confirm ── */}
      <AnimatePresence>
        {confirmClear && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center px-5 backdrop-blur-sm"
            style={{ background: 'rgba(7,8,10,0.85)' }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={e => { if (e.target === e.currentTarget) setConfirmClear(false); }}
          >
            <motion.div
              className="w-full max-w-[320px] rounded-lg border border-[var(--line-2)] bg-[var(--bg-1)] p-5"
              initial={{ scale: 0.94, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.94, y: 12 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              style={{ boxShadow: '0 0 0 1px var(--line-2), 0 24px 48px rgba(0,0,0,0.55)' }}
            >
              <p className="font-display text-[20px] tracking-[1px] uppercase text-[var(--ink-0)] mb-1">
                Clear Session
              </p>
              <p className="font-mono text-[11px] text-[var(--ink-2)] tracking-[0.3px] leading-relaxed mb-5">
                This will remove all exercises and cardio logged for this day.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmClear(false)}
                  className="flex-1 que-btn-ghost"
                >
                  Cancel
                </button>
                <button
                  onClick={() => { setConfirmClear(false); clearWorkout(); }}
                  className="flex-1 py-2.5 rounded font-mono text-[11px] font-bold tracking-[1.5px] uppercase border border-[var(--danger)]/50 bg-[var(--danger-12)] text-[var(--danger)] hover:border-[var(--danger)] transition-all"
                >
                  Clear
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <SaveWorkoutModal
        open={saveModal} swm={swm} lifts={lifts}
        dupWarning={dupWarning}
        onClose={() => setSaveModal(false)}
        onSave={confirmSave}
        onChangeName={v => { setDupWarning(false); setSwm(s => ({ ...s, name: v })); }}
        onTogglePreset={() => setSwm(s => ({ ...s, isPreset: !s.isPreset }))}
        onToggleRecurring={() => setSwm(s => ({ ...s, isRecurring: !s.isRecurring }))}
        onToggleDay={dayNum =>
          setSwm(s => ({
            ...s,
            days: s.days.includes(dayNum)
              ? s.days.filter(d => d !== dayNum)
              : [...s.days, dayNum],
          }))
        }
        onSetFreq={n => setSwm(s => ({ ...s, freq: n }))}
      />

      {/* ── Workout Log Card ── */}
      <div
        ref={spotlight.ref}
        onMouseMove={spotlight.onMouseMove}
        onMouseLeave={spotlight.onMouseLeave}
        onTouchMove={spotlight.onTouchMove}
        onTouchEnd={spotlight.onTouchEnd}
        className="que-card que-card-accent"
      >
        {spotlight.Overlay}
        <div className="p-5">

          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <h2 className="que-section-label"><span className="dot" />WORKOUT LOG</h2>
              <span className={`flex items-center gap-1.5 font-mono text-[10px] font-bold tracking-[1.5px] uppercase text-[var(--positive)] transition-opacity duration-300 ${saveFlash ? 'opacity-100' : 'opacity-0'}`}>
                <Check size={11} /> Saved
              </span>
            </div>
            <div className="flex items-center gap-2.5">
              {/* Bring back the rest timer if it was dismissed/closed — only
                  shown for a window after the last logged exercise. */}
              {canReopen && (
                <button
                  onClick={reopen}
                  title="Show rest timer"
                  aria-label="Show rest timer"
                  className="flex items-center gap-1.5 h-8 px-2.5 rounded bg-[var(--accent-12)] border border-[var(--accent)]/40 text-[var(--accent)] hover:bg-[var(--accent)]/20 hover:border-[var(--accent)] transition-all font-mono text-[10px] font-bold tracking-[1.5px] uppercase"
                >
                  <Timer size={13} /> Rest
                </button>
              )}
              <span className="font-mono text-[10px] font-bold tracking-[1.5px] text-[var(--accent)] bg-[var(--accent-12)] border border-[var(--accent)] rounded-sm px-3 py-1">
                {dayLabel}
              </span>
              <button
                onClick={() => setConfirmClear(true)}
                title="Clear this day's workout"
                className="w-8 h-8 flex items-center justify-center rounded bg-[var(--danger-12)] border border-[var(--danger)]/30 text-[var(--danger)] hover:bg-[var(--danger)]/20 hover:border-[var(--danger)] transition-all"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>

          {/* Template loader */}
          <button
            onClick={() => setTemplateModal(true)}
            className="w-full flex items-center justify-center gap-2.5 mb-5 px-4 py-3 rounded border border-dashed border-[var(--line-2)] bg-[var(--bg-2)] font-mono text-[11px] font-bold tracking-[2px] uppercase text-[var(--ink-1)] hover:bg-[var(--bg-3)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-all"
          >
            <Layers size={14} /> Load Preset
          </button>

          {/* ── SECTION TABS ── */}
          <div className="flex mb-5 border-b border-[var(--line)]">
            {(['lifting', 'cardio'] as const).map(sec => {
              const count = sec === 'lifting' ? lifts.length : cardios.length;
              const active = activeSection === sec;
              return (
                <button
                  key={sec}
                  onClick={() => setActiveSection(sec)}
                  className={[
                    'flex-1 flex items-center justify-center gap-2 py-2.5 font-mono text-[10px] font-bold tracking-[2px] uppercase transition-colors relative',
                    active ? 'text-[var(--accent)]' : 'text-[var(--ink-3)] hover:text-[var(--ink-1)]',
                  ].join(' ')}
                >
                  {sec}
                  {count > 0 && (
                    <span className={[
                      'font-mono text-[9px] font-bold px-1.5 py-0.5 rounded-sm',
                      active
                        ? 'bg-[var(--accent)] text-[var(--accent-ink)]'
                        : 'bg-[var(--bg-3)] text-[var(--ink-2)]',
                    ].join(' ')}>
                      {count}
                    </span>
                  )}
                  {active && (
                    <span
                      className="absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--accent)] rounded-t-sm"
                      style={{ boxShadow: '0 0 6px var(--accent-40)' }}
                    />
                  )}
                </button>
              );
            })}
          </div>

          {/* ── SECTION CONTENT ── */}
          <AnimatePresence mode="wait" initial={false}>
          {activeSection === 'lifting' && <motion.div
            key="lifting"
            initial={{ opacity: 0, x: -18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{    opacity: 0, x:  18 }}
            transition={{ duration: 0.22, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="mb-4"
          >

            {/* Pills */}
            <div className="relative mb-4">
              <span className="absolute right-0 top-0 bottom-0 w-12 bg-gradient-to-r from-transparent to-[var(--bg-1)] pointer-events-none z-10" />
              <div
                ref={pillsRowRef}
                className="flex gap-2 overflow-x-scroll pb-0.5 pr-12 scrollbar-none cursor-grab select-none"
                style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}
                onMouseDown={onPillsMouseDown}
                onMouseMove={onPillsMouseMove}
                onMouseUp={onPillsMouseUp}
                onMouseLeave={onPillsMouseUp}
                onWheel={onPillsWheel}
              >
                {MUSCLE_GROUPS.map(g => (
                  <button
                    key={g} data-group={g}
                    onClick={e => handlePillClick(g, e)}
                    data-active={currentGroup === g}
                    className="que-pill flex-shrink-0"
                  >
                    {g.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {/* Add Lift Form */}
            <div className="bg-[var(--bg-2)] border border-[var(--line)] rounded p-4 mb-3.5">
              <div className="mb-3">
                {isCustomEx ? (
                  <input
                    autoFocus type="text" className="que-input"
                    value={customName} placeholder="Type exercise name…"
                    onChange={e => setCustomName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); commitLift(); }
                      if (e.key === 'Escape') { e.preventDefault(); setIsCustomEx(false); setCustomName(''); }
                    }}
                  />
                ) : (
                  <div className="space-y-2">
                    {/* Search filter */}
                    <div className="relative">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ink-3)] pointer-events-none" aria-hidden>
                        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                      </svg>
                      <input
                        type="text" className="que-input pl-8"
                        placeholder="Search exercises…"
                        value={exSearch}
                        onChange={e => setExSearch(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Escape') setExSearch(''); }}
                      />
                      {exSearch && (
                        <button onClick={() => setExSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--ink-3)] hover:text-[var(--ink-0)] transition-colors">
                          <X size={12} />
                        </button>
                      )}
                    </div>
                    {/* Filtered select with primary + secondary grouping */}
                    <div className="relative">
                      {(() => {
                        const q = exSearch.toLowerCase();
                        const filteredPrimary   = exerciseOptions.primary.filter(n => !q || n.toLowerCase().includes(q));
                        const filteredSecondary = exerciseOptions.secondary.filter(({ n }) => !q || n.toLowerCase().includes(q));
                        const totalVisible      = filteredPrimary.length + filteredSecondary.length;
                        return (
                          <select
                            className="que-input pr-9 cursor-pointer"
                            value={selectedEx}
                            onChange={e => {
                              if (e.target.value === '__custom__') {
                                setIsCustomEx(true); setSelectedEx(''); setExSearch('');
                              } else { setSelectedEx(e.target.value); setExSearch(''); }
                            }}
                            size={exSearch ? Math.min(8, totalVisible + 1) : 1}
                          >
                            {filteredPrimary.map(n => <option key={n} value={n}>{n}</option>)}
                            {filteredSecondary.length > 0 && (
                              <optgroup label="── Also trains this muscle ──">
                                {filteredSecondary.map(({ n, fromGroup }) => (
                                  <option key={n} value={n}>{n} · {fromGroup}</option>
                                ))}
                              </optgroup>
                            )}
                            <option value="__custom__">+ Custom exercise…</option>
                          </select>
                        );
                      })()}
                      {!exSearch && <ChevronDown size={13} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--ink-2)] pointer-events-none" />}
                    </div>
                  </div>
                )}
                {isCustomEx && (
                  <div className="mt-2 space-y-2">
                    {/* Secondary + tertiary muscle selectors for custom exercises */}
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { label: 'Primary muscle', value: currentGroup, disabled: true },
                      ].map(f => (
                        <div key={f.label}>
                          <label className="que-label">{f.label}</label>
                          <select className="que-input cursor-not-allowed opacity-60" disabled value={f.value}>
                            <option value={f.value}>{capitalize(f.value)}</option>
                          </select>
                        </div>
                      ))}
                      <div>
                        <label className="que-label">Secondary <span className="font-normal text-[var(--ink-3)] normal-case">(opt)</span></label>
                        <select className="que-input cursor-pointer" value={customG2} onChange={e => setCustomG2(e.target.value)}>
                          <option value="">None</option>
                          {(Object.keys(PRESETS) as Array<keyof typeof PRESETS>).filter(g => g !== currentGroup).map(g => (
                            <option key={g} value={g}>{capitalize(String(g))}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="que-label">Tertiary <span className="font-normal text-[var(--ink-3)] normal-case">(opt)</span></label>
                        <select className="que-input cursor-pointer" value={customG3} onChange={e => setCustomG3(e.target.value)} disabled={!customG2}>
                          <option value="">None</option>
                          {(Object.keys(PRESETS) as Array<keyof typeof PRESETS>).filter(g => g !== currentGroup && g !== customG2).map(g => (
                            <option key={g} value={g}>{capitalize(String(g))}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <button
                      onClick={() => { setIsCustomEx(false); setCustomName(''); setCustomG2(''); setCustomG3(''); }}
                      className="font-mono text-[10px] text-[var(--ink-3)] hover:text-[var(--accent)] transition-colors tracking-[1px] uppercase"
                    >
                      ← back to presets
                    </button>
                  </div>
                )}
              </div>

              {/* Sets stepper */}
              <div className="flex items-center gap-3 mb-3">
                <span className="font-mono text-[10px] font-bold uppercase tracking-[2px] text-[var(--ink-2)]">SETS</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => adjustSets(-1)}
                    className="w-8 h-8 flex items-center justify-center rounded-sm border border-[var(--line-2)] bg-[var(--bg-1)] text-[var(--ink-0)] text-lg hover:border-[var(--accent)] hover:text-[var(--accent)] transition-all"
                  >−</button>
                  <span className="font-display tabular text-[22px] text-[var(--accent)] min-w-[28px] text-center leading-none">
                    {String(pendingSetsCount).padStart(2, '0')}
                  </span>
                  <button
                    onClick={() => adjustSets(1)}
                    className="w-8 h-8 flex items-center justify-center rounded-sm border border-[var(--line-2)] bg-[var(--bg-1)] text-[var(--ink-0)] text-lg hover:border-[var(--accent)] hover:text-[var(--accent)] transition-all"
                  >+</button>
                </div>
              </div>

              {/* "Last session" hint — visible whenever pre-fill loaded
                  values from a prior day's record. Makes the auto-fill
                  legible instead of magical, and the +Weight buttons below
                  give a 1-tap path to progressive overload. */}
              {prefillSource && prefillSource.topWeight > 0 && (
                <div className="mb-3 flex items-center gap-2 rounded border border-[var(--accent)]/30 bg-[var(--accent)]/8 px-3 py-2">
                  <span className="font-mono text-[8px] font-bold tracking-[1.5px] uppercase text-[var(--accent)]">
                    Last Session
                  </span>
                  <span className="font-mono text-[10px] text-[var(--ink-1)] tracking-[0.3px] flex-1">
                    Top set <strong className="text-[var(--ink-0)]">{prefillSource.topWeight} lb × {prefillSource.topReps}</strong>
                    {' · '}
                    <span className="text-[var(--ink-3)]">{fmtRelative(prefillSource.date)}</span>
                  </span>
                </div>
              )}

              {/* Set rows */}
              <div className="mb-3">
                <div className="grid grid-cols-[28px_1fr_1.6fr] gap-2 mb-2">
                  <span />
                  <span className="que-label !mb-0">Reps</span>
                  <span className="que-label !mb-0 flex items-center justify-between">
                    <span>Weight <span className="normal-case font-normal text-[var(--ink-3)]">(opt)</span></span>
                    {(() => {
                      // Epley 1RM estimator: 1RM = w × (1 + r/30).
                      // Most accurate in the 1–10 rep range. Shown only when
                      // at least one set has weight + reps. Picks the best
                      // (highest implied 1RM) of any set so multi-set entries
                      // don't drift on the warm-up.
                      let best = 0;
                      for (const s of pendingSetData) {
                        const w = parseFloat(s.w) || 0;
                        const r = parseInt(s.r) || 0;
                        if (w > 0 && r >= 1 && r <= 10) {
                          const e1rm = w * (1 + r / 30);
                          if (e1rm > best) best = e1rm;
                        }
                      }
                      if (best <= 0) return null;
                      return (
                        <span className="font-mono text-[8px] tracking-[1px] text-[var(--accent)] normal-case">
                          ≈ {Math.round(best)} lb 1RM
                        </span>
                      );
                    })()}
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <AnimatePresence initial={false}>
                    {pendingSetData.map((set, i) => (
                      <motion.div
                        key={i}
                        initial={{ opacity: 0, x: -12 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -12, height: 0, marginBottom: 0 }}
                        transition={{ duration: 0.16, delay: i * 0.03, ease: 'easeOut' }}
                        className="grid grid-cols-[28px_1fr_1.6fr] gap-2 items-center"
                      >
                        <span className="font-display tabular text-[16px] text-[var(--ink-3)] text-right leading-none">
                          {String(i + 1).padStart(2, '0')}
                        </span>
                        <input
                          ref={el => { repsRefs.current[i] = el; }}
                          type="number" min="1" inputMode="numeric"
                          value={set.r} placeholder="1"
                          className="que-input text-center font-display text-[18px] py-2 [appearance:textfield]"
                          style={{ MozAppearance: 'textfield' } as React.CSSProperties}
                          onChange={e => updatePendingSet(i, 'r', e.target.value)}
                          onFocus={e => e.target.select()}
                          onKeyDown={e => handleRepsKeyDown(e, i)}
                        />
                        <input
                          ref={el => { weightRefs.current[i] = el; }}
                          type="text" inputMode="decimal"
                          value={set.w} placeholder="e.g. 135 lbs"
                          className="que-input py-2 font-mono text-[14px] font-bold"
                          onChange={e => updatePendingSet(i, 'w', e.target.value)}
                          onFocus={e => e.target.select()}
                          onKeyDown={e => handleWeightKeyDown(e, i)}
                        />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </div>

              {/* Progressive overload nudge — only shown when sets have pre-filled weights */}
              {pendingSetData.some(s => !!s.w) && (
                <div className="flex items-center gap-2 mb-3">
                  <span className="font-mono text-[9px] text-[var(--ink-3)] tracking-[1px] uppercase flex-shrink-0">+Weight</span>
                  {[2.5, 5, 10].map(d => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => incrementAllWeights(d)}
                      className="flex-1 font-mono text-[10px] font-bold tracking-[1px] py-1.5 rounded-sm border border-[var(--line-2)] bg-[var(--bg-2)] text-[var(--ink-2)] hover:border-[var(--positive)] hover:text-[var(--positive)] transition-all"
                    >
                      +{d}
                    </button>
                  ))}
                </div>
              )}

              {outlierPending && (
                <div className="mb-2 rounded border border-[var(--warn)]/50 bg-[var(--warn)]/8 px-3 py-2">
                  <p className="font-mono text-[10px] text-[var(--warn)] tracking-[0.3px] leading-relaxed">
                    <strong>{outlierPending.weight} lb</strong> is {(outlierPending.weight / outlierPending.pr).toFixed(1)}× your best ({outlierPending.pr} lb).
                    Tap <strong>Log Exercise</strong> again to confirm — or edit the weight if it&apos;s a typo.
                  </p>
                </div>
              )}

              <button
                onClick={commitLift}
                className={outlierPending
                  ? 'que-btn-ghost w-full !border-[var(--warn)] !text-[var(--warn)]'
                  : 'que-btn-primary w-full'}
              >
                <Plus size={14} /> {outlierPending ? 'CONFIRM LOG' : 'LOG EXERCISE'}
              </button>
            </div>

            {/* Recurring banner */}
            {recurringPreset && (
              <div className="flex items-center justify-between gap-3 bg-[var(--accent-12)] border border-[var(--accent)] rounded px-4 py-3 mb-3">
                <p className="font-mono text-[11px] text-[var(--ink-1)] flex-1 tracking-[0.5px]">
                  <span className="text-[var(--accent)] font-bold uppercase tracking-[1.5px]">RECURRING ·</span>{' '}
                  <strong className="text-[var(--ink-0)]">{recurringPreset.name}</strong>
                </p>
                <button
                  onClick={() => loadRecurringWorkout(recurringPreset)}
                  className="flex-shrink-0 que-btn-primary !py-2 !px-4 !text-[10px]"
                >
                  LOAD
                </button>
              </div>
            )}

            {/* Logged list */}
            {lifts.length === 0 ? (
              <div className="text-center py-8 border border-dashed border-[var(--line-2)] rounded">
                <p className="font-mono text-[10px] tracking-[1px] text-[var(--ink-3)] uppercase">
                  No exercises · Pick a group, log sets &amp; hit commit
                </p>
              </div>
            ) : (
              <>
                <p className="font-mono text-[9px] text-[var(--ink-3)] tracking-[1px] uppercase mb-1 md:hidden">
                  Hold ≡ to reorder · Swipe right to delete
                </p>
                <Reorder.Group
                  as="div"
                  axis="y"
                  values={lifts}
                  onReorder={handleLiftReorder}
                  className="flex flex-col gap-2"
                >
                  {lifts.map((entry, numIdx) => {
                    const pr = entry.n ? (prBaselineRef.current?.[entry.n] ?? 0) : 0;
                    return (
                      <ReorderableExerciseItem
                        key={entry._key}
                        entry={entry}
                        numIdx={numIdx}
                        isPR={!!entry.n && prLiftNames.has(entry.n)}
                        earnedBadgeIcon={entry.n ? liftBadgeIcon(entry.n, pr) : null}
                        onDelete={deleteEntry}
                        onUpdateName={updateExerciseName}
                        onUpdateSets={updateExerciseSets}
                        onViewHistory={entry.n ? () => setHistoryEx(entry.n!) : undefined}
                      />
                    );
                  })}
                </Reorder.Group>
              </>
            )}

            {lifts.length > 0 && (
              <button
                onClick={openSaveModal}
                className="mt-3 w-full flex items-center justify-center gap-2 py-2.5 rounded border border-dashed border-[var(--line-2)] font-mono text-[10px] font-bold tracking-[2px] uppercase text-[var(--ink-2)] hover:border-[var(--accent)] hover:text-[var(--accent)] hover:bg-[var(--bg-2)] transition-all"
              >
                <Save size={13} /> Save as Preset
              </button>
            )}
          </motion.div>}

          {activeSection === 'cardio' && <motion.div
            key="cardio"
            initial={{ opacity: 0, x:  18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{    opacity: 0, x: -18 }}
            transition={{ duration: 0.22, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="mb-4"
          >
            {/* Add cardio buttons */}
            <div className="flex gap-2 mb-4">
              {(['swim','run','bike'] as CardioKind[]).map(kind => {
                const hasLogged = cardios.some(e => e.k === kind);
                return (
                  <button
                    key={kind}
                    onClick={() => addCardioEntry(kind)}
                    className="flex-1 flex flex-col items-center gap-1.5 font-mono text-[10px] font-bold tracking-[1.5px] uppercase py-3 rounded border border-[var(--line-2)] bg-[var(--bg-2)] hover:border-[var(--accent)] transition-all"
                    style={{ color: hasLogged ? 'var(--accent)' : 'var(--ink-2)' }}
                  >
                    <ActivityIcon kind={kind} active={hasLogged} size={22} />
                    + {kind}
                  </button>
                );
              })}
            </div>

            {cardios.length === 0 ? (
              <div className="text-center py-8 border border-dashed border-[var(--line-2)] rounded">
                <p className="font-mono text-[10px] tracking-[1px] text-[var(--ink-3)] uppercase">
                  Tap Swim, Run or Bike above to log cardio
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <AnimatePresence initial={false}>
                  {cardios.map((entry, cardioIdx) => (
                    <motion.div
                      key={entry._idx}
                      initial={{ opacity: 0, y: 10, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, x: -24, scale: 0.95 }}
                      transition={{ duration: 0.22, ease: 'easeOut' }}
                    >
                      <CardioEntryCard
                        entry={entry}
                        onDelete={deleteEntry}
                        onUpdateField={updateCardioField}
                        onCommit={() => persistExercises(exercises, notes)}
                        firstBadgeIcon={
                          entry.k === 'run'  ? (runFirstBadgeIcon ?? runTotalBadgeIcon) :
                          entry.k === 'bike' ? bikeBadgeIcon :
                          entry.k === 'swim' ? (swimFirstBadgeIcon ?? swimTotalBadgeIcon) :
                          null
                        }
                        badgeMilesLabel={
                          entry.k === 'run'  ? runMilesLabel :
                          entry.k === 'bike' ? bikeMilesLabel :
                          entry.k === 'swim' ? swimMilesLabel :
                          null
                        }
                        burnBadgeIcon={cardioIdx === 0 ? burnBadgeIcon : null}
                        burnCalLabel={cardioIdx === 0 ? burnCalLabel : null}
                      />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            )}
          </motion.div>}
          </AnimatePresence>

          {/* Notes */}
          <div className="mb-6">
            <label className="que-label">Session Notes</label>
            <textarea
              value={notes}
              onChange={e => handleNotesChange(e.target.value)}
              rows={2}
              placeholder="PRs hit, fatigue level, form cues…"
              className="que-input resize-y min-h-[72px] font-sans !text-[13px] tracking-normal"
            />
          </div>

          {/* Log Workout */}
          <button
            onClick={logWorkout}
            className={[
              'w-full py-4 rounded font-sans text-[12px] font-bold uppercase tracking-[3px] transition-all duration-200',
              loggedFlash
                ? 'bg-[var(--positive)] text-[var(--accent-ink)] que-flicker'
                : 'que-btn-primary',
            ].join(' ')}
          >
            {loggedFlash ? '✓ LOGGED' : 'COMMIT SESSION'}
          </button>

        </div>
      </div>

      <ExerciseHistoryModal
        name={historyEx}
        open={historyEx !== null}
        onClose={() => setHistoryEx(null)}
      />

      {/* Badge earned modal — centered, celebrate animation, haptic */}
      <AnimatePresence>
        {earnedBadges.length > 0 && (
          <motion.div
            className="fixed inset-0 z-[400] flex items-center justify-center px-6 pointer-events-none"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          >
            {/* Confetti burst behind card */}
            <Lottie
              animationData={celebrateAnim}
              loop={false}
              autoplay
              className="absolute inset-0 w-full h-full pointer-events-none"
            />

            {/* Card */}
            <motion.div
              className="relative w-full max-w-[320px] rounded-2xl overflow-hidden pointer-events-auto"
              initial={{ scale: 0.7, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.8, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 420, damping: 26 }}
              style={{ boxShadow: '0 0 0 1px rgba(79,195,247,0.5), 0 0 60px rgba(79,195,247,0.2), 0 24px 60px rgba(0,0,0,0.7)' }}
            >
              <div className="h-1.5" style={{ background: 'linear-gradient(90deg, #1a6fa8, #4fc3f7, #1a6fa8)' }} />
              <div className="bg-[var(--bg-1)] px-5 py-5">
                <div className="flex items-center justify-between mb-4">
                  <p className="font-mono text-[9px] font-bold tracking-[3px] uppercase" style={{ color: '#4fc3f7' }}>
                    Badge{earnedBadges.length > 1 ? 's' : ''} Unlocked
                  </p>
                  <button type="button" onClick={() => setEarnedBadges([])}
                    className="w-6 h-6 flex items-center justify-center rounded text-[var(--ink-3)] hover:text-[var(--ink-0)]">
                    <X size={14} />
                  </button>
                </div>
                <div className="flex flex-col gap-4">
                  {earnedBadges.map((b, i) => (
                    <div key={`${b.slug}-${i}`} className="flex items-center gap-4">
                      {b.icon.startsWith('/') ? (
                        <AutoCropImage src={b.icon} alt={b.label} className="w-14 h-14 object-contain flex-shrink-0" />
                      ) : (
                        <span className="text-[44px] leading-none flex-shrink-0">{b.icon}</span>
                      )}
                      <div>
                        <p className="font-display text-[18px] tracking-[1px] uppercase text-[var(--ink-0)]">{b.label}</p>
                        <p className="font-mono text-[9px] text-[var(--ink-3)] capitalize tracking-[1px] mt-0.5">{b.category} badge</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Undo delete snackbar */}
      <AnimatePresence>
        {pendingDelete && (
          <motion.div
            initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed bottom-[calc(env(safe-area-inset-bottom)+76px)] left-4 right-4 md:left-auto md:right-8 md:w-80 z-[350] flex items-center justify-between gap-3 rounded border border-[var(--line-2)] bg-[var(--bg-2)] px-4 py-3"
            style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.4)' }}
          >
            <span className="font-mono text-[10px] text-[var(--ink-1)] tracking-[0.5px] truncate">
              Deleted <strong className="text-[var(--ink-0)]">{pendingDelete.entry.n ?? pendingDelete.entry.k}</strong>
            </span>
            <button
              type="button"
              onClick={undoDelete}
              className="font-mono text-[10px] font-bold tracking-[1px] uppercase text-[var(--accent)] border border-[var(--accent)]/50 rounded-sm px-2.5 py-1 hover:bg-[var(--accent)] hover:text-[var(--accent-ink)] transition-all flex-shrink-0"
            >
              Undo
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
