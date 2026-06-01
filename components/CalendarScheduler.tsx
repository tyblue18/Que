'use client';

import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import { PRLiveBadge } from '@/components/ActivityIcon';
import { AutoCropImage } from '@/components/AutoCropImage';
import { ExerciseHistoryModal } from '@/components/ExerciseHistory';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Dumbbell,
  Flame,
  Plus,
  X,
} from 'lucide-react';
import { useSpotlightBorder } from '@/hooks/useSpotlightBorder';
import { GOAL_TOLERANCE, LIFT_PRS_KEY, LIFTING_PROGRAM_KEY } from '@/lib/constants';
import {
  useApp,
  MONTHS,
  type ViewMode,
  type DayRecord,
} from '@/lib/AppContext';
import { pushNow, gatherSettings } from '@/lib/syncEngine';
import type { LiftingProgram } from '@/lib/lifting/program';
import { weekAdjustedDays } from '@/lib/lifting/volume';
import { buildProgramDayEntries, loadLiftPRs } from '@/lib/lifting/loadDay';
import type { LoggedDay } from '@/lib/lifting/progression';
import { useUnits } from '@/lib/units';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────
interface CellData {
  dateStr: string; dayNum: number; label: string;
  isToday: boolean; isSelected: boolean; isPadding: boolean;
  hasLift: boolean; hasCardio: boolean;
  summary: string;
}
interface ParsedEntry {
  k: string; g?: string; g2?: string; g3?: string; n?: string;
  sets?: Array<{ r: string; w: string }>;
  s?: string; r?: string; w?: string;
  v1?: string; v2?: string; note?: string;
}

const DOW_ABBR  = ['SU','MO','TU','WE','TH','FR','SA'];
const DOW_SHORT = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseEx(raw: string): ParsedEntry[] {
  if (!raw) return [];
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; }
  catch { return raw.split('\n').filter(l => l.trim()).map(l => ({ k: 'text', n: l })); }
}
function normalizeSets(e: ParsedEntry): Array<{ r: string; w: string }> {
  if (e.sets && Array.isArray(e.sets)) return e.sets;
  const count = parseInt(String(e.s ?? '1')) || 1;
  return Array.from({ length: count }, () => ({ r: String(e.r ?? '1'), w: String(e.w ?? '') }));
}
function buildCellSummary(raw: string): string {
  if (!raw) return '';
  const arr = parseEx(raw);
  return arr.map(e => {
    if (e.k === 'lift') {
      const sets = normalizeSets(e);
      const n = sets.length;
      const r = sets[0]?.r ?? '';
      return `${e.n ?? ''}${n && r ? ` ${n}×${r}` : ''}`;
    }
    if (e.k === 'swim') return `Swim${e.v1 ? ` ${e.v1}min` : ''}`;
    if (e.k === 'run')  return `Run${e.v1 ? ` ${e.v1}mi` : ''}`;
    if (e.k === 'bike') return `Bike${e.v1 ? ` ${e.v1}mi` : ''}`;
    return e.n ?? '';
  }).filter(Boolean).join('\n');
}
function detectActivity(raw: string): { hasLift: boolean; hasCardio: boolean } {
  const arr = parseEx(raw);
  return {
    hasLift:   arr.some(e => e.k === 'lift' || e.k === 'text'),
    hasCardio: arr.some(e => e.k === 'run' || e.k === 'bike' || e.k === 'swim'),
  };
}
function navTitle(mode: ViewMode, d: Date): string {
  if (mode === 'month') return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  if (mode === 'week') {
    const sow = new Date(d); sow.setDate(d.getDate() - d.getDay());
    const eow = new Date(sow); eow.setDate(sow.getDate() + 6);
    const startLbl = `${MONTHS[sow.getMonth()].slice(0,3)} ${sow.getDate()}`;
    const endLbl = sow.getMonth() !== eow.getMonth()
      ? `${MONTHS[eow.getMonth()].slice(0,3)} ${eow.getDate()}` : String(eow.getDate());
    return `${startLbl} – ${endLbl}`;
  }
  const ord = (n: number) => {
    const v = n % 100; const s = ['th','st','nd','rd'];
    return s[(v-20)%10] ?? s[v] ?? s[0];
  };
  const n = d.getDate();
  return `${MONTHS[d.getMonth()]} ${n}${ord(n)}, ${d.getFullYear()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT — DayCell (month grid)
// ─────────────────────────────────────────────────────────────────────────────

function DayCell({
  cell, onClick, onClear,
}: {
  cell: CellData;
  onClick: (dateStr: string) => void;
  onClear: (dateStr: string) => void;
}) {
  if (cell.isPadding) {
    return <div className="min-h-[56px] lg:min-h-[96px] rounded bg-transparent" />;
  }
  const hasAny  = cell.hasLift || cell.hasCardio;
  const todayDs = toDateStr(new Date());
  const isRest  = !hasAny && !cell.isToday && cell.dateStr < todayDs;

  return (
    <div
      onClick={() => onClick(cell.dateStr)}
      className={[
        'group relative min-h-[56px] lg:min-h-[96px] rounded cursor-pointer p-2 lg:p-3',
        'border transition-all duration-200 flex flex-col gap-1 overflow-hidden',
        cell.isSelected
          ? 'border-[var(--accent)] bg-[var(--accent-12)]'
          : 'border-[var(--line)] bg-[var(--bg-2)] hover:border-[var(--line-2)] hover:bg-[var(--bg-3)]',
      ].join(' ')}
      style={cell.isSelected ? { boxShadow: '0 0 0 1px var(--accent), 0 0 18px var(--accent-12)' } : undefined}
    >
      {/* Day number — Anton condensed */}
      <span
        className={[
          'font-display leading-none tabular self-start',
          'text-[20px] lg:text-[26px]',
          cell.isToday ? 'text-[var(--accent)]' : cell.isSelected ? 'text-[var(--ink-0)]' : 'text-[var(--ink-2)]',
        ].join(' ')}
        style={cell.isToday ? { textShadow: '0 0 12px var(--accent-40)' } : undefined}
      >
        {String(cell.dayNum).padStart(2, '0')}
      </span>

      {/* Summary (desktop only) */}
      {cell.summary && (
        <p className="hidden lg:block text-[10px] text-[var(--ink-1)] leading-snug line-clamp-3 pl-2 border-l border-[var(--accent-24)]">
          {cell.summary}
        </p>
      )}

      {/* Activity ticks */}
      {hasAny && (
        <div className="flex items-center gap-1 mt-auto">
          {cell.hasLift && <span className="block w-2 h-[2px] bg-[var(--accent)]" />}
          {cell.hasCardio && <span className="block w-2 h-[2px] bg-[var(--ink-1)]" />}
        </div>
      )}

      {/* Rest day indicator */}
      {isRest && (
        <span className="mt-auto font-mono text-[7px] font-bold tracking-[1.5px] uppercase text-[var(--ink-4)] select-none">
          REST
        </span>
      )}

      {/* TODAY marker */}
      {cell.isToday && (
        <span className="absolute top-2 right-2 font-mono text-[8px] tracking-[2px] text-[var(--accent)]">
          ●
        </span>
      )}

      {/* Clear */}
      {hasAny && (
        <button
          onClick={e => { e.stopPropagation(); onClear(cell.dateStr); }}
          className="absolute top-1 right-1 w-5 h-5 rounded flex items-center justify-center
                     bg-[var(--danger-12)] border border-[var(--danger)]/30 text-[var(--danger)]
                     opacity-0 group-hover:opacity-100 transition-opacity"
          title="Remove workout"
        >
          <X size={10} />
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT — WeekCell
// ─────────────────────────────────────────────────────────────────────────────

function WeekCell({
  cell, compact, onClick, onClear,
}: {
  cell: CellData; compact: boolean;
  onClick: (dateStr: string) => void;
  onClear: (dateStr: string) => void;
}) {
  const hasAny = cell.hasLift || cell.hasCardio;

  if (compact) {
    return (
      <div
        onClick={() => onClick(cell.dateStr)}
        className={[
          'group relative flex flex-col items-center justify-center gap-1.5 rounded cursor-pointer',
          'min-h-[88px] py-2 border transition-all duration-200',
          cell.isSelected
            ? 'border-[var(--accent)] bg-[var(--accent-12)]'
            : 'border-[var(--line)] bg-[var(--bg-2)] hover:border-[var(--line-2)]',
        ].join(' ')}
      >
        <span className="font-mono text-[9px] font-bold tracking-[1.5px] text-[var(--ink-3)]">
          {DOW_ABBR[new Date(cell.dateStr + 'T00:00:00').getDay()]}
        </span>

        <span
          className={[
            'font-display tabular leading-none text-[28px]',
            cell.isToday ? 'text-[var(--accent)]' : cell.isSelected ? 'text-[var(--ink-0)]' : 'text-[var(--ink-1)]',
          ].join(' ')}
          style={cell.isToday ? { textShadow: '0 0 12px var(--accent-40)' } : undefined}
        >
          {String(cell.dayNum).padStart(2, '0')}
        </span>

        {hasAny && (
          <div className="flex gap-1">
            {cell.hasLift && <span className="block w-2 h-[2px] bg-[var(--accent)]" />}
            {cell.hasCardio && <span className="block w-2 h-[2px] bg-[var(--ink-1)]" />}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      onClick={() => onClick(cell.dateStr)}
      className={[
        'group relative flex flex-col gap-2 rounded cursor-pointer p-3',
        'min-h-[210px] border transition-all duration-200 overflow-hidden',
        cell.isSelected
          ? 'border-[var(--accent)] bg-[var(--accent-12)]'
          : 'border-[var(--line)] bg-[var(--bg-2)] hover:border-[var(--line-2)] hover:bg-[var(--bg-3)]',
      ].join(' ')}
    >
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[1.5px] text-[var(--ink-3)]">
          {DOW_SHORT[new Date(cell.dateStr + 'T00:00:00').getDay()]}
        </span>
        <span
          className={[
            'font-display tabular leading-none text-[34px]',
            cell.isToday ? 'text-[var(--accent)]' : cell.isSelected ? 'text-[var(--ink-0)]' : 'text-[var(--ink-1)]',
          ].join(' ')}
          style={cell.isToday ? { textShadow: '0 0 12px var(--accent-40)' } : undefined}
        >
          {String(cell.dayNum).padStart(2, '0')}
        </span>
      </div>

      {cell.summary && (
        <p className="text-[10px] text-[var(--ink-1)] leading-relaxed pl-2 border-l border-[var(--accent-24)] flex-1 overflow-hidden whitespace-pre-line">
          {cell.summary}
        </p>
      )}

      {hasAny && (
        <div className="flex gap-1.5 mt-auto">
          {cell.hasLift   && <span className="font-mono text-[9px] font-bold tracking-[1px] text-[var(--accent-ink)] bg-[var(--accent)] px-1.5 py-0.5 rounded-sm uppercase">Lift</span>}
          {cell.hasCardio && <span className="font-mono text-[9px] font-bold tracking-[1px] text-[var(--ink-0)] bg-[var(--bg-3)] border border-[var(--line-2)] px-1.5 py-0.5 rounded-sm uppercase">Cardio</span>}
        </div>
      )}

      {hasAny && (
        <button
          onClick={e => { e.stopPropagation(); onClear(cell.dateStr); }}
          className="absolute top-2 right-2 w-5 h-5 rounded flex items-center justify-center
                     bg-[var(--danger-12)] border border-[var(--danger)]/30 text-[var(--danger)]
                     opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <X size={10} />
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BADGE HELPERS (mirrors badgeEngine thresholds, client-side only)
// ─────────────────────────────────────────────────────────────────────────────
const BENCH_NAMES = new Set(['Bench Press','Barbell Bench Press','Flat Bench Press','Flat Barbell Bench']);
const SQUAT_NAMES = new Set(['Squat','Back Squat','Barbell Squat','Low Bar Squat','High Bar Squat']);
const DEAD_NAMES  = new Set(['Deadlift','Barbell Deadlift','Conventional Deadlift','Romanian Deadlift']);
const BADGE_WEIGHTS = [135, 225, 315, 405, 495, 540, 630];

const RUN_MILESTONES = [
  { threshold: 50,   icon: '/Badges/Run_50miles.png' },
  { threshold: 26.2, icon: '/Badges/First_marathon_badge.png' },
  { threshold: 13.1, icon: '/Badges/First_half_marathon_badge.png' },
  { threshold: 9.3,  icon: '/Badges/First_15K_badge.png' },
  { threshold: 6.2,  icon: '/Badges/First_10K_badge.png' },
  { threshold: 3.1,  icon: '/Badges/First_5K_badge.png' },
];

const BIKE_MILESTONES = [
  { threshold:  0.1, icon: '/Badges/First_bike_badge.png'         },
  { threshold: 50,   icon: '/Badges/Running_total_bike_badge.png' },
  { threshold: 1000, icon: '/Badges/1000_miles_biked_badge.png'   },
];

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
// SUB-COMPONENT — TodaysWorkoutSummary
// ─────────────────────────────────────────────────────────────────────────────

function TodaysWorkoutSummary({ dateStr, rec }: { dateStr: string; rec: DayRecord }) {
  const { updateDayRecord, setActiveDayFocus, localDB, todayStr } = useApp();
  const arr    = parseEx(rec.exercises ?? '');
  const lifts  = arr.filter(e => e.k === 'lift' || e.k === 'text');
  const cardio = arr.filter(e => ['swim','run','bike'].includes(e.k));

  // ── Active lifting program → "add today's plan workout" ─────────────────────
  // When a structured program is set, surface its next-up day. Tapping the button
  // opens a confirm modal where the user PICKS which exercises to add (default
  // all) — so they can drop in only some, do them out of order, or skip ones they
  // can't do today. Same coached load + cursor advance as the Protocol builder.
  const u = useUnits();
  const [planAdded, setPlanAdded] = useState(false);
  const [planPickerOpen, setPlanPickerOpen] = useState(false);
  const [planPicks, setPlanPicks] = useState<Set<number>>(new Set()); // selected exercise indices
  const program = useMemo<LiftingProgram | null>(() => {
    try {
      const raw = localStorage.getItem(LIFTING_PROGRAM_KEY);
      return raw ? (JSON.parse(raw) as LiftingProgram) : null;
    } catch { return null; }
  }, []);
  // The program day "up next" (cursor), with this week's set count applied.
  const nextPlanDay = useMemo(() => {
    if (!program || program.days.length === 0) return null;
    const days = weekAdjustedDays(program, todayStr);
    const idx  = ((program.cursor % days.length) + days.length) % days.length; // safe mod
    return { day: days[idx], idx };
  }, [program, todayStr]);

  // Coached entries for the next-up day (built once) — the modal reads each
  // exercise's pre-filled top-set weight from here to show the "~weight" hint.
  const planEntryPreview = useMemo(() => {
    if (!nextPlanDay) return [];
    const entries = buildProgramDayEntries(
      nextPlanDay.day, localDB as Record<string, LoggedDay>, todayStr, loadLiftPRs(LIFT_PRS_KEY),
    );
    return entries.map(e => ({ wLb: parseFloat(String(e.sets?.[0]?.w ?? '0')) || 0 }));
  }, [nextPlanDay, localDB, todayStr]);

  // Open the picker with every exercise pre-selected.
  const openPlanPicker = () => {
    if (!nextPlanDay) return;
    setPlanPicks(new Set(nextPlanDay.day.exercises.map((_, i) => i)));
    setPlanPickerOpen(true);
  };

  // Add only the checked exercises to today's session, in their listed order.
  const confirmAddPlan = () => {
    if (!program || !nextPlanDay) return;
    const all = buildProgramDayEntries(
      nextPlanDay.day, localDB as Record<string, LoggedDay>, todayStr, loadLiftPRs(LIFT_PRS_KEY),
    );
    const chosen = all.filter((_, i) => planPicks.has(i));
    if (chosen.length === 0) { setPlanPickerOpen(false); return; }
    window.dispatchEvent(new CustomEvent('que-load-program-day', {
      detail: { exercises: chosen, dayName: nextPlanDay.day.name },
    }));
    // Advance the cursor only when the WHOLE day was added — a partial pick (the
    // user skipped some) shouldn't move them off this split day yet.
    if (chosen.length === nextPlanDay.day.exercises.length) {
      try {
        const next = { ...program, cursor: (nextPlanDay.idx + 1) % program.days.length };
        localStorage.setItem(LIFTING_PROGRAM_KEY, JSON.stringify(next));
      } catch { /* storage full — entries already dispatched */ }
    }
    setPlanPickerOpen(false);
    setPlanAdded(true);
    setTimeout(() => setPlanAdded(false), 2200);
  };

  // Recomputes all-time PRs from full localDB + the newly-edited exercises for
  // this day, writes queLiftPRs to localStorage, and fires an immediate sync so
  // badge award/revocation is triggered on the server.
  const recomputePRs = (newExs: ParsedEntry[]) => {
    const prRecs: Record<string, number> = {};
    for (const [date, dayRec] of Object.entries(localDB)) {
      if (date === dateStr) continue; // overlay from newExs below
      parseEx(String((dayRec as { exercises?: string }).exercises ?? ''))
        .filter(e => e.k === 'lift' && e.n)
        .forEach(ex => {
          normalizeSets(ex).forEach(s => {
            const w = parseFloat(String(s.w ?? '0')) || 0;
            if (w > 0) prRecs[ex.n!] = Math.max(prRecs[ex.n!] ?? 0, w);
          });
        });
    }
    newExs.filter(e => e.k === 'lift' && e.n).forEach(ex => {
      normalizeSets(ex).forEach(s => {
        const w = parseFloat(String(s.w ?? '0')) || 0;
        if (w > 0) prRecs[ex.n!] = Math.max(prRecs[ex.n!] ?? 0, w);
      });
    });
    try { localStorage.setItem(LIFT_PRS_KEY, JSON.stringify(prRecs)); } catch { /* storage full */ }
    pushNow({ settings: gatherSettings() });
  };

  // Historical max and total run distance from all days except dateStr.
  const { historicalMaxRunDist, historicalTotalRunDist } = useMemo(() => {
    let max = 0, total = 0;
    for (const [date, dayRec] of Object.entries(localDB)) {
      if (date === dateStr) continue;
      parseEx(String((dayRec as { exercises?: string }).exercises ?? ''))
        .filter(e => e.k === 'run')
        .forEach(e => { const d = parseFloat(String(e.v1 ?? '0')) || 0; if (d > max) max = d; total += d; });
    }
    return { historicalMaxRunDist: max, historicalTotalRunDist: total };
  }, [localDB, dateStr]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentDayRunDist = useMemo(
    () => cardio.filter(e => e.k === 'run').reduce((s, e) => s + (parseFloat(String(e.v1 ?? '0')) || 0), 0),
    [cardio],
  );

  const { historicalMaxBikeDist, historicalTotalBikeDist } = useMemo(() => {
    let max = 0, total = 0;
    for (const [date, dayRec] of Object.entries(localDB)) {
      if (date === dateStr) continue;
      parseEx(String((dayRec as { exercises?: string }).exercises ?? ''))
        .filter(e => e.k === 'bike')
        .forEach(e => { const d = parseFloat(String(e.v1 ?? '0')) || 0; if (d > max) max = d; total += d; });
    }
    return { historicalMaxBikeDist: max, historicalTotalBikeDist: total };
  }, [localDB, dateStr]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentDayBikeDist = useMemo(
    () => cardio.filter(e => e.k === 'bike').reduce((s, e) => s + (parseFloat(String(e.v1 ?? '0')) || 0), 0),
    [cardio],
  );

  const { historicalMaxSwimTime, historicalTotalSwimDist } = useMemo(() => {
    let maxTime = 0, totalDist = 0;
    for (const [date, dayRec] of Object.entries(localDB)) {
      if (date === dateStr) continue;
      const t = parseFloat(String((dayRec as { swimTime?: unknown }).swimTime ?? '0')) || 0;
      const d = parseFloat(String((dayRec as { swimDist?: unknown }).swimDist ?? '0')) || 0;
      if (t > maxTime) maxTime = t;
      totalDist += d;
    }
    return { historicalMaxSwimTime: maxTime, historicalTotalSwimDist: totalDist };
  }, [localDB, dateStr]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentDaySwimTime = useMemo(
    () => cardio.filter(e => e.k === 'swim').reduce((s, e) => s + (parseFloat(String(e.v1 ?? '0')) || 0), 0),
    [cardio],
  );
  const currentDaySwimDist = useMemo(
    () => cardio.filter(e => e.k === 'swim').reduce((s, e) => s + (parseFloat(String(e.v2 ?? '0')) || 0), 0),
    [cardio],
  );

  // Ref for the weight input so Enter on reps can advance focus
  const editWeightRef = useRef<HTMLInputElement>(null);

  // ── Exercise history sparkline (Feature 6) ───────────────────────────────
  const [historyEx, setHistoryEx] = useState<string | null>(null);

  // ── Inline set editing ───────────────────────────────────────────────────
  const [editCell, setEditCell] = useState<{ arrIdx: number; setIdx: number } | null>(null);
  const [editR,    setEditR]    = useState('');
  const [editW,    setEditW]    = useState('');

  const startEdit = (arrIdx: number, setIdx: number, r: string, w: string) => {
    setEditCell({ arrIdx, setIdx }); setEditR(r); setEditW(w);
  };

  const commitEdit = () => {
    if (!editCell) return;
    const exs = parseEx(String(rec.exercises ?? ''));
    const ex  = exs[editCell.arrIdx];
    if (ex) {
      const sets: Array<{ r: string; w: string }> = Array.isArray(ex.sets)
        ? (ex.sets as Array<{ r: string; w: string }>).slice()
        : normalizeSets(ex);
      sets[editCell.setIdx] = { r: editR.trim() || '1', w: editW.trim() };
      ex.sets = sets as typeof ex.sets;
      updateDayRecord(dateStr, { exercises: JSON.stringify(exs) });
      recomputePRs(exs);
    }
    setEditCell(null);
  };

  const removeSet = (arrIdx: number, setIdx: number) => {
    const exs = parseEx(String(rec.exercises ?? ''));
    const ex  = exs[arrIdx];
    if (!ex) return;
    const sets: Array<{ r: string; w: string }> = Array.isArray(ex.sets)
      ? (ex.sets as Array<{ r: string; w: string }>).slice()
      : normalizeSets(ex);
    if (sets.length <= 1) return; // always keep at least one set
    sets.splice(setIdx, 1);
    ex.sets = sets as typeof ex.sets;
    updateDayRecord(dateStr, { exercises: JSON.stringify(exs) });
    recomputePRs(exs);
    setEditCell(null);
  };

  const addSet = (arrIdx: number) => {
    const exs = parseEx(String(rec.exercises ?? ''));
    const ex  = exs[arrIdx];
    if (!ex) return;
    const sets: Array<{ r: string; w: string }> = Array.isArray(ex.sets)
      ? (ex.sets as Array<{ r: string; w: string }>).slice()
      : normalizeSets(ex);
    // Copy last set's values so the user only needs to change what differs
    const last = sets[sets.length - 1] ?? { r: '1', w: '' };
    sets.push({ r: last.r, w: last.w });
    ex.sets = sets as typeof ex.sets;
    updateDayRecord(dateStr, { exercises: JSON.stringify(exs) });
    recomputePRs(exs);
  };

  // ── Swipe to change day ──────────────────────────────────────────────────
  const touchStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const onTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const dx = touchStart.current.x - e.changedTouches[0].clientX;
    const dy = touchStart.current.y - e.changedTouches[0].clientY;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.8) return;
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + (dx > 0 ? 1 : -1));
    setActiveDayFocus(toDateStr(d));
  };

  // ── Groups with original array index for editing ─────────────────────────
  const indexedGroups = useMemo(() => {
    const g: Record<string, Array<ParsedEntry & { arrIdx: number }>> = {};
    arr.forEach((e, arrIdx) => {
      if (e.k !== 'lift' && e.k !== 'text') return;
      (g[e.g ?? 'other'] ||= []).push({ ...e, arrIdx });
    });
    return g;
  }, [arr]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── PR detection ─────────────────────────────────────────────────────────
  const prRecs = useMemo((): Record<string, number> => {
    try { return JSON.parse(localStorage.getItem(LIFT_PRS_KEY) ?? '{}') as Record<string, number>; }
    catch { return {}; }
  }, [lifts]); // re-reads after recomputePRs updates localStorage and triggers re-render via rec prop

  const prLiftNames = useMemo(() => {
    const prs = new Set<string>();
    lifts.forEach(ex => {
      if (ex.k !== 'lift' || !ex.n) return;
      const maxToday = Math.max(0, ...normalizeSets(ex).map(s => parseFloat(s.w) || 0));
      if (maxToday > 0 && maxToday >= (prRecs[ex.n!] ?? 0)) prs.add(ex.n!);
    });
    return prs;
  }, [lifts, prRecs]);

  // Muscle groups that first crossed 1,000,000 lbs total volume on this specific day.
  const millionGroupsCrossedToday = useMemo(() => {
    const todayVol: Record<string, number> = {};
    lifts.forEach(ex => {
      if (!ex.g) return;
      normalizeSets(ex).forEach(s => {
        todayVol[ex.g!] = (todayVol[ex.g!] ?? 0) + (parseFloat(String(s.r ?? '1')) || 0) * (parseFloat(String(s.w ?? '0')) || 0);
      });
    });
    if (Object.keys(todayVol).length === 0) return [];
    const histVol: Record<string, number> = {};
    for (const [date, dayRec] of Object.entries(localDB)) {
      if (date === dateStr) continue;
      parseEx(String((dayRec as { exercises?: string }).exercises ?? '')).forEach(ex => {
        if (ex.k !== 'lift' || !ex.g) return;
        normalizeSets(ex).forEach(s => {
          histVol[ex.g!] = (histVol[ex.g!] ?? 0) + (parseFloat(String(s.r ?? '1')) || 0) * (parseFloat(String(s.w ?? '0')) || 0);
        });
      });
    }
    return Object.entries(todayVol)
      .filter(([g, v]) => (histVol[g] ?? 0) + v >= 1_000_000 && (histVol[g] ?? 0) < 1_000_000)
      .map(([g]) => g[0].toUpperCase() + g.slice(1));
  }, [localDB, dateStr, lifts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Count consecutive logged days ending on (and including) dateStr.
  const workoutStreakOnDate = useMemo((): number => {
    const hasEx = (d: string) => String((localDB[d] as { exercises?: string } | undefined)?.exercises ?? '').length > 2;
    if (!hasEx(dateStr)) return 0;
    let streak = 1;
    const cursor = new Date(dateStr + 'T00:00:00Z');
    for (;;) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      if (!hasEx(toDateStr(cursor))) break;
      streak++;
    }
    return streak;
  }, [localDB, dateStr]); // eslint-disable-line react-hooks/exhaustive-deps

  // Count consecutive days ending on dateStr where BOTH workout logged AND calorie goal hit.
  const combinedStreakOnDate = useMemo((): number => {
    const qualifies = (d: string): boolean => {
      const rec   = (localDB[d] as { exercises?: string; calsEaten?: string; budget?: number | string } | undefined);
      if (!rec) return false;
      const hasEx = String(rec.exercises ?? '').length > 2;
      const eaten = parseFloat(String(rec.calsEaten ?? '0'));
      const bud   = parseFloat(String(rec.budget   ?? '0'));
      return hasEx && eaten > 0 && bud > 0 && Math.abs(eaten - bud) <= GOAL_TOLERANCE;
    };
    if (!qualifies(dateStr)) return 0;
    let streak = 1;
    const cursor = new Date(dateStr + 'T00:00:00Z');
    for (;;) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      if (!qualifies(toDateStr(cursor))) break;
      streak++;
    }
    return streak;
  }, [localDB, dateStr]); // eslint-disable-line react-hooks/exhaustive-deps

  const today    = new Date();
  const isToday  = dateStr === todayStr;
  const d        = new Date(dateStr + 'T00:00:00');
  const diffDays = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - d.getTime()) / 86400000);
  const dateTag  = `(${d.getMonth() + 1}/${d.getDate()})`;
  const label    = diffDays === 0 ? `TODAY'S SESSION ${dateTag}`
    : diffDays === 1 ? `YESTERDAY'S SESSION ${dateTag}`
    : `${DOW_SHORT[d.getDay()]} ${MONTHS[d.getMonth()].slice(0,3).toUpperCase()} ${d.getDate()}`;

  const isEmpty = lifts.length === 0 && cardio.length === 0;

  return (
    <div
      className="que-card mt-4"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="p-5">
        <div className="flex items-center justify-between mb-5">
          <h2 className="que-section-label"><span className="dot" />{label}</h2>
          <div className="flex items-center gap-3">
            {rec.prBothDay && (
              <div className="flex items-center gap-1.5">
                <AutoCropImage src="/Badges/PR_both_lift_and_cardio.png" alt="Double PR Day" className="w-5 h-5 object-contain" />
                <span className="font-mono text-[9px] font-bold tracking-[1px] text-[var(--accent)] uppercase">Double PR</span>
              </div>
            )}
            {parseFloat(String(rec.runDist  ?? '0')) > 0 &&
             parseFloat(String(rec.bikeDist ?? '0')) > 0 &&
             parseFloat(String(rec.swimTime ?? '0')) > 0 && (
              <div className="flex items-center gap-1.5">
                <AutoCropImage src="/Badges/Triathlete_badge.png" alt="Triathlete" className="w-5 h-5 object-contain" />
                <span className="font-mono text-[9px] font-bold tracking-[1px] text-[var(--accent)] uppercase">Triathlete</span>
              </div>
            )}
            {millionGroupsCrossedToday.length > 0 && (
              <div className="flex items-center gap-1.5">
                <AutoCropImage src="/Badges/Million_pounds_lifted.png" alt="Million Lbs" className="w-5 h-5 object-contain" />
                <span className="font-mono text-[9px] font-bold tracking-[1px] text-[var(--accent)] uppercase">
                  1M — {millionGroupsCrossedToday.join(', ')}
                </span>
              </div>
            )}
            {workoutStreakOnDate >= 14 && (
              <div className="flex items-center gap-1.5">
                <AutoCropImage
                  src={workoutStreakOnDate >= 50 ? '/Badges/seer_badge.png' : workoutStreakOnDate >= 30 ? '/Badges/master_badge.png' : '/Badges/scholar_badge.png'}
                  alt="Streak"
                  className="w-5 h-5 object-contain"
                />
                <span className="font-mono text-[9px] font-bold tracking-[1px] text-[var(--accent)] uppercase">
                  {workoutStreakOnDate}d Streak
                </span>
              </div>
            )}
            {combinedStreakOnDate >= 50 && (
              <div className="flex items-center gap-1.5">
                <AutoCropImage src="/Badges/stoic_badge.png" alt="Stoic" className="w-5 h-5 object-contain" />
                <span className="font-mono text-[9px] font-bold tracking-[1px] text-[var(--accent)] uppercase">
                  Stoic
                </span>
              </div>
            )}
            {(parseFloat(String(rec.burn ?? '0')) || 0) >= 1000 && (
              <div className="flex items-center gap-1.5">
                <AutoCropImage src="/Badges/1000_calorie_burned_badge.png" alt="1000 Cal Burn" className="w-5 h-5 object-contain" />
                <span className="font-mono text-[9px] font-bold tracking-[1px] text-[var(--accent)] uppercase">
                  {Math.round(parseFloat(String(rec.burn ?? '0')))} kcal
                </span>
              </div>
            )}
            {(parseFloat(String(rec.calsEaten ?? '0')) || 0) >= 10000 ? (
              <div className="flex items-center gap-1.5">
                <AutoCropImage src="/Badges/10000_calories_eaten_badge.jpg" alt="10000 Cal Day" className="w-5 h-5 object-contain" />
                <span className="font-mono text-[9px] font-bold tracking-[1px] text-[var(--accent)] uppercase">
                  {Math.round(parseFloat(String(rec.calsEaten ?? '0'))).toLocaleString()} kcal
                </span>
              </div>
            ) : (parseFloat(String(rec.calsEaten ?? '0')) || 0) >= 5000 ? (
              <div className="flex items-center gap-1.5">
                <AutoCropImage src="/Badges/5000_calories_eaten.png" alt="5000 Cal Day" className="w-5 h-5 object-contain" />
                <span className="font-mono text-[9px] font-bold tracking-[1px] text-[var(--accent)] uppercase">
                  {Math.round(parseFloat(String(rec.calsEaten ?? '0'))).toLocaleString()} kcal
                </span>
              </div>
            ) : null}
            {isToday && nextPlanDay && (
              <button
                type="button"
                onClick={openPlanPicker}
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[1px] transition-all ${
                  planAdded
                    ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--bg-0)]'
                    : 'border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent-12)]'
                }`}
                title={`Add "${nextPlanDay.day.name}" from your lifting program to today`}
              >
                {planAdded
                  ? <><Check size={11} /> Added</>
                  : <><Plus size={11} /> {nextPlanDay.day.name}</>}
              </button>
            )}
            <p className="font-mono text-[9px] text-[var(--ink-3)] tracking-[0.5px]">
              {isToday ? 'Swipe ← → to browse days' : '← → to browse'}
            </p>
          </div>
        </div>

        {isEmpty ? (
          <div className="text-center py-10 border border-dashed border-[var(--line-2)] rounded">
            <p className="font-mono text-[11px] tracking-[1px] text-[var(--ink-3)] uppercase">
              {isToday ? 'No session logged · Add lifts to begin' : 'No session logged'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {Object.keys(indexedGroups).length > 0 && (
              <div className="flex flex-col gap-5">
                {Object.entries(indexedGroups).map(([g, entries]) => (
                  <div key={g}>
                    <div className="flex items-center justify-between pb-2 mb-3 border-b border-[var(--line)]">
                      <p className="font-mono text-[10px] font-bold uppercase tracking-[2px] text-[var(--ink-1)]">{g}</p>
                      <p className="font-mono text-[10px] text-[var(--ink-3)]">
                        {entries.length} EX · {entries.reduce((s, e) => s + normalizeSets(e).length, 0)} SETS
                      </p>
                    </div>
                    <div className="flex flex-col gap-2.5">
                      {entries.map((e) => {
                        const sets = normalizeSets(e);
                        const isPR = !!e.n && prLiftNames.has(e.n);
                        const badgeIcon = e.n ? liftBadgeIcon(e.n, prRecs[e.n] ?? 0) : null;
                        return (
                          <div key={e.arrIdx} className="flex flex-col gap-1">
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => e.n && setHistoryEx(e.n)}
                                className="text-[14px] font-semibold text-[var(--ink-0)] hover:text-[var(--accent)] transition-colors text-left"
                                title="Tap to see history"
                              >
                                {e.n ?? e.k}
                              </button>
                              <PRLiveBadge active={isPR} size={26} />
                              {badgeIcon && (
                                badgeIcon.startsWith('/')
                                  ? <img src={badgeIcon} alt="" className="w-5 h-5 rounded-full object-cover flex-shrink-0" />
                                  : <span className="text-[14px] leading-none">{badgeIcon}</span>
                              )}
                            </div>
                            {(e.g2 || e.g3) && (
                              <div className="flex items-center gap-1">
                                {([e.g2, e.g3].filter(Boolean) as string[]).map((g, i) => (
                                  <span key={g} className="font-mono text-[8px] font-bold tracking-[0.8px] uppercase text-[var(--ink-3)] border border-[var(--line)] rounded-sm px-1 py-px">
                                    {i === 0 ? '2°' : '3°'} {g}
                                  </span>
                                ))}
                              </div>
                            )}
                            {sets.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {sets.map((s, si) => {
                                  const isEditing = editCell?.arrIdx === e.arrIdx && editCell?.setIdx === si;
                                  return (
                                    <span
                                      key={si}
                                      className={[
                                        'inline-flex items-center gap-1 font-mono text-[11px] rounded-sm px-2 py-0.5 whitespace-nowrap transition-colors',
                                        isEditing
                                          ? 'bg-[var(--bg-3)] border border-[var(--accent)]'
                                          : 'bg-[var(--bg-2)] border border-[var(--line)] cursor-pointer hover:border-[var(--accent)] active:bg-[var(--bg-3)]',
                                      ].join(' ')}
                                      onClick={() => !isEditing && startEdit(e.arrIdx, si, String(s.r || '1'), s.w || '')}
                                    >
                                      {isEditing ? (
                                        // Container-level onBlur commits only when focus leaves
                                        // the chip entirely — not when moving between the reps
                                        // and weight inputs. Without this, mobile blur-commits
                                        // a tap on the weight field before it can receive focus.
                                        <span
                                          className="inline-flex items-center gap-1"
                                          onBlur={ev => {
                                            if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) {
                                              commitEdit();
                                            }
                                          }}
                                        >
                                          <input
                                            autoFocus
                                            type="text" inputMode="numeric"
                                            value={editR}
                                            onChange={ev => setEditR(ev.target.value)}
                                            onKeyDown={ev => {
                                              if (ev.key === 'Enter') { ev.preventDefault(); editWeightRef.current?.focus(); }
                                              if (ev.key === 'Escape') setEditCell(null);
                                            }}
                                            className="w-8 text-center bg-transparent text-[var(--ink-0)] font-bold outline-none"
                                          />
                                          <span className="text-[9px] text-[var(--ink-3)]">@</span>
                                          <input
                                            ref={editWeightRef}
                                            type="text" inputMode="decimal"
                                            value={editW}
                                            onChange={ev => setEditW(ev.target.value)}
                                            onKeyDown={ev => {
                                              if (ev.key === 'Enter') commitEdit();
                                              if (ev.key === 'Escape') setEditCell(null);
                                            }}
                                            className="w-16 text-center bg-transparent text-[var(--ink-2)] outline-none"
                                          />
                                          {/* Remove this set — only if more than one set exists */}
                                          {sets.length > 1 && (
                                            <button
                                              type="button"
                                              onMouseDown={ev => {
                                                ev.preventDefault(); // prevent blur firing before remove
                                                removeSet(e.arrIdx, si);
                                              }}
                                              className="ml-0.5 text-[var(--danger)] text-[12px] font-bold leading-none hover:text-[var(--danger)] flex-shrink-0"
                                              title="Remove set"
                                            >×</button>
                                          )}
                                        </span>
                                      ) : (
                                        <>
                                          <span className="text-[9px] text-[var(--ink-3)]">{si+1}</span>
                                          <span className="text-[var(--ink-0)] font-bold">{s.r || '—'}</span>
                                          {s.w && <span className="text-[var(--ink-2)]">@{s.w}</span>}
                                        </>
                                      )}
                                    </span>
                                  );
                                })}
                                {/* Add set button */}
                                <button
                                  type="button"
                                  onClick={() => addSet(e.arrIdx)}
                                  className="inline-flex items-center justify-center font-mono text-[11px] font-bold text-[var(--accent)] border border-[var(--accent)]/40 rounded-sm px-2 py-0.5 hover:bg-[var(--accent)]/10 active:bg-[var(--accent)]/20 transition-colors"
                                  title="Add set"
                                >+</button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {cardio.length > 0 && (
              <div>
                <p className="font-mono text-[10px] font-bold uppercase tracking-[2px] text-[var(--ink-1)] pb-2 mb-3 border-b border-[var(--line)]">
                  Cardio
                </p>
                <div className="flex flex-col gap-2">
                  {cardio.map((e, i) => {
                    const labels: Record<string, string> = { swim: 'SWIM', run: 'RUN', bike: 'BIKE' };
                    const v1unit: Record<string, string> = { swim: 'min', run: 'mi', bike: 'mi' };
                    const v2unit: Record<string, string> = { swim: 'mi',  run: 'min', bike: 'min' };
                    const runDist  = e.k === 'run'  ? (parseFloat(String(e.v1 ?? '0')) || 0) : 0;
                    const bikeDist = e.k === 'bike' ? (parseFloat(String(e.v1 ?? '0')) || 0) : 0;
                    const swimTime = e.k === 'swim' ? (parseFloat(String(e.v1 ?? '0')) || 0) : 0;
                    const runBadgeIcon = e.k === 'run' ? (() => {
                      const firstHit = RUN_MILESTONES.find(m => runDist >= m.threshold && historicalMaxRunDist < m.threshold)?.icon ?? null;
                      if (firstHit) return firstHit;
                      const lifetime = historicalTotalRunDist + currentDayRunDist;
                      if (lifetime >= 50 && historicalTotalRunDist < 50) return '/Badges/Running_total_run_badge.png';
                      return null;
                    })() : null;
                    const bikeBadgeIcon = e.k === 'bike' ? (() => {
                      const lifetime = historicalTotalBikeDist + currentDayBikeDist;
                      if (lifetime >= 1000 && historicalTotalBikeDist < 1000) return '/Badges/1000_miles_biked_badge.png';
                      if (lifetime >= 50  && historicalTotalBikeDist < 50)   return '/Badges/Running_total_bike_badge.png';
                      if (bikeDist >= 0.1 && historicalMaxBikeDist < 0.1)    return '/Badges/First_bike_badge.png';
                      return null;
                    })() : null;
                    const swimBadgeIcon = e.k === 'swim' ? (() => {
                      if (swimTime > 0 && historicalMaxSwimTime === 0) return '/Badges/First_swim_badge.png';
                      const lifetime = historicalTotalSwimDist + currentDaySwimDist;
                      if (lifetime >= 15 && historicalTotalSwimDist < 15) return '/Badges/Running_total_swim_badge.png';
                      return null;
                    })() : null;
                    const cardioMilestoneBadge = runBadgeIcon ?? bikeBadgeIcon ?? swimBadgeIcon;
                    const cardioMilesLabel = (() => {
                      if (bikeBadgeIcon === '/Badges/Running_total_bike_badge.png')
                        return `${Math.round(historicalTotalBikeDist + currentDayBikeDist)} mi`;
                      if (runBadgeIcon === '/Badges/Running_total_run_badge.png')
                        return `${Math.round(historicalTotalRunDist + currentDayRunDist)} mi`;
                      if (swimBadgeIcon === '/Badges/Running_total_swim_badge.png')
                        return `${(historicalTotalSwimDist + currentDaySwimDist).toFixed(1)} mi`;
                      return null;
                    })();
                    return (
                      <div key={i} className="flex items-center justify-between gap-3 py-1">
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-[10px] font-bold tracking-[1.5px] text-[var(--accent)] w-12">{labels[e.k]}</span>
                          <span className="text-[14px] text-[var(--ink-0)]">
                            {e.v1 && <span className="font-mono">{e.v1} {v1unit[e.k]}</span>}
                            {e.v2 && <span className="font-mono text-[var(--ink-2)]"> · {e.v2}{v2unit[e.k]}</span>}
                          </span>
                          {cardioMilestoneBadge && (
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <AutoCropImage src={cardioMilestoneBadge} alt="milestone" className="w-6 h-6 object-contain" />
                              {cardioMilesLabel && (
                                <span className="font-mono text-[10px] font-bold tracking-[1px] text-[var(--accent)]">{cardioMilesLabel}</span>
                              )}
                            </div>
                          )}
                        </div>
                        {e.note && <span className="text-[12px] text-[var(--ink-2)] truncate">{e.note}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <ExerciseHistoryModal
        name={historyEx}
        open={historyEx !== null}
        onClose={() => setHistoryEx(null)}
      />

      {/* ── Plan-workout picker: choose which exercises to add to today ── */}
      <AnimatePresence>
        {planPickerOpen && nextPlanDay && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center px-5 backdrop-blur-sm"
            style={{ background: 'rgba(7,8,10,0.85)' }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={e => { if (e.target === e.currentTarget) setPlanPickerOpen(false); }}
          >
            <motion.div
              className="w-full max-w-[360px] rounded-lg border border-[var(--line-2)] bg-[var(--bg-1)] p-5"
              initial={{ scale: 0.94, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.94, y: 12 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              style={{ boxShadow: '0 0 0 1px var(--line-2), 0 24px 48px rgba(0,0,0,0.55)' }}
            >
              <p className="font-display text-[20px] tracking-[1px] uppercase text-[var(--ink-0)] mb-1">
                {nextPlanDay.day.name}
              </p>
              <p className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.3px] mb-4">
                Pick what you&apos;re doing today — log them in any order.
              </p>

              <div className="flex flex-col gap-1.5 max-h-[46vh] overflow-y-auto -mx-1 px-1">
                {planEntryPreview.map((p, i) => {
                  const ex = nextPlanDay.day.exercises[i];
                  const checked = planPicks.has(i);
                  return (
                    <button
                      key={i} type="button"
                      onClick={() => setPlanPicks(prev => {
                        const next = new Set(prev);
                        if (next.has(i)) next.delete(i); else next.add(i);
                        return next;
                      })}
                      className={`flex items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-all ${
                        checked
                          ? 'border-[var(--accent)] bg-[var(--accent-12)]'
                          : 'border-[var(--line-2)] bg-[var(--bg-2)] opacity-55'
                      }`}
                    >
                      <span className={`flex-shrink-0 w-4 h-4 rounded-sm border flex items-center justify-center ${checked ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--line-3)]'}`}>
                        {checked && <Check size={11} className="text-[var(--bg-0)]" />}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block font-mono text-[11px] text-[var(--ink-1)] tracking-[0.2px] truncate">{ex.name}</span>
                        <span className="block font-mono text-[8px] text-[var(--ink-3)] tracking-[0.3px]">
                          {ex.sets} × {ex.repLow}-{ex.repHigh}{p.wLb > 0 ? ` · ~${u.fmtWeight(p.wLb)}` : ''}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="flex gap-2 mt-4">
                <button onClick={() => setPlanPickerOpen(false)} className="flex-1 que-btn-ghost">
                  Cancel
                </button>
                <button
                  onClick={confirmAddPlan}
                  disabled={planPicks.size === 0}
                  className="flex-1 py-2.5 rounded font-mono text-[11px] font-bold tracking-[1.5px] uppercase border border-[var(--accent)] bg-[var(--accent-12)] text-[var(--accent)] hover:bg-[var(--accent-24)] transition-all disabled:opacity-40"
                >
                  Add {planPicks.size > 0 ? planPicks.size : ''}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function CalendarScheduler() {
  const {
    today, todayStr,
    activeDayFocus, setActiveDayFocus,
    currentDisplayDate, setCurrentDisplayDate,
    viewMode, setViewMode,
    localDB, updateDayRecord,
  } = useApp();

  const navigate = useCallback((dir: 1 | -1) => {
    setCurrentDisplayDate(prev => {
      const d = new Date(prev);
      if (viewMode === 'month')     d.setMonth(d.getMonth() + dir);
      else if (viewMode === 'week') d.setDate(d.getDate() + dir * 7);
      else                          d.setDate(d.getDate() + dir);
      return d;
    });
  }, [viewMode, setCurrentDisplayDate]);

  const [confirmClearDate, setConfirmClearDate] = useState<string | null>(null);

  const goToday   = useCallback(() => setActiveDayFocus(todayStr), [todayStr, setActiveDayFocus]);
  const selectDay = useCallback((d: string) => setActiveDayFocus(d), [setActiveDayFocus]);
  const clearDay  = useCallback((dateStr: string) => {
    setConfirmClearDate(dateStr);
  }, []);
  const confirmClear = useCallback(() => {
    if (!confirmClearDate) return;
    updateDayRecord(confirmClearDate, {
      exercises: '', notes: '', steps: 0,
      runDist: 0, runTime: 0, bikeDist: 0, bikeTime: 0, swimTime: 0, swimDist: 0, burn: 0,
    });
    setConfirmClearDate(null);
  }, [confirmClearDate, updateDayRecord]);

  const cells = useMemo<CellData[]>(() => {
    const year  = currentDisplayDate.getFullYear();
    const month = currentDisplayDate.getMonth();

    const makeCell = (dateStr: string, dayNum: number, label: string): CellData => {
      const rec = localDB[dateStr] ?? {};
      const raw = rec.exercises ?? '';
      const { hasLift, hasCardio } = detectActivity(raw);
      return {
        dateStr, dayNum, label,
        isToday:    dateStr === todayStr,
        isSelected: dateStr === activeDayFocus,
        isPadding:  false,
        hasLift, hasCardio,
        summary:    buildCellSummary(raw),
      };
    };
    const PAD: CellData = { dateStr:'', dayNum:0, label:'', isToday:false, isSelected:false, isPadding:true, hasLift:false, hasCardio:false, summary:'' };

    if (viewMode === 'month') {
      const firstDow = new Date(year, month, 1).getDay();
      const totalDays = new Date(year, month + 1, 0).getDate();
      const result: CellData[] = Array.from({ length: firstDow }, () => ({ ...PAD }));
      for (let d = 1; d <= totalDays; d++) {
        const ds = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        result.push(makeCell(ds, d, String(d)));
      }
      return result;
    }
    if (viewMode === 'week') {
      const sow = new Date(currentDisplayDate);
      sow.setDate(currentDisplayDate.getDate() - currentDisplayDate.getDay());
      return Array.from({ length: 7 }, (_, i) => {
        const ld = new Date(sow); ld.setDate(sow.getDate() + i);
        return makeCell(toDateStr(ld), ld.getDate(), `${MONTHS[ld.getMonth()]} ${ld.getDate()}`);
      });
    }
    const ds = `${year}-${String(month+1).padStart(2,'0')}-${String(currentDisplayDate.getDate()).padStart(2,'0')}`;
    return [makeCell(ds, currentDisplayDate.getDate(), `${MONTHS[month]} ${currentDisplayDate.getDate()}, ${year}`)];
  }, [currentDisplayDate, viewMode, localDB, activeDayFocus, todayStr]);

  const activeDayRec = localDB[activeDayFocus] ?? {};
  const weekLabels   = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  const spotlight    = useSpotlightBorder({ color: '79,195,247', size: 280, opacity: 0.45 });

  // True when today's date falls within the currently displayed period
  const isViewingToday = useMemo(() => {
    const t = new Date(todayStr + 'T00:00:00');
    const d = currentDisplayDate;
    if (viewMode === 'month') {
      return t.getFullYear() === d.getFullYear() && t.getMonth() === d.getMonth();
    }
    if (viewMode === 'week') {
      const sow = new Date(d); sow.setDate(d.getDate() - d.getDay());
      const eow = new Date(sow); eow.setDate(sow.getDate() + 6);
      return t >= sow && t <= eow;
    }
    return toDateStr(d) === todayStr;
  }, [todayStr, currentDisplayDate, viewMode]);

  const todayLabel = useMemo(() => {
    const t = new Date(todayStr + 'T00:00:00');
    return `${MONTHS[t.getMonth()].slice(0, 3)} ${t.getDate()}`;
  }, [todayStr]);

  return (
    <div className="flex flex-col gap-4">

      {/* ╔══════════════════════════════════════════════════════════╗
          ║ CALENDAR CARD                                            ║
          ╚══════════════════════════════════════════════════════════╝ */}
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

          {/* Navigation — Row 1: prev / title / next */}
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={() => navigate(-1)}
              className="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded border border-[var(--line-2)] bg-[var(--bg-2)] text-[var(--ink-1)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-all"
              aria-label="Previous"
            >
              <ChevronLeft size={16} />
            </button>

            <span className="flex-1 font-display text-[20px] lg:text-[26px] tracking-[2px] uppercase text-[var(--ink-0)] truncate text-center">
              {navTitle(viewMode, currentDisplayDate)}
            </span>

            <button
              onClick={() => navigate(1)}
              className="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded border border-[var(--line-2)] bg-[var(--bg-2)] text-[var(--ink-1)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-all"
              aria-label="Next"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          {/* Navigation — Row 2: view switcher + today button */}
          <div className="flex items-center gap-2 mb-5">
            <div className="flex flex-1 bg-[var(--bg-2)] border border-[var(--line)] rounded-sm p-1 gap-0.5">
              {(['day','week','month'] as ViewMode[]).map(m => (
                <button
                  key={m}
                  onClick={() => setViewMode(m)}
                  className={[
                    'flex-1 py-1.5 rounded-sm font-mono text-[10px] font-bold tracking-[1px] uppercase transition-all',
                    viewMode === m
                      ? 'bg-[var(--accent)] text-[var(--accent-ink)]'
                      : 'text-[var(--ink-2)] hover:text-[var(--ink-0)]',
                  ].join(' ')}
                >
                  {m}
                </button>
              ))}
            </div>

            {!isViewingToday && (
              <button
                onClick={goToday}
                className="flex items-center gap-1.5 font-mono text-[10px] font-bold text-[var(--accent)] border border-[var(--accent)] rounded-sm px-2.5 py-1.5 hover:bg-[var(--accent)] hover:text-[var(--accent-ink)] transition-all uppercase tracking-[1px] whitespace-nowrap flex-shrink-0"
              >
                <span className="block w-1.5 h-1.5 rounded-full bg-current" />
                {todayLabel}
              </button>
            )}
          </div>

          {/* Grid */}
          <AnimatePresence mode="sync" initial={false}>

            {viewMode === 'month' && (
              <motion.div
                key={`month-${currentDisplayDate.getFullYear()}-${currentDisplayDate.getMonth()}`}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.22, ease: [0.25, 0.46, 0.45, 0.94] }}
              >
                <div className="grid grid-cols-7 gap-1.5 mb-2">
                  {weekLabels.map(l => (
                    <div key={l} className="text-center font-mono text-[10px] font-bold text-[var(--ink-3)] tracking-[2px] py-2">
                      <span className="md:hidden">{l[0]}</span>
                      <span className="hidden md:inline">{l}</span>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-7 gap-1.5">
                  {cells.map((cell, i) =>
                    cell.isPadding ? (
                      <div key={`pad-${i}`} className="min-h-[48px] lg:min-h-[96px]" />
                    ) : (
                      <DayCell key={cell.dateStr} cell={cell} onClick={selectDay} onClear={clearDay} />
                    )
                  )}
                </div>
              </motion.div>
            )}

            {viewMode === 'week' && (
              <motion.div
                key={`week-${toDateStr(currentDisplayDate)}`}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.22 }}
                className="grid grid-cols-7 gap-1 md:gap-2"
              >
                {cells.map(cell => (
                  <React.Fragment key={cell.dateStr}>
                    <div className="md:hidden">
                      <WeekCell cell={cell} compact={true}  onClick={selectDay} onClear={clearDay} />
                    </div>
                    <div className="hidden md:block">
                      <WeekCell cell={cell} compact={false} onClick={selectDay} onClear={clearDay} />
                    </div>
                  </React.Fragment>
                ))}
              </motion.div>
            )}

            {viewMode === 'day' && cells[0] && (
              <motion.div
                key={`day-${cells[0].dateStr}`}
                initial={{ opacity: 0, scale: 0.97, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, y: -6 }}
                transition={{ duration: 0.22 }}
              >
                <div className="rounded border border-[var(--accent)] bg-[var(--accent-12)] p-6 min-h-[180px]">
                  <div className="flex items-baseline gap-4 mb-4">
                    <span
                      className="font-display text-[72px] leading-none tabular text-[var(--accent)]"
                      style={{ textShadow: '0 0 24px var(--accent-40)' }}
                    >
                      {String(cells[0].dayNum).padStart(2, '0')}
                    </span>
                    <span className="font-mono text-[11px] text-[var(--ink-1)] tracking-[2px] uppercase">
                      {weekLabels[new Date(cells[0].dateStr + 'T00:00:00').getDay()]}
                    </span>
                    <div className="flex gap-1.5 ml-auto">
                      {cells[0].hasLift   && <span className="font-mono text-[10px] font-bold tracking-[1.5px] text-[var(--accent-ink)] bg-[var(--accent)] px-2 py-1 rounded-sm uppercase">Lift</span>}
                      {cells[0].hasCardio && <span className="font-mono text-[10px] font-bold tracking-[1.5px] text-[var(--ink-0)] bg-[var(--bg-2)] border border-[var(--line-2)] px-2 py-1 rounded-sm uppercase">Cardio</span>}
                    </div>
                  </div>
                  {cells[0].summary ? (
                    <p className="text-[13px] text-[var(--ink-1)] leading-relaxed pl-3 border-l-2 border-[var(--accent)] whitespace-pre-line">
                      {cells[0].summary}
                    </p>
                  ) : (
                    <p className="font-mono text-[11px] tracking-[1px] text-[var(--ink-3)] uppercase">No session logged.</p>
                  )}
                </div>
              </motion.div>
            )}

          </AnimatePresence>

        </div>
      </div>

      <motion.div
        key={activeDayFocus}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24, delay: 0.06 }}
      >
        <TodaysWorkoutSummary dateStr={activeDayFocus} rec={activeDayRec} />
      </motion.div>

      {/* ── Clear day confirm ── */}
      <AnimatePresence>
        {confirmClearDate && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center px-5 backdrop-blur-sm"
            style={{ background: 'rgba(7,8,10,0.85)' }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={e => { if (e.target === e.currentTarget) setConfirmClearDate(null); }}
          >
            <motion.div
              className="w-full max-w-[320px] rounded-lg border border-[var(--line-2)] bg-[var(--bg-1)] p-5"
              initial={{ scale: 0.94, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.94, y: 12 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              style={{ boxShadow: '0 0 0 1px var(--line-2), 0 24px 48px rgba(0,0,0,0.55)' }}
            >
              <p className="font-display text-[20px] tracking-[1px] uppercase text-[var(--ink-0)] mb-1">
                Remove Workout
              </p>
              <p className="font-mono text-[11px] text-[var(--ink-2)] tracking-[0.3px] leading-relaxed mb-5">
                Remove all activity logged for{' '}
                <span className="text-[var(--ink-0)] font-bold">{confirmClearDate}</span>?
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmClearDate(null)}
                  className="flex-1 que-btn-ghost"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmClear}
                  className="flex-1 py-2.5 rounded font-mono text-[11px] font-bold tracking-[1.5px] uppercase border border-[var(--danger)]/50 bg-[var(--danger-12)] text-[var(--danger)] hover:border-[var(--danger)] transition-all"
                >
                  Remove
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
