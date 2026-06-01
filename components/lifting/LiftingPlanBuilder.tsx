'use client';

import { useState, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Dumbbell, ChevronDown, Plus, RotateCcw, Check, ArrowRight, Target, Beef } from 'lucide-react';
import { SECONDARY_MUSCLES, useApp, type ExerciseEntry } from '@/lib/AppContext';
import { useUnits, lbToKg } from '@/lib/units';
import { LIFTING_PROGRAM_KEY, LIFT_PRS_KEY } from '@/lib/constants';
import {
  generateProgram, suggestedWorkingLb,
  type LiftingProgram, type ProgramDay, type LiftGoal, type LiftExperience,
} from '@/lib/lifting/program';

// Pretty muscle labels for the weekly-volume readout.
const MUSCLE_LABEL: Record<string, string> = {
  chest: 'Chest', back: 'Back', shoulders: 'Shoulders', tricep: 'Triceps', bicep: 'Biceps',
  forearms: 'Forearms', abs: 'Abs', quads: 'Quads', hamstring: 'Hamstrings', glutes: 'Glutes',
  calfs: 'Calves', adductors: 'Adductors',
};

const DAY_OPTIONS = [2, 3, 4, 5, 6];
const GOALS: Array<{ id: LiftGoal; label: string; hint: string }> = [
  { id: 'hypertrophy', label: 'Build muscle', hint: 'High volume, 0-3 RIR' },
  { id: 'strength',    label: 'Get stronger', hint: 'Heavy, low reps, 2-3 RIR' },
  { id: 'general',     label: 'General fitness', hint: 'Balanced, lower volume' },
];
const LEVELS: Array<{ id: LiftExperience; label: string }> = [
  { id: 'beginner',     label: 'Beginner' },
  { id: 'intermediate', label: 'Intermediate' },
  { id: 'advanced',     label: 'Advanced' },
];

function loadProgram(): LiftingProgram | null {
  try {
    const raw = localStorage.getItem(LIFTING_PROGRAM_KEY);
    return raw ? (JSON.parse(raw) as LiftingProgram) : null;
  } catch { return null; }
}
function loadPRs(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LIFT_PRS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch { return {}; }
}

/**
 * Structured lifting-program builder. Asks how many days a week the user can
 * lift (+ goal / experience), generates a split with prescribed sets × rep
 * ranges, and lets them push any day's exercises straight into today's workout
 * log (via the `que-load-program-day` event WorkoutLogger listens for).
 */
export default function LiftingPlanBuilder({ bare = false }: { bare?: boolean } = {}) {
  const u = useUnits();
  const { profile } = useApp();
  const [program, setProgram] = useState<LiftingProgram | null>(null);
  // `bare` (rendered inside the Athlete-Profile modal, which already has its own
  // header) skips the collapsible card chrome and always shows the content.
  const [collapsed, setCollapsed] = useState(!bare);

  // form
  const [days, setDays]   = useState<number>(3);
  const [goal, setGoal]   = useState<LiftGoal>('hypertrophy');
  const [level, setLevel] = useState<LiftExperience>('intermediate');

  const [openDay, setOpenDay] = useState<number | null>(0);
  const [added, setAdded]     = useState<number | null>(null); // flash "Added" on a day

  useEffect(() => {
    const p = loadProgram();
    setProgram(p);
    if (p) { setDays(p.daysPerWeek); setGoal(p.goal); setLevel(p.experience); setCollapsed(false); }
  }, []);

  const persist = useCallback((p: LiftingProgram | null) => {
    setProgram(p);
    try {
      if (p) localStorage.setItem(LIFTING_PROGRAM_KEY, JSON.stringify(p));
      else   localStorage.removeItem(LIFTING_PROGRAM_KEY);
    } catch { /* storage full / unavailable — keep in-memory copy */ }
  }, []);

  const build = useCallback(() => {
    // Body weight (stored canonical lb) → kg for the protein target. Skipped if
    // the user hasn't set a weight yet (protein band just won't show).
    const wLb = parseFloat(String(profile.weight ?? ''));
    const bodyweightKg = Number.isFinite(wLb) && wLb > 0 ? lbToKg(wLb) : undefined;
    const p = generateProgram({ daysPerWeek: days, goal, experience: level, bodyweightKg });
    persist(p);
    setOpenDay(0);
    setCollapsed(false);
  }, [days, goal, level, profile.weight, persist]);

  // Push a day's exercises into today's workout log.
  const startDay = useCallback((day: ProgramDay, idx: number) => {
    if (!program) return;
    const prs = loadPRs();
    const entries: ExerciseEntry[] = day.exercises.map(ex => {
      const sec  = SECONDARY_MUSCLES[ex.name] ?? {};
      const wLb  = suggestedWorkingLb(prs[ex.name], program.goal);
      const w    = wLb != null ? String(wLb) : ''; // canonical lb; logger converts for display
      return {
        k: 'lift',
        n: ex.name,
        g: ex.group,
        ...(sec.g2 ? { g2: sec.g2 } : {}),
        ...(sec.g3 ? { g3: sec.g3 } : {}),
        sets: Array.from({ length: ex.sets }, () => ({ r: '1', w })),
      };
    });
    window.dispatchEvent(new CustomEvent('que-load-program-day', {
      detail: { exercises: entries, dayName: day.name },
    }));
    // advance the "up next" cursor so the next visit suggests the following day
    persist({ ...program, cursor: (idx + 1) % program.days.length });
    setAdded(idx);
    setTimeout(() => setAdded(a => (a === idx ? null : a)), 2200);
  }, [program, persist]);

  // ── Builder form (no program yet, or rebuilding) ──────────────────────────
  const Form = (
    <div className="space-y-4">
      <div>
        <span className="que-label">How many days a week can you lift?</span>
        <div className="flex gap-2 mt-2">
          {DAY_OPTIONS.map(d => (
            <button
              key={d} type="button" onClick={() => setDays(d)}
              className={`flex-1 rounded-md border py-2.5 font-mono text-sm font-bold transition-all ${
                days === d
                  ? 'border-[var(--accent)] bg-[var(--accent-12)] text-[var(--accent)]'
                  : 'border-[var(--line-2)] bg-[var(--bg-2)] text-[var(--ink-2)] hover:border-[var(--line-3)]'
              }`}
            >{d}</button>
          ))}
        </div>
      </div>

      <div>
        <span className="que-label">Goal</span>
        <div className="grid grid-cols-3 gap-2 mt-2">
          {GOALS.map(g => (
            <button
              key={g.id} type="button" onClick={() => setGoal(g.id)}
              className={`rounded-md border p-2.5 text-left transition-all ${
                goal === g.id
                  ? 'border-[var(--accent)] bg-[var(--accent-12)]'
                  : 'border-[var(--line-2)] bg-[var(--bg-2)] hover:border-[var(--line-3)]'
              }`}
            >
              <span className={`block font-mono text-[11px] font-bold tracking-[0.3px] ${goal === g.id ? 'text-[var(--accent)]' : 'text-[var(--ink-1)]'}`}>{g.label}</span>
              <span className="block font-mono text-[8px] text-[var(--ink-3)] mt-0.5 leading-tight">{g.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className="que-label">Experience</span>
        <div className="flex gap-2 mt-2">
          {LEVELS.map(l => (
            <button
              key={l.id} type="button" onClick={() => setLevel(l.id)}
              className={`flex-1 rounded-md border py-2 font-mono text-[10px] font-bold uppercase tracking-[1px] transition-all ${
                level === l.id
                  ? 'border-[var(--accent)] bg-[var(--accent-12)] text-[var(--accent)]'
                  : 'border-[var(--line-2)] bg-[var(--bg-2)] text-[var(--ink-2)] hover:border-[var(--line-3)]'
              }`}
            >{l.label}</button>
          ))}
        </div>
      </div>

      <button
        type="button" onClick={build}
        className="w-full flex items-center justify-center gap-2 rounded-md bg-[var(--accent)] py-3 font-mono text-[11px] font-bold uppercase tracking-[1.5px] text-[var(--bg-0)] hover:opacity-90 transition-opacity"
      >
        <Dumbbell size={14} /> {program ? 'Rebuild program' : 'Build my program'}
      </button>
    </div>
  );

  // ── Program view ──────────────────────────────────────────────────────────
  const ProgramView = program && (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <span className="font-mono text-[13px] font-bold text-[var(--ink-1)] tracking-[0.3px]">{program.splitName}</span>
          <span className="block font-mono text-[9px] text-[var(--ink-3)] tracking-[0.5px] uppercase mt-0.5">
            {program.daysPerWeek} days · {program.goal} · {program.experience}
          </span>
        </div>
        <button
          type="button" onClick={() => persist(null)}
          className="flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-[1px] text-[var(--ink-3)] hover:text-[var(--accent)] transition-colors"
        >
          <RotateCcw size={11} /> Rebuild
        </button>
      </div>

      {program.days.map((day, idx) => {
        const isOpen = openDay === idx;
        const isNext = program.cursor === idx;
        return (
          <div key={idx} className="rounded-lg border border-[var(--line)] bg-[var(--bg-1)] overflow-hidden">
            <button
              type="button" onClick={() => setOpenDay(isOpen ? null : idx)}
              className="w-full flex items-center justify-between px-3.5 py-3 text-left"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="flex flex-col min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px] font-bold text-[var(--ink-1)] tracking-[0.3px]">{day.name}</span>
                    {isNext && (
                      <span className="font-mono text-[7px] font-bold uppercase tracking-[1px] text-[var(--accent)] bg-[var(--accent-12)] rounded px-1.5 py-0.5">Up next</span>
                    )}
                  </div>
                  <span className="font-mono text-[8px] text-[var(--ink-3)] tracking-[0.4px] uppercase truncate">{day.focus}</span>
                </div>
              </div>
              <ChevronDown size={15} className={`text-[var(--ink-3)] transition-transform flex-shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.18 }} className="overflow-hidden"
                >
                  <div className="px-3.5 pb-3.5 pt-0.5">
                    <div className="divide-y divide-[var(--line)]">
                      {day.exercises.map((ex, i) => {
                        const prs = loadPRs();
                        const wLb = suggestedWorkingLb(prs[ex.name], program.goal);
                        const rir = ex.rirLow === ex.rirHigh ? `${ex.rirLow}` : `${ex.rirLow}-${ex.rirHigh}`;
                        return (
                          <div key={i} className="flex items-center justify-between py-2 gap-3">
                            <div className="min-w-0">
                              <span className="font-mono text-[11px] text-[var(--ink-1)] tracking-[0.2px]">{ex.name}</span>
                              {wLb != null && (
                                <span className="font-mono text-[8px] text-[var(--ink-3)] ml-2">~{u.fmtWeight(wLb)}</span>
                              )}
                              <span className="block font-mono text-[8px] text-[var(--ink-3)] tracking-[0.3px] mt-0.5">
                                {rir} RIR · {ex.restSec >= 60 ? `${Math.round(ex.restSec / 60 * 10) / 10}m` : `${ex.restSec}s`} rest
                              </span>
                            </div>
                            <span className="font-mono text-[10px] font-bold text-[var(--accent)] flex-shrink-0 text-right">
                              {ex.sets} × {ex.repLow}-{ex.repHigh}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    <button
                      type="button" onClick={() => startDay(day, idx)}
                      className={`w-full mt-3 flex items-center justify-center gap-2 rounded-md py-2.5 font-mono text-[10px] font-bold uppercase tracking-[1.5px] transition-all ${
                        added === idx
                          ? 'bg-[var(--accent)] text-[var(--bg-0)]'
                          : 'border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent-12)]'
                      }`}
                    >
                      {added === idx
                        ? <><Check size={13} /> Added to today — scroll down to log</>
                        : <><Plus size={13} /> Start this workout</>}
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}

      {/* Weekly volume — the primary driver. Fractional sets (compounds credit
          0.5 to each secondary mover) vs. the experience-scaled target. */}
      <div className="rounded-lg border border-[var(--line)] bg-[var(--bg-1)] p-3.5">
        <div className="flex items-center gap-1.5 mb-2.5">
          <Target size={12} className="text-[var(--accent)]" />
          <span className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-[var(--ink-1)]">Weekly Volume</span>
          <span className="font-mono text-[8px] text-[var(--ink-3)] ml-auto">target ~{program.weeklyTarget} sets/muscle</span>
        </div>
        <div className="space-y-1.5">
          {Object.entries(program.weeklyVolume)
            .sort((a, b) => b[1] - a[1])
            .map(([m, sets]) => {
              const pct = Math.min(100, (sets / program.weeklyTarget) * 100);
              const low = sets < 4; // below the ~4-set growth threshold
              return (
                <div key={m} className="flex items-center gap-2">
                  <span className="font-mono text-[9px] text-[var(--ink-2)] w-[68px] flex-shrink-0 tracking-[0.3px]">{MUSCLE_LABEL[m] ?? m}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-[var(--bg-3)] overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, background: low ? 'var(--ink-3)' : 'var(--accent)' }} />
                  </div>
                  <span className="font-mono text-[9px] font-bold text-[var(--ink-1)] w-7 text-right flex-shrink-0">{sets}</span>
                </div>
              );
            })}
        </div>
        <p className="font-mono text-[8px] text-[var(--ink-3)] leading-relaxed tracking-[0.3px] mt-2.5">
          Sets per muscle per week is the strongest driver of growth — compounds count a half-set toward each assisting muscle. ~4 is the minimum to grow; 5–10 banks most gains.
        </p>
      </div>

      {/* Protein target — 1.6–2.2 g/kg/day across 3–6 meals. */}
      {program.protein && (
        <div className="rounded-lg border border-[var(--line)] bg-[var(--bg-1)] p-3.5">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Beef size={12} className="text-[var(--accent)]" />
            <span className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-[var(--ink-1)]">Protein</span>
          </div>
          <span className="font-mono text-[14px] font-bold text-[var(--accent)]">{program.protein.lowG}–{program.protein.highG} g</span>
          <span className="font-mono text-[9px] text-[var(--ink-3)] ml-1.5">/ day</span>
          <p className="font-mono text-[8px] text-[var(--ink-3)] leading-relaxed tracking-[0.3px] mt-1.5">
            1.6–2.2 g/kg bodyweight, spread over 3–6 meals of {program.protein.perMealLowG}–{program.protein.perMealHighG} g to maximize muscle protein synthesis.
          </p>
        </div>
      )}

      <p className="font-mono text-[8px] text-[var(--ink-3)] leading-relaxed tracking-[0.3px] flex items-start gap-1.5 pt-1">
        <ArrowRight size={11} className="text-[var(--ink-2)] flex-shrink-0 mt-px" aria-hidden />
        <span><strong className="text-[var(--ink-2)]">Double progression:</strong> train each set to the listed reps-in-reserve (RIR). When you hit the top of the rep range on every set, add weight next time (~5 lb upper body, ~10 lb lower) and start back at the bottom. Deload every 4–8 weeks.</span>
      </p>
    </div>
  );

  // Shared body: the program view (or the build form), plus the toggle between them.
  const Body = (
    <div className={bare ? '' : 'pt-4'}>
      {program && openDay !== -1 ? ProgramView : Form}
      {program && (
        <button
          type="button" onClick={() => setOpenDay(openDay === -1 ? 0 : -1)}
          className="w-full mt-3 font-mono text-[9px] font-bold uppercase tracking-[1px] text-[var(--ink-3)] hover:text-[var(--accent)] transition-colors"
        >
          {openDay === -1 ? '← Back to program' : 'Change days / goal'}
        </button>
      )}
    </div>
  );

  // Bare mode (Athlete-Profile modal): no card chrome, no collapse — the modal
  // already provides a header + scroll container.
  if (bare) return Body;

  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-1)] p-4">
      <button
        type="button" onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between"
      >
        <span className="flex items-center gap-2">
          <Dumbbell size={15} className="text-[var(--accent)]" />
          <span className="font-mono text-[12px] font-bold uppercase tracking-[1.5px] text-[var(--ink-1)]">Lifting Program</span>
        </span>
        <ChevronDown size={16} className={`text-[var(--ink-3)] transition-transform ${collapsed ? '' : 'rotate-180'}`} />
      </button>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }} className="overflow-hidden"
          >
            {Body}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
