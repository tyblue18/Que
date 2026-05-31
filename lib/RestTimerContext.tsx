'use client';

/**
 * lib/RestTimerContext.tsx
 *
 * Global owner of the floating rest-timer bar. Previously the timer lived in
 * WorkoutLogger's local state, so it vanished the moment the user switched tabs
 * (WorkoutLogger unmounts) or closed the app. Lifting it here fixes both:
 *
 *  - The bar is rendered once at the app-shell level (see RestTimerProvider's
 *    own render), so it FOLLOWS the user across every tab.
 *  - State is persisted to localStorage (`queRestTimer`), so a mid-workout
 *    refresh / app restart restores the bar.
 *  - If the bar is dismissed (skip / auto-expire), a "bring it back" affordance
 *    can re-open it for a window after the last logged exercise (`canReopen`).
 *
 * "Log set" still flows through WorkoutLogger when it's mounted on the timer's
 * day (so PR recompute + badge popups fire). When it isn't (user on another
 * tab), we append straight to the day record — WorkoutLogger's external-change
 * detector reloads it on remount, so the two writers never diverge.
 */

import {
  createContext, useContext, useState, useEffect, useRef, useCallback, useMemo,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'framer-motion';
import { useApp, type DayRecord } from '@/lib/AppContext';
import { REST_TIMER_KEY } from '@/lib/constants';
import { parseEx, serializeEx, normalizeSets } from '@/lib/exerciseSerial';
import { RestTimerBar } from '@/components/workout/RestTimerBar';

/** 2:30 — a sane default rest for hypertrophy sets. */
export const DEFAULT_REST_MS = 150_000;
/** How long after the last committed exercise the "bring it back" button stays
 *  available (and a closed-app restore is allowed). One long session. */
const REOPEN_WINDOW_MS = 90 * 60_000;

export interface RestTimerState {
  startMs:    number;  // wall-clock start (countdown is now − startMs)
  durationMs: number;
  date:       string;  // YYYY-MM-DD the exercise belongs to
  exIndex:    number;  // its index in that day's exercises array (fallback log-set)
  exKey:      string;  // WorkoutLogger's stable key (in-mount delegated log-set)
  reps:       string;  // last set's reps — prefill for the next quick-log
  weight:     string;  // last set's weight
}

interface PersistShape {
  timer:        RestTimerState | null;
  visible:      boolean;
  lastCommitAt: number | null;
}

type LogSetFn = (exKey: string, reps: string, weight: string) => void;

interface RestTimerCtx {
  /** Start (or restart) the rest timer — called by WorkoutLogger on commit. */
  startRest: (t: RestTimerState) => void;
  /** True when the bar is hidden but was recently active and can be re-opened. */
  canReopen: boolean;
  /** Re-show the bar after a dismiss (restarts the clock if it had expired). */
  reopen: () => void;
  /** WorkoutLogger registers its set-appender for the day it's currently showing. */
  registerLogSetHandler: (date: string, fn: LogSetFn | null) => void;
}

const Ctx = createContext<RestTimerCtx | null>(null);

const EMPTY: PersistShape = { timer: null, visible: false, lastCommitAt: null };

function loadInitial(): PersistShape {
  if (typeof window === 'undefined') return EMPTY;
  try {
    const raw = localStorage.getItem(REST_TIMER_KEY);
    if (!raw) return EMPTY;
    const p = JSON.parse(raw) as PersistShape;
    const now = Date.now();
    const withinWindow = !!p.lastCommitAt && now - p.lastCommitAt < REOPEN_WINDOW_MS;
    // Stale (older than the reopen window) → don't show, don't offer reopen.
    if (!p.timer || !withinWindow) return { timer: p.timer ?? null, visible: false, lastCommitAt: p.lastCommitAt ?? null };
    // Restored mid-session. If the rest already elapsed while the app was away,
    // restart the clock so the user gets a usable bar instead of a stale 0:00.
    const expired = now >= p.timer.startMs + p.timer.durationMs;
    return {
      timer:        expired ? { ...p.timer, startMs: now } : p.timer,
      visible:      p.visible,
      lastCommitAt: p.lastCommitAt,
    };
  } catch { return EMPTY; }
}

export function RestTimerProvider({ children }: { children: React.ReactNode }) {
  const { localDB, updateDayRecord } = useApp();

  const [state, setState] = useState<PersistShape>(loadInitial);
  const stateRef   = useRef(state);  stateRef.current = state;
  const localDBRef = useRef(localDB); localDBRef.current = localDB;
  const handlerRef = useRef<{ date: string; fn: LogSetFn } | null>(null);
  // Portal target only exists on the client — gate the portal until mounted.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const update = useCallback((fn: (p: PersistShape) => PersistShape) => {
    setState(prev => {
      const next = fn(prev);
      try { localStorage.setItem(REST_TIMER_KEY, JSON.stringify(next)); } catch { /* quota — bar still works in-memory */ }
      return next;
    });
  }, []);

  const startRest = useCallback((t: RestTimerState) => {
    update(() => ({ timer: t, visible: true, lastCommitAt: Date.now() }));
  }, [update]);

  const adjust = useCallback((deltaMs: number) => {
    update(prev => prev.timer
      ? { ...prev, timer: { ...prev.timer, durationMs: Math.max(15_000, prev.timer.durationMs + deltaMs) } }
      : prev);
  }, [update]);

  const dismiss = useCallback(() => {
    update(prev => ({ ...prev, visible: false }));
  }, [update]);

  const reopen = useCallback(() => {
    update(prev => {
      if (!prev.timer) return prev;
      const now = Date.now();
      const expired = now >= prev.timer.startMs + prev.timer.durationMs;
      return { ...prev, visible: true, timer: expired ? { ...prev.timer, startMs: now } : prev.timer };
    });
  }, [update]);

  const registerLogSetHandler = useCallback((date: string, fn: LogSetFn | null) => {
    if (fn) handlerRef.current = { date, fn };
    else if (handlerRef.current?.date === date) handlerRef.current = null;
  }, []);

  const logSet = useCallback((reps: string, weight: string) => {
    const t = stateRef.current.timer;
    if (!t) return;
    const handler = handlerRef.current;
    if (handler && handler.date === t.date) {
      // WorkoutLogger is mounted on this day — let it append so PR recompute
      // and lift-badge popups fire as they always have.
      handler.fn(t.exKey, reps, weight);
    } else {
      // Not mounted here — append straight to the day record. The logger's
      // external-change detector reconciles it on remount.
      const rec = localDBRef.current[t.date] as DayRecord | undefined;
      const arr = parseEx(rec?.exercises ?? '');
      const e = arr[t.exIndex];
      if (e && e.k === 'lift') {
        const sets = Array.isArray(e.sets) && e.sets.length ? [...e.sets] : normalizeSets(e);
        sets.push({ r: reps || '1', w: weight });
        arr[t.exIndex] = { ...e, sets };
        updateDayRecord(t.date, { exercises: serializeEx(arr) });
      }
    }
    // Restart the rest clock for the next set, prefilled from what was just logged.
    update(prev => prev.timer
      ? { ...prev, visible: true, timer: { ...prev.timer, startMs: Date.now(), reps, weight } }
      : prev);
  }, [update, updateDayRecord]);

  const canReopen =
    !state.visible &&
    !!state.timer &&
    !!state.lastCommitAt &&
    Date.now() - state.lastCommitAt < REOPEN_WINDOW_MS;

  const value = useMemo<RestTimerCtx>(
    () => ({ startRest, canReopen, reopen, registerLogSetHandler }),
    [startRest, canReopen, reopen, registerLogSetHandler],
  );

  // Render the bar through a portal to <body> so it lives outside the tab
  // subtree entirely — no stacking-context, overflow, or transform ancestor can
  // ever clip or detach it as the user moves between tabs.
  const bar = (
    <AnimatePresence>
      {state.visible && state.timer && (
        <RestTimerBar
          key="que-rest-timer"
          startMs={state.timer.startMs}
          durationMs={state.timer.durationMs}
          suggestReps={state.timer.reps}
          suggestWeight={state.timer.weight}
          onLogSet={logSet}
          onAdjust={adjust}
          onDismiss={dismiss}
        />
      )}
    </AnimatePresence>
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {mounted ? createPortal(bar, document.body) : null}
    </Ctx.Provider>
  );
}

export function useRestTimer(): RestTimerCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useRestTimer must be used within RestTimerProvider');
  return ctx;
}
