'use client';

import { useMemo, useState } from 'react';
import { Check, X, Dumbbell, Utensils, Scale, Swords, ChevronRight } from 'lucide-react';
import { useApp } from '@/lib/AppContext';
import { parseEx } from '@/lib/exerciseSerial';
import { GETTING_STARTED_KEY } from '@/lib/constants';

export type AppTab = 'calendar' | 'calories' | 'metrics' | 'protocol' | 'social';

interface GsState { dismissed?: boolean; socialSeen?: boolean }

function read(): GsState {
  if (typeof window === 'undefined') return {};
  try { return JSON.parse(localStorage.getItem(GETTING_STARTED_KEY) ?? '{}') as GsState; }
  catch { return {}; }
}
function write(s: GsState): void {
  try { localStorage.setItem(GETTING_STARTED_KEY, JSON.stringify(s)); } catch { /* quota */ }
}

/**
 * Week-one "Getting started" checklist. The app's value compounds with data, so
 * the gap between install and "this is useful" is where users churn. This shows
 * the core loop as 4 tappable steps, auto-completing from real logged data, and
 * disappears for good once finished or dismissed.
 */
export function GettingStarted({ onNavigate }: { onNavigate: (tab: AppTab) => void }) {
  const { localDB, isLoaded } = useApp();
  const [state, setState] = useState<GsState>(read);

  const { hasWorkout, hasMeal, hasWeight } = useMemo(() => {
    let w = false, m = false, wt = false;
    for (const rec of Object.values(localDB)) {
      if (!w) {
        const exs = parseEx(String((rec as { exercises?: unknown }).exercises ?? ''));
        if (exs.length > 0) w = true;
      }
      if (!m) {
        const cals = parseFloat(String((rec as { calsEaten?: unknown }).calsEaten ?? '0')) || 0;
        const foods = String((rec as { foods?: unknown }).foods ?? '');
        if (cals > 0 || foods.length > 2) m = true;
      }
      if (!wt && (parseFloat(String((rec as { weight?: unknown }).weight ?? '0')) || 0) > 0) wt = true;
      if (w && m && wt) break;
    }
    return { hasWorkout: w, hasMeal: m, hasWeight: wt };
  }, [localDB]);

  const items = [
    { key: 'workout', label: 'Log your first workout',          done: hasWorkout,        tab: 'calendar' as const, Icon: Dumbbell },
    { key: 'meal',    label: 'Log a meal',                      done: hasMeal,           tab: 'calories' as const, Icon: Utensils },
    { key: 'weight',  label: 'Log your weight',                 done: hasWeight,         tab: 'metrics'  as const, Icon: Scale },
    { key: 'social',  label: 'Race yourself or add a friend',   done: !!state.socialSeen, tab: 'social'   as const, Icon: Swords },
  ];
  const completed = items.filter(i => i.done).length;

  // Hide once everything's done, dismissed, or before localDB hydrates.
  if (!isLoaded || state.dismissed || completed === items.length) return null;

  const go = (tab: AppTab, key: string) => {
    if (key === 'social') { const next = { ...state, socialSeen: true }; setState(next); write(next); }
    onNavigate(tab);
  };
  const dismiss = () => { const next = { ...state, dismissed: true }; setState(next); write(next); };

  return (
    <div className="que-card mb-4 px-5 py-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="que-section-label">
          <span className="dot" style={{ background: 'var(--accent)' }} />
          GETTING STARTED
        </h2>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] font-bold tabular-nums text-[var(--ink-3)]">{completed}/{items.length}</span>
          <button onClick={dismiss} aria-label="Dismiss" title="Dismiss"
            className="w-6 h-6 flex items-center justify-center rounded text-[var(--ink-3)] hover:text-[var(--ink-1)] transition-colors">
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="space-y-1.5">
        {items.map(({ key, label, done, tab, Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => !done && go(tab, key)}
            disabled={done}
            className={[
              'w-full flex items-center gap-3 px-3 py-2.5 rounded-md border text-left transition-all',
              done
                ? 'border-[var(--line)] bg-transparent cursor-default'
                : 'border-[var(--line-2)] bg-[var(--bg-2)] hover:border-[var(--accent)] hover:bg-[var(--bg-3)]',
            ].join(' ')}
          >
            <span
              className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 border"
              style={done
                ? { background: 'var(--positive)', borderColor: 'var(--positive)' }
                : { borderColor: 'var(--line-3)' }}
            >
              {done ? <Check size={12} stroke="#07080A" strokeWidth={3} /> : <Icon size={12} className="text-[var(--ink-3)]" />}
            </span>
            <span className={`flex-1 font-mono text-[11px] tracking-[0.3px] ${done ? 'text-[var(--ink-3)] line-through' : 'text-[var(--ink-1)]'}`}>
              {label}
            </span>
            {!done && <ChevronRight size={14} className="text-[var(--ink-3)] flex-shrink-0" />}
          </button>
        ))}
      </div>
    </div>
  );
}
