'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Activity, ChevronRight, Download, Dumbbell, History, Plus, Sparkles, TrendingUp, TrendingDown, Minus, User, X } from 'lucide-react';
import { estimateAdaptiveTDEE, countQualifyingDays, QUALIFYING_DAYS_TO_UNLOCK, type TdeeDay } from '@/lib/adaptiveTdee';
import {
  useApp,
  type DayRecord, type UserProfile,
} from '@/lib/AppContext';
import { ActivityIcon } from '@/components/ActivityIcon';
import { useSpotlightBorder } from '@/hooks/useSpotlightBorder';
import { LIFT_PRS_KEY } from '@/lib/constants';
import { streakEndingAt, type StreakDay } from '@/lib/streaks';
import Lottie from 'lottie-react';
import prData from '@/public/PR_animation.json';
import {
  type CardioFields, type BudgetMetrics, type PRFlags,
  EMPTY_CARDIO, INTENSITY_LABELS,
  useBudgetMetrics, loadPlan, savePlanToStorage, intensityForKcal,
  loadPlanHistory,
  getPlanBaseline, planExpectedChange,
  dayMaintenance, parseNum, fmt, fmtDateLong, toDateStr,
} from '@/lib/metricsTypes';
import { drawLineChart } from '@/lib/metricsCharts';
import { parseExercises, deriveCardioFields, setCardioOfKind, existingCardioDistance } from '@/lib/cardioSync';
import { useUnits, kgToLb, cmToIn, parseDurationToMin, fmtDuration } from '@/lib/units';
import { Measurements } from '@/components/metrics/Measurements';
import { ProgressPhoto } from '@/components/metrics/ProgressPhoto';
import { DataTrackerPanel } from '@/components/metrics/DataTrackerPanel';
import { RecoveryPanel } from '@/components/metrics/RecoveryPanel';
import {
  MilestoneModal, CelebrationModal, PlanProgressModal, PlanModal, ProjectionModal, PlanHistoryModal,
} from '@/components/metrics/MetricsModals';
import RunningPlanBuilder from '@/components/running/RunningPlanBuilder';
import LiftingPlanBuilder from '@/components/lifting/LiftingPlanBuilder';

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT — StepSyncPanel
// ─────────────────────────────────────────────────────────────────────────────

// Drop in your published iCloud Shortcut link here (in Shortcuts: share the
// shortcut → Copy iCloud Link) to turn the iOS setup into one tap. While empty,
// the iOS tab shows the manual "build a Shortcut" steps instead — no broken link.
const IOS_SHORTCUT_URL: string = '';

// The importable request. HTTP Shortcuts (Android) reads this via "Import from
// cURL"; on iOS it's the reference for a "Get Contents of URL" action. distance
// and time are placeholders the user wires to their workout (or a prompt).
const ACTIVITY_BODY = '{"type":"run","distance":0,"unit":"mi","time":0}';
const STEPS_BODY    = '{"steps":0}';
const buildCurl = (endpoint: string, token: string, body: string) =>
  `curl -X POST '${endpoint}' \\\n  -H 'Authorization: Bearer ${token}' \\\n  -H 'Content-Type: application/json' \\\n  -d '${body}'`;

function StepSyncPanel() {
  const { updateDayRecord, todayStr, localDB } = useApp();

  // Steps are entered manually here (works on any device), or pushed
  // automatically from an iOS Shortcut / Tasker via the personal step-sync
  // token (POST /api/health/steps) — both write to the same day record.
  const storedSteps = localDB[todayStr]?.steps;
  const [manualSteps, setManualSteps] = useState('');
  useEffect(() => {
    setManualSteps(storedSteps != null && storedSteps !== '' ? String(storedSteps) : '');
  }, [storedSteps, todayStr]);

  const saveManualSteps = useCallback(() => {
    const n = parseInt(manualSteps, 10);
    if (!Number.isFinite(n) || n < 0) return;
    updateDayRecord(todayStr, { steps: n });
  }, [manualSteps, todayStr, updateDayRecord]);

  // ── Auto-sync setup (personal token + endpoints) ──────────────────────────
  // Collapsed by default; the token is fetched lazily on first expand so we
  // never issue one for users who don't use it. Same token drives steps AND
  // cardio — an iOS Shortcut / "Auto Health Export" / Tasker POSTs each finished
  // run/bike/swim so distance, time (and therefore calories) fill in with no
  // manual entry. It's the user's OWN data, so it feeds battles/groups too.
  const [showSync, setShowSync] = useState(false);
  const [sync, setSync] = useState<{ token: string; activityEndpoint: string; stepsEndpoint: string } | null>(null);
  const [syncErr, setSyncErr] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [platform, setPlatform] = useState<'android' | 'ios'>(() =>
    typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'ios' : 'android');
  // Which feed the setup command targets — workouts (cardio) or the daily step total.
  const [dataType, setDataType] = useState<'activity' | 'steps'>('activity');

  const toggleSync = useCallback(() => {
    setShowSync(v => !v);
    if (sync) return;
    fetch('/api/health/token')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then((d: { token: string; endpoint: string; activityEndpoint?: string }) =>
        setSync({
          token:            d.token,
          stepsEndpoint:    d.endpoint,
          activityEndpoint: d.activityEndpoint ?? `${d.endpoint.replace(/\/steps$/, '')}/activity`,
        }))
      .catch(() => setSyncErr(true));
  }, [sync]);

  const copy = useCallback((text: string, which: string) => {
    navigator.clipboard?.writeText(text)
      .then(() => { setCopied(which); setTimeout(() => setCopied(null), 1500); })
      .catch(() => {});
  }, []);

  // The endpoint + cURL for the currently selected feed.
  const isSteps     = dataType === 'steps';
  const curEndpoint = sync ? (isSteps ? sync.stepsEndpoint : sync.activityEndpoint) : '';
  const curCurl     = sync ? buildCurl(curEndpoint, sync.token, isSteps ? STEPS_BODY : ACTIVITY_BODY) : '';

  return (
    <div className="mt-4 pt-4 border-t border-[var(--line)]">
      <div className="rounded border border-[var(--line)] bg-[var(--bg-2)] p-3">
        <label className="que-label">Steps today</label>
        <div className="flex gap-2">
          <input
            type="text"
            inputMode="numeric"
            className="que-input flex-1"
            placeholder="e.g. 8000"
            value={manualSteps}
            onChange={e => setManualSteps(e.target.value.replace(/[^0-9]/g, ''))}
            onBlur={saveManualSteps}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          />
          <button
            type="button"
            onClick={saveManualSteps}
            className="que-btn-ghost px-4 flex-shrink-0"
          >
            Save
          </button>
        </div>
        <p className="font-mono text-[8px] text-[var(--ink-3)] mt-1 tracking-[0.3px]">
          Read it off your phone&apos;s health app — saves to today and syncs to your other devices.
        </p>

        {/* Auto-sync disclosure */}
        <button
          type="button"
          onClick={toggleSync}
          className="mt-3 w-full flex items-center justify-between font-mono text-[9px] font-bold tracking-[1px] uppercase text-[var(--accent)]"
        >
          <span>Auto-sync from your watch</span>
          <span className="text-[var(--ink-3)]">{showSync ? '–' : '+'}</span>
        </button>

        {showSync && (
          <div className="mt-2 space-y-2 border-t border-[var(--line)] pt-2">
            <p className="font-mono text-[9px] text-[var(--ink-2)] leading-relaxed tracking-[0.2px]">
              Push finished workouts (and your daily steps) from your phone automatically — no manual entry, calories included. Pick your phone &amp; what to sync:
            </p>

            {syncErr ? (
              <p className="font-mono text-[9px] text-[var(--warn)]">Couldn&apos;t load your token — check your connection and reopen.</p>
            ) : !sync ? (
              <p className="font-mono text-[9px] text-[var(--ink-3)] animate-pulse">Loading your token…</p>
            ) : (
              <>
                {/* Platform tabs */}
                <div className="flex bg-[var(--bg-3)] rounded-sm p-0.5 gap-0.5">
                  {(['android', 'ios'] as const).map(p => (
                    <button
                      key={p} type="button" onClick={() => setPlatform(p)}
                      className={[
                        'flex-1 py-1.5 rounded-sm font-mono text-[9px] font-bold uppercase tracking-[1px] transition-all',
                        platform === p ? 'bg-[var(--accent)] text-[var(--accent-ink)]' : 'text-[var(--ink-3)] hover:text-[var(--ink-1)]',
                      ].join(' ')}
                    >
                      {p === 'android' ? 'Android' : 'iPhone'}
                    </button>
                  ))}
                </div>

                {/* What to sync */}
                <div className="flex bg-[var(--bg-3)] rounded-sm p-0.5 gap-0.5">
                  {([['activity', 'Workouts'], ['steps', 'Steps']] as const).map(([v, label]) => (
                    <button
                      key={v} type="button" onClick={() => setDataType(v)}
                      className={[
                        'flex-1 py-1.5 rounded-sm font-mono text-[9px] font-bold uppercase tracking-[1px] transition-all',
                        dataType === v ? 'bg-[var(--accent-12)] text-[var(--accent)]' : 'text-[var(--ink-3)] hover:text-[var(--ink-1)]',
                      ].join(' ')}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {platform === 'android' ? (
                  <div className="space-y-2">
                    <ol className="font-mono text-[9px] text-[var(--ink-2)] leading-relaxed space-y-1 list-decimal pl-3.5">
                      <li>Install <span className="text-[var(--ink-0)]">HTTP Shortcuts</span> (free, Play Store).</li>
                      <li>In it: <span className="text-[var(--ink-0)]">＋ → Import from cURL</span> → paste the command below → Save.</li>
                      <li>{isSteps ? 'Run it once a day — schedule it in the app (steps are a daily total).' : 'Tap it after a workout, or trigger from Tasker + Health Connect for hands-free sync.'}</li>
                    </ol>
                    <button
                      type="button"
                      onClick={() => copy(curCurl, 'curl')}
                      className="que-btn-primary w-full py-2.5 text-[10px]"
                    >
                      {copied === 'curl' ? 'Copied ✓' : 'Copy setup command'}
                    </button>
                  </div>
                ) : IOS_SHORTCUT_URL ? (
                  <div className="space-y-2">
                    <ol className="font-mono text-[9px] text-[var(--ink-2)] leading-relaxed space-y-1 list-decimal pl-3.5">
                      <li>Tap <span className="text-[var(--ink-0)]">Add Shortcut</span> and add it to your library.</li>
                      <li>Run it once — paste your token when it asks (copy it below).</li>
                      <li>{isSteps ? 'It runs on a daily time automation.' : 'It fires from a “When a Workout ends” automation.'}</li>
                    </ol>
                    <a
                      href={IOS_SHORTCUT_URL} target="_blank" rel="noopener noreferrer"
                      className="que-btn-primary w-full py-2.5 text-[10px] text-center block"
                    >
                      Add Shortcut
                    </a>
                    <button type="button" onClick={() => copy(sync.token, 'token')} className="que-btn-ghost w-full py-2 text-[9px]">
                      {copied === 'token' ? 'Token copied ✓' : 'Copy token'}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <ol className="font-mono text-[9px] text-[var(--ink-2)] leading-relaxed space-y-1 list-decimal pl-3.5">
                      <li>Shortcuts app → new Shortcut → add <span className="text-[var(--ink-0)]">Get Contents of URL</span>.</li>
                      <li>Method <span className="text-[var(--ink-0)]">POST</span>, header <span className="text-[var(--ink-0)]">Authorization: Bearer &lt;token&gt;</span>, JSON body.</li>
                      <li>{isSteps ? 'Run it from a daily time automation.' : 'Run it from a “When a Workout ends” automation.'} (“Copy request” below has it all.)</li>
                    </ol>
                    <button
                      type="button"
                      onClick={() => copy(curCurl, 'curl')}
                      className="que-btn-primary w-full py-2.5 text-[10px]"
                    >
                      {copied === 'curl' ? 'Copied ✓' : 'Copy request (cURL)'}
                    </button>
                  </div>
                )}

                {/* Raw values — copyable on either platform */}
                <div className="space-y-1.5 border-t border-[var(--line)] pt-2">
                  <div className="flex gap-1.5">
                    <code className="flex-1 min-w-0 truncate font-mono text-[9px] text-[var(--ink-1)] bg-[var(--bg-3)] rounded px-2 py-1.5">{curEndpoint}</code>
                    <button type="button" onClick={() => copy(curEndpoint, 'url')} className="que-btn-ghost px-2 flex-shrink-0 text-[8px]">{copied === 'url' ? '✓' : 'URL'}</button>
                  </div>
                  <div className="flex gap-1.5">
                    <code className="flex-1 min-w-0 truncate font-mono text-[9px] text-[var(--ink-1)] bg-[var(--bg-3)] rounded px-2 py-1.5">{sync.token}</code>
                    <button type="button" onClick={() => copy(sync.token, 'token')} className="que-btn-ghost px-2 flex-shrink-0 text-[8px]">{copied === 'token' ? '✓' : 'Token'}</button>
                  </div>
                </div>

                <p className="font-mono text-[8px] text-[var(--ink-3)] leading-relaxed tracking-[0.3px]">
                  {isSteps ? (
                    <><span className="text-[var(--ink-2)]">steps</span> = your day&apos;s running total (it overwrites, not adds) · optional <span className="text-[var(--ink-2)]">date</span> YYYY-MM-DD.</>
                  ) : (
                    <><span className="text-[var(--ink-2)]">type</span> run · bike · swim · <span className="text-[var(--ink-2)]">time</span> in minutes · <span className="text-[var(--ink-2)]">unit</span> mi or km · unique <span className="text-[var(--ink-2)]">externalId</span> so a re-sync never double-counts.</>
                  )}{' '}
                  Keep your token private — anyone with it can write to your log.
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT — ProfilePanel
// ─────────────────────────────────────────────────────────────────────────────

function ProfilePanel({ profile, onChange, onOpenPlan, onOpenRunPlan, onOpenLiftPlan, onOpenHistory }: {
  profile: UserProfile;
  onChange: (updates: Partial<UserProfile>) => void;
  onOpenPlan: () => void;
  onOpenRunPlan: () => void;
  onOpenLiftPlan: () => void;
  onOpenHistory: () => void;
}) {
  const hasPlanHistory = typeof window !== 'undefined' && loadPlanHistory().length > 0;
  const u = useUnits();
  // Weight/height edit through local display state and commit (convert → store)
  // on blur — avoids the round-trip jank a live-converted controlled input has.
  const [wInput, setWInput] = useState('');
  const [hInput, setHInput] = useState('');
  useEffect(() => { setWInput(profile.weight ? u.dispWeight(parseNum(profile.weight)) : ''); }, [profile.weight, u.system]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setHInput(profile.height ? u.dispHeight(parseNum(profile.height), 1) : ''); }, [profile.height, u.system]); // eslint-disable-line react-hooks/exhaustive-deps
  const commitWeight = () => { const n = parseNum(wInput); if (n > 0) onChange({ weight: u.isMetric ? kgToLb(n).toFixed(1) : String(n) }); };
  const commitHeight = () => { const n = parseNum(hInput); if (n > 0) onChange({ height: u.isMetric ? cmToIn(n).toFixed(1) : String(n) }); };

  const activityOptions = [
    { value: '1.20', label: 'Desk job, no gym (×1.20)' },
    { value: '1.30', label: 'Desk job + light activity (×1.30)' },
    { value: '1.40', label: 'Desk + gym 3×/wk (×1.40)' },
    { value: '1.45', label: 'Desk + gym 4–5×/wk (×1.45)' },
    { value: '1.55', label: 'Active job + gym 4–5×/wk (×1.55)' },
    { value: '1.65', label: 'Physical job + heavy daily (×1.65)' },
  ];

  return (
    <div className="que-card que-card-accent mb-4">
      <div className="p-5">
        <h2 className="que-section-label mb-4"><span className="dot" />ATHLETE PROFILE</h2>

        <div className="mb-4 font-mono text-[11px] text-[var(--ink-1)] bg-[var(--bg-2)] border-l-2 border-[var(--accent)] rounded-sm px-4 py-3 leading-relaxed tracking-[0.5px]">
          Set <strong className="text-[var(--accent)]">Activity Level</strong> to match your typical week (lifting only — cardio is tracked separately).{' '}
          <span className="text-[var(--ink-2)]">Budget = TDEE − Deficit + 60% eat-back.</span>
        </div>

        {/* Units toggle — switches every weight/height/distance across the app. */}
        <div className="flex items-center justify-between mb-3">
          <span className="que-label">Units</span>
          <div className="flex rounded-md border border-[var(--line-2)] overflow-hidden">
            {(['imperial', 'metric'] as const).map(sys => (
              <button
                key={sys} type="button" onClick={() => u.setSystem(sys)}
                className={[
                  'px-3 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[1px] transition-colors',
                  u.system === sys ? 'bg-[var(--accent-12)] text-[var(--accent)]' : 'bg-[var(--bg-2)] text-[var(--ink-3)]',
                ].join(' ')}
              >
                {sys === 'imperial' ? 'lb / in' : 'kg / cm'}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <label className="que-label">Weight / {u.weightUnit}</label>
            <input type="number" inputMode="decimal" className="que-input"
              value={wInput} onChange={e => setWInput(e.target.value)} onBlur={commitWeight} />
          </div>
          <div>
            <label className="que-label">Height / {u.heightUnit}</label>
            <input type="number" inputMode="decimal" className="que-input"
              value={hInput} onChange={e => setHInput(e.target.value)} onBlur={commitHeight} />
          </div>
          <div>
            <label className="que-label">Age</label>
            <input type="number" className="que-input"
              value={profile.age} onChange={e => onChange({ age: e.target.value })} />
          </div>

          <div>
            <label className="que-label">Sex</label>
            <select
              className="que-input cursor-pointer"
              value={profile.sex}
              onChange={e => onChange({ sex: e.target.value as 'male' | 'female' })}
            >
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </div>

          <div className="col-span-2 sm:col-span-1">
            {/* Manual daily target. A surplus is persisted as a NEGATIVE
                profile.deficit so the single budget formula handles both
                directions. The Deficit/Surplus toggle sets that sign; the input
                sets the magnitude. When an active plan matches the chosen
                direction, its dailyKcal is kept in lockstep so the projection
                and the budget never disagree. */}
            {(() => {
              const rawDef    = parseNum(profile.deficit);
              const isSurplus = rawDef < 0;
              const mag       = Math.abs(rawDef);
              const display   = String(mag || (profile.deficit === '' ? '' : 0));
              // Apply a signed daily target + sync an active same-direction plan.
              const apply = (magnitude: number, surplus: boolean) => {
                const m2 = Math.max(0, Math.round(magnitude));
                onChange({ deficit: String(surplus ? -m2 : m2) });
                const plan = loadPlan();
                if (plan && m2 > 0 && (plan.type === 'cut') === !surplus) {
                  savePlanToStorage({ ...plan, dailyKcal: m2, intensity: intensityForKcal(m2) });
                }
              };
              return (
                <>
                  <label className="que-label">Daily Target / kcal</label>
                  <div className="flex gap-1 mb-1.5">
                    {([['Deficit', false], ['Surplus', true]] as const).map(([lbl, surplus]) => {
                      const active = isSurplus === surplus;
                      return (
                        <button
                          key={lbl} type="button"
                          onClick={() => apply(mag || 500, surplus)}
                          className={[
                            'flex-1 py-1 rounded-sm font-mono text-[9px] font-bold tracking-[0.5px] uppercase transition-all',
                            active
                              ? surplus
                                ? 'bg-[var(--positive)] text-[var(--accent-ink)]'
                                : 'bg-[var(--accent)] text-[var(--accent-ink)]'
                              : 'bg-[var(--bg-2)] text-[var(--ink-2)] hover:text-[var(--ink-0)] border border-[var(--line-2)]',
                          ].join(' ')}
                        >
                          {lbl}
                        </button>
                      );
                    })}
                  </div>
                  <input
                    type="number" inputMode="numeric" className="que-input"
                    value={display}
                    placeholder={isSurplus ? 'e.g. 400' : 'e.g. 500'}
                    onChange={e => apply(parseNum(e.target.value), isSurplus)}
                  />
                  {(() => {
                    const plan = loadPlan();
                    const conflict = plan && ((plan.type === 'cut') !== !isSurplus);
                    return conflict ? (
                      <p className="font-mono text-[8px] text-[var(--warn)] tracking-[0.5px] mt-1 leading-tight">
                        Active {plan!.type} plan targets a {plan!.type === 'cut' ? 'deficit' : 'surplus'} — edit the plan to switch its direction.
                      </p>
                    ) : null;
                  })()}
                </>
              );
            })()}
          </div>

          <div className="col-span-2 sm:col-span-3 lg:col-span-1">
            <label className="que-label">Lifestyle</label>
            <select
              className="que-input cursor-pointer"
              value={profile.activityLevel}
              onChange={e => onChange({ activityLevel: e.target.value })}
            >
              {activityOptions.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 mt-4 pt-4 border-t border-[var(--line)] flex-wrap">
          <button
            onClick={() => {
              void import('@/lib/dataExport').then(m => m.downloadExport());
              void import('@/lib/telemetry').then(m => m.trackEvent('data_exported'));
            }}
            className="que-btn-ghost flex items-center gap-2"
            title="Download a JSON snapshot of all your local data"
          >
            <Download size={13} /> Export Data
          </button>
          <button onClick={onOpenLiftPlan} className="que-btn-ghost flex items-center gap-2">
            <Dumbbell size={13} /> Lifting Program
          </button>
          <button onClick={onOpenRunPlan} className="que-btn-ghost flex items-center gap-2">
            <Activity size={13} /> Running Plan
          </button>
          <button onClick={onOpenPlan} className="que-btn-ghost flex items-center gap-2">
            <Plus size={13} /> Create Plan
          </button>
          {hasPlanHistory && (
            <button onClick={onOpenHistory} className="que-btn-ghost flex items-center gap-2">
              <History size={13} /> Plan History
            </button>
          )}
        </div>

        <Measurements />
        <ProgressPhoto />

        <StepSyncPanel />
        <RecoveryPanel />
        <DataTrackerPanel />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PRBadge — plays the trophy animation once when a personal record is set
// ─────────────────────────────────────────────────────────────────────────────

function PRBadge({ size = 44 }: { size?: number }) {
  return (
    <div
      style={{ width: size, height: size, flexShrink: 0, pointerEvents: 'none' }}
      title="Personal Record!"
    >
      <Lottie
        animationData={prData}
        loop={false}
        autoplay={true}
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT — CalorieBudgetCard
// ─────────────────────────────────────────────────────────────────────────────

// Durations accept "h:mm:ss" / "mm:ss" / plain minutes (parsed at the UI edge;
// storage stays decimal minutes) — hence 'text' inputMode so mobile keyboards
// offer the colon.
const CARDIO_QUICK_CFG = {
  run:  { f1label: 'Distance / mi', f1mode: 'decimal', f1key: 'runDist',  f2label: 'Duration', f2key: 'runTime'  },
  bike: { f1label: 'Distance / mi', f1mode: 'decimal', f1key: 'bikeDist', f2label: 'Duration', f2key: 'bikeTime' },
  swim: { f1label: 'Duration',      f1mode: 'text',    f1key: 'swimTime', f2label: null,       f2key: null       },
} as const;

function CalorieBudgetCard({ m, onOpenProgress, prFlags }: {
  m: BudgetMetrics;
  onOpenProgress?: () => void;
  prFlags?: PRFlags;
}) {
  const spotlight = useSpotlightBorder({ color: '79,195,247', size: 280, opacity: 0.55 });
  const { updateDayRecord, getDayRecord, localDB, activeDayFocus, profile } = useApp();
  const u = useUnits();

  const calsEaten  = parseNum(String(localDB[activeDayFocus]?.calsEaten ?? 0));
  const remaining  = m.budget - calsEaten;
  const eatPct     = m.budget > 0 ? Math.min(1, calsEaten / m.budget) : 0;
  const isOver     = remaining < 0;

  const [cardioModal, setCardioModal] = useState<'run' | 'bike' | 'swim' | null>(null);
  const [f1, setF1] = useState('');
  const [f2, setF2] = useState('');

  const openCardioModal = useCallback((kind: 'run' | 'bike' | 'swim') => {
    const rec = getDayRecord(activeDayFocus);
    const cfg = CARDIO_QUICK_CFG[kind];
    const f1IsDistance = cfg.f1key === 'runDist' || cfg.f1key === 'bikeDist';
    const raw = (rec as Record<string, unknown>)[cfg.f1key];
    // Prefill: distance → display units; duration → h:mm:ss.
    setF1(raw
      ? (f1IsDistance ? u.dispDistance(parseNum(String(raw))) : fmtDuration(parseNum(String(raw))))
      : '');
    const f2raw = cfg.f2key ? parseNum(String((rec as Record<string, unknown>)[cfg.f2key] || 0)) : 0;
    setF2(f2raw > 0 ? fmtDuration(f2raw) : '');
    setCardioModal(kind);
  }, [getDayRecord, activeDayFocus, u]);

  // Write cardio through the EXERCISES ARRAY (the source of truth) and derive the
  // top-level fields, so cardio logged here also shows on the calendar / day
  // summary and can't desync from the workout log. See lib/cardioSync.
  const writeCardio = useCallback((kind: 'run' | 'bike' | 'swim', distanceMi: number, durationMin: number) => {
    const rec = getDayRecord(activeDayFocus) as { exercises?: unknown };
    const entries = parseExercises(rec.exercises);
    const next = setCardioOfKind(entries, kind, distanceMi, durationMin);
    const derived = deriveCardioFields(next, profile, rec as Parameters<typeof deriveCardioFields>[2]);
    updateDayRecord(activeDayFocus, { exercises: JSON.stringify(next), ...derived } as Parameters<typeof updateDayRecord>[1]);
  }, [activeDayFocus, updateDayRecord, getDayRecord, profile]);

  const submitCardio = useCallback(() => {
    if (!cardioModal) return;
    let distanceMi = 0;
    let durationMin = 0;
    if (cardioModal === 'swim') {
      // Swim modal edits TIME only (f1) — preserve any existing logged distance.
      durationMin = parseDurationToMin(f1) ?? 0;
      distanceMi = existingCardioDistance(parseExercises((getDayRecord(activeDayFocus) as { exercises?: unknown }).exercises), 'swim');
    } else {
      distanceMi = u.toStoredDistance(parseFloat(f1) || 0); // display unit → canonical miles
      durationMin = parseDurationToMin(f2) ?? 0;
    }
    writeCardio(cardioModal, distanceMi, durationMin);
    setCardioModal(null);
  }, [cardioModal, f1, f2, activeDayFocus, getDayRecord, writeCardio, u]);

  const clearCardio = useCallback((kind: 'run' | 'bike' | 'swim') => {
    writeCardio(kind, 0, 0); // 0/0 → removes the kind from the array + zeroes derived fields
  }, [writeCardio]);

  const todayRec = localDB[activeDayFocus] ?? {};
  const runDist  = parseNum(String(todayRec.runDist  ?? 0));
  const bikeDist = parseNum(String(todayRec.bikeDist ?? 0));
  const swimMin  = parseNum(String(todayRec.swimTime ?? 0));

  const tiles = [
    {
      label: 'RUN',  value: m.runBurn,  key: 'run',
      dist: runDist  > 0 ? u.fmtDistance(runDist)  : undefined,
      pace: m.runPaceStr                           || undefined,
    },
    {
      label: 'BIKE', value: m.bikeBurn, key: 'bike',
      dist: bikeDist > 0 ? u.fmtDistance(bikeDist) : undefined,
      pace: m.bikeSpeed > 0 ? `${m.bikeSpeed} mph` : undefined,
    },
    {
      label: 'SWIM', value: m.swimBurn, key: 'swim',
      dist: undefined,
      pace: swimMin  > 0 ? fmtDuration(swimMin)    : undefined,
    },
    { label: 'STEPS', value: m.stepBurn, key: 'step', dim: true, dist: undefined, pace: undefined },
  ];

  return (
    <div
      ref={spotlight.ref}
      onMouseMove={spotlight.onMouseMove}
      onMouseLeave={spotlight.onMouseLeave}
      onTouchMove={spotlight.onTouchMove}
      onTouchEnd={spotlight.onTouchEnd}
      className="que-card que-card-accent mb-4"
    >
      {spotlight.Overlay}
      <div className="p-5">
        <h2 className="que-section-label mb-5"><span className="dot" />CALORIE BUDGET</h2>

        {/* Hero — oversized telemetry */}
        <div className="relative rounded p-6 mb-4 bg-[var(--bg-2)] border border-[var(--line)] overflow-hidden">
          <span
            className="absolute left-0 right-0 bottom-0 h-px"
            style={{ background: 'linear-gradient(90deg, transparent, var(--accent), transparent)' }}
          />
          <span className="absolute top-3 left-5 font-mono text-[9px] tracking-[3px] text-[var(--ink-3)] uppercase">
            ◐ {calsEaten > 0 ? 'REMAINING' : 'DAILY TARGET'}
          </span>
          <span className="absolute top-3 right-5 font-mono text-[9px] tracking-[3px] text-[var(--accent)] uppercase">
            LIVE
          </span>

          <div className="mt-6 flex items-end gap-3">
            <span
              className="font-display tabular leading-none text-[96px] sm:text-[120px] lg:text-[140px]"
              style={{
                color: isOver ? 'var(--danger)' : 'var(--accent)',
                textShadow: isOver ? '0 0 40px rgba(255,80,80,0.4)' : '0 0 40px var(--accent-40)',
                letterSpacing: '-0.04em',
              }}
            >
              {isOver ? fmt(-remaining) : fmt(calsEaten > 0 ? remaining : m.budget)}
            </span>
            <div className="pb-3 flex flex-col gap-0.5">
              <span className="font-display text-[24px] tracking-[3px] uppercase text-[var(--ink-2)]">
                kcal
              </span>
              {isOver && (
                <span className="font-mono text-[9px] tracking-[1.5px] uppercase" style={{ color: 'var(--danger)' }}>
                  over
                </span>
              )}
            </div>
          </div>

          {calsEaten > 0 && (
            <div className="mt-4 mb-1">
              <div className="h-1.5 rounded-full bg-[var(--bg-3)] overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${Math.min(100, eatPct * 100)}%`,
                    background: isOver ? 'var(--danger)' : 'var(--accent)',
                    boxShadow: isOver ? '0 0 8px rgba(255,80,80,0.5)' : '0 0 8px var(--accent-40)',
                  }}
                />
              </div>
              <p className="mt-2 font-mono text-[10px] text-[var(--ink-3)] tracking-[0.5px]">
                {fmt(calsEaten)} eaten · {fmt(m.budget)} target
              </p>
            </div>
          )}

          {calsEaten === 0 && (
            <p className="mt-3 font-mono text-[11px] text-[var(--ink-3)] tracking-[1px]">
              {/* m.deficit is negative on an active bulk plan (surplus
                  encoded as a signed deficit). Render the operator separately
                  so the formula reads "tdee + 500 + eatBack" for a bulk
                  instead of the visually broken "tdee − -500". */}
              {`${fmt(m.tdee)} ${m.deficit < 0 ? '+' : '−'} ${fmt(Math.abs(m.deficit))}${m.eatBack > 0 ? ` + ${fmt(m.eatBack)}` : ''} = ${fmt(m.budget)} kcal`}
            </p>
          )}
        </div>

        {/* Math breakdown — telemetry strip */}
        <div className="rounded border border-[var(--line)] bg-[var(--bg-2)] px-4 mb-4">
          {([
            { label: 'BMR (Mifflin-St Jeor)', value: `${fmt(m.bmr)} kcal`,           indent: false, bold: false },
            { label: '× Activity Multiplier',  value: `× ${m.multiplier}`,             indent: true,  bold: false },
            { label: '= Maintenance (TDEE)',   value: `${fmt(m.tdee)} kcal`,           indent: false, bold: true  },
            null,
            // Bulk plans store their surplus as a negative profile.deficit
            // so the single budget formula works for both directions. Flip
            // the row label so it reads "+ Surplus" instead of "− Deficit: −-500".
            m.deficit < 0
              ? { label: '+ Surplus Goal', value: `+${fmt(Math.abs(m.deficit))} kcal`, indent: false, bold: false, green: true }
              : { label: '− Deficit Goal', value: `−${fmt(m.deficit)} kcal`,           indent: false, bold: false, red:   true },
            { label: 'Tracked cardio burn',    value: m.activityBurn > 0 ? `${fmt(m.activityBurn)} kcal` : '— kcal', indent: true, bold: false, accent: true },
            { label: 'Run',  value: m.runBurn  > 0 ? `${fmt(m.runBurn)}  kcal` : '—', indent: true,  bold: false, icon: 'run'  as const, iconActive: m.runBurn  > 0 },
            { label: 'Bike', value: m.bikeBurn > 0 ? `${fmt(m.bikeBurn)} kcal` : '—', indent: true,  bold: false, icon: 'bike' as const, iconActive: m.bikeBurn > 0 },
            { label: 'Swim', value: m.swimBurn > 0 ? `${fmt(m.swimBurn)} kcal` : '—', indent: true,  bold: false, icon: 'swim' as const, iconActive: m.swimBurn > 0 },
            { label: '+ 60% Eat-Back',         value: m.eatBack > 0 ? `+${fmt(m.eatBack)} kcal` : '+0 kcal', indent: false, bold: false, green: true },
          ] as const).map((row, i) => {
            if (row === null) {
              return <hr key={i} className="my-1 border-0 h-px bg-[var(--line)]" />;
            }
            const hasIcon = 'icon' in row;
            return (
              <div key={i} className="flex justify-between items-center py-2 border-b border-[var(--line)] last:border-b-0">
                <span className={[
                  'flex items-center gap-2 font-mono text-[11px] tracking-[0.5px]',
                  row.indent ? 'pl-4 text-[var(--ink-3)]' : 'text-[var(--ink-1)]',
                  row.bold   ? '!text-[12px] !font-bold !text-[var(--ink-0)] uppercase tracking-[1px]' : '',
                ].join(' ')}>
                  {hasIcon && (
                    <ActivityIcon
                      kind={(row as { icon: 'run'|'bike'|'swim' }).icon}
                      active={(row as { iconActive: boolean }).iconActive}
                      size={24}
                    />
                  )}
                  {row.label}
                </span>
                <span className={[
                  'font-mono font-bold tabular text-[13px]',
                  row.indent ? 'text-[11px] text-[var(--ink-3)]' : 'text-[var(--ink-0)]',
                  row.bold   ? '!text-[16px] !text-[var(--ink-0)]' : '',
                  'red'    in row && row.red    ? '!text-[var(--danger)]'   : '',
                  'accent' in row && row.accent ? '!text-[var(--accent)]'   : '',
                  'green'  in row && row.green  ? '!text-[var(--positive)]' : '',
                  hasIcon && (row as { iconActive: boolean }).iconActive ? '!text-[var(--positive)]' : '',
                ].join(' ')}>
                  {row.value}
                </span>
              </div>
            );
          })}
        </div>

        {/* Per-activity burn tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {tiles.map(t => {
            const lit = !t.dim && t.value > 0;
            return (
              <div
                key={t.key}
                onClick={() => !t.dim && openCardioModal(t.key as 'run' | 'bike' | 'swim')}
                className={[
                  'relative rounded p-3 border overflow-hidden',
                  t.dim ? 'border-[var(--line)] bg-[var(--bg-2)] opacity-60'
                    : lit ? 'border-[var(--positive)]/40 cursor-pointer'
                    : 'border-[var(--line-2)] bg-[var(--bg-2)] hover:border-[var(--accent)] transition-all cursor-pointer',
                ].join(' ')}
                style={lit ? {
                  background: 'var(--tile-bg-lit)',
                  animation:  'tile-glow-pulse 2.8s ease-in-out infinite',
                } : undefined}
                title={t.dim ? undefined : 'Tap to log'}
              >
                {lit && (
                  <span
                    key={`flash-${t.key}-active`}
                    className="absolute inset-0 pointer-events-none rounded"
                    style={{ animation: 'tile-activate 1s ease-out forwards' }}
                  />
                )}

                <div className="flex items-center justify-between mb-2">
                  <p className="font-mono text-[9px] font-bold tracking-[2px] text-[var(--ink-3)]">
                    {t.label}
                  </p>
                  {!t.dim && (
                    <div className="flex items-center gap-1">
                      {prFlags?.[`pr${t.key.charAt(0).toUpperCase()}${t.key.slice(1)}` as keyof PRFlags] && (
                        <PRBadge size={36} />
                      )}
                      {lit && (
                        <button
                          onClick={e => { e.stopPropagation(); clearCardio(t.key as 'run' | 'bike' | 'swim'); }}
                          className="w-5 h-5 flex items-center justify-center rounded text-[var(--ink-3)] hover:text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors"
                          title="Clear"
                        >
                          <X size={12} />
                        </button>
                      )}
                      <ActivityIcon kind={t.key as 'run' | 'bike' | 'swim'} active={lit} size={28} />
                    </div>
                  )}
                </div>
                <div className="flex items-end justify-between gap-1">
                  <div>
                    <p
                      className="font-display tabular leading-none text-[26px]"
                      style={{
                        color:      t.dim ? 'var(--ink-3)' : lit ? 'var(--positive)' : 'var(--accent)',
                        textShadow: t.dim || !lit ? 'none' : '0 0 16px var(--tile-text-glow)',
                      }}
                    >
                      {t.value > 0 ? fmt(t.value) : '—'}
                    </p>
                    <p className="font-mono text-[9px] text-[var(--ink-3)] mt-1 tracking-[1px]">
                      {t.dim ? 'IN MULTIPLIER' : 'KCAL'}
                    </p>
                  </div>
                  {lit && (t.dist || t.pace) && (
                    <div className="flex flex-col items-end gap-0.5 pb-0.5">
                      {t.dist && (
                        <p className="font-mono text-[11px] font-semibold text-[var(--positive)] tracking-[0.5px]">
                          {t.dist}
                        </p>
                      )}
                      {t.pace && (
                        <p className="font-mono text-[11px] text-[var(--ink-2)] tracking-[0.5px]">
                          {t.pace}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Quick-log cardio modal */}
        <AnimatePresence>
          {cardioModal && (() => {
            const cfg = CARDIO_QUICK_CFG[cardioModal];
            const name = cardioModal.toUpperCase();
            return (
              <motion.div
                key="cardio-quick"
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.18 }}
                className="mt-3 rounded border border-[var(--accent)]/40 bg-[var(--bg-2)] p-3"
              >
                <div className="flex items-center justify-between mb-2.5">
                  <p className="font-mono text-[9px] font-bold tracking-[2px] text-[var(--accent)] uppercase">
                    Log {name}
                  </p>
                  <button onClick={() => setCardioModal(null)} className="text-[var(--ink-3)] hover:text-[var(--ink-0)] transition-colors">
                    <X size={14} />
                  </button>
                </div>
                <div className={`grid gap-2 mb-2.5 ${cfg.f2key ? 'grid-cols-2' : 'grid-cols-1'}`}>
                  <div>
                    <label className="que-label">
                      {cardioModal === 'run' || cardioModal === 'bike' ? `Distance / ${u.distanceUnit}` : cfg.f1label}
                    </label>
                    <input
                      autoFocus type="text" inputMode={cfg.f1mode}
                      className="que-input" value={f1} onChange={e => setF1(e.target.value)}
                      placeholder={cardioModal === 'swim' ? '45:00' : undefined}
                      onKeyDown={e => e.key === 'Enter' && submitCardio()}
                    />
                  </div>
                  {cfg.f2key && (
                    <div>
                      <label className="que-label">{cfg.f2label}</label>
                      <input
                        type="text" inputMode="text"
                        className="que-input" value={f2} onChange={e => setF2(e.target.value)}
                        placeholder="45:00"
                        onKeyDown={e => e.key === 'Enter' && submitCardio()}
                      />
                    </div>
                  )}
                </div>
                <button onClick={submitCardio} className="que-btn-primary w-full py-2.5 text-[11px]">
                  Save {name}
                </button>
              </motion.div>
            );
          })()}
        </AnimatePresence>

        {/* Active Plan Progress */}
        {(() => {
          if (typeof window === 'undefined') return null;
          const plan = loadPlan(); if (!plan) return null;
          // Exact ms-based elapsed weeks (matches the modals; no day-rounding).
          const weeksSince = Math.max(0, (Date.now() - new Date(plan.startDate + 'T00:00:00').getTime()) / (7 * 86400000));
          // Anchor projection at the plan's locked start weight so this tile stays
          // consistent with the chart and Change stat in PlanProgressModal. Capped
          // at the goal so a completed/overrun plan doesn't project past it.
          const baseline   = getPlanBaseline(plan, localDB);
          const projNow      = baseline + planExpectedChange(plan, weeksSince);
          const weeksLeft    = Math.max(0, plan.weeksTarget - weeksSince);
          const planAccent   = plan.type === 'cut' ? 'var(--accent)' : 'var(--positive)';
          const planBg       = plan.type === 'cut' ? 'var(--accent-12)' : 'var(--positive-12)';
          const planBorder   = plan.type === 'cut' ? 'var(--accent)' : 'var(--positive)';
          const intensityLbl = plan.intensity ? INTENSITY_LABELS[plan.type][plan.intensity] : plan.type.toUpperCase();
          return (
            <button
              type="button"
              onClick={onOpenProgress}
              className="mt-4 w-full rounded border p-4 text-left transition-all hover:brightness-110 active:scale-[0.99]"
              style={{ borderColor: planBorder, background: planBg }}
            >
              <div className="flex items-center justify-between mb-3">
                <p className="font-mono text-[9px] font-bold tracking-[2px] text-[var(--ink-3)] uppercase">Active Plan</p>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[9px] font-bold tracking-[1.5px] uppercase px-2 py-0.5 rounded-sm"
                    style={{ color: planAccent, border: `1px solid ${planAccent}` }}>
                    {intensityLbl} · {fmt(plan.dailyKcal)} kcal
                  </span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: planAccent, opacity: 0.7 }} aria-hidden>
                    <polyline points="9 18 15 12 9 6"/>
                  </svg>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {[
                  { label: 'Week',     value: `${Math.ceil(weeksSince)}/${plan.weeksTarget}`, color: 'var(--ink-0)' },
                  { label: 'Proj Now', value: u.fmtWeight(projNow),                          color: planAccent      },
                  { label: 'Goal',     value: u.fmtWeight(plan.goalWeight),                  color: planAccent      },
                  { label: 'Left',     value: `${Math.ceil(weeksLeft)} wks`,                  color: 'var(--ink-0)' },
                ].map(s => (
                  <div key={s.label}>
                    <p className="font-mono text-[8px] font-bold tracking-[1px] text-[var(--ink-3)] uppercase mb-1">{s.label}</p>
                    <p className="font-display text-[14px] leading-none" style={{ color: s.color }}>{s.value}</p>
                  </div>
                ))}
              </div>
            </button>
          );
        })()}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT — TrophyCaseCard
// ─────────────────────────────────────────────────────────────────────────────

function TrophyCaseCard() {
  const { localDB } = useApp();
  const u = useUnits();

  const records = useMemo(() => {
    let prs: Record<string, number> = {};
    try { prs = JSON.parse(localStorage.getItem(LIFT_PRS_KEY) ?? '{}'); } catch { /* noop */ }

    const prDates: Record<string, string> = {};
    Object.entries(localDB).sort(([a], [b]) => a.localeCompare(b)).forEach(([ds, rec]) => {
      if (!rec.exercises) return;
      try {
        (JSON.parse(String(rec.exercises)) as Array<{ k?: string; n?: string; sets?: Array<{ w?: string }> }>)
          .forEach(ex => {
            if (ex.k !== 'lift' || !ex.n || !ex.sets) return;
            const w = Math.max(0, ...ex.sets.map(s => parseFloat(s.w ?? '0') || 0));
            if (w > 0 && w >= (prs[ex.n] ?? 0) && !prDates[ex.n]) prDates[ex.n] = ds;
          });
      } catch { /* skip */ }
    });

    return Object.entries(prs)
      .sort((a, b) => b[1] - a[1])
      .map(([name, weight]) => ({ name, weight, date: prDates[name] ?? null }));
  }, [localDB]);

  if (records.length === 0) return null;

  return (
    <div className="que-card mb-4">
      <div className="p-5">
        <h2 className="que-section-label mb-4"><span className="dot" />TROPHY CASE</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {records.slice(0, 12).map(({ name, weight, date }) => (
            <div key={name} className="flex items-center justify-between gap-3 rounded border border-[var(--line)] bg-[var(--bg-2)] px-3 py-2.5">
              <div className="min-w-0">
                <p className="font-mono text-[10px] font-semibold text-[var(--ink-0)] truncate">{name}</p>
                {date && (
                  <p className="font-mono text-[8px] text-[var(--ink-3)] tracking-[0.5px] mt-0.5">
                    {fmtDateLong(date)}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="#FFB547" aria-hidden>
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                </svg>
                <span className="font-display text-[16px] leading-none" style={{ color: '#FFB547' }}>{u.dispWeight(weight)}</span>
                <span className="font-mono text-[9px] text-[var(--ink-3)]">{u.weightUnit}</span>
              </div>
            </div>
          ))}
        </div>
        {records.length > 12 && (
          <p className="font-mono text-[8px] text-[var(--ink-3)] mt-2 text-center tracking-[0.5px]">
            +{records.length - 12} more records
          </p>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT — WeeklyRecapCard
// ─────────────────────────────────────────────────────────────────────────────

function WeeklyRecapCard() {
  const { localDB, today, todayStr } = useApp();
  const [dismissed, setDismissed] = useState(false);

  const weekKey = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return `${d.getFullYear()}-W${String(Math.ceil((d.getDate() + new Date(d.getFullYear(), 0, 1).getDay()) / 7)).padStart(2, '0')}`;
  }, [today]);

  const shouldShow = useMemo(() => {
    if (dismissed) return false;
    const seen = localStorage.getItem('queWeeklyRecapSeen');
    if (seen === weekKey) return false;
    return today.getDay() === 0;
  }, [today, weekKey, dismissed]);

  const stats = useMemo(() => {
    if (!shouldShow) return null;
    const mon = new Date(today); mon.setDate(today.getDate() - 6);
    const weekStart = toDateStr(mon);

    let sessions = 0, calBudgetDays = 0, liftPRsThisWeek = 0;
    let prRecs: Record<string, number> = {};
    try { prRecs = JSON.parse(localStorage.getItem(LIFT_PRS_KEY) ?? '{}'); } catch { /* noop */ }
    const prBeforeWeek: Record<string, number> = {};

    Object.entries(localDB).forEach(([ds, rec]) => {
      if (ds >= weekStart) return;
      if (!rec.exercises) return;
      try {
        (JSON.parse(String(rec.exercises)) as Array<{ k?: string; n?: string; sets?: Array<{ w?: string }> }>)
          .forEach(ex => {
            if (ex.k !== 'lift' || !ex.n || !ex.sets) return;
            const w = Math.max(0, ...ex.sets.map(s => parseFloat(s.w ?? '0') || 0));
            if (w > 0) prBeforeWeek[ex.n] = Math.max(prBeforeWeek[ex.n] ?? 0, w);
          });
      } catch { /* skip */ }
    });

    Object.entries(localDB).forEach(([ds, rec]) => {
      if (ds < weekStart || ds > todayStr) return;
      if (rec.exercises) {
        try {
          const exs = JSON.parse(String(rec.exercises)) as Array<{ k?: string; n?: string; sets?: Array<{ w?: string }> }>;
          if (exs.some(e => e.k === 'lift')) sessions++;
          exs.forEach(ex => {
            if (ex.k !== 'lift' || !ex.n || !ex.sets) return;
            const w = Math.max(0, ...ex.sets.map(s => parseFloat(s.w ?? '0') || 0));
            if (w > 0 && w > (prBeforeWeek[ex.n] ?? 0)) liftPRsThisWeek++;
          });
        } catch { /* skip */ }
      }
      const eaten = parseNum(String(rec.calsEaten ?? 0));
      const budget = parseNum(String(rec.budget ?? 0));
      if (budget > 0 && eaten > 0 && eaten <= budget) calBudgetDays++;
    });

    void prRecs; // used for baseline above
    return { sessions, liftPRsThisWeek, calBudgetDays };
  }, [localDB, today, todayStr, shouldShow]);

  if (!shouldShow || !stats) return null;

  const dismiss = () => {
    localStorage.setItem('queWeeklyRecapSeen', weekKey);
    setDismissed(true);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
      className="rounded border border-[var(--positive)]/30 bg-[var(--positive)]/5 p-4 mb-4"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="font-mono text-[9px] font-bold tracking-[2px] text-[var(--positive)] uppercase mb-0.5">Weekly Recap</p>
          <p className="font-mono text-[10px] text-[var(--ink-1)] leading-relaxed">
            This week: <strong>{stats.sessions} session{stats.sessions !== 1 ? 's' : ''}</strong>
            {stats.liftPRsThisWeek > 0 && <> · <strong className="text-[#FFB547]">+{stats.liftPRsThisWeek} PR{stats.liftPRsThisWeek !== 1 ? 's' : ''}</strong></>}
            {' '}· <strong>{stats.calBudgetDays} of 7 days</strong> on budget
          </p>
        </div>
        <button onClick={dismiss} className="text-[var(--ink-3)] hover:text-[var(--ink-0)] transition-colors flex-shrink-0">
          <X size={14} />
        </button>
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT — MaintenanceCard (adaptive TDEE)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Surfaces the adaptive-TDEE estimate (lib/adaptiveTdee) — the user's maintenance
 * *learned from their own logs*, not a static formula. HONESTY is load-bearing
 * here: the engine proved it returns maintenance-in-logging-units, NOT lab-true
 * metabolic rate, so the copy says "learned from your logs," never "true TDEE."
 *
 * For most current users this renders the EMPTY state (needs ~10 days logging
 * weight + food together). That state is treated as the primary experience: a
 * motivating unlock-progress nudge, since that's the feature's near-term job.
 */
function MaintenanceCard({ formulaTdee }: { formulaTdee: number }) {
  const { localDB } = useApp();
  const u = useUnits();

  const tdeeDays = useMemo<TdeeDay[]>(
    () => Object.entries(localDB).map(([date, rec]) => ({
      date, weight: (rec as DayRecord).weight, calsEaten: (rec as DayRecord).calsEaten,
    })),
    [localDB],
  );

  const result   = useMemo(() => estimateAdaptiveTDEE(tdeeDays, formulaTdee), [tdeeDays, formulaTdee]);
  const qualDays = useMemo(() => countQualifyingDays(tdeeDays), [tdeeDays]);

  const CONF_LABEL: Record<string, { text: string; color: string }> = {
    low:    { text: 'LOW CONFIDENCE',    color: 'var(--warn)' },
    medium: { text: 'MEDIUM CONFIDENCE', color: 'var(--accent)' },
    high:   { text: 'HIGH CONFIDENCE',   color: 'var(--positive)' },
  };

  // ── Empty / unlock state (the primary experience for current users) ──────────
  if (result.estimate === null) {
    const remaining = Math.max(0, QUALIFYING_DAYS_TO_UNLOCK - qualDays);
    const pct = Math.min(1, qualDays / QUALIFYING_DAYS_TO_UNLOCK);
    return (
      <div className="que-card mb-4">
        <div className="p-5">
          <h2 className="que-section-label mb-3"><span className="dot" />ADAPTIVE MAINTENANCE</h2>
          <div className="flex items-start gap-2.5">
            <Sparkles size={15} className="text-[var(--accent)] flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="font-mono text-[11px] text-[var(--ink-1)] leading-relaxed">
                Log your <strong className="text-[var(--ink-0)]">weight and food on the same day</strong> about {QUALIFYING_DAYS_TO_UNLOCK} times this month to unlock a maintenance estimate learned from <em>your</em> data — not a formula.
              </p>
            </div>
          </div>
          {/* Progress toward unlock — the actual near-term function. */}
          <div className="mt-3">
            <div className="flex justify-between items-baseline mb-1">
              <span className="font-mono text-[9px] font-bold uppercase tracking-[1.5px] text-[var(--ink-2)]">Qualifying days</span>
              <span className="font-mono text-[9px] text-[var(--ink-3)] tracking-[0.5px]">{qualDays} of ~{QUALIFYING_DAYS_TO_UNLOCK}</span>
            </div>
            <div className="h-1.5 bg-[var(--bg-3)] rounded-full overflow-hidden">
              <motion.div
                className="h-full rounded-full bg-[var(--accent)]"
                initial={{ width: 0 }} animate={{ width: `${pct * 100}%` }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
              />
            </div>
            <p className="font-mono text-[8px] text-[var(--ink-3)] mt-2 tracking-[0.3px]">
              {remaining > 0
                ? `${remaining} more day${remaining === 1 ? '' : 's'} with both a weigh-in and a food log.`
                : 'Almost there — keep logging consistently.'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Estimate state ───────────────────────────────────────────────────────────
  const conf = CONF_LABEL[result.confidence] ?? CONF_LABEL.low;
  const trendLb = result.weightTrendLb ?? 0;
  const TrendIcon = trendLb < -0.2 ? TrendingDown : trendLb > 0.2 ? TrendingUp : Minus;
  const trendWord = trendLb < -0.2 ? 'losing' : trendLb > 0.2 ? 'gaining' : 'holding steady';
  const diffFromFormula = result.estimate - formulaTdee;

  return (
    <div className="que-card mb-4">
      <div className="p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="que-section-label !mb-0"><span className="dot" />ADAPTIVE MAINTENANCE</h2>
          <span className="font-mono text-[8px] font-bold tracking-[1px] px-2 py-0.5 rounded" style={{ color: conf.color, background: 'var(--bg-2)' }}>
            {conf.text}
          </span>
        </div>

        <div className="flex items-baseline gap-2">
          <span className="font-display text-[32px] leading-none text-[var(--ink-0)]">{Math.round(result.estimate).toLocaleString()}</span>
          <span className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.5px]">kcal / day</span>
        </div>
        <p className="font-mono text-[9px] text-[var(--ink-2)] mt-1.5 tracking-[0.3px] leading-relaxed">
          Your estimated maintenance, <strong className="text-[var(--ink-1)]">learned from your logs</strong>.
          {Math.abs(diffFromFormula) >= 30 && (
            <> That&apos;s {Math.abs(diffFromFormula)} kcal {diffFromFormula > 0 ? 'above' : 'below'} the formula estimate.</>
          )}
        </p>

        {/* The "why" — weight trend context makes the number credible, not magic. */}
        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-[var(--line)]">
          <TrendIcon size={14} className="text-[var(--ink-2)] flex-shrink-0" />
          <span className="font-mono text-[9px] text-[var(--ink-2)] tracking-[0.3px]">
            Based on your weight {trendWord}
            {Math.abs(trendLb) > 0.2 && <> {u.fmtWeight(Math.abs(trendLb))}</>} over {result.windowDays} days, across {result.daysUsed} logged days.
          </span>
        </div>

        {/* Transparency: the raw adaptive number behind the blended estimate. */}
        {result.adaptiveRaw !== null && result.adaptiveRaw !== result.estimate && (
          <p className="font-mono text-[8px] text-[var(--ink-3)] mt-2 tracking-[0.3px]">
            Blended with the baseline formula for stability · raw signal: {result.adaptiveRaw.toLocaleString()} kcal
          </p>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT — WeeklyVolumeCard
// ─────────────────────────────────────────────────────────────────────────────

function WeeklyVolumeCard() {
  const { localDB, today, todayStr } = useApp();
  const u = useUnits();

  const volumeByGroup = useMemo(() => {
    const mon = new Date(today);
    mon.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const weekStart = toDateStr(mon);

    const groups: Record<string, number> = {};
    Object.entries(localDB).forEach(([ds, rec]) => {
      if (ds < weekStart || ds > todayStr || !rec.exercises) return;
      try {
        (JSON.parse(String(rec.exercises)) as Array<{ k?: string; g?: string; g2?: string; g3?: string; sets?: Array<{ r: string; w: string }> }>)
          .forEach(ex => {
            if (ex.k !== 'lift' || !ex.g || !ex.sets) return;
            const vol = ex.sets.reduce((s, set) => {
              const r = parseInt(String(set.r)) || 0;
              const w = parseFloat(String(set.w)) || 0;
              return s + r * w;
            }, 0);
            if (vol > 0) {
              groups[ex.g]                 = (groups[ex.g]  ?? 0) + vol;
              if (ex.g2) groups[ex.g2]     = (groups[ex.g2] ?? 0) + vol * 0.5;
              if (ex.g3) groups[ex.g3]     = (groups[ex.g3] ?? 0) + vol * 0.25;
            }
          });
      } catch { /* skip */ }
    });
    return Object.entries(groups).sort((a, b) => b[1] - a[1]);
  }, [localDB, today, todayStr]);

  if (volumeByGroup.length === 0) return null;

  const maxVol = Math.max(...volumeByGroup.map(([, v]) => v), 1);

  return (
    <div className="que-card mb-4">
      <div className="p-5">
        <h2 className="que-section-label mb-4"><span className="dot" />WEEKLY VOLUME</h2>
        <div className="space-y-2.5">
          {volumeByGroup.map(([group, vol]) => (
            <div key={group}>
              <div className="flex justify-between items-baseline mb-1">
                <span className="font-mono text-[9px] font-bold uppercase tracking-[1.5px] text-[var(--ink-2)]">{group}</span>
                <span className="font-mono text-[9px] text-[var(--ink-3)] tracking-[0.5px]">
                  {(() => { const v = u.fromStoredWeight(vol); return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v); })()} {u.weightUnit}
                </span>
              </div>
              <div className="h-1.5 bg-[var(--bg-3)] rounded-full overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-[var(--accent)]"
                  initial={{ width: 0 }}
                  animate={{ width: `${(vol / maxVol) * 100}%` }}
                  transition={{ duration: 0.6, ease: 'easeOut' }}
                  style={{ opacity: 0.7 + (vol / maxVol) * 0.3 }}
                />
              </div>
            </div>
          ))}
        </div>
        <p className="font-mono text-[8px] text-[var(--ink-3)] mt-3 tracking-[0.5px]">
          Sets × reps × weight · current week (Mon–{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][today.getDay()]})
        </p>
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT — ActivityLogCard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Real caloric balance for a logged day: calsEaten − true maintenance, where
 * maintenance comes from dayMaintenance() (the stored TDEE snapshot, or the
 * legacy budget+deficit reconstruction for older days). Negative = a real
 * deficit, positive = a real surplus. Returns null when the day lacks the data.
 *
 * NOTE: this is the true deficit/surplus vs. maintenance — NOT calsEaten −
 * budget, which only measures how far under/over the GOAL you landed.
 */
function dayCalorieBalance(
  rec: { calsEaten?: unknown; tdee?: unknown; budget?: unknown; burn?: unknown },
  goalDeficit: number,
): number | null {
  const eaten = parseNum(String(rec.calsEaten ?? 0));
  if (eaten <= 0) return null;
  const maintenance = dayMaintenance(rec, goalDeficit);
  if (maintenance === null) return null;
  return Math.round(eaten - maintenance);
}

function ActivityLogCard() {
  const { localDB, today, profile } = useApp();
  const [page, setPage] = useState(30);
  // Goal direction: positive deficit = cutting, negative = bulking (surplus
  // stored as a negative deficit). Matches getPlanCompliance's default of 500.
  const goalDeficit = parseNum(profile.deficit) || 500;
  const cutting     = goalDeficit >= 0;

  const DOW = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  const todayStr = toDateStr(today);

  const allKeys = useMemo(() => Object.keys(localDB).sort((a, b) => b.localeCompare(a)), [localDB]);
  const visible = useMemo(() => {
    const keys = allKeys.includes(todayStr) ? allKeys : [todayStr, ...allKeys];
    return keys.slice(0, page);
  }, [allKeys, todayStr, page]);
  const remaining = allKeys.length - page;

  return (
    <div className="que-card mb-4">
      <div className="p-5">
        <h2 className="que-section-label mb-4"><span className="dot" />ACTIVITY LOG</h2>

        {visible.length === 0 ? (
          <p className="text-center font-mono text-[11px] text-[var(--ink-3)] py-8 border border-dashed border-[var(--line-2)] rounded tracking-[1px] uppercase">
            No logged days yet
          </p>
        ) : (
          <div className="flex flex-col">
            {visible.map(ds => {
              const rec    = localDB[ds] ?? {};
              const d        = new Date(ds + 'T00:00:00');
              const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
              const dayIdx   = Math.round((todayMid.getTime() - d.getTime()) / 86400000);
              const label  = dayIdx === 0 ? 'TODAY'
                : dayIdx === 1 ? 'YESTERDAY'
                : `${DOW[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
              // Real balance vs maintenance (deficit when negative, surplus when
              // positive) — not just "under/over the goal budget".
              const balance = dayCalorieBalance(rec, goalDeficit);

              let netEl: React.ReactNode = <span className="font-mono text-[11px] text-[var(--ink-3)] tracking-[1px]">—</span>;
              if (balance !== null) {
                if (balance === 0) {
                  netEl = <span className="font-mono font-bold text-[13px] tabular text-[var(--ink-1)]">maintenance</span>;
                } else {
                  const isDeficit = balance < 0;
                  // Green when the balance moves toward the user's goal.
                  const onGoal = cutting ? isDeficit : !isDeficit;
                  const col    = onGoal ? 'text-[var(--positive)]' : 'text-[var(--danger)]';
                  netEl = (
                    <span className={`font-mono font-bold text-[13px] tabular ${col}`}>
                      {Math.abs(balance).toLocaleString()}
                      <span className="font-normal text-[10px] text-[var(--ink-3)] tracking-[0.5px] uppercase ml-1">
                        {isDeficit ? 'deficit' : 'surplus'}
                      </span>
                    </span>
                  );
                }
              }
              return (
                <div
                  key={ds}
                  className="flex justify-between items-center px-1 py-3 border-b border-[var(--line)] last:border-b-0 hover:bg-[var(--bg-2)] transition-colors"
                >
                  <span className="font-mono text-[12px] font-bold tracking-[1.5px] text-[var(--ink-0)]">{label}</span>
                  {netEl}
                </div>
              );
            })}
          </div>
        )}

        {remaining > 0 && (
          <button
            onClick={() => setPage(p => p + 30)}
            className="que-btn-ghost mt-3 w-full"
          >
            LOAD {Math.min(30, remaining)} MORE / {remaining} REMAINING
          </button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT — CalorieHistoryCard
// ─────────────────────────────────────────────────────────────────────────────

function CalorieHistoryCard({ streak, avgNet, days, cutting }: {
  streak: number; avgNet: number; days: number; cutting: boolean;
}) {
  const isDeficit = avgNet < 0;
  // Green when the average balance moves toward the user's goal.
  const onGoal    = avgNet === 0 ? true : cutting ? isDeficit : !isDeficit;
  return (
    <div className="que-card mb-4 cursor-pointer transition-all hover:border-[var(--line-2)]">
      <div className="p-5 flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <h2 className="que-section-label mb-2"><span className="dot" />CALORIE HISTORY</h2>
          {days > 0 ? (
            <p className="font-mono text-[11px] text-[var(--ink-1)] tracking-[0.5px]">
              {days} DAYS · AVG{' '}
              <span className={`font-bold tabular ${onGoal ? 'text-[var(--positive)]' : 'text-[var(--danger)]'}`}>
                {avgNet === 0 ? 'maintenance' : `${fmt(Math.abs(avgNet))} kcal ${isDeficit ? 'deficit' : 'surplus'}/day`}
              </span>
            </p>
          ) : (
            <p className="font-mono text-[11px] text-[var(--ink-3)] tracking-[1px] uppercase">Tap to view</p>
          )}
        </div>
        {streak > 0 && (
          <div className="text-center flex-shrink-0">
            <p
              className="font-display tabular text-[var(--accent)] leading-none text-[42px]"
              style={{ textShadow: '0 0 16px var(--accent-40)' }}
            >
              {streak}
            </p>
            <p className="font-mono text-[9px] font-bold uppercase tracking-[2px] text-[var(--ink-2)] mt-1">DAY STREAK</p>
          </div>
        )}
        <ChevronRight size={18} className="text-[var(--ink-3)] flex-shrink-0" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT — TrendsCard
// ─────────────────────────────────────────────────────────────────────────────

type TrendKey = 'weight' | 'burn' | 'budget' | 'runDist' | 'bikeDist' | 'swimTime' | 'sessRating' | 'sessFeel'
  | 'hrv' | 'restingHr' | 'sleepScore';

function TrendsCard() {
  const { localDB } = useApp();
  const u = useUnits();
  const [activeTab, setActiveTab] = useState<TrendKey>('weight');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const chartConfig: Record<TrendKey, { label: string; color: string; unit: string }> = {
    weight:   { label: 'WEIGHT', color: '#4FC3F7', unit: ' lbs'  },
    burn:     { label: 'BURN',   color: '#FFB547', unit: ' kcal' },
    budget:   { label: 'BUDGET', color: '#6DFF99', unit: ' kcal' },
    runDist:  { label: 'RUN',    color: '#F87171', unit: ' mi'   },
    bikeDist: { label: 'BIKE',   color: '#A78BFA', unit: ' mi'   },
    swimTime: { label: 'SWIM',   color: '#34D399', unit: ' min'  },
    sessRating: { label: 'RATING', color: '#FFD23F', unit: ' /10' },
    sessFeel:   { label: 'FEEL',   color: '#F472B6', unit: ' /10' },
    // Recovery metrics from the Garmin wellness import (lib/healthActivity).
    hrv:        { label: 'HRV',    color: '#38BDF8', unit: ' ms'  },
    restingHr:  { label: 'RHR',    color: '#FB923C', unit: ' bpm' },
    sleepScore: { label: 'SLEEP',  color: '#C084FC', unit: ' /100' },
  };

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const keys = Object.keys(localDB).sort().slice(-90);
    if (keys.length < 2) {
      const ctx = canvas.getContext('2d'); if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const W = canvas.offsetWidth || 600;
      const H = parseInt(getComputedStyle(canvas).height) || 220;
      canvas.width = W * dpr; canvas.height = H * dpr; ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(107,110,118,0.7)';
      ctx.font = '12px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('NOT ENOUGH DATA — KEEP LOGGING', W / 2, H / 2);
      return;
    }
    const labels = keys.map(ds => {
      const d = new Date(ds + 'T00:00:00');
      return `${d.getMonth() + 1}/${d.getDate()}`;
    });
    const values = keys.map(ds => {
      const rec = localDB[ds];
      // Convert stored (imperial) values to the user's display units.
      if (activeTab === 'weight')   return u.fromStoredWeight(parseFloat(String(rec?.weight   ?? '0')) || 0);
      if (activeTab === 'burn')     return Number(rec?.burn)                        || 0;
      if (activeTab === 'runDist')  return u.fromStoredDistance(parseFloat(String(rec?.runDist  ?? '0')) || 0);
      if (activeTab === 'bikeDist') return u.fromStoredDistance(parseFloat(String(rec?.bikeDist ?? '0')) || 0);
      if (activeTab === 'swimTime') return parseFloat(String(rec?.swimTime ?? '0')) || 0;
      if (activeTab === 'sessRating') return Number(rec?.sessRating) || 0;
      if (activeTab === 'sessFeel')   return Number(rec?.sessFeel)   || 0;
      if (activeTab === 'hrv')        return Number(rec?.hrv)        || 0;
      if (activeTab === 'restingHr')  return Number(rec?.restingHr)  || 0;
      if (activeTab === 'sleepScore') return Number(rec?.sleepScore) || 0;
      return Number(rec?.budget) || 0;
    });
    const { color } = chartConfig[activeTab];
    const unit = activeTab === 'weight' ? ` ${u.weightUnit}`
      : (activeTab === 'runDist' || activeTab === 'bikeDist') ? ` ${u.distanceUnit}`
      : chartConfig[activeTab].unit;

    // 7-day rolling average for the noisy day-to-day series — weight, and the
    // recovery metrics where the baseline (not the daily reading) is the signal.
    const rollingAvg = (activeTab === 'weight' || activeTab === 'hrv' || activeTab === 'restingHr')
      ? values.map((_, i) => {
          const win = values.slice(Math.max(0, i - 6), i + 1).filter(v => v > 0);
          return win.length > 0 ? win.reduce((s, v) => s + v, 0) / win.length : 0;
        })
      : undefined;

    drawLineChart(canvas, labels, values, color, unit, rollingAvg);
  }, [localDB, activeTab, u]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="que-card mb-4">
      <div className="p-5">
        <h2 className="que-section-label mb-4"><span className="dot" />TRENDS</h2>

        <div className="flex gap-1.5 mb-4 overflow-x-auto flex-nowrap pb-1">
          {(Object.keys(chartConfig) as TrendKey[]).map(k => (
            <button
              key={k}
              onClick={() => setActiveTab(k)}
              data-active={activeTab === k}
              className="que-pill flex-shrink-0"
              style={activeTab === k ? { background: chartConfig[k].color, color: 'var(--accent-ink)', borderColor: chartConfig[k].color } : undefined}
            >
              {chartConfig[k].label}
            </button>
          ))}
        </div>

        <canvas ref={canvasRef} className="block w-full h-[220px] lg:h-[260px]" />
        {activeTab === 'weight' && (
          <div className="flex items-center gap-3 mt-2">
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-5 h-px bg-[#4FC3F7] opacity-70" />
              <span className="font-mono text-[8px] text-[var(--ink-3)] tracking-[0.5px]">Daily</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-5 h-[2px] bg-white opacity-50" />
              <span className="font-mono text-[8px] text-[var(--ink-3)] tracking-[0.5px]">7-day avg</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function MetricsDashboard({ openProfileSignal = 0 }: { openProfileSignal?: number } = {}) {
  const {
    today, todayStr,
    activeDayFocus,
    profile, setProfile, persistProfile,
    localDB, setLastBurn, setLastBudget,
    getLastKnownWeight,
    isLoaded,
  } = useApp();

  const [profileOpen,      setProfileOpen]      = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  // Opened from the header dropdown ("Athlete Profile"). page.tsx switches to
  // this tab and bumps openProfileSignal; we expand the panel + scroll to it.
  // A prop (not an event listener) so it works even when this tab was lazy-
  // mounted by that same click — the signal is already set on first render.
  useEffect(() => {
    if (openProfileSignal <= 0) return;
    setProfileOpen(true);
    const t = setTimeout(() => profileRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    return () => clearTimeout(t);
  }, [openProfileSignal]);
  const [projVisible,      setProjVisible]      = useState(false);
  const [planOpen,         setPlanOpen]         = useState(false);
  const [progressOpen,     setProgressOpen]     = useState(false);
  const [historyOpen,      setHistoryOpen]      = useState(false);
  const [celebrateVisible, setCelebrateVisible] = useState(false);
  const [milestone,        setMilestone]        = useState<{ pct: number; weightChange: number } | null>(null);
  const [runPlanOpen,      setRunPlanOpen]      = useState(false);
  const [liftPlanOpen,     setLiftPlanOpen]     = useState(false);

  const milestoneCheckedRef = useRef(false);
  useEffect(() => {
    if (milestoneCheckedRef.current || !isLoaded) return;
    milestoneCheckedRef.current = true;

    const plan = loadPlan(); if (!plan) return;
    const msElapsed  = Date.now() - new Date(plan.startDate + 'T00:00:00').getTime();
    const weeksSince = Math.max(0, msElapsed / (7 * 86400000));
    const ratio      = weeksSince / plan.weeksTarget;
    const THRESHOLDS = [0.25, 0.5, 0.75];

    let seen: number[] = [];
    try {
      const raw = JSON.parse(localStorage.getItem('quePlanMilestones') ?? '{}');
      if (raw.planStartDate === plan.startDate) seen = raw.seen ?? [];
    } catch { /* noop */ }

    for (const t of THRESHOLDS) {
      if (ratio >= t && !seen.includes(Math.round(t * 100))) {
        const pct = Math.round(t * 100);
        seen.push(pct);
        localStorage.setItem('quePlanMilestones', JSON.stringify({ planStartDate: plan.startDate, seen }));
        // Plan-window only — a pre-plan weight doesn't represent progress.
        // weightChange = 0 (shown as no figure in the modal) when nothing has
        // been weighed since plan start.
        const entries = (Object.entries(localDB) as [string, DayRecord][])
          .filter(([ds, r]) => ds >= plan.startDate && parseNum(String(r.weight ?? '0')) > 0)
          .sort(([a], [b]) => a.localeCompare(b));
        const latestW  = entries.length > 0 ? parseNum(String(entries[entries.length - 1][1].weight)) : 0;
        const baseline = getPlanBaseline(plan, localDB);
        setMilestone({ pct, weightChange: latestW > 0 ? latestW - baseline : 0 });
        break;
      }
    }
  }, [isLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const [cardio, setCardio]                = useState<CardioFields>(EMPTY_CARDIO);
  const [todayWeight, setTodayWeightRaw]   = useState('');
  const [todayCals,   setTodayCalsRaw]     = useState('');

  useEffect(() => {
    if (!isLoaded) return;
    const rec = localDB[activeDayFocus] ?? {};
    setTodayWeightRaw(String(rec.weight ?? getLastKnownWeight(activeDayFocus) ?? ''));
    setTodayCalsRaw(String(rec.calsEaten ?? ''));
  }, [isLoaded, activeDayFocus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cardio has no direct text input in this component — the quick-log modal
  // in CalorieBudgetCard writes straight to localDB. Re-deriving on every
  // active-day record change keeps m.budget in sync without racing the
  // user's typing (no typing path exists for cardio here).
  const activeDayRec = localDB[activeDayFocus];
  useEffect(() => {
    if (!isLoaded) return;
    const rec = activeDayRec ?? {};
    setCardio({
      steps:      String(rec.steps    ?? 0),
      runDist:    String(rec.runDist  ?? 0),
      runTime:    String(rec.runTime  ?? 0),
      bikeDist:   String(rec.bikeDist ?? 0),
      bikeTime:   String(rec.bikeTime ?? 0),
      swimTime:   String(rec.swimTime ?? 0),
      swimDist:   String(rec.swimDist ?? 0),
      // Measured Garmin calories supersede the estimate (fixes the cardio card
      // + burn breakdown reading low, matching the calorie budget).
      garminKcal:     String(rec.garminKcal     ?? 0),
      garminRunKcal:  String(rec.garminRunKcal  ?? 0),
      garminBikeKcal: String(rec.garminBikeKcal ?? 0),
      garminSwimKcal: String(rec.garminSwimKcal ?? 0),
    });
  }, [isLoaded, activeDayFocus, activeDayRec]);

  useEffect(() => {
    if (!isLoaded) return;
    const fromDB = localDB[activeDayFocus]?.calsEaten;
    if (fromDB !== undefined) setTodayCalsRaw(String(fromDB));
  }, [isLoaded, localDB, activeDayFocus]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = useBudgetMetrics(profile, cardio);

  useEffect(() => {
    setLastBurn(m.activityBurn);
    setLastBudget(m.budget);
  }, [m.activityBurn, m.budget, setLastBurn, setLastBudget]);

  const handleProfileChange = useCallback((updates: Partial<UserProfile>) => {
    setProfile(updates); persistProfile(updates);
  }, [setProfile, persistProfile]);

  const prFlags = useMemo((): PRFlags => {
    const today = (localDB[activeDayFocus] ?? {}) as DayRecord;
    const others = Object.entries(localDB)
      .filter(([ds]) => ds !== activeDayFocus)
      .map(([, r]) => r as DayRecord);

    const n = (v: string | number | undefined) => parseNum(String(v ?? 0));

    const todayRunDist  = n(today.runDist);
    const todayRunTime  = n(today.runTime);
    const todayRunPace  = todayRunDist > 0 && todayRunTime > 0 ? todayRunDist / todayRunTime : 0;
    const prevRunDist   = Math.max(0, ...others.map(r => n(r.runDist)));
    const prevRunPace   = Math.max(0, ...others
      .filter(r => n(r.runDist) > 0 && n(r.runTime) > 0)
      .map(r => n(r.runDist) / n(r.runTime)));
    const prRun = todayRunDist > 0 && (todayRunDist > prevRunDist || todayRunPace > prevRunPace);

    const todayBikeDist = n(today.bikeDist);
    const todayBikeTime = n(today.bikeTime);
    const todayBikePace = todayBikeDist > 0 && todayBikeTime > 0 ? todayBikeDist / todayBikeTime : 0;
    const prevBikeDist  = Math.max(0, ...others.map(r => n(r.bikeDist)));
    const prevBikePace  = Math.max(0, ...others
      .filter(r => n(r.bikeDist) > 0 && n(r.bikeTime) > 0)
      .map(r => n(r.bikeDist) / n(r.bikeTime)));
    const prBike = todayBikeDist > 0 && (todayBikeDist > prevBikeDist || todayBikePace > prevBikePace);

    const todaySwimTime = n(today.swimTime);
    const prevSwimTime  = Math.max(0, ...others.map(r => n(r.swimTime)));
    const prSwim = todaySwimTime > 0 && todaySwimTime > prevSwimTime;

    let prLift = false;
    try {
      type SetRow = { w?: string };
      type ExRow  = { k?: string; n?: string; sets?: SetRow[] };
      const todayExs: ExRow[] = today.exercises ? JSON.parse(String(today.exercises)) : [];

      const allTimeMax: Record<string, number> = {};
      others.forEach(r => {
        if (!r.exercises) return;
        try {
          (JSON.parse(String(r.exercises)) as ExRow[]).forEach(ex => {
            if (ex.k !== 'lift' || !ex.n || !ex.sets) return;
            ex.sets.forEach(s => {
              const w = parseNum(s.w ?? '0');
              if (w > 0) allTimeMax[ex.n!] = Math.max(allTimeMax[ex.n!] ?? 0, w);
            });
          });
        } catch { /* skip corrupt records */ }
      });

      todayExs.forEach(ex => {
        if (ex.k !== 'lift' || !ex.n || !ex.sets) return;
        ex.sets.forEach(s => {
          const w = parseNum(s.w ?? '0');
          if (w > 0 && w > (allTimeMax[ex.n!] ?? 0)) prLift = true;
        });
      });
    } catch { /* skip */ }

    return { prRun, prBike, prSwim, prLift };
  }, [localDB, activeDayFocus]);

  const { calDays, avgNet, streak, workoutStreak, weighStreak } = useMemo(() => {
    // Average real balance vs maintenance (matches the per-day Activity Log),
    // not average vs goal budget.
    const goalDeficit = parseNum(profile.deficit) || 500;
    const days = Object.keys(localDB)
      .map(ds => {
        const bal = dayCalorieBalance(localDB[ds], goalDeficit);
        return bal === null ? null : { ds, net: bal };
      })
      .filter(Boolean) as { ds: string; net: number }[];
    const avg    = days.length ? days.reduce((s, d) => s + d.net, 0) / days.length : 0;
    const logged = new Set(days.map(d => d.ds));

    const countStreak = (hasDay: (ds: string) => boolean) => {
      const c = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      if (!hasDay(todayStr)) c.setDate(c.getDate() - 1);
      let n = 0;
      while (hasDay(toDateStr(c))) { n++; c.setDate(c.getDate() - 1); }
      return n;
    };

    const s = countStreak(ds => logged.has(ds));

    // Rest-aware lift streak: a marked rest day bridges it (shared lib/streaks,
    // lift-only predicate so cardio-only days don't count here). Today-grace: if
    // today isn't yet a lift/rest day, measure the streak ending yesterday.
    const isLiftDay = (r: StreakDay | undefined | null): boolean => {
      if (!r?.exercises) return false;
      try { return (JSON.parse(String(r.exercises)) as Array<{ k?: string }>).some(e => e.k === 'lift'); }
      catch { return false; }
    };
    const yesterdayStr = toDateStr(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1));
    const ws = streakEndingAt(localDB as Record<string, StreakDay>, todayStr, isLiftDay)
            || streakEndingAt(localDB as Record<string, StreakDay>, yesterdayStr, isLiftDay);

    const weighDays = new Set(Object.keys(localDB).filter(ds => parseFloat(String(localDB[ds]?.weight ?? '0')) > 0));
    const wis = countStreak(ds => weighDays.has(ds));

    return { calDays: days.length, avgNet: avg, streak: s, workoutStreak: ws, weighStreak: wis };
  }, [localDB, today, todayStr, profile.deficit]);

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center h-64 font-mono text-[11px] text-[var(--ink-3)] tracking-[2px] uppercase">
        Loading
      </div>
    );
  }

  // Brand-new account → teach instead of showing empty charts/zeroes.
  const hasAnyData = useMemo(
    () => Object.values(localDB).some(r =>
      parseNum(String(r.weight ?? 0)) > 0 ||
      parseNum(String(r.calsEaten ?? 0)) > 0 ||
      String(r.exercises ?? '').length > 2,
    ),
    [localDB],
  );

  return (
    <div className="max-w-3xl mx-auto px-4 py-5 pb-24 lg:py-8">

      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className="block w-2 h-2 rounded-full bg-[var(--accent)]" style={{ boxShadow: '0 0 8px var(--accent-40)' }} />
          <span className="font-mono text-[11px] font-bold tabular tracking-[2px] uppercase text-[var(--ink-1)]">
            {fmtDateLong(activeDayFocus)}
          </span>
        </div>
        <button
          onClick={() => setProfileOpen(o => !o)}
          title="Athlete Profile"
          className={[
            'w-10 h-10 rounded flex items-center justify-center border transition-all',
            profileOpen
              ? 'border-[var(--accent)] bg-[var(--accent-12)] text-[var(--accent)]'
              : 'border-[var(--line-2)] bg-[var(--bg-2)] text-[var(--ink-1)] hover:border-[var(--accent)] hover:text-[var(--accent)]',
          ].join(' ')}
        >
          <User size={18} />
        </button>
      </div>

      {(streak > 0 || workoutStreak > 0 || weighStreak > 0) && (
        <div className="flex gap-1.5 mb-5 flex-wrap">
          {[
            { n: streak,        label: 'cal',    icon: '🔥' },
            { n: workoutStreak, label: 'lifts',  icon: '💪' },
            { n: weighStreak,   label: 'weigh',  icon: '⚖️' },
          ].filter(x => x.n > 0).map(x => (
            <span
              key={x.label}
              className="inline-flex items-center gap-1 font-mono text-[9px] font-bold tracking-[1px] text-[var(--ink-2)] border border-[var(--line-2)] bg-[var(--bg-2)] rounded-sm px-2 py-1"
            >
              {x.icon}
              <span className="text-[var(--accent)]">{x.n}</span>d {x.label}
            </span>
          ))}
        </div>
      )}

      {/* Streak nudge — once there's some data but no active streak yet. */}
      {isLoaded && hasAnyData && streak === 0 && workoutStreak === 0 && weighStreak === 0 && (
        <p className="mb-5 font-mono text-[10px] tracking-[0.5px] text-[var(--ink-3)]">
          🔥 Log today to start a streak.
        </p>
      )}

      {/* Teaching empty state — brand-new account with nothing logged. */}
      {isLoaded && !hasAnyData && (
        <div className="que-card mb-5 px-5 py-7 text-center">
          <p className="font-display text-[18px] tracking-[1px] uppercase text-[var(--ink-1)] mb-2">
            Nothing logged yet
          </p>
          <p className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.5px] leading-relaxed max-w-[280px] mx-auto">
            Log a weigh-in, a meal, or a workout and your trend, calorie budget, streaks, and PRs will
            start showing up here.
          </p>
        </div>
      )}

      <WeeklyRecapCard />

      {profileOpen && <div ref={profileRef}><ProfilePanel profile={profile} onChange={handleProfileChange} onOpenPlan={() => setPlanOpen(true)} onOpenRunPlan={() => setRunPlanOpen(true)} onOpenLiftPlan={() => setLiftPlanOpen(true)} onOpenHistory={() => setHistoryOpen(true)} /></div>}

      <CalorieBudgetCard m={m} onOpenProgress={() => setProgressOpen(true)} prFlags={prFlags} />

      <MaintenanceCard formulaTdee={m.tdee} />

      <WeeklyVolumeCard />
      <TrophyCaseCard />
      <ActivityLogCard />
      <CalorieHistoryCard streak={streak} avgNet={avgNet} days={calDays} cutting={(parseNum(profile.deficit) || 500) >= 0} />
      <TrendsCard />

      <ProjectionModal
        open={projVisible}
        m={m}
        weightLbs={parseNum(todayWeight || profile.weight)}
        calsEaten={parseNum(todayCals)}
        localDB={localDB}
        onClose={() => setProjVisible(false)}
      />

      <PlanModal
        open={planOpen}
        onClose={() => setPlanOpen(false)}
        profile={profile}
        persistProfile={persistProfile}
        m={m}
        localDB={localDB}
        todayStr={todayStr}
      />

      <PlanProgressModal
        open={progressOpen}
        onClose={() => setProgressOpen(false)}
        localDB={localDB}
        profile={profile}
      />

      <PlanHistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        localDB={localDB}
        todayStr={todayStr}
      />

      <CelebrationModal
        open={celebrateVisible}
        onClose={() => setCelebrateVisible(false)}
        localDB={localDB}
        calsEaten={parseNum(todayCals)}
        budget={m.budget}
      />

      <MilestoneModal
        open={milestone !== null}
        onClose={() => setMilestone(null)}
        pct={milestone?.pct ?? 0}
        weightChange={milestone?.weightChange ?? 0}
      />

      <AnimatePresence>
        {runPlanOpen && (
          <motion.div
            className="fixed inset-0 z-[400] flex flex-col bg-[var(--bg-0)]"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--line)]">
              <button
                onClick={() => setRunPlanOpen(false)}
                className="w-8 h-8 rounded flex items-center justify-center text-[var(--ink-2)] hover:text-[var(--ink-1)] transition-colors"
              >
                <X size={18} />
              </button>
              <span className="font-mono text-[11px] font-bold tracking-[2px] uppercase text-[var(--ink-1)]">Running Plan</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              <RunningPlanBuilder />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {liftPlanOpen && (
          <motion.div
            className="fixed inset-0 z-[400] flex flex-col bg-[var(--bg-0)]"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--line)]">
              <button
                onClick={() => setLiftPlanOpen(false)}
                className="w-8 h-8 rounded flex items-center justify-center text-[var(--ink-2)] hover:text-[var(--ink-1)] transition-colors"
              >
                <X size={18} />
              </button>
              <span className="font-mono text-[11px] font-bold tracking-[2px] uppercase text-[var(--ink-1)]">Lifting Program</span>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <LiftingPlanBuilder bare />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
