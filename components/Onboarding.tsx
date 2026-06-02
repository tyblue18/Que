'use client';

import { useState, useCallback, useEffect } from 'react';
import Image from 'next/image';
import { Bell, BellOff, Scale, Utensils, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { useApp } from '@/lib/AppContext';
import { INTENSITY_KCAL, type PlanIntensity } from '@/lib/metricsTypes';
import { pushNow } from '@/lib/syncEngine';
import {
  type UnitSystem, detectDefaultUnits, setUnits as persistUnits,
  weightUnit, heightUnit, kgToLb, cmToIn, toStoredWeight, toStoredHeight, dispWeight, dispHeight,
} from '@/lib/units';
import { UNITS_KEY } from '@/lib/constants';

export const ONBOARDING_KEY = 'queProfileSetup';

export function needsOnboarding(): boolean {
  if (typeof window === 'undefined') return false;
  return !localStorage.getItem(ONBOARDING_KEY);
}

const ACTIVITY_OPTIONS = [
  { value: '1.20', label: 'Desk job, no gym' },
  { value: '1.30', label: 'Desk + light activity' },
  { value: '1.40', label: 'Desk + gym 3×/wk' },
  { value: '1.45', label: 'Desk + gym 4–5×/wk' },
  { value: '1.55', label: 'Active job + gym 4–5×/wk' },
  { value: '1.65', label: 'Physical job + heavy training' },
];

const VAPID_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function subscribeAndSave(): Promise<boolean> {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return false;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_KEY),
    });
    await fetch('/api/push/subscribe', {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify(sub.toJSON()),
    });
    return true;
  } catch {
    return false;
  }
}

// ── Step 2 — Notifications opt-in ─────────────────────────────────────────────

function NotificationsStep({ onDone }: { onDone: () => void }) {
  const [state,   setState]   = useState<'idle' | 'loading' | 'granted' | 'denied'>('idle');
  const [support, setSupport] = useState(true);

  useEffect(() => {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !VAPID_KEY) {
      setSupport(false);
    } else if (Notification.permission === 'granted') {
      // Already granted — skip this step immediately
      onDone();
    } else if (Notification.permission === 'denied') {
      setState('denied');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!support) {
    // Browser doesn't support push — skip silently
    onDone();
    return null;
  }

  const handleEnable = async () => {
    setState('loading');
    const ok = await subscribeAndSave();
    setState(ok ? 'granted' : 'denied');
    if (ok) setTimeout(onDone, 900);
  };

  return (
    <div className="w-full space-y-6">

      {/* Icon cluster */}
      <div className="flex justify-center gap-4">
        <div className="ob-notif-icon-wrap">
          <Scale size={20} className="text-[var(--accent)]" />
        </div>
        <div className="ob-notif-icon-wrap">
          <Utensils size={20} className="text-[var(--accent)]" />
        </div>
        <div className="ob-notif-icon-wrap">
          <Bell size={20} className="text-[var(--accent)]" />
        </div>
      </div>

      <div className="text-center space-y-2">
        <h2 className="font-display text-[24px] tracking-[2px] uppercase text-[var(--ink-0)]">
          Stay on track
        </h2>
        <p className="font-mono text-[10px] text-[var(--ink-2)] tracking-[0.5px] leading-relaxed">
          Get a reminder to weigh in each morning and a nudge in the evening if you haven&apos;t logged yet.
        </p>
      </div>

      {/* Reminder previews */}
      <div className="space-y-2">
        <div className="ob-notif-preview">
          <span className="ob-notif-preview-icon">⚖️</span>
          <div>
            <p className="ob-notif-preview-title">Morning weigh-in · 8 am</p>
            <p className="ob-notif-preview-body">Log your weight to keep your trend accurate.</p>
          </div>
        </div>
        <div className="ob-notif-preview">
          <span className="ob-notif-preview-icon">📋</span>
          <div>
            <p className="ob-notif-preview-title">Evening nudge · 8 pm</p>
            <p className="ob-notif-preview-body">Haven&apos;t logged today yet. Keep your streak alive.</p>
          </div>
        </div>
      </div>

      {state === 'granted' ? (
        <div className="ob-notif-success">
          <Bell size={14} /> Notifications on
        </div>
      ) : state === 'denied' ? (
        <>
          <div className="ob-notif-denied">
            <BellOff size={13} />
            Notifications blocked — enable them in browser settings later.
          </div>
          <button type="button" onClick={onDone} className="que-btn-primary w-full py-4">
            Continue
          </button>
        </>
      ) : (
        <div className="space-y-2">
          <button
            type="button"
            onClick={handleEnable}
            disabled={state === 'loading'}
            className="que-btn-primary w-full py-4"
          >
            {state === 'loading' ? 'Enabling…' : 'Enable Notifications'}
          </button>
          <button
            type="button"
            onClick={onDone}
            className="w-full py-3 font-mono text-[10px] font-bold uppercase tracking-[1px] text-[var(--ink-3)]"
          >
            Maybe later
          </button>
        </div>
      )}
    </div>
  );
}

// ── Step 2 — Goal / plan intent ───────────────────────────────────────────────
// Sets profile.deficit so the very first calorie budget reflects the user's
// actual goal instead of the old hard-coded 500 kcal cut. Mirrors PlanModal:
// cut → +kcal, bulk → −kcal, maintain → 0, with INTENSITY_KCAL as the magnitude.

type Goal = 'lose' | 'maintain' | 'build';

const GOAL_OPTIONS: { value: Goal; label: string; desc: string; Icon: typeof TrendingDown }[] = [
  { value: 'lose',     label: 'Lose fat',     desc: 'Eat below maintenance to drop body fat.', Icon: TrendingDown },
  { value: 'maintain', label: 'Maintain',     desc: 'Hold your weight at maintenance.',        Icon: Minus },
  { value: 'build',    label: 'Build muscle', desc: 'Eat above maintenance to gain size.',     Icon: TrendingUp },
];

const PACE_OPTIONS: { value: PlanIntensity; label: string; rate: string }[] = [
  { value: 'slight',     label: 'Gentle',     rate: '~0.5 lb/wk' },
  { value: 'moderate',   label: 'Steady',     rate: '~1 lb/wk'   },
  { value: 'aggressive', label: 'Intense',    rate: '~2 lb/wk'   },
];

function GoalStep({ onSubmit }: { onSubmit: (goal: Goal, pace: PlanIntensity) => void }) {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [pace, setPace] = useState<PlanIntensity>('moderate');

  const kcal  = INTENSITY_KCAL[pace];
  const delta = goal === 'lose'  ? `−${kcal} kcal / day`
              : goal === 'build' ? `+${kcal} kcal / day`
              : goal === 'maintain' ? 'maintenance calories'
              : '';

  return (
    <div className="w-full space-y-5">
      <div className="text-center space-y-2">
        <h1 className="font-display text-[26px] md:text-[32px] tracking-[2px] uppercase text-[var(--ink-0)]">
          What&apos;s your goal?
        </h1>
        <p className="font-mono text-[10px] text-[var(--ink-3)] tracking-[1px] leading-relaxed">
          This sets your nutrition target — and it&apos;ll adapt to the training you log. Fine-tune anytime in Metrics → Plan.
        </p>
      </div>

      {/* Goal cards */}
      <div className="space-y-2">
        {GOAL_OPTIONS.map(({ value, label, desc, Icon }) => {
          const active = goal === value;
          return (
            <button
              key={value} type="button"
              onClick={() => setGoal(value)}
              className={[
                'w-full flex items-center gap-3 px-4 py-3 rounded border text-left transition-all',
                active
                  ? 'border-[var(--accent)] bg-[var(--accent-12)]'
                  : 'border-[var(--line-2)] bg-[var(--bg-2)] hover:border-[var(--line-3)]',
              ].join(' ')}
            >
              <Icon size={18} className={active ? 'text-[var(--accent)]' : 'text-[var(--ink-3)]'} />
              <div>
                <p className={`font-mono text-[12px] font-bold uppercase tracking-[1px] ${active ? 'text-[var(--accent)]' : 'text-[var(--ink-1)]'}`}>
                  {label}
                </p>
                <p className="font-mono text-[9px] text-[var(--ink-3)] tracking-[0.5px] mt-0.5">{desc}</p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Pace — only relevant when changing weight */}
      {goal && goal !== 'maintain' && (
        <div>
          <label className="que-label">How fast?</label>
          <div className="flex gap-2">
            {PACE_OPTIONS.map(({ value, label, rate }) => {
              const active = pace === value;
              return (
                <button
                  key={value} type="button"
                  onClick={() => setPace(value)}
                  className={[
                    'flex-1 flex flex-col items-center py-2.5 rounded border font-mono transition-all',
                    active
                      ? 'border-[var(--accent)] bg-[var(--accent-12)] text-[var(--accent)]'
                      : 'border-[var(--line-2)] bg-[var(--bg-2)] text-[var(--ink-2)] hover:border-[var(--line-3)]',
                  ].join(' ')}
                >
                  <span className="text-[10px] font-bold uppercase tracking-[1px]">{label}</span>
                  <span className="text-[8px] tracking-[0.5px] text-[var(--ink-3)] mt-0.5">{rate}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Live preview of the resulting daily target */}
      {goal && (
        <div className="text-center font-mono text-[10px] tracking-[0.5px] text-[var(--ink-2)] py-1">
          Daily target: <span className="text-[var(--accent)] font-bold">{delta}</span>
        </div>
      )}

      <button
        type="button"
        disabled={!goal}
        onClick={() => goal && onSubmit(goal, pace)}
        className="que-btn-primary w-full py-4 disabled:opacity-40"
      >
        Next
      </button>
    </div>
  );
}

// ── Main Onboarding ────────────────────────────────────────────────────────────

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const { setProfile, persistProfile, updateDayRecord, todayStr } = useApp();

  const [step,     setStep]     = useState<'profile' | 'goal' | 'notifications'>('profile');
  const [weight,   setWeight]   = useState('');
  const [height,   setHeight]   = useState('');
  const [age,      setAge]      = useState('');
  const [sex,      setSex]      = useState<'male' | 'female'>('male');
  const [activity, setActivity] = useState('1.45');
  const [error,    setError]    = useState('');
  // Default to the locale's likely system for a brand-new user; respect any
  // saved choice. The form collects values in this system and converts to the
  // canonical imperial storage on submit.
  const [units, setUnitsState] = useState<UnitSystem>('imperial');
  useEffect(() => {
    const stored = localStorage.getItem(UNITS_KEY);
    setUnitsState(stored === 'metric' ? 'metric' : stored === 'imperial' ? 'imperial' : detectDefaultUnits());
  }, []);

  // Toggle units, converting any already-typed values so the real measurement
  // is preserved (185 lb ↔ 83.9 kg) rather than reinterpreted.
  const switchUnits = useCallback((next: UnitSystem) => {
    setWeight(prev => { const n = parseFloat(prev); return n > 0 ? dispWeight(toStoredWeight(n, units), next) : prev; });
    setHeight(prev => { const n = parseFloat(prev); return n > 0 ? dispHeight(toStoredHeight(n, units), next) : prev; });
    persistUnits(next);
    setUnitsState(next);
  }, [units]);

  // Step 1 — save the BMR profile, then ask for goal. We deliberately DON'T set
  // the deficit or mark onboarding complete here: the daily budget must reflect
  // a goal the user actually chose (next step), not a silent default.
  const handleProfileSubmit = useCallback(() => {
    if (!weight || !height || !age) {
      setError('Weight, height and age are required.');
      return;
    }
    // Persist canonical imperial; imperial users' strings pass through untouched.
    const wStored = units === 'metric' ? kgToLb(parseFloat(weight)).toFixed(1) : weight;
    const hStored = units === 'metric' ? cmToIn(parseFloat(height)).toFixed(1) : height;
    const updates = { weight: wStored, height: hStored, age, sex, activityLevel: activity };
    setProfile(updates);
    persistProfile(updates);
    updateDayRecord(todayStr, { weight: wStored });
    setError('');
    setStep('goal');
  }, [weight, height, age, sex, activity, units, todayStr, setProfile, persistProfile, updateDayRecord]);

  // Step 2 — translate goal + pace into a signed deficit and persist it, then
  // complete onboarding. Cut → +kcal, bulk → −kcal, maintain → 0 (mirrors the
  // single-form budget = TDEE − deficit + eatBack used everywhere else).
  const handleGoalSubmit = useCallback((goal: Goal, pace: PlanIntensity) => {
    const kcal    = INTENSITY_KCAL[pace];
    const deficit = goal === 'lose' ? String(kcal)
                  : goal === 'build' ? String(-kcal)
                  : '0';
    persistProfile({ deficit });
    localStorage.setItem(ONBOARDING_KEY, 'done');
    pushNow({});
    setStep('notifications');
  }, [persistProfile]);

  return (
    <div className="fixed inset-0 z-[500] flex flex-col bg-[var(--bg-0)] overflow-y-auto">
      <div className="flex-1 flex flex-col items-center justify-center px-5 py-10 max-w-md mx-auto w-full">

        {/* Logo + wordmark */}
        <div className="flex items-center gap-3 mb-8">
          <Image src="/Que_logo.png" alt="" width={36} height={36}
            style={{ objectFit: 'contain', filter: 'invert(1)', mixBlendMode: 'screen' }} />
          <span className="font-display text-[28px] tracking-[8px] text-[var(--ink-0)]">QUE</span>
        </div>

        {/* Step indicator */}
        <div className="flex gap-2 mb-8">
          {(['profile', 'goal', 'notifications'] as const).map((s) => (
            <div
              key={s}
              className="h-1 rounded-full transition-all"
              style={{
                width: step === s ? '24px' : '8px',
                background: step === s ? 'var(--accent)' : 'var(--bg-3)',
              }}
            />
          ))}
        </div>

        {step === 'profile' ? (
          <>
            <h1 className="font-display text-[26px] md:text-[32px] tracking-[2px] uppercase text-[var(--ink-0)] text-center mb-1">
              Set up your profile
            </h1>
            <p className="font-mono text-[10px] text-[var(--ink-3)] tracking-[1px] text-center mb-8">
              Used to calculate your calorie budget and track plan progress.
            </p>

            <div className="w-full space-y-4">

              {/* Units toggle */}
              <div className="flex rounded-md border border-[var(--line-2)] overflow-hidden">
                {(['imperial', 'metric'] as const).map(sys => (
                  <button
                    key={sys} type="button" onClick={() => switchUnits(sys)}
                    className={[
                      'flex-1 py-2 font-mono text-[10px] font-bold uppercase tracking-[1.5px] transition-colors',
                      units === sys ? 'bg-[var(--accent-12)] text-[var(--accent)]' : 'bg-[var(--bg-2)] text-[var(--ink-3)]',
                    ].join(' ')}
                  >
                    {sys === 'imperial' ? 'lb / in' : 'kg / cm'}
                  </button>
                ))}
              </div>

              <div>
                <label className="que-label">Current Weight / {weightUnit(units)}</label>
                <input
                  type="number" inputMode="decimal" className="que-input"
                  placeholder={units === 'metric' ? 'e.g. 84' : 'e.g. 185'}
                  value={weight} onChange={e => { setWeight(e.target.value); setError(''); }}
                />
              </div>

              <div>
                <label className="que-label">Height / {heightUnit(units)}</label>
                <input
                  type="number" inputMode="decimal" className="que-input"
                  placeholder={units === 'metric' ? 'e.g. 178' : 'e.g. 70  (5 ft 10 in = 70)'}
                  value={height} onChange={e => setHeight(e.target.value)}
                />
              </div>

              <div>
                <label className="que-label">Age</label>
                <input
                  type="number" inputMode="numeric" className="que-input"
                  placeholder="e.g. 24"
                  value={age} onChange={e => setAge(e.target.value)}
                />
              </div>

              <div>
                <label className="que-label">Sex</label>
                <div className="flex gap-2">
                  {(['male', 'female'] as const).map(s => (
                    <button
                      key={s} type="button"
                      onClick={() => setSex(s)}
                      className={[
                        'flex-1 py-2.5 rounded border font-mono text-[10px] font-bold uppercase tracking-[1.5px] transition-all',
                        sex === s
                          ? 'border-[var(--accent)] bg-[var(--accent-12)] text-[var(--accent)]'
                          : 'border-[var(--line-2)] bg-[var(--bg-2)] text-[var(--ink-2)] hover:border-[var(--line-3)]',
                      ].join(' ')}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="que-label">Activity Level</label>
                <select
                  className="que-input cursor-pointer"
                  value={activity} onChange={e => setActivity(e.target.value)}
                >
                  {ACTIVITY_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              {error && (
                <p className="font-mono text-[9px] text-[var(--danger)] tracking-[0.5px]">{error}</p>
              )}

              <button
                type="button"
                onClick={handleProfileSubmit}
                className="que-btn-primary w-full py-4 mt-2"
              >
                Next
              </button>
            </div>
          </>
        ) : step === 'goal' ? (
          <GoalStep onSubmit={handleGoalSubmit} />
        ) : (
          <NotificationsStep onDone={onComplete} />
        )}

      </div>
    </div>
  );
}
