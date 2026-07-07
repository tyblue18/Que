'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { AnimatePresence, motion, useDragControls } from 'framer-motion';
import { Plus, X, Trash2, Pencil, Flame } from 'lucide-react';
import Lottie from 'lottie-react';
import coinAnim      from '@/public/Calorie_Coin_animation.json';
import celebrateAnim from '@/public/Celebrate_animation.json';
import { useApp } from '@/lib/AppContext';
import type { FoodEntry, UserProfile } from '@/lib/AppContext';
import { recordFood } from '@/lib/foodUsage';
import { trackEvent } from '@/lib/telemetry';
import { computeBaseBudget, loadCoins, saveCoins, isGoalDay, hitGoal, dayMaintenanceFromRecord, type PlanDirection, type CoinData } from '@/lib/calorie-utils';
import {
  DonutChart, MacroBar, MacroGoalModal,
  type MacroGoals, loadMacroGoals, saveMacroGoals, getBaseline,
} from '@/components/calorie/MacroGoals';
import {
  AddFoodModal,
  FIXED_MEALS, MEAL_LABELS, DEFAULT_ORDER, getMealLabel,
} from '@/components/calorie/AddFoodModal';
import { useBudgetMetrics, type CardioFields, parseNum, fmtDateLong, loadPlan } from '@/lib/metricsTypes';
import { useUnits } from '@/lib/units';
import { useSpotlightBorder } from '@/hooks/useSpotlightBorder';
import { CelebrationModal, ProjectionModal } from '@/components/metrics/MetricsModals';

// ── Calorie Coin system ───────────────────────────────────────────────────────
// computeBaseBudget, loadCoins, saveCoins, isGoalDay (the plan-aware goal
// predicate), and the CoinData interface live in lib/calorie-utils.

function streakEndingAt(
  db: Record<string, { budget?: unknown; calsEaten?: unknown; tdee?: unknown; burn?: unknown }>,
  dateStr: string,
  fallback: number,
  direction: PlanDirection,
): number {
  let count = 0;
  const d = new Date(dateStr + 'T00:00:00');
  for (let i = 0; i < 366; i++) {
    const ds  = [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
    const rec = db[ds];
    if (!rec) break;
    const b     = (parseFloat(String(rec.budget ?? '0')) || 0) || fallback;
    const maint = dayMaintenanceFromRecord(rec);
    if (!isGoalDay(rec.calsEaten, b, maint, direction)) break;
    count++;
    d.setDate(d.getDate() - 1);
  }
  return count;
}

function coinsForStreak(streak: number): number {
  return Math.floor(streak / 7) + 1;
}

// ── Coin award modal ──────────────────────────────────────────────────────────

function CoinAwardModal({ open, onClose, total, dateLabel, earned = 1 }: {
  open: boolean; onClose: () => void; total: number; dateLabel: string; earned?: number;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[500] flex items-end md:items-center justify-center backdrop-blur-sm px-3 md:px-0"
          style={{ background: 'rgba(7,8,10,0.92)' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          onClick={e => { if (e.target === e.currentTarget) onClose(); }}
        >
          <motion.div
            className="w-full md:max-w-[360px] rounded-t-2xl md:rounded-2xl bg-[var(--bg-1)] overflow-hidden"
            initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            style={{ boxShadow: '0 0 0 1px rgba(255,181,71,0.5), 0 0 40px rgba(255,181,71,0.2), 0 40px 80px rgba(0,0,0,0.6)' }}
          >
            {/* Coin animation */}
            <div className="flex justify-center bg-[var(--bg-2)] py-2">
              <Lottie animationData={coinAnim} loop={false} autoplay={true} style={{ width: 160, height: 160 }} />
            </div>

            <div className="px-6 pb-7 pt-4 text-center space-y-2">
              <p className="font-mono text-[10px] font-bold tracking-[2px] uppercase" style={{ color: '#FFB547' }}>
                Calorie Coin{earned > 1 ? 's' : ''} Earned
              </p>
              <h3 className="font-display text-[32px] tracking-[2px] uppercase text-[var(--ink-0)]">
                +{earned} 🪙
              </h3>
              {earned > 1 && (
                <p className="font-mono text-[10px] font-bold tracking-[0.5px]" style={{ color: '#FFB547' }}>
                  Week {earned} streak bonus ×{earned}
                </p>
              )}
              <p className="font-mono text-[11px] text-[var(--ink-2)] tracking-[0.5px]">
                Within 100 kcal of your goal on {dateLabel}.
              </p>

              {/* Coin stack display */}
              <div className="flex items-center justify-center gap-2 py-3">
                {Array.from({ length: Math.min(total, 7) }).map((_, i) => (
                  <motion.div
                    key={i}
                    initial={{ y: -8, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.3 + i * 0.06, duration: 0.3 }}
                    className="w-7 h-7 rounded-full flex items-center justify-center text-[14px] font-bold"
                    style={{ background: 'rgba(255,181,71,0.2)', border: '2px solid rgba(255,181,71,0.6)' }}
                  >
                    🪙
                  </motion.div>
                ))}
                {total > 7 && (
                  <span className="font-mono text-[11px] font-bold" style={{ color: '#FFB547' }}>+{total - 7}</span>
                )}
              </div>

              <p className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.5px]">
                {total} coin{total !== 1 ? 's' : ''} total
              </p>

              <button onClick={onClose} className="que-btn-primary w-full py-3 mt-2"
                style={{ background: '#FFB547', boxShadow: '0 0 0 1px #FFB547, 0 0 20px rgba(255,181,71,0.3)' }}>
                Collect!
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Edit food modal ───────────────────────────────────────────────────────────

function EditFoodModal({ food, onClose, onSave, mealOrder = DEFAULT_ORDER }: {
  food: FoodEntry | null;
  onClose: () => void;
  onSave: (updated: FoodEntry) => void;
  mealOrder?: string[];
}) {
  const [name,     setName]     = useState('');
  const [servings, setServings] = useState(1);
  const [meal,     setMeal]     = useState<string>('breakfast');
  const [kcalPS,    setKcalPS]    = useState(0);
  const [proteinPS, setProteinPS] = useState(0);
  const [carbsPS,   setCarbsPS]   = useState(0);
  const [fatPS,     setFatPS]     = useState(0);

  useEffect(() => {
    if (!food) return;
    const s = Math.max(0.5, food.servings);
    setName(food.name);
    setServings(food.servings);
    setMeal(food.meal ?? 'breakfast');
    setKcalPS(   +(food.kcal    / s).toFixed(2));
    setProteinPS(+(food.protein / s).toFixed(3));
    setCarbsPS(  +(food.carbs   / s).toFixed(3));
    setFatPS(    +(food.fat     / s).toFixed(3));
  }, [food?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const newKcal    = Math.round(kcalPS    * servings);
  const newProtein = Math.round(proteinPS * servings * 10) / 10;
  const newCarbs   = Math.round(carbsPS   * servings * 10) / 10;
  const newFat     = Math.round(fatPS     * servings * 10) / 10;

  const save = () => {
    if (!food) return;
    onSave({ ...food, meal, name: name.trim() || food.name, servings, kcal: newKcal, protein: newProtein, carbs: newCarbs, fat: newFat });
  };

  return (
    <AnimatePresence>
      {food && (
        <motion.div
          className="fixed inset-0 z-[350] flex items-end md:items-center justify-center backdrop-blur-sm px-0 md:px-3"
          style={{ background: 'rgba(7,8,10,0.88)' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={e => { if (e.target === e.currentTarget) onClose(); }}
        >
          <motion.div
            className="w-full md:max-w-[460px] max-h-[88dvh] flex flex-col rounded-t-2xl md:rounded-2xl bg-[var(--bg-1)] overflow-hidden"
            initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 60, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            style={{ boxShadow: '0 0 0 1px var(--line-2), 0 -2px 0 0 var(--accent), 0 40px 80px rgba(0,0,0,0.6)' }}
          >
            {/* Header */}
            <div className="flex-shrink-0 flex items-center justify-between px-5 pt-5 pb-4 border-b border-[var(--line)]">
              <h3 className="font-display text-[18px] tracking-[2px] uppercase text-[var(--ink-0)]">Edit Food</h3>
              <button onClick={onClose} className="w-11 h-11 flex items-center justify-center text-[var(--ink-2)] hover:text-[var(--accent)] transition-colors">
                <X size={20} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4 pb-8">
              {/* Name */}
              <div>
                <label className="que-label">Name</label>
                <input type="text" className="que-input" value={name}
                  onChange={e => setName(e.target.value)} />
              </div>

              {/* Meal picker */}
              {mealOrder.length > 1 && (
                <div>
                  <label className="que-label">Meal</label>
                  <div className="flex flex-wrap gap-1.5">
                    {mealOrder.map(id => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setMeal(id)}
                        className={[
                          'px-3 py-1.5 rounded-sm font-mono text-[9px] font-bold tracking-[1px] uppercase transition-all border',
                          meal === id
                            ? 'bg-[var(--accent)] text-[var(--accent-ink)] border-[var(--accent)]'
                            : 'border-[var(--line-2)] text-[var(--ink-2)] hover:border-[var(--accent)]/60 hover:text-[var(--ink-0)]',
                        ].join(' ')}
                      >
                        {getMealLabel(id, mealOrder)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Serving info */}
              <div>
                <p className="font-mono text-[9px] font-bold tracking-[1.5px] uppercase text-[var(--ink-3)] mb-2">
                  Servings · {food.servingDesc} each
                </p>
                <div className="flex items-center gap-3">
                  <button type="button"
                    onClick={() => setServings(s => Math.max(0.5, +(s - 0.5).toFixed(1)))}
                    className="w-11 h-11 flex items-center justify-center rounded-sm border border-[var(--line-2)] bg-[var(--bg-2)] text-[var(--ink-0)] text-xl hover:border-[var(--accent)] hover:text-[var(--accent)] transition-all">−</button>
                  <span className="font-display tabular text-[26px] text-[var(--accent)] min-w-[52px] text-center leading-none">
                    {servings}
                  </span>
                  <button type="button"
                    onClick={() => setServings(s => +(s + 0.5).toFixed(1))}
                    className="w-11 h-11 flex items-center justify-center rounded-sm border border-[var(--line-2)] bg-[var(--bg-2)] text-[var(--ink-0)] text-xl hover:border-[var(--accent)] hover:text-[var(--accent)] transition-all">+</button>
                </div>
              </div>

              {/* Macro preview */}
              <div className="rounded border border-[var(--line-2)] bg-[var(--bg-2)] p-3">
                <div className="grid grid-cols-4 gap-2 text-center">
                  {[
                    { label: 'Calories', value: newKcal,    unit: 'kcal', accent: true },
                    { label: 'Protein',  value: newProtein, unit: 'g' },
                    { label: 'Carbs',    value: newCarbs,   unit: 'g' },
                    { label: 'Fat',      value: newFat,     unit: 'g' },
                  ].map(m => (
                    <div key={m.label}>
                      <p className="font-display text-[20px] leading-none" style={{ color: m.accent ? 'var(--accent)' : 'var(--ink-0)' }}>{m.value}</p>
                      <p className="font-mono text-[8px] text-[var(--ink-3)] mt-0.5">{m.unit}</p>
                      <p className="font-mono text-[7px] text-[var(--ink-3)] uppercase tracking-[0.5px]">{m.label}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2">
                <button type="button" onClick={onClose} className="flex-1 que-btn-ghost py-3.5">Cancel</button>
                <button type="button" onClick={save}    className="flex-1 que-btn-primary py-3.5">Save</button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Food log item ─────────────────────────────────────────────────────────────

function FoodLogItem({ food, onRemove, onEdit, onMoveUp, onMoveDown, canMoveUp, canMoveDown }: {
  food: FoodEntry; onRemove: () => void; onEdit: () => void;
  onMoveUp?: () => void; onMoveDown?: () => void;
  canMoveUp?: boolean; canMoveDown?: boolean;
}) {
  const dragControls = useDragControls();

  return (
    <motion.div
      drag="y"
      dragListener={false}
      dragControls={dragControls}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={0.1}
      dragMomentum={false}
      onDragEnd={(_: unknown, info: { offset: { y: number } }) => {
        if (info.offset.y < -55 && canMoveUp)   onMoveUp?.();
        if (info.offset.y >  55 && canMoveDown) onMoveDown?.();
      }}
      className="flex items-center gap-2 py-3.5 border-b border-[var(--line)] last:border-0"
    >
      {/* Drag grip — 44×44 touch target */}
      <div
        className="touch-none cursor-grab active:cursor-grabbing text-[var(--ink-3)] flex-shrink-0 w-10 h-10 flex items-center justify-center"
        onPointerDown={e => { e.preventDefault(); dragControls.start(e); }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="8"  cy="6"  r="1.3" fill="currentColor"/>
          <circle cx="16" cy="6"  r="1.3" fill="currentColor"/>
          <circle cx="8"  cy="12" r="1.3" fill="currentColor"/>
          <circle cx="16" cy="12" r="1.3" fill="currentColor"/>
          <circle cx="8"  cy="18" r="1.3" fill="currentColor"/>
          <circle cx="16" cy="18" r="1.3" fill="currentColor"/>
        </svg>
      </div>

      {/* Food info — tap to edit */}
      <button type="button" onClick={onEdit} className="flex-1 min-w-0 text-left group/edit">
        <div className="flex items-center gap-1.5 min-w-0">
          <p className="font-mono text-[13px] font-semibold text-[var(--ink-0)] truncate">{food.name}</p>
          <Pencil size={10} className="flex-shrink-0 text-[var(--ink-4)] group-hover/edit:text-[var(--accent)] group-active/edit:text-[var(--accent)] transition-colors" />
        </div>
        {food.brand && <p className="font-mono text-[10px] text-[var(--ink-3)] truncate">{food.brand}</p>}
        <p className="font-mono text-[10px] text-[var(--ink-3)] mt-0.5">
          {food.servings} × {food.servingDesc}
        </p>
      </button>

      {/* Macros */}
      <div className="text-right flex-shrink-0">
        <p className="font-display text-[20px] leading-none" style={{ color: 'var(--accent)' }}>{food.kcal}</p>
        <p className="font-mono text-[9px] text-[var(--ink-3)]">kcal</p>
        <p className="font-mono text-[9px] text-[var(--ink-3)] mt-0.5">P{food.protein} C{food.carbs} F{food.fat}g</p>
      </div>

      {/* Remove — 44×44 */}
      <button
        type="button" onClick={onRemove}
        className="text-[var(--ink-3)] hover:text-[var(--danger)] active:text-[var(--danger)] transition-colors flex-shrink-0 w-11 h-11 flex items-center justify-center rounded"
      >
        <Trash2 size={16} />
      </button>
    </motion.div>
  );
}

// ── Today's Log Card ─────────────────────────────────────────────────────────

function DailyLogCard({
  todayLabel, todayWeight, todayCals, todayProtein,
  onWeightChange, onLogToday, undereatingWarning,
}: {
  todayLabel: string; todayWeight: string; todayCals: string; todayProtein: string;
  onWeightChange: (v: string) => void;
  onLogToday: () => void;
  undereatingWarning: boolean;
}) {
  const spotlight = useSpotlightBorder({ color: '79,195,247', size: 260, opacity: 0.45 });

  return (
    <div
      ref={spotlight.ref}
      onMouseMove={spotlight.onMouseMove}
      onMouseLeave={spotlight.onMouseLeave}
      onTouchMove={spotlight.onTouchMove}
      onTouchEnd={spotlight.onTouchEnd}
      className="que-card mb-4"
    >
      {spotlight.Overlay}
      <div className="p-5">
        <div className="flex items-baseline justify-between mb-5">
          <h2 className="que-section-label"><span className="dot" />TODAY&apos;S LOG</h2>
          <span className="font-mono text-[10px] text-[var(--ink-3)] tracking-[1px]">{todayLabel}</span>
        </div>

        {undereatingWarning && (
          <div className="flex items-start gap-2 rounded border border-[var(--warn)]/40 bg-[var(--warn)]/6 px-3 py-2.5 mb-4">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#FFB547" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 mt-px" aria-hidden>
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <p className="font-mono text-[9px] text-[var(--warn)] leading-relaxed tracking-[0.3px]">
              You&apos;ve been eating well under budget for 3+ days — this can slow metabolism over time.
            </p>
          </div>
        )}

        <div className="grid grid-cols-3 gap-3 mb-4">
          <div>
            <label className="que-label">Weight / lbs</label>
            <input
              type="number" inputMode="decimal" className="que-input"
              value={todayWeight} onChange={e => onWeightChange(e.target.value)}
              placeholder="e.g. 180"
            />
          </div>
          <div>
            <label className="que-label">Calories</label>
            <div className="que-input flex items-center font-mono text-[13px] text-[var(--ink-1)] bg-[var(--bg-3)] cursor-default select-none">
              {todayCals || '—'}
            </div>
          </div>
          <div>
            <label className="que-label">Protein / g</label>
            <div className="que-input flex items-center font-mono text-[13px] text-[var(--ink-1)] bg-[var(--bg-3)] cursor-default select-none">
              {todayProtein || '—'}
            </div>
          </div>
        </div>

        <button onClick={onLogToday} className="que-btn-primary w-full">
          LOG TODAY
        </button>
      </div>
    </div>
  );
}

// ── Main Calorie Tracker ──────────────────────────────────────────────────────

export default function CalorieTracker() {
  const { localDB, updateDayRecord, todayStr, activeDayFocus, today, profile, persistProfile, getLastKnownWeight } = useApp();
  const activeRec = localDB[activeDayFocus] ?? {};
  const [showModal,    setShowModal]    = useState(false);
  const [targetMeal,   setTargetMeal]   = useState<string>('breakfast');
  const [coinData,      setCoinData]     = useState<CoinData>(() => loadCoins());
  const [pendingCoin,   setPendingCoin]  = useState<{ date: string; label: string; amount: number } | null>(null);
  const [macroGoals,    setMacroGoals]   = useState<MacroGoals | null>(() => loadMacroGoals());
  const [showMacroModal, setShowMacroModal] = useState(false);
  const [todayWeight, setTodayWeight] = useState('');
  const [projVisible,      setProjVisible]      = useState(false);
  const [celebrateVisible, setCelebrateVisible] = useState(false);

  const foods = useMemo((): FoodEntry[] => {
    try { return JSON.parse(String(activeRec.foods ?? '[]')); }
    catch { return []; }
  }, [activeRec.foods]);

  const mealOrder = useMemo((): string[] => {
    try { return JSON.parse(String(activeRec.foodMealOrder ?? 'null')) ?? DEFAULT_ORDER; }
    catch { return DEFAULT_ORDER; }
  }, [activeRec.foodMealOrder]);

  const foodsByMeal = useMemo(() => {
    const map: Record<string, FoodEntry[]> = {};
    for (const id of mealOrder) map[id] = [];
    for (const f of foods) {
      const key = f.meal ?? 'breakfast';
      if (!map[key]) map[key] = [];
      map[key].push(f);
    }
    return map;
  }, [foods, mealOrder]);

  const totals = useMemo(() => ({
    kcal:    foods.reduce((s, f) => s + f.kcal,    0),
    protein: +(foods.reduce((s, f) => s + f.protein, 0)).toFixed(1),
    carbs:   +(foods.reduce((s, f) => s + f.carbs,   0)).toFixed(1),
    fat:     +(foods.reduce((s, f) => s + f.fat,     0)).toFixed(1),
  }), [foods]);

  const baseBudget = useMemo(() => computeBaseBudget(profile), [profile]);

  // Build cardio from the active day's record so eat-back is live
  const todayCardio = useMemo((): CardioFields => ({
    steps:    String(activeRec.steps    ?? '0'),
    runDist:  String(activeRec.runDist  ?? '0'),
    runTime:  String(activeRec.runTime  ?? '0'),
    bikeDist: String(activeRec.bikeDist ?? '0'),
    bikeTime: String(activeRec.bikeTime ?? '0'),
    swimTime: String(activeRec.swimTime ?? '0'),
  }), [activeRec.steps, activeRec.runDist, activeRec.runTime, activeRec.bikeDist, activeRec.bikeTime, activeRec.swimTime]);

  const liveMetrics = useBudgetMetrics(profile, todayCardio);
  const u = useUnits();
  const budget      = liveMetrics.budget || baseBudget;
  const proteinTarget = Math.round(parseFloat(profile.weight) * 0.8) || 0;

  const planDir         = (loadPlan()?.type ?? null) as PlanDirection;
  const liveMaintenance = liveMetrics.tdee + liveMetrics.activityBurn;
  // LIVE "at goal" indicator + the real-time coin/celebration use the PRECISE
  // ±100-of-budget band (budget already encodes cut/bulk via the signed deficit).
  // The broad plan-aware predicate (cut = anything under maintenance, bulk = over)
  // is deliberately NOT used here: it spans ~40–100% of maintenance, which made
  // the "goal met" popup fire mid-entry at any modest intake (e.g. 1223 kcal).
  // That broad rule still governs the deliberate "Log Today" commit (handleLogToday)
  // and the server-side coin/badge economy (isGoalDay) — those are unchanged.
  const todayGoalHit = hitGoal(totals.kcal, budget);

  // Sync weight from the active day's record on load / date change
  useEffect(() => {
    const w = String(activeRec.weight ?? getLastKnownWeight(activeDayFocus) ?? '');
    setTodayWeight(w);
  }, [activeDayFocus]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleWeightChange = useCallback((val: string) => {
    setTodayWeight(val);
    updateDayRecord(activeDayFocus, { weight: val });
    // Mirror TODAY's check-in weight into the profile (the BMR/Athlete-Profile
    // weight) so the two stay in sync — but ONLY for today. Editing a PAST day's
    // weight (correcting an old log) must not overwrite the current body weight.
    if (activeDayFocus === todayStr && val && parseFloat(val) > 0) {
      persistProfile({ weight: val });
    }
  }, [activeDayFocus, todayStr, updateDayRecord, persistProfile]);

  const undereatingWarning = useMemo(() => {
    const days = Object.keys(localDB).sort().reverse();
    let streak = 0;
    for (const ds of days) {
      const r = localDB[ds];
      const eaten  = parseNum(String(r.calsEaten ?? 0));
      const bud    = parseNum(String(r.budget    ?? 0));
      if (bud > 0 && eaten > 0 && eaten < bud * 0.60) streak++;
      else break;
      if (streak >= 3) return true;
    }
    return false;
  }, [localDB]);

  const handleLogToday = useCallback(() => {
    updateDayRecord(activeDayFocus, {
      burn:   liveMetrics.activityBurn,
      budget: liveMetrics.budget || baseBudget,
      // Snapshot TDEE so plan-progress maintenance = tdee + burn stays exact
      // even if the user later changes their deficit/profile.
      ...(liveMetrics.tdee > 0 && { tdee: liveMetrics.tdee }),
      ...(todayWeight && parseFloat(todayWeight) > 0 && { weight: todayWeight }),
    });
    // Award the calorie coin here — on this DELIBERATE "Log Today" commit — not
    // in a real-time effect that re-fires on every tab open. The popup rides the
    // award (setPendingCoin), and the awardedDates guard makes it fire at most
    // once per day. Same plan-aware goal as the coin engine (under maintenance on
    // a cut, over on a bulk, ±100 with no plan).
    const hitGoalFlag = isGoalDay(totals.kcal, liveMetrics.budget || baseBudget, liveMaintenance, planDir);
    if (hitGoalFlag) {
      navigator.vibrate?.([50, 30, 80]);
      const coins = loadCoins();
      if (activeDayFocus === todayStr && !coins.awardedDates.includes(todayStr)) {
        const earned  = coinsForStreak(streakEndingAt(localDB, todayStr, baseBudget, planDir) || 1);
        const newData = { total: coins.total + earned, awardedDates: [...coins.awardedDates, todayStr] };
        saveCoins(newData);
        setCoinData(newData);
        setPendingCoin({ date: todayStr, label: 'today', amount: earned });
      } else {
        // Already earned today (or logging a past day) — celebrate without
        // re-awarding, so the coin never double-pops.
        setCelebrateVisible(true);
      }
    } else {
      setProjVisible(true);
    }
  }, [activeDayFocus, liveMetrics, baseBudget, todayWeight, totals.kcal, updateDayRecord, planDir, liveMaintenance, todayStr, localDB]);

  // On mount: scan past days for unawarded coins (only days before today).
  // Skip coin logic entirely when browsing a day other than today.
  useEffect(() => {
    if (activeDayFocus !== todayStr) return;
    const coins = loadCoins();
    const awarded = new Set(coins.awardedDates);

    const pendingDates = Object.keys(localDB)
      .filter(ds => ds < todayStr && !awarded.has(ds))
      .sort()
      .reverse();

    for (const ds of pendingDates) {
      const rec       = localDB[ds];
      const dayBudget = (parseFloat(String(rec.budget ?? '0')) || 0) || baseBudget;
      if (isGoalDay(rec.calsEaten, dayBudget, dayMaintenanceFromRecord(rec), planDir)) {
        const dayStreak = streakEndingAt(localDB, ds, baseBudget, planDir);
        const earned    = coinsForStreak(dayStreak || 1);
        const newTotal  = coins.total + earned;
        const newData   = { total: newTotal, awardedDates: [...coins.awardedDates, ds] };
        saveCoins(newData);
        setCoinData(newData);

        const d    = new Date(ds + 'T00:00:00');
        const diff = Math.round((new Date(todayStr + 'T00:00:00').getTime() - d.getTime()) / 86400000);
        const label = diff === 1 ? 'yesterday'
          : diff === 2 ? 'two days ago'
          : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

        setPendingCoin({ date: ds, label, amount: earned });
        return;
      }
    }
  }, [todayStr]); // eslint-disable-line react-hooks/exhaustive-deps

  // NOTE: today's coin is awarded on the deliberate "Log Today" press
  // (handleLogToday), NOT in a real-time effect. The old effect here re-ran on
  // every tab mount and re-popped the coin modal on each open; tying the award
  // to the explicit commit makes the popup fire exactly once. Days the user
  // never commits are picked up retroactively by the past-days scan above,
  // which shows the "yesterday" popup on the next day.

  const collectCoin = useCallback(() => {
    setPendingCoin(null);
  }, []);

  // ── Macro completion glow + celebration ────────────────────────────────────
  const hitProtein  = (macroGoals?.protein ?? 0) > 0 && totals.protein >= (macroGoals?.protein ?? Infinity);
  const hitCarbs    = (macroGoals?.carbs   ?? 0) > 0 && totals.carbs   >= (macroGoals?.carbs   ?? Infinity);
  const hitFat      = (macroGoals?.fat     ?? 0) > 0 && totals.fat     >= (macroGoals?.fat     ?? Infinity);
  const allMacrosHit = hitProtein && hitCarbs && hitFat;
  const isPerfect    = todayGoalHit && allMacrosHit;

  const [macroCelebrate, setMacroCelebrate] = useState(false);
  const prevAllHitRef = useRef(false);

  useEffect(() => {
    if (isPerfect && !prevAllHitRef.current) {
      navigator.vibrate?.([30, 15, 50, 15, 80, 20, 120, 20, 80, 15, 50, 15, 30]);
      setMacroCelebrate(true);
    }
    prevAllHitRef.current = isPerfect;
  }, [isPerfect]);

  const persistFoods = useCallback((updated: FoodEntry[], newOrder?: string[]) => {
    // Store day-level calorie + macro totals (each entry's macros are already
    // the total for its servings). Battles read these pre-summed fields, so all
    // three macros must be persisted, not just protein.
    //
    // These are written UNCONDITIONALLY (even when zero). updateDayRecord MERGES
    // partials, so omitting a field on zero — which a `kcal > 0 && {…}` guard
    // does — would leave the previous value stranded. That's the bug where
    // removing all food kept the calories deducted in Metrics and the budget.
    const kcal    = updated.reduce((s, f) => s + f.kcal, 0);
    const protein = +(updated.reduce((s, f) => s + f.protein, 0)).toFixed(1);
    const carbs   = +(updated.reduce((s, f) => s + f.carbs,   0)).toFixed(1);
    const fat     = +(updated.reduce((s, f) => s + f.fat,     0)).toFixed(1);
    updateDayRecord(activeDayFocus, {
      foods: JSON.stringify(updated),
      ...(newOrder && { foodMealOrder: JSON.stringify(newOrder) }),
      calsEaten: String(kcal),
      protein,
      carbs,
      fat,
      // Persist budget + the TDEE snapshot together (see handleLogToday) so the
      // plan ledger can reconstruct true maintenance without the deficit. burn is
      // written too so maintenance (tdee + burn) reflects the day's cardio even
      // when the user never taps "Log Today".
      ...(budget > 0 && { budget }),
      ...(liveMetrics.tdee > 0 && { tdee: liveMetrics.tdee }),
      burn: liveMetrics.activityBurn,
    });
  }, [activeDayFocus, updateDayRecord, budget, liveMetrics.tdee, liveMetrics.activityBurn]);

  const [editingFood, setEditingFood] = useState<FoodEntry | null>(null);

  const removeFood = useCallback((id: string) => {
    persistFoods(foods.filter(f => f.id !== id));
  }, [foods, persistFoods]);

  const saveEditedFood = useCallback((updated: FoodEntry) => {
    persistFoods(foods.map(f => f.id === updated.id ? updated : f));
    setEditingFood(null);
  }, [foods, persistFoods]);

  const moveFoodInSection = useCallback((foodId: string, dir: 'up' | 'down') => {
    const food = foods.find(f => f.id === foodId);
    if (!food) return;
    const sectionId = food.meal ?? 'breakfast';
    const sec = foods
      .filter(f => (f.meal ?? 'breakfast') === sectionId)
      .sort((a, b) => (a.loggedAt) - (b.loggedAt));
    const idx = sec.findIndex(f => f.id === foodId);
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sec.length) return;
    const aTs = sec[idx].loggedAt;
    const bTs = sec[swapIdx].loggedAt;
    persistFoods(foods.map(f => {
      if (f.id === sec[idx].id)     return { ...f, loggedAt: bTs };
      if (f.id === sec[swapIdx].id) return { ...f, loggedAt: aTs };
      return f;
    }));
  }, [foods, persistFoods]);

  const addFood = useCallback((food: Omit<FoodEntry, 'id' | 'loggedAt' | 'meal'>, barcode?: string) => {
    const entry: FoodEntry = {
      ...food,
      meal: targetMeal,
      id:       `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      loggedAt: Date.now(),
      ...(barcode && { barcode }),
    };
    persistFoods([...foods, entry]);
    // Track usage so the Recents/Frequents lists in the food picker stay
    // current. Fire-and-forget (synchronous localStorage write).
    recordFood(food, barcode);
    setShowModal(false);
  }, [foods, targetMeal, persistFoods]);

  /** YYYY-MM-DD for the day before the currently active day. Used to source
   *  "copy yesterday" foods — pure string arithmetic so DST doesn't bite. */
  const yesterdayStr = useMemo(() => {
    const d = new Date(activeDayFocus + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }, [activeDayFocus]);

  /** Yesterday's foods grouped by meal — used to show/hide the "Copy
   *  yesterday's [meal]" button per section. */
  const yesterdayFoodsByMeal = useMemo(() => {
    const map: Record<string, FoodEntry[]> = {};
    try {
      const yRec  = localDB[yesterdayStr] ?? {};
      const yArr  = JSON.parse(String(yRec.foods ?? '[]')) as FoodEntry[];
      for (const f of yArr) {
        const key = f.meal ?? 'breakfast';
        (map[key] ??= []).push(f);
      }
    } catch { /* corrupt — show nothing */ }
    return map;
  }, [localDB, yesterdayStr]);

  /** Clone every food from yesterday's `mealId` section into today, with fresh
   *  IDs and timestamps. Also records each into the usage tracker so frequent
   *  copies surface in Recents. */
  const copyFromYesterday = useCallback((mealId: string) => {
    const src = yesterdayFoodsByMeal[mealId];
    if (!src || src.length === 0) return;
    const baseTs = Date.now();
    const cloned: FoodEntry[] = src.map((f, i) => ({
      ...f,
      meal:     mealId,
      id:       `${baseTs + i}-${Math.random().toString(36).slice(2, 7)}`,
      loggedAt: baseTs + i,
    }));
    persistFoods([...foods, ...cloned]);
    for (const f of cloned) recordFood(f, f.barcode);
    trackEvent('meal_copied_yesterday', { meal: mealId, count: cloned.length });
  }, [foods, persistFoods, yesterdayFoodsByMeal]);

  const openModal = useCallback((meal: string) => {
    setTargetMeal(meal); setShowModal(true);
  }, []);

  const addSnack = useCallback((afterId: string) => {
    const snackId = `snack-${Date.now()}`;
    const idx = mealOrder.indexOf(afterId);
    const newOrder = [...mealOrder.slice(0, idx + 1), snackId, ...mealOrder.slice(idx + 1)];
    updateDayRecord(activeDayFocus, { foodMealOrder: JSON.stringify(newOrder) });
    setTargetMeal(snackId); setShowModal(true);
  }, [mealOrder, activeDayFocus, updateDayRecord]);

  const moveSnack = useCallback((snackId: string, dir: 'up' | 'down') => {
    const idx = mealOrder.indexOf(snackId);
    if (idx < 0) return;
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= mealOrder.length) return;
    const newOrder = [...mealOrder];
    [newOrder[idx], newOrder[swapIdx]] = [newOrder[swapIdx], newOrder[idx]];
    updateDayRecord(activeDayFocus, { foodMealOrder: JSON.stringify(newOrder) });
  }, [mealOrder, activeDayFocus, updateDayRecord]);

  const removeSnack = useCallback((snackId: string) => {
    const newOrder  = mealOrder.filter(id => id !== snackId);
    const remaining = foods.filter(f => f.meal !== snackId);
    persistFoods(remaining, newOrder);
  }, [mealOrder, foods, persistFoods]);

  const activeDate = new Date(activeDayFocus + 'T00:00:00');
  const dateTag    = `${activeDate.getMonth() + 1}/${activeDate.getDate()}`;

  return (
    <div className="max-w-2xl mx-auto px-4 py-5 pb-28 lg:py-8">

      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <span className="block w-2 h-2 rounded-full bg-[var(--accent)]" style={{ boxShadow: '0 0 8px var(--accent-40)' }} />
          <span className="font-mono text-[11px] font-bold tabular tracking-[2px] uppercase text-[var(--ink-1)]">
            Nutrition · {dateTag}
          </span>
        </div>
      </div>

      {/* Calorie summary hero — pulses golden when perfect */}
      <motion.div
        className="que-card mb-4"
        animate={isPerfect ? {
          boxShadow: [
            '0 0 0 1px rgba(255,181,71,0.35), 0 0 28px rgba(255,181,71,0.18)',
            '0 0 0 1px rgba(255,181,71,0.85), 0 0 56px rgba(255,181,71,0.5)',
            '0 0 0 1px rgba(255,181,71,0.35), 0 0 28px rgba(255,181,71,0.18)',
          ],
        } : { boxShadow: '0 0 0 0px transparent' }}
        transition={isPerfect
          ? { duration: 2, repeat: Infinity, ease: 'easeInOut' }
          : { duration: 0.5 }
        }
      >
        <div className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="que-section-label !mb-0">
              <motion.span
                className="dot"
                style={{ background: todayGoalHit ? '#FFB547' : undefined }}
                animate={isPerfect ? { boxShadow: ['0 0 4px rgba(255,181,71,0.4)', '0 0 12px rgba(255,181,71,1)', '0 0 4px rgba(255,181,71,0.4)'] } : {}}
                transition={isPerfect ? { duration: 1.4, repeat: Infinity, ease: 'easeInOut' } : {}}
              />
              {activeDayFocus === todayStr ? "TODAY'S INTAKE" : fmtDateLong(activeDayFocus)}
            </h2>
            {/* Coin stack badge */}
            {coinData.total > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-[16px]">🪙</span>
                <span className="font-mono text-[11px] font-bold" style={{ color: '#FFB547' }}>
                  ×{coinData.total}
                </span>
              </div>
            )}
          </div>

          {/* Big calorie number */}
          <div className="flex items-end gap-3 mb-4">
            <span
              className="font-display tabular leading-none text-[72px] sm:text-[96px]"
              style={{
                color:      todayGoalHit ? '#FFB547' : 'var(--accent)',
                textShadow: todayGoalHit ? '0 0 32px rgba(255,181,71,0.5)' : '0 0 32px var(--accent-40)',
                letterSpacing: '-0.04em',
              }}
            >
              {totals.kcal}
            </span>
            <div className="pb-2">
              <span className="font-display text-[22px] tracking-[2px] text-[var(--ink-2)]">kcal</span>
              {todayGoalHit && (
                <p className="font-mono text-[9px] font-bold tracking-[1px] uppercase mt-0.5" style={{ color: '#FFB547' }}>
                  ✓ Goal hit!
                </p>
              )}
              {budget > 0 && !todayGoalHit && (() => {
                const rem = budget - totals.kcal;
                const over = rem < 0;
                return (
                  <div className="mt-0.5">
                    <p className="font-mono text-[9px] text-[var(--ink-3)] tracking-[0.5px]">
                      of {budget} budget
                    </p>
                    <p
                      className="font-mono text-[13px] font-bold tracking-[0.5px]"
                      style={{
                        color:      over ? 'var(--danger)' : 'var(--accent)',
                        textShadow: over
                          ? '0 0 12px rgba(255,77,94,0.6)'
                          : '0 0 12px var(--accent-40)',
                      }}
                    >
                      {over ? `${Math.abs(rem)} over` : `${rem} left`}
                    </p>
                  </div>
                );
              })()}
            </div>
          </div>

          {/* ── Training credit — makes the eat-back VISIBLE. This is Que's whole
               point: your food budget knows your training. Only renders on days
               with logged cardio (eatBack > 0; steps don't count toward it). The
               run/bike/swim burns + the day's distances all come from liveMetrics,
               which is keyed to the day being viewed, so the copy always matches. ── */}
          {liveMetrics.eatBack > 0 && (() => {
            const runDist  = parseNum(String(activeRec.runDist  ?? 0));
            const bikeDist = parseNum(String(activeRec.bikeDist ?? 0));
            const swimMin  = parseNum(String(activeRec.swimTime ?? 0));
            const parts: string[] = [];
            if (liveMetrics.runBurn  > 0) parts.push(runDist  > 0 ? `ran ${u.fmtDistance(runDist)}`  : 'ran');
            if (liveMetrics.bikeBurn > 0) parts.push(bikeDist > 0 ? `biked ${u.fmtDistance(bikeDist)}` : 'biked');
            if (liveMetrics.swimBurn > 0) parts.push(swimMin  > 0 ? `swam ${Math.round(swimMin)} min` : 'swam');
            const did  = parts.length ? parts.join(' · ') : 'trained';
            const when = activeDayFocus === todayStr ? 'today' : 'that day';
            return (
              <div
                className="mb-4 flex items-start gap-2.5 rounded-lg border px-3 py-2.5"
                style={{ borderColor: 'var(--accent-24)', background: 'var(--accent-12)' }}
              >
                <Flame size={15} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--accent)' }} aria-hidden="true" />
                <div className="min-w-0">
                  <p className="font-mono text-[12px] font-bold tracking-[0.3px]" style={{ color: 'var(--accent)' }}>
                    +{liveMetrics.eatBack} kcal added because you {did} {when}
                  </p>
                  <p className="font-mono text-[9px] text-[var(--ink-3)] tracking-[0.3px] mt-0.5">
                    Your training burned {liveMetrics.activityBurn} kcal — Que adds 60% of that back to your budget.
                  </p>
                </div>
              </div>
            );
          })()}

          {/* Calorie progress bar */}
          {budget > 0 && (
            <div className="mb-4">
              <div className="h-2 bg-[var(--bg-3)] rounded-full overflow-hidden">
                <motion.div
                  className="h-full rounded-full"
                  style={{
                    background: totals.kcal > budget ? 'var(--danger)' : 'var(--accent)',
                    boxShadow: totals.kcal > budget ? '0 0 8px rgba(255,77,94,0.4)' : '0 0 8px var(--accent-40)',
                  }}
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(100, (totals.kcal / budget) * 100)}%` }}
                  transition={{ duration: 0.6, ease: 'easeOut' }}
                />
              </div>
            </div>
          )}

          {/* Macro breakdown + goals */}
          <div className="flex items-center gap-4">
            {/* Donut chart — shows target distribution */}
            <button
              type="button"
              onClick={() => setShowMacroModal(true)}
              className="flex-shrink-0 relative group"
              title="Set macro goals"
            >
              <DonutChart
                protein={macroGoals?.protein ?? 0}
                carbs={macroGoals?.carbs ?? 0}
                fat={macroGoals?.fat ?? 0}
                size={120}
              />
              {/* Tap hint */}
              <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 group-active:opacity-100 transition-opacity">
                <span className="font-mono text-[8px] font-bold tracking-[1px] uppercase text-[var(--accent)] bg-[var(--bg-1)]/80 rounded px-1.5 py-0.5">
                  Edit
                </span>
              </span>
            </button>

            {/* Actual vs goal bars */}
            <div className="flex-1 space-y-2.5 min-w-0">
              <MacroBar label="Protein" value={totals.protein} max={macroGoals?.protein ?? proteinTarget} color="#4FC3F7" hit={hitProtein}  allHit={isPerfect} />
              <MacroBar label="Carbs"   value={totals.carbs}   max={macroGoals?.carbs   ?? 0}             color="#FFB547" hit={hitCarbs}    allHit={isPerfect} />
              <MacroBar label="Fat"     value={totals.fat}      max={macroGoals?.fat     ?? 0}             color="#6DFF99" hit={hitFat}      allHit={isPerfect} />
              <button
                type="button"
                onClick={() => setShowMacroModal(true)}
                className="font-mono text-[9px] font-bold tracking-[1px] uppercase text-[var(--ink-3)] hover:text-[var(--accent)] active:text-[var(--accent)] transition-colors"
              >
                {macroGoals ? '⚙ Edit goals' : '⚙ Set macro goals'}
              </button>
            </div>
          </div>
        </div>
      </motion.div>

      {/* ── Meal sections ──────────────────────────────────────────── */}
      {mealOrder.map((sectionId, sectionIdx) => {
        const isSnack      = !FIXED_MEALS.includes(sectionId as typeof FIXED_MEALS[number]);
        const label        = isSnack ? 'Snack' : MEAL_LABELS[sectionId];
        const sectionFoods = foodsByMeal[sectionId] ?? [];
        const sectionKcal  = sectionFoods.reduce((s, f) => s + f.kcal, 0);
        const canUp        = isSnack && sectionIdx > 0;
        const canDown      = isSnack && sectionIdx < mealOrder.length - 1;

        return (
          <div key={sectionId}>
            {/* Meal section card */}
            <motion.div layout className="que-card mb-1">
              {/* ── Section header ── */}
              <div className="flex items-center justify-between px-4 pt-4 pb-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  {/* Grip handle for snack reordering */}
                  {isSnack && (
                    <motion.div
                      drag="y"
                      dragConstraints={{ top: 0, bottom: 0 }}
                      dragElastic={0.15}
                      dragMomentum={false}
                      onDragEnd={(_: unknown, info: { offset: { y: number } }) => {
                        if (info.offset.y < -55 && canUp)   moveSnack(sectionId, 'up');
                        if (info.offset.y >  55 && canDown) moveSnack(sectionId, 'down');
                      }}
                      className="flex items-center justify-center w-10 h-10 -ml-2 cursor-grab active:cursor-grabbing text-[var(--ink-3)] flex-shrink-0 touch-none"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="8" cy="6" r="1.2" fill="currentColor"/><circle cx="16" cy="6" r="1.2" fill="currentColor"/>
                        <circle cx="8" cy="12" r="1.2" fill="currentColor"/><circle cx="16" cy="12" r="1.2" fill="currentColor"/>
                        <circle cx="8" cy="18" r="1.2" fill="currentColor"/><circle cx="16" cy="18" r="1.2" fill="currentColor"/>
                      </svg>
                    </motion.div>
                  )}
                  <span className="font-display text-[18px] tracking-[1px] uppercase text-[var(--ink-0)]">
                    {label}
                  </span>
                  {sectionKcal > 0 && (
                    <span className="font-mono text-[11px] font-bold text-[var(--accent)]">{sectionKcal} kcal</span>
                  )}
                </div>

                {/* Snack controls — 44×44px tap targets */}
                {isSnack && (
                  <div className="flex items-center">
                    {canUp && (
                      <button type="button" onClick={() => moveSnack(sectionId, 'up')}
                        className="w-11 h-11 flex items-center justify-center text-[var(--ink-3)] hover:text-[var(--accent)] active:text-[var(--accent)] transition-colors">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
                      </button>
                    )}
                    {canDown && (
                      <button type="button" onClick={() => moveSnack(sectionId, 'down')}
                        className="w-11 h-11 flex items-center justify-center text-[var(--ink-3)] hover:text-[var(--accent)] active:text-[var(--accent)] transition-colors">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                      </button>
                    )}
                    {sectionFoods.length === 0 && (
                      <button type="button" onClick={() => removeSnack(sectionId)}
                        className="w-11 h-11 flex items-center justify-center text-[var(--ink-3)] hover:text-[var(--danger)] active:text-[var(--danger)] transition-colors">
                        <X size={16} />
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* ── Foods ── */}
              <div className="px-4">
                {sectionFoods.length > 0 ? (
                  (() => {
                    const sorted = [...sectionFoods].sort((a, b) => a.loggedAt - b.loggedAt);
                    return sorted.map((food, fi) => (
                      <FoodLogItem
                        key={food.id}
                        food={food}
                        onRemove={() => removeFood(food.id)}
                        onEdit={() => setEditingFood(food)}
                        onMoveUp={() => moveFoodInSection(food.id, 'up')}
                        onMoveDown={() => moveFoodInSection(food.id, 'down')}
                        canMoveUp={fi > 0}
                        canMoveDown={fi < sorted.length - 1}
                      />
                    ));
                  })()
                ) : (
                  <p className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.5px] py-2 italic">
                    Nothing logged yet
                  </p>
                )}
              </div>

              {/* ── Copy-from-yesterday shortcut ──
                  Only shown when this section is empty AND yesterday had this
                  meal. Saves the user from re-adding habitual foods (cereal,
                  protein shake, etc.). One tap clones the lot. */}
              {sectionFoods.length === 0 && (yesterdayFoodsByMeal[sectionId]?.length ?? 0) > 0 && (
                <button
                  type="button"
                  onClick={() => copyFromYesterday(sectionId)}
                  className="w-full flex items-center gap-2 px-4 py-3 text-left border-t border-[var(--line)] hover:bg-[var(--bg-2)] active:bg-[var(--bg-3)] transition-colors"
                >
                  <span className="w-6 h-6 rounded flex items-center justify-center bg-[var(--positive)]/15 text-[var(--positive)]">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </span>
                  <span className="font-mono text-[11px] font-bold tracking-[0.5px] text-[var(--positive)]">
                    Copy yesterday&apos;s {label.toLowerCase()} ({yesterdayFoodsByMeal[sectionId]?.length})
                  </span>
                </button>
              )}

              {/* ── Add to section ── */}
              <button
                type="button"
                onClick={() => openModal(sectionId)}
                className="w-full flex items-center gap-2 px-4 py-4 text-left border-t border-[var(--line)] hover:bg-[var(--bg-2)] active:bg-[var(--bg-3)] transition-colors"
              >
                <span className="w-6 h-6 rounded flex items-center justify-center bg-[var(--accent)]/15 text-[var(--accent)]">
                  <Plus size={13} />
                </span>
                <span className="font-mono text-[11px] font-bold tracking-[0.5px] text-[var(--accent)]">
                  Add to {label}
                </span>
              </button>
            </motion.div>

            {/* Add snack divider */}
            {sectionIdx < mealOrder.length - 1 && (
              <button
                type="button"
                onClick={() => addSnack(sectionId)}
                className="w-full flex items-center gap-2 py-3 px-2 group"
              >
                <div className="flex-1 h-px bg-[var(--line)] group-hover:bg-[var(--accent)]/30 transition-colors" />
                <span className="flex items-center gap-1.5 font-mono text-[10px] font-bold tracking-[1px] uppercase text-[var(--ink-3)] group-hover:text-[var(--accent)] transition-colors flex-shrink-0">
                  <Plus size={11} /> Add Snack
                </span>
                <div className="flex-1 h-px bg-[var(--line)] group-hover:bg-[var(--accent)]/30 transition-colors" />
              </button>
            )}
          </div>
        );
      })}

      {/* Add snack after last section */}
      <button
        type="button"
        onClick={() => addSnack(mealOrder[mealOrder.length - 1])}
        className="w-full flex items-center gap-2 py-3 px-2 group mt-1"
      >
        <div className="flex-1 h-px bg-[var(--line)] group-hover:bg-[var(--accent)]/30 transition-colors" />
        <span className="flex items-center gap-1.5 font-mono text-[10px] font-bold tracking-[1px] uppercase text-[var(--ink-3)] group-hover:text-[var(--accent)] transition-colors flex-shrink-0">
          <Plus size={11} /> Add Snack
        </span>
        <div className="flex-1 h-px bg-[var(--line)] group-hover:bg-[var(--accent)]/30 transition-colors" />
      </button>

      {/* Attribution */}
      <p className="font-mono text-[8px] text-[var(--ink-4)] text-center tracking-[0.5px] mt-4">
        Nutrition data from USDA FoodData Central &amp; Open Food Facts
      </p>

      <DailyLogCard
        todayLabel={fmtDateLong(activeDayFocus)}
        todayWeight={todayWeight}
        todayCals={totals.kcal > 0 ? String(Math.round(totals.kcal)) : ''}
        todayProtein={totals.protein > 0 ? String(Math.round(totals.protein)) : ''}
        onWeightChange={handleWeightChange}
        onLogToday={handleLogToday}
        undereatingWarning={undereatingWarning}
      />

      <AddFoodModal
        open={showModal}
        onClose={() => setShowModal(false)}
        onAdd={addFood}
      />

      <CoinAwardModal
        open={pendingCoin !== null}
        onClose={collectCoin}
        total={coinData.total}
        dateLabel={pendingCoin?.label ?? ''}
        earned={pendingCoin?.amount ?? 1}
      />

      {/* Macro all-hit confetti */}
      <AnimatePresence>
        {macroCelebrate && (
          <motion.div
            className="fixed inset-0 z-[450] flex items-center justify-center pointer-events-none"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            <div
              className="absolute inset-0"
              style={{ background: 'radial-gradient(ellipse at center, rgba(255,181,71,0.18) 0%, transparent 70%)' }}
            />
            <Lottie
              animationData={celebrateAnim}
              loop={false}
              autoplay={true}
              onComplete={() => setMacroCelebrate(false)}
              style={{ width: '100%', height: '100%', maxWidth: 600, maxHeight: 600 }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <MacroGoalModal
        open={showMacroModal}
        onClose={() => setShowMacroModal(false)}
        onSave={g => {
          saveMacroGoals(g);
          setMacroGoals(g);
        }}
        budget={budget}
        weightLbs={parseFloat(profile.weight) || 170}
        initial={macroGoals ?? getBaseline(budget, parseFloat(profile.weight) || 170)}
      />

      <EditFoodModal
        food={editingFood}
        onClose={() => setEditingFood(null)}
        onSave={saveEditedFood}
        mealOrder={mealOrder}
      />

      <CelebrationModal
        open={celebrateVisible}
        onClose={() => setCelebrateVisible(false)}
        localDB={localDB}
        calsEaten={totals.kcal}
        budget={budget}
      />

      <ProjectionModal
        open={projVisible}
        m={liveMetrics}
        weightLbs={parseFloat(todayWeight || profile.weight) || 0}
        calsEaten={totals.kcal}
        localDB={localDB}
        onClose={() => setProjVisible(false)}
      />
    </div>
  );
}
