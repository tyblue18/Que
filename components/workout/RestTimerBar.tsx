'use client';

/**
 * components/workout/RestTimerBar.tsx
 *
 * Floating rest-timer bar shown between sets. Started by WorkoutLogger on every
 * successful commitLift. Features:
 *   - Drag handle (grip): hold and move the bar anywhere on screen — it no longer
 *     sits trapped behind the mobile nav/chrome at the bottom.
 *   - ±30 s adjusters and a skip (✕).
 *   - "Log set": reveals reps × weight inputs (prefilled from the last set) and
 *     appends that set to the exercise the timer belongs to, then restarts the
 *     clock — so you can run the set → rest → log loop without scrolling back up.
 *
 * Wall-clock based — survives tab background / sleep without drift. The countdown
 * resets when `startMs` changes (a new set/commit) WITHOUT remounting, so the
 * user's dragged position is preserved across the rest loop.
 */

import { useEffect, useState } from 'react';
import { motion, useDragControls } from 'framer-motion';
import { Plus, Minus, X, Check, GripVertical } from 'lucide-react';
import { useUnits } from '@/lib/units';

export function RestTimerBar({
  startMs,
  durationMs,
  suggestReps,
  suggestWeight,
  onLogSet,
  onAdjust,
  onDismiss,
}: {
  startMs:       number;
  durationMs:    number;
  suggestReps:   string;
  suggestWeight: string;
  onLogSet:      (reps: string, weight: string) => void;
  onAdjust:      (deltaMs: number) => void;
  onDismiss:     () => void;
}) {
  const u = useUnits();
  const [now, setNow]         = useState(() => Date.now());
  const [vibed, setVibed]     = useState(false);
  const [logging, setLogging] = useState(false);
  const [reps, setReps]       = useState(suggestReps);
  // suggestWeight is canonical lb; edit it in the user's unit.
  const [weight, setWeight]   = useState(() => (suggestWeight ? u.dispWeight(parseFloat(suggestWeight)) : ''));
  const dragControls          = useDragControls();

  // 1 s tick. Don't tick faster — it's wall-clock anyway, granularity is fine.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // A new set / commit restarts the clock (startMs changes) — reset the countdown
  // state in place (no remount) so the dragged position survives the rest loop.
  useEffect(() => { setNow(Date.now()); setVibed(false); }, [startMs]);

  const remaining = Math.max(0, durationMs - (now - startMs));
  const done      = remaining === 0;

  // One-shot vibration the instant we hit zero.
  useEffect(() => {
    if (done && !vibed) {
      setVibed(true);
      navigator.vibrate?.([120, 60, 120, 60, 200]);
    }
  }, [done, vibed]);

  // Auto-dismiss 8 s after expiry — but never while the user is mid-log.
  useEffect(() => {
    if (!done || logging) return;
    const id = setTimeout(onDismiss, 8_000);
    return () => clearTimeout(id);
  }, [done, logging, onDismiss]);

  const mm = Math.floor(remaining / 60_000);
  const ss = Math.floor((remaining % 60_000) / 1000).toString().padStart(2, '0');

  const openLog = () => {
    setReps(suggestReps);
    setWeight(suggestWeight ? u.dispWeight(parseFloat(suggestWeight)) : '');
    setLogging(true);
  };
  // Inputs are in the user's unit; hand back canonical lb to the appender.
  const saveLog = () => {
    const w = weight.trim() ? String(u.toStoredWeight(parseFloat(weight))) : '';
    onLogSet(reps.trim() || '1', w);
    setLogging(false);
  };

  return (
    <motion.div
      drag
      dragListener={false}
      dragControls={dragControls}
      dragMomentum={false}
      dragElastic={0.12}
      initial={{ scale: 0.92, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0.92, opacity: 0 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className="fixed left-0 right-0 mx-auto w-max max-w-[calc(100vw-20px)] z-[60] flex items-center gap-2 rounded-full border bg-[var(--bg-1)] px-2 py-2 shadow-2xl"
      style={{
        // Default to mid-screen (not pinned behind the bottom nav). Once the user
        // drags, framer-motion's transform takes over and the bar stays where
        // they left it across the rest loop (it doesn't remount on startMs change).
        top:         '42vh',
        borderColor: done ? 'var(--positive)' : 'var(--accent)',
        boxShadow:   `0 0 0 1px ${done ? 'var(--positive-12)' : 'var(--accent-12)'}, 0 18px 40px rgba(0,0,0,0.5)`,
      }}
    >
      {/* Drag handle — press and move the bar anywhere on screen. */}
      <button
        type="button"
        onPointerDown={e => dragControls.start(e)}
        aria-label="Drag rest timer"
        title="Drag to move"
        className="w-7 h-9 flex items-center justify-center rounded-full border border-[var(--line-2)] bg-[var(--bg-2)] text-[var(--ink-2)] hover:text-[var(--ink-0)] cursor-grab active:cursor-grabbing flex-shrink-0"
        style={{ touchAction: 'none' }}
      >
        <GripVertical size={16} />
      </button>

      {logging ? (
        <>
          <input
            type="number" inputMode="numeric" value={reps}
            onChange={e => setReps(e.target.value)}
            placeholder="reps" aria-label="Reps"
            className="w-12 h-9 text-center rounded-md border border-[var(--line-2)] bg-[var(--bg-2)] font-mono text-[13px] text-[var(--ink-0)] focus:border-[var(--accent)] outline-none"
          />
          <span className="font-mono text-[12px] text-[var(--ink-3)]">×</span>
          <input
            type="number" inputMode="decimal" value={weight}
            onChange={e => setWeight(e.target.value)}
            placeholder={u.weightUnit} aria-label="Weight"
            className="w-16 h-9 text-center rounded-md border border-[var(--line-2)] bg-[var(--bg-2)] font-mono text-[13px] text-[var(--ink-0)] focus:border-[var(--accent)] outline-none"
          />
          <button
            type="button" onClick={saveLog}
            className="h-9 px-3 flex items-center gap-1 rounded-full font-mono text-[10px] font-bold uppercase tracking-[0.5px] flex-shrink-0"
            style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
          >
            <Check size={13} /> Save
          </button>
          <button
            type="button" onClick={() => setLogging(false)} aria-label="Back"
            className="w-8 h-8 flex items-center justify-center rounded-full text-[var(--ink-3)] hover:text-[var(--ink-1)] transition-colors flex-shrink-0"
          >
            <X size={14} />
          </button>
        </>
      ) : (
        <>
          <button
            type="button" onClick={() => onAdjust(-30_000)} disabled={done}
            className="w-8 h-8 flex items-center justify-center rounded-full border border-[var(--line-2)] bg-[var(--bg-2)] text-[var(--ink-2)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-all disabled:opacity-30 flex-shrink-0"
            title="Subtract 30 s"
          >
            <Minus size={13} />
          </button>

          <div className="flex flex-col items-center min-w-[54px]">
            <span
              className="font-display tabular text-[22px] leading-none"
              style={{ color: done ? 'var(--positive)' : 'var(--accent)' }}
            >
              {done ? 'GO' : `${mm}:${ss}`}
            </span>
            <span className="font-mono text-[7px] tracking-[1.5px] uppercase text-[var(--ink-3)] mt-0.5">
              {done ? 'next set' : 'rest'}
            </span>
          </div>

          <button
            type="button" onClick={() => onAdjust(30_000)} disabled={done}
            className="w-8 h-8 flex items-center justify-center rounded-full border border-[var(--line-2)] bg-[var(--bg-2)] text-[var(--ink-2)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-all disabled:opacity-30 flex-shrink-0"
            title="Add 30 s"
          >
            <Plus size={13} />
          </button>

          {/* Log the set you just did — appends to the current exercise + restarts rest. */}
          <button
            type="button" onClick={openLog}
            className="h-8 px-3 flex items-center gap-1 rounded-full font-mono text-[10px] font-bold uppercase tracking-[0.5px] flex-shrink-0"
            style={{ background: done ? 'var(--positive)' : 'var(--accent)', color: 'var(--accent-ink)' }}
            title="Log this set"
          >
            <Check size={13} /> Log set
          </button>

          <button
            type="button" onClick={onDismiss} aria-label="Skip rest"
            className="w-8 h-8 flex items-center justify-center rounded-full text-[var(--ink-3)] hover:text-[var(--danger)] transition-colors flex-shrink-0"
            title="Skip rest"
          >
            <X size={14} />
          </button>
        </>
      )}
    </motion.div>
  );
}
