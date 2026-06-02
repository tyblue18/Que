'use client';

import { useState, useRef, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, Dumbbell, Footprints, Flame, Trophy, TrendingUp, Target, Bike, Sparkles } from 'lucide-react';
import { useApp } from '@/lib/AppContext';
import { computeWeeklyRecap, hasRecapData, recapSunday, markRecapMaintenanceShown, type WeeklyRecap } from '@/lib/weeklyRecap';

const SEEN_KEY = 'queWeeklyRecapSeen';

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The recap is "due" once it's ≥7pm on the recap Sunday, and stays available on
 *  the following days until the user has seen that week's recap. */
function isDue(now: Date): boolean {
  const sunday = recapSunday(now);
  const today  = toDateStr(now);
  return today > sunday || (today === sunday && now.getHours() >= 19);
}

const fmt = (n: number) => Math.round(n).toLocaleString();

// ── presentational atoms ──────────────────────────────────────────────────────

function StatTile({ value, unit, label, accent }: { value: string; unit?: string; label: string; accent?: 'accent' | 'positive' | 'warn' }) {
  const color = accent === 'positive' ? 'var(--positive)' : accent === 'warn' ? 'var(--warn)' : 'var(--accent)';
  return (
    <div className="rounded-lg bg-[var(--bg-2)] border border-[var(--line)] px-3 py-2.5 text-center">
      <p className="font-display text-[22px] leading-none" style={{ color }}>
        {value}<span className="font-mono text-[10px] text-[var(--ink-3)] ml-0.5">{unit}</span>
      </p>
      <p className="font-mono text-[8px] tracking-[1px] uppercase text-[var(--ink-3)] mt-1">{label}</p>
    </div>
  );
}

function Section({ icon, title, accent, children }: { icon: React.ReactNode; title: string; accent?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-1)] p-3.5">
      <div className="flex items-center gap-2 mb-3">
        <span style={{ color: accent ?? 'var(--accent)' }}>{icon}</span>
        <p className="font-mono text-[9px] font-bold tracking-[2px] uppercase text-[var(--ink-2)]">{title}</p>
      </div>
      {children}
    </div>
  );
}

// ── modal ───────────────────────────────────────────────────────────────────

export function WeeklyRecapModal() {
  const { localDB, profile, isLoaded } = useApp();
  const [open,  setOpen]  = useState(false);
  // Computed once when shown and kept after dismiss so the exit animation can
  // play (open flips false while recap stays available).
  const [recap, setRecap] = useState<WeeklyRecap | null>(null);

  const tryShow = useRef<() => void>(() => {});
  tryShow.current = () => {
    if (!isLoaded) return;
    const now = new Date();
    if (!isDue(now)) return;
    const sunday = recapSunday(now);
    if (localStorage.getItem(SEEN_KEY) === sunday) return;   // already seen this week
    const r = computeWeeklyRecap(localDB, profile, sunday);
    if (!hasRecapData(r)) return;                            // nothing worth showing
    setRecap(r);
    setOpen(true);
  };

  useEffect(() => {
    const t = setTimeout(() => tryShow.current(), 900); // let the shell settle
    return () => clearTimeout(t);
  }, [isLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') tryShow.current(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const dismiss = () => {
    if (recap) {
      try { localStorage.setItem(SEEN_KEY, recap.weekId); } catch { /* noop */ }
      markRecapMaintenanceShown(recap); // advance the maintenance baseline now that it's been seen
    }
    setOpen(false);
  };

  if (!recap) return null;

  const { cardio, lifts, steps, nutrition, plan, weight, maintenance } = recap;
  const headline = recap.highlights[0] ?? 'Here\'s how your week went';

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[460] flex items-end md:items-center justify-center backdrop-blur-sm px-0 md:px-3"
          style={{ background: 'rgba(7,8,10,0.92)' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.22 }}
          onClick={e => { if (e.target === e.currentTarget) dismiss(); }}
        >
          <motion.div
            className="w-full md:max-w-[440px] rounded-t-2xl md:rounded-2xl bg-[var(--bg-0)] overflow-y-auto max-h-[90dvh]"
            initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            style={{ boxShadow: '0 0 0 1px var(--line-2), 0 -2px 0 0 var(--accent), 0 40px 80px rgba(0,0,0,0.7)' }}
          >
            {/* Header */}
            <div className="relative px-5 pt-6 pb-5 bg-[var(--bg-2)]" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              <button onClick={dismiss} aria-label="Close"
                className="absolute top-4 right-4 p-1.5 rounded-lg text-[var(--ink-3)] hover:text-[var(--ink-1)] hover:bg-[var(--bg-3)] transition-colors">
                <X size={15} />
              </button>
              <p className="font-mono text-[9px] font-bold tracking-[2.5px] uppercase text-[var(--accent)] mb-1">
                {recap.rangeLabel}
              </p>
              <h2 className="font-display text-[30px] tracking-[1.5px] uppercase text-[var(--ink-0)] leading-none">
                Week in Review
              </h2>
              <p className="font-mono text-[10px] text-[var(--ink-2)] mt-2 tracking-[0.3px]">{headline}</p>
              {recap.highlights.length > 1 && (
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {recap.highlights.slice(1).map((h, i) => (
                    <span key={i} className="font-mono text-[8px] font-bold tracking-[0.5px] px-2 py-0.5 rounded-full"
                      style={{ background: 'var(--accent-12)', color: 'var(--accent)' }}>{h}</span>
                  ))}
                </div>
              )}
            </div>

            <div className="px-4 py-4 space-y-3">
              {/* Consistency */}
              <div className="grid grid-cols-3 gap-2">
                <StatTile value={String(recap.workoutDays)} unit="/7" label="Workout Days" />
                <StatTile value={String(recap.daysLogged)} unit="/7" label="Days Logged" />
                <StatTile value={fmt(steps.total)} label="Total Steps" accent="positive" />
              </div>

              {/* Adaptive maintenance — the weekly recalibration beat. Honest:
                  "updated" only on a real change, else "held steady". */}
              {maintenance && maintenance.status !== 'locked' && maintenance.estimate != null && (
                <Section icon={<Sparkles size={13} />} title="Maintenance">
                  {maintenance.status === 'updated' ? (
                    <p className="font-mono text-[11px] text-[var(--ink-1)] leading-relaxed">
                      Your estimated maintenance{' '}
                      {maintenance.previous != null && (
                        <>moved from <span className="text-[var(--ink-3)]">{maintenance.previous.toLocaleString()}</span> to </>
                      )}
                      <span className="text-[var(--accent)] font-bold">{maintenance.estimate.toLocaleString()} kcal</span> this week — learned from your logs.
                    </p>
                  ) : (
                    <p className="font-mono text-[11px] text-[var(--ink-1)] leading-relaxed">
                      Your estimated maintenance held steady at{' '}
                      <span className="text-[var(--accent)] font-bold">{maintenance.estimate.toLocaleString()} kcal</span>.
                    </p>
                  )}
                </Section>
              )}
              {maintenance?.status === 'locked' && maintenance.qualifyingDays != null && (
                <Section icon={<Sparkles size={13} />} title="Maintenance">
                  <p className="font-mono text-[10px] text-[var(--ink-2)] leading-relaxed">
                    Keep logging your weight and food together — your maintenance estimate unlocks at{' '}
                    <span className="text-[var(--ink-0)]">{maintenance.needed}</span> qualifying days
                    {' '}(<span className="text-[var(--accent)]">{maintenance.qualifyingDays}</span> so far).
                  </p>
                </Section>
              )}

              {/* Lifts */}
              {lifts.sessions > 0 && (
                <Section icon={<Dumbbell size={13} />} title="Lifting">
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    <StatTile value={fmt(lifts.totalVolume)} unit="lb" label="Volume" />
                    <StatTile value={fmt(lifts.totalReps)} label="Reps" />
                    <StatTile value={String(lifts.totalSets)} label="Sets" />
                  </div>
                  {lifts.topSet && (
                    <p className="font-mono text-[10px] text-[var(--ink-2)] mb-2">
                      Top set · <span className="text-[var(--ink-0)] font-bold">{lifts.topSet.name}</span>{' '}
                      <span className="text-[var(--accent)]">{lifts.topSet.weight} lb × {lifts.topSet.reps}</span>
                    </p>
                  )}
                  {lifts.prs.length > 0 && (
                    <div className="rounded-lg bg-[var(--positive)]/8 border border-[var(--positive)]/25 p-2.5 mb-2">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <Trophy size={11} className="text-[var(--positive)]" />
                        <p className="font-mono text-[9px] font-bold tracking-[1px] uppercase text-[var(--positive)]">
                          {lifts.prs.length} New PR{lifts.prs.length !== 1 ? 's' : ''}
                        </p>
                      </div>
                      {lifts.prs.map(p => (
                        <p key={p.name} className="font-mono text-[10px] text-[var(--ink-1)] flex justify-between">
                          <span className="truncate pr-2">{p.name}</span>
                          <span className="text-[var(--positive)] font-bold flex-shrink-0">{p.weight} lb (+{p.delta})</span>
                        </p>
                      ))}
                    </div>
                  )}
                  {lifts.improvements.filter(i => i.kind === 'reps').slice(0, 3).map(i => (
                    <p key={i.name} className="font-mono text-[9px] text-[var(--ink-3)] flex items-center gap-1.5">
                      <TrendingUp size={9} className="text-[var(--accent)]" />
                      <span className="text-[var(--ink-2)]">{i.name}</span> — more reps at top weight
                    </p>
                  ))}
                </Section>
              )}

              {/* Cardio */}
              {(cardio.sessions > 0 || cardio.totalMiles > 0) && (
                <Section icon={<Bike size={13} />} title="Cardio" accent="var(--positive)">
                  <div className="grid grid-cols-3 gap-2 mb-2">
                    <StatTile value={String(cardio.totalMiles)} unit="mi" label="Distance" accent="positive" />
                    <StatTile value={fmt(cardio.totalMinutes)} unit="min" label="Time" accent="positive" />
                    <StatTile value={fmt(cardio.caloriesBurned)} unit="kcal" label="Burned" accent="warn" />
                  </div>
                  {cardio.fastestRun && (
                    <p className="font-mono text-[10px] text-[var(--ink-2)]">
                      Fastest run · <span className="text-[var(--ink-0)] font-bold">{cardio.fastestRun.pace}</span>
                      <span className="text-[var(--ink-3)]"> ({cardio.fastestRun.miles} mi)</span>
                    </p>
                  )}
                  {cardio.longest && (
                    <p className="font-mono text-[10px] text-[var(--ink-2)]">
                      Longest {cardio.longest.kind} · <span className="text-[var(--ink-0)] font-bold">{cardio.longest.miles} mi</span>
                    </p>
                  )}
                </Section>
              )}

              {/* Plan progress (if on a cut/bulk) */}
              {plan && (
                <Section icon={<Target size={13} />} title={`${plan.type === 'cut' ? 'Cut' : 'Bulk'} Plan`}>
                  <div className="grid grid-cols-3 gap-2 mb-2">
                    <StatTile
                      value={plan.weekChange != null ? (plan.weekChange > 0 ? `+${plan.weekChange}` : String(plan.weekChange)) : '—'}
                      unit="lb" label="This Week"
                      accent={plan.weekChange != null && ((plan.type === 'cut' && plan.weekChange < 0) || (plan.type === 'bulk' && plan.weekChange > 0)) ? 'positive' : 'warn'}
                    />
                    <StatTile value={String(plan.daysOnTarget)} unit="/7" label="On Target" />
                    <StatTile value={fmt(plan.avgDailyKcal)} unit="kcal" label="Avg/Day" />
                  </div>
                  {plan.overallChange != null && (
                    <p className="font-mono text-[10px] text-[var(--ink-2)]">
                      Since start ·{' '}
                      <span className="text-[var(--ink-0)] font-bold">{plan.overallChange > 0 ? '+' : ''}{plan.overallChange} lb</span>
                      <span className="text-[var(--ink-3)]"> · goal {plan.goalWeight} lb</span>
                    </p>
                  )}
                </Section>
              )}

              {/* Nutrition (when not on a plan) */}
              {!plan && nutrition.daysLogged > 0 && (
                <Section icon={<Flame size={13} />} title="Nutrition" accent="var(--warn)">
                  <div className="grid grid-cols-3 gap-2">
                    <StatTile value={fmt(nutrition.avgCalories)} unit="kcal" label="Avg/Day" />
                    <StatTile value={String(nutrition.daysOnTarget)} unit="/7" label="On Goal" accent="positive" />
                    <StatTile value={fmt(nutrition.avgProtein)} unit="g" label="Avg Protein" />
                  </div>
                </Section>
              )}

              {/* Steps + weight footer row */}
              {(steps.bestDay || weight.change != null) && (
                <div className="flex flex-wrap gap-2 text-[var(--ink-3)] px-1">
                  {steps.bestDay && (
                    <span className="font-mono text-[9px] flex items-center gap-1">
                      <Footprints size={10} /> Best day {fmt(steps.bestDay.steps)} steps
                    </span>
                  )}
                  {!plan && weight.change != null && weight.change !== 0 && (
                    <span className="font-mono text-[9px]">
                      Weight {weight.change > 0 ? '+' : ''}{weight.change} lb
                    </span>
                  )}
                </div>
              )}

              <button onClick={dismiss}
                className="w-full py-3.5 mt-1 rounded-lg font-mono text-[11px] font-bold tracking-[1.5px] uppercase"
                style={{ background: 'var(--accent)', color: 'var(--accent-ink)', boxShadow: '0 0 0 1px var(--accent), 0 0 20px var(--accent-24)' }}>
                Let&apos;s go again 💪
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
