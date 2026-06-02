'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Layers, Dumbbell, Footprints, Bike, Waves, Plus, X, Check, Trash2,
  ChevronDown, Moon, Copy, Sparkles, CalendarClock,
} from 'lucide-react';
import { useApp } from '@/lib/AppContext';
import { useUnits } from '@/lib/units';
import { LIFTING_PROGRAM_KEY } from '@/lib/constants';
import type { LiftingProgram } from '@/lib/lifting/program';
import { queueSync, gatherSettings } from '@/lib/syncEngine';
import {
  generateBlockSkeleton, loadTrainingBlock, writeTrainingBlock,
  trainingDayCount, isBrickDay, newSessionId,
  PHASE_LABEL, INTENSITY_LABEL, DISCIPLINE_LABEL, ZONE_LABEL, TRAINING_BLOCK_CHANGED_EVENT,
  blockLengthOptions, ironmanReadinessNote, sessionFuelKcal,
  type TrainingBlock, type BlockGoal, type BlockWeeks, type BlockSession,
  type Discipline, type TimeOfDay, type SessionIntensity, type DayOfWeek, type AthleteLevel,
} from '@/lib/trainingBlock';
import { formatPace } from '@/lib/running/vdot';
import type { TrainingPlan } from '@/lib/running/types';

const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DISC_META: Record<Discipline, { Icon: typeof Dumbbell; color: string }> = {
  lift: { Icon: Dumbbell,    color: 'var(--accent)' },
  run:  { Icon: Footprints,  color: '#FFB547' },
  bike: { Icon: Bike,        color: '#6DFF99' },
  swim: { Icon: Waves,       color: '#4FC3F7' },
};

const CARDIO_INTENSITIES: SessionIntensity[] = ['recovery', 'easy', 'tempo', 'threshold', 'interval', 'long'];
const LIFT_INTENSITIES: SessionIntensity[]   = ['strength', 'hypertrophy'];

const GOALS: Array<{ id: BlockGoal; label: string; hint: string }> = [
  { id: 'ironman', label: 'Ironman / Tri', hint: 'Swim · bike · run + 2 lifts, brick & long days' },
  { id: 'hybrid',  label: 'Hybrid',        hint: 'Balanced lifting + running/biking' },
  { id: 'custom',  label: 'Blank',         hint: 'Empty weeks (phases scaffolded) — build it yourself' },
];

const DPW_OPTIONS = [3, 4, 5, 6];

function loadLiftingProgram(): LiftingProgram | null {
  try {
    const raw = localStorage.getItem(LIFTING_PROGRAM_KEY);
    return raw ? (JSON.parse(raw) as LiftingProgram) : null;
  } catch { return null; }
}

/** VDOT-derived run paces from the saved running plan (queRunningPlan), if any —
 *  this is the integration: block run sessions reuse the Jack Daniels engine. */
function loadRunPaces() {
  try {
    const raw = localStorage.getItem('queRunningPlan');
    if (!raw) return null;
    const saved = JSON.parse(raw) as { plan?: TrainingPlan };
    return saved.plan?.vdot?.paces ?? null;
  } catch { return null; }
}

const LEVELS: Array<{ id: AthleteLevel; label: string }> = [
  { id: 'beginner',     label: 'Beginner' },
  { id: 'intermediate', label: 'Intermediate' },
  { id: 'advanced',     label: 'Advanced' },
];

/** The Sunday on or before `dateStr` — block week-1 day-0 is a Sunday so the
 *  Sun..Sat session layout lands on real weekdays. */
function sundayOnOrBefore(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - d.getDay());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayLocalStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface EditorTarget { weekIdx: number; dow: DayOfWeek; sessionId?: string }

/**
 * Multi-week periodized training-block builder (hybrid lift + cardio scheduler).
 * Mobile-first: a horizontally-swipeable week strip + a vertical day stack +
 * a bottom-sheet session editor. Seeds from a template (Ironman / Hybrid / blank)
 * then every session is editable. An ACTIVE block feeds the calendar (see
 * CalendarScheduler "Planned today"). Logging stays in DayRecord — plan vs actual
 * are kept separate.
 */
export default function TrainingBlockBuilder() {
  const u = useUnits();
  const { todayStr } = useApp();
  const [block, setBlock] = useState<TrainingBlock | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [selWeek, setSelWeek] = useState(0);
  const [editor, setEditor] = useState<EditorTarget | null>(null);

  // new-block form
  const [goal, setGoal] = useState<BlockGoal>('ironman');
  const [weeks, setWeeks] = useState<BlockWeeks>(12);
  const [dpw, setDpw] = useState(6);
  const [level, setLevel] = useState<AthleteLevel>('intermediate');
  const [startDate, setStartDate] = useState(() => sundayOnOrBefore(todayLocalStr()));

  const liftProgram = useMemo(() => loadLiftingProgram(), []);
  const runPaces = useMemo(() => loadRunPaces(), []);
  const lengthOpts = useMemo(() => blockLengthOptions(goal), [goal]);

  // Keep the selected length valid for the goal (Ironman = 12/16/24 only).
  useEffect(() => {
    if (!lengthOpts.includes(weeks)) setWeeks(lengthOpts.includes(12) ? 12 : lengthOpts[0]);
  }, [lengthOpts]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const b = loadTrainingBlock();
    if (b) { setBlock(b); setCollapsed(false); }
  }, []);

  const persist = useCallback((b: TrainingBlock | null) => {
    setBlock(b);
    writeTrainingBlock(b);
    queueSync({ settings: gatherSettings() });
    window.dispatchEvent(new CustomEvent(TRAINING_BLOCK_CHANGED_EVENT));
  }, []);

  /** Immutable edit of the current block. */
  const mutate = useCallback((fn: (b: TrainingBlock) => void) => {
    setBlock(prev => {
      if (!prev) return prev;
      const next = structuredClone(prev) as TrainingBlock;
      fn(next);
      writeTrainingBlock(next);
      queueSync({ settings: gatherSettings() });
      window.dispatchEvent(new CustomEvent(TRAINING_BLOCK_CHANGED_EVENT));
      return next;
    });
  }, []);

  const createBlock = useCallback(() => {
    const snapped = sundayOnOrBefore(startDate);
    const b = generateBlockSkeleton(goal, weeks, dpw, snapped, undefined, { experience: level, runPaces });
    persist(b);
    setSelWeek(0);
    setCollapsed(false);
  }, [goal, weeks, dpw, level, runPaces, startDate, persist]);

  const week = block?.weeksData[selWeek];

  // ── New-block (empty) state ────────────────────────────────────────────────
  if (!block) {
    return (
      <section className="rounded-xl border border-[var(--line)] bg-[var(--bg-1)] p-4">
        <div className="flex items-center gap-2 mb-3">
          <Layers size={18} className="text-[var(--accent)]" />
          <h2 className="font-display text-[18px] tracking-[1px]">TRAINING BLOCK</h2>
        </div>
        <p className="font-mono text-[11px] text-[var(--ink-3)] leading-relaxed mb-4">
          Build a multi-week plan that schedules lifts and cardio together — including
          two-a-days — with periodized phases and deloads. Pick a starting template, then edit
          every session.
        </p>

        <Label>Goal</Label>
        <div className="flex flex-col gap-2 mb-4">
          {GOALS.map(g => (
            <button key={g.id} type="button" onClick={() => setGoal(g.id)}
              className={`text-left rounded-lg border px-3 py-2.5 transition-all ${
                goal === g.id ? 'border-[var(--accent)] bg-[var(--accent-12)]' : 'border-[var(--line-2)] hover:border-[var(--ink-3)]'}`}>
              <p className="font-mono text-[12px] font-bold tracking-[0.5px]">{g.label}</p>
              <p className="font-mono text-[10px] text-[var(--ink-3)] mt-0.5">{g.hint}</p>
            </button>
          ))}
        </div>

        <Label>Length{goal === 'ironman' ? ' (16–24 wk recommended)' : ''}</Label>
        <div className="flex gap-2 mb-2">
          {lengthOpts.map(w => (
            <Chip key={w} active={weeks === w} onClick={() => setWeeks(w)}>{w} wk</Chip>
          ))}
        </div>
        {goal === 'ironman' && (
          <p className="font-mono text-[9px] leading-relaxed text-[#FFB547] bg-[#FFB547]/10 border border-[#FFB547]/25 rounded-md px-2.5 py-2 mb-4">
            {ironmanReadinessNote(weeks)}
          </p>
        )}

        <Label>Experience</Label>
        <div className="flex gap-2 mb-4">
          {LEVELS.map(l => (
            <Chip key={l.id} active={level === l.id} onClick={() => setLevel(l.id)}>{l.label}</Chip>
          ))}
        </div>

        <Label>Days / week</Label>
        <div className="flex gap-2 mb-4">
          {DPW_OPTIONS.map(d => (
            <Chip key={d} active={dpw === d} onClick={() => setDpw(d)}>{d}</Chip>
          ))}
        </div>

        <Label>Start date (snaps to that week&apos;s Sunday)</Label>
        <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
          className="que-input w-full mb-1.5 font-mono text-[12px]" />
        {runPaces && (
          <p className="font-mono text-[9px] text-[var(--ink-3)] mb-4">
            ✓ Run paces will be pulled from your saved running plan (VDOT).
          </p>
        )}
        {!runPaces && <div className="mb-4" />}

        <button type="button" onClick={createBlock}
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-[var(--accent)] text-[var(--bg-0)] font-mono text-[12px] font-bold uppercase tracking-[1px] py-3">
          <Sparkles size={14} /> Generate block
        </button>
      </section>
    );
  }

  // ── Existing block ───────────────────────────────────────────────────────
  return (
    <section className="rounded-xl border border-[var(--line)] bg-[var(--bg-1)]">
      {/* Header */}
      <button type="button" onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <Layers size={18} className="text-[var(--accent)] flex-shrink-0" />
          <div className="text-left min-w-0">
            <h2 className="font-display text-[16px] tracking-[1px] truncate">{block.name.toUpperCase()}</h2>
            <p className="font-mono text-[9px] text-[var(--ink-3)] tracking-[0.5px]">
              {block.weeks} weeks · {block.active ? 'ACTIVE' : 'draft'}
            </p>
          </div>
        </div>
        <ChevronDown size={18} className={`text-[var(--ink-3)] transition-transform ${collapsed ? '' : 'rotate-180'}`} />
      </button>

      {!collapsed && (
        <div className="px-4 pb-4">
          {/* Activate / discard */}
          <div className="flex gap-2 mb-4">
            <button type="button" onClick={() => mutate(b => { b.active = !b.active; })}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg border py-2 font-mono text-[10px] font-bold uppercase tracking-[1px] transition-all ${
                block.active ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--bg-0)]' : 'border-[var(--accent)] text-[var(--accent)]'}`}>
              {block.active ? <><Check size={12} /> Active on calendar</> : <><CalendarClock size={12} /> Activate</>}
            </button>
            <button type="button"
              onClick={() => { if (confirm('Discard this training block?')) persist(null); }}
              className="rounded-lg border border-[var(--line-2)] px-3 text-[var(--ink-3)] hover:text-[var(--danger)] hover:border-[var(--danger)] transition-colors">
              <Trash2 size={14} />
            </button>
          </div>

          {/* Week strip — bar anchored to the weekly HOURS target */}
          <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1" style={{ scrollbarWidth: 'thin' }}>
            {block.weeksData.map((wk, i) => {
              const maxHours = Math.max(0.1, ...block.weeksData.map(w => w.targetHours));
              const taper = wk.phase === 'taper';
              return (
                <button key={wk.weekNumber} type="button" onClick={() => setSelWeek(i)}
                  className={`flex-shrink-0 w-[68px] rounded-lg border px-2 py-2 text-left transition-all ${
                    selWeek === i ? 'border-[var(--accent)] bg-[var(--accent-12)]' : 'border-[var(--line-2)]'}`}>
                  <p className="font-mono text-[9px] font-bold tracking-[0.5px] text-[var(--ink-2)]">WK {wk.weekNumber}</p>
                  <p className="font-mono text-[8px] tracking-[0.5px] uppercase mt-0.5"
                     style={{ color: taper ? '#4FC3F7' : wk.isDeload ? '#FFB547' : 'var(--ink-3)' }}>
                    {taper ? 'Taper' : wk.isDeload ? 'Deload' : PHASE_LABEL[wk.phase]}
                  </p>
                  <p className="font-mono text-[9px] font-bold text-[var(--ink-1)] mt-0.5">{wk.targetHours}h</p>
                  <div className="h-1 mt-1 rounded-full bg-[var(--bg-3)] overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(wk.targetHours / maxHours) * 100}%`, background: 'var(--accent)' }} />
                  </div>
                </button>
              );
            })}
          </div>

          {/* Selected week meta */}
          {week && (
            <div className="flex items-center justify-between mt-3 mb-2">
              <p className="font-mono text-[11px] font-bold tracking-[0.5px]">
                Week {week.weekNumber} · {week.phase === 'taper' ? 'Taper' : week.isDeload ? 'Deload' : PHASE_LABEL[week.phase]} · {week.targetHours}h
              </p>
              <div className="flex items-center gap-3">
                <span className="font-mono text-[9px] text-[var(--ink-3)]">{trainingDayCount(week)} days</span>
                {selWeek < block.weeksData.length - 1 && (
                  <button type="button"
                    onClick={() => mutate(b => { b.weeksData[selWeek + 1].days = structuredClone(b.weeksData[selWeek].days); })}
                    className="flex items-center gap-1 font-mono text-[9px] font-bold uppercase tracking-[0.5px] text-[var(--ink-3)] hover:text-[var(--accent)]">
                    <Copy size={10} /> Copy → next
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Day stack */}
          {week && (
            <div className="flex flex-col gap-2">
              {week.days.map(day => {
                const brick = isBrickDay(day);
                const rest = day.sessions.length === 0;
                return (
                  <div key={day.dow} className="rounded-lg border border-[var(--line-2)] bg-[var(--bg-2)] p-2.5">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] font-bold tracking-[1px] text-[var(--ink-1)] w-9">{DOW_LABEL[day.dow]}</span>
                        {brick && <span className="font-mono text-[8px] font-bold tracking-[0.5px] uppercase text-[#6DFF99] border border-[#6DFF99]/40 rounded px-1">Brick</span>}
                        {rest && <span className="flex items-center gap-1 font-mono text-[8px] font-bold tracking-[0.5px] uppercase text-[var(--ink-3)]"><Moon size={9} /> Rest</span>}
                      </div>
                      <button type="button" onClick={() => setEditor({ weekIdx: selWeek, dow: day.dow })}
                        className="flex items-center gap-1 font-mono text-[9px] font-bold uppercase tracking-[0.5px] text-[var(--accent)]">
                        <Plus size={11} /> Add
                      </button>
                    </div>
                    {!rest && (
                      <div className="flex flex-col gap-1.5">
                        {day.sessions.map(s => {
                          const { Icon, color } = DISC_META[s.discipline];
                          const hasMeta = !!(s.keySession || s.zone || (s.discipline === 'run' && s.paceSecPerMile) || s.fuelKcalPerHr);
                          return (
                            <button key={s.id} type="button"
                              onClick={() => setEditor({ weekIdx: selWeek, dow: day.dow, sessionId: s.id })}
                              className="flex flex-col gap-1 rounded-md bg-[var(--bg-1)] border border-[var(--line)] px-2 py-1.5 text-left">
                              <div className="flex items-center gap-2 w-full">
                                <Icon size={14} style={{ color }} className="flex-shrink-0" />
                                <span className="font-mono text-[8px] font-bold tracking-[0.5px] uppercase rounded px-1 py-0.5"
                                      style={{ color: 'var(--bg-0)', background: s.timeOfDay === 'am' ? '#FFB547' : '#8B7DFF' }}>
                                  {s.timeOfDay.toUpperCase()}
                                </span>
                                <span className="font-mono text-[11px] text-[var(--ink-1)] truncate flex-1">
                                  {DISCIPLINE_LABEL[s.discipline]} · {INTENSITY_LABEL[s.intensity]}
                                </span>
                                <span className="font-mono text-[10px] text-[var(--ink-3)] flex-shrink-0">
                                  {s.discipline !== 'swim' && s.distance ? u.fmtDistance(s.distance) : s.durationMin ? `${s.durationMin}'` : ''}
                                </span>
                              </div>
                              {hasMeta && (
                                <div className="flex items-center flex-wrap gap-1.5 pl-[22px]">
                                  {s.keySession && (
                                    <span className="font-mono text-[8px] font-bold tracking-[0.5px] uppercase rounded px-1 py-0.5 text-[var(--bg-0)]" style={{ background: 'var(--accent)' }}>
                                      ★ {s.keySession}
                                    </span>
                                  )}
                                  {s.zone && <span className="font-mono text-[9px] text-[var(--ink-3)]">{ZONE_LABEL[s.zone]}</span>}
                                  {s.discipline === 'run' && s.paceSecPerMile && (
                                    <span className="font-mono text-[9px] text-[var(--ink-3)]">@ {formatPace(s.paceSecPerMile, u.isMetric ? 'km' : 'mi')}/{u.distanceUnit}</span>
                                  )}
                                  {s.fuelKcalPerHr && (
                                    <span className="font-mono text-[9px]" style={{ color: '#FFB547' }}>🔥 {s.fuelKcalPerHr} kcal/hr ({sessionFuelKcal(s)} total)</span>
                                  )}
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Session editor bottom-sheet */}
      <AnimatePresence>
        {editor && week && (
          <SessionEditor
            target={editor}
            block={block}
            liftDayNames={liftProgram?.days.map(d => d.name) ?? []}
            u={u}
            onClose={() => setEditor(null)}
            onSave={(session) => {
              mutate(b => {
                const day = b.weeksData[editor.weekIdx].days.find(d => d.dow === editor.dow)!;
                if (editor.sessionId) {
                  const idx = day.sessions.findIndex(s => s.id === editor.sessionId);
                  if (idx >= 0) day.sessions[idx] = session;
                } else {
                  day.sessions.push(session);
                }
                // Keep AM before PM for readability.
                day.sessions.sort((a, c) => (a.timeOfDay === c.timeOfDay ? 0 : a.timeOfDay === 'am' ? -1 : 1));
              });
              setEditor(null);
            }}
            onDelete={editor.sessionId ? () => {
              mutate(b => {
                const day = b.weeksData[editor.weekIdx].days.find(d => d.dow === editor.dow)!;
                day.sessions = day.sessions.filter(s => s.id !== editor.sessionId);
              });
              setEditor(null);
            } : undefined}
          />
        )}
      </AnimatePresence>
    </section>
  );
}

// ── Small presentational helpers ──────────────────────────────────────────────
function Label({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[var(--ink-3)] mb-1.5">{children}</p>;
}
function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`flex-1 rounded-lg border py-2 font-mono text-[12px] font-bold tracking-[0.5px] transition-all ${
        active ? 'border-[var(--accent)] bg-[var(--accent-12)] text-[var(--accent)]' : 'border-[var(--line-2)] text-[var(--ink-2)]'}`}>
      {children}
    </button>
  );
}

// ── Session editor (bottom sheet) ─────────────────────────────────────────────
function SessionEditor({
  target, block, liftDayNames, u, onClose, onSave, onDelete,
}: {
  target: EditorTarget;
  block: TrainingBlock;
  liftDayNames: string[];
  u: ReturnType<typeof useUnits>;
  onClose: () => void;
  onSave: (s: BlockSession) => void;
  onDelete?: () => void;
}) {
  const existing = useMemo(() => {
    if (!target.sessionId) return null;
    const day = block.weeksData[target.weekIdx].days.find(d => d.dow === target.dow);
    return day?.sessions.find(s => s.id === target.sessionId) ?? null;
  }, [target, block]);

  const [discipline, setDiscipline] = useState<Discipline>(existing?.discipline ?? 'run');
  const [timeOfDay, setTimeOfDay]   = useState<TimeOfDay>(existing?.timeOfDay ?? 'am');
  const [intensity, setIntensity]   = useState<SessionIntensity>(existing?.intensity ?? 'easy');
  const [durationMin, setDurationMin] = useState<string>(existing?.durationMin ? String(existing.durationMin) : '');
  const [distance, setDistance]     = useState<string>(existing?.distance ? u.dispDistance(existing.distance) : '');
  const [liftDayName, setLiftDayName] = useState<string>(existing?.liftDayName ?? (liftDayNames[0] ?? ''));
  const [note, setNote] = useState<string>(existing?.note ?? '');

  const isLift = discipline === 'lift';
  const intensities = isLift ? LIFT_INTENSITIES : CARDIO_INTENSITIES;

  // Keep intensity valid when switching discipline class.
  useEffect(() => {
    if (!intensities.includes(intensity)) setIntensity(intensities[0]);
  }, [discipline]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = () => {
    const s: BlockSession = {
      id: existing?.id ?? newSessionId(),
      discipline, timeOfDay, intensity,
      ...(durationMin ? { durationMin: Math.round(parseFloat(durationMin)) } : {}),
      ...(!isLift && discipline !== 'swim' && distance ? { distance: u.toStoredDistance(parseFloat(distance)) } : {}),
      ...(isLift && liftDayName ? { liftDayName } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    onSave(s);
  };

  return (
    <motion.div className="fixed inset-0 z-[300] flex items-end md:items-center justify-center"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose} style={{ background: 'rgba(0,0,0,0.6)' }}>
      <motion.div
        className="w-full md:max-w-md max-h-[88dvh] flex flex-col rounded-t-2xl md:rounded-2xl border-t md:border border-[var(--line)] bg-[var(--bg-1)] overflow-hidden"
        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', damping: 28, stiffness: 300 }}
        onClick={e => e.stopPropagation()}>
        {/* Header (pinned) */}
        <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-[var(--line)] flex-shrink-0">
          <h3 className="font-display text-[16px] tracking-[1px]">{existing ? 'EDIT SESSION' : 'ADD SESSION'} · {DOW_LABEL[target.dow]}</h3>
          <button type="button" onClick={onClose} className="text-[var(--ink-3)] p-1"><X size={18} /></button>
        </div>

        {/* Fields (scrollable) */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">
          <Label>Discipline</Label>
          <div className="grid grid-cols-4 gap-2 mb-4">
            {(['lift', 'run', 'bike', 'swim'] as Discipline[]).map(d => {
              const { Icon, color } = DISC_META[d];
              return (
                <button key={d} type="button" onClick={() => setDiscipline(d)}
                  className={`flex flex-col items-center gap-1 rounded-lg border py-2.5 transition-all ${
                    discipline === d ? 'border-[var(--accent)] bg-[var(--accent-12)]' : 'border-[var(--line-2)]'}`}>
                  <Icon size={18} style={{ color }} />
                  <span className="font-mono text-[9px] font-bold tracking-[0.5px]">{DISCIPLINE_LABEL[d]}</span>
                </button>
              );
            })}
          </div>

          <Label>Time of day</Label>
          <div className="flex gap-2 mb-4">
            {(['am', 'pm'] as TimeOfDay[]).map(t => (
              <Chip key={t} active={timeOfDay === t} onClick={() => setTimeOfDay(t)}>{t === 'am' ? 'AM' : 'PM'}</Chip>
            ))}
          </div>

          <Label>Intensity</Label>
          <div className="flex flex-wrap gap-2 mb-4">
            {intensities.map(it => (
              <button key={it} type="button" onClick={() => setIntensity(it)}
                className={`rounded-lg border px-3 py-1.5 font-mono text-[11px] font-bold tracking-[0.5px] transition-all ${
                  intensity === it ? 'border-[var(--accent)] bg-[var(--accent-12)] text-[var(--accent)]' : 'border-[var(--line-2)] text-[var(--ink-2)]'}`}>
                {INTENSITY_LABEL[it]}
              </button>
            ))}
          </div>

          {isLift && liftDayNames.length > 0 && (
            <>
              <Label>Lifting-program day (loads coached sets)</Label>
              <select value={liftDayName} onChange={e => setLiftDayName(e.target.value)}
                className="que-input w-full mb-4 font-mono text-[12px]">
                {liftDayNames.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </>
          )}

          <div className="flex gap-3 mb-4">
            <div className="flex-1">
              <Label>Duration (min)</Label>
              <input type="number" inputMode="numeric" value={durationMin} onChange={e => setDurationMin(e.target.value)}
                className="que-input w-full font-mono text-[12px]" placeholder="e.g. 60" />
            </div>
            {!isLift && discipline !== 'swim' && (
              <div className="flex-1">
                <Label>Distance ({u.distanceUnit})</Label>
                <input type="number" inputMode="decimal" value={distance} onChange={e => setDistance(e.target.value)}
                  className="que-input w-full font-mono text-[12px]" placeholder="optional" />
              </div>
            )}
          </div>

          <Label>Note</Label>
          <input type="text" value={note} onChange={e => setNote(e.target.value)}
            className="que-input w-full font-mono text-[12px]" placeholder="optional (e.g. brick off the bike)" />
        </div>

        {/* Actions (pinned above the nav + safe area) */}
        <div className="flex gap-2 px-4 pt-3 border-t border-[var(--line)] flex-shrink-0"
          style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>
          {onDelete && (
            <button type="button" onClick={onDelete}
              className="rounded-lg border border-[var(--danger)]/40 text-[var(--danger)] px-3 py-2.5">
              <Trash2 size={15} />
            </button>
          )}
          <button type="button" onClick={save}
            className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-[var(--accent)] text-[var(--bg-0)] font-mono text-[12px] font-bold uppercase tracking-[1px] py-2.5">
            <Check size={14} /> {existing ? 'Save' : 'Add session'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
