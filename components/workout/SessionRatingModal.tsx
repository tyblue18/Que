'use client';

import { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, Check } from 'lucide-react';

export interface SessionRating { rating: number; feel: number; notes: string }

/** 1–10 tappable scale. 0 = unset. */
function Scale10({ value, onChange, lowLabel, highLabel }: {
  value: number; onChange: (v: number) => void; lowLabel: string; highLabel: string;
}) {
  return (
    <div>
      <div className="grid grid-cols-10 gap-1">
        {Array.from({ length: 10 }, (_, i) => i + 1).map(n => {
          const active = value === n;
          return (
            <button
              key={n} type="button" onClick={() => onChange(n)}
              className={[
                'h-9 rounded-md font-mono text-[12px] font-bold tabular-nums transition-all',
                active
                  ? 'bg-[var(--accent)] text-[var(--accent-ink)]'
                  : 'bg-[var(--bg-2)] text-[var(--ink-2)] border border-[var(--line)] hover:border-[var(--line-3)]',
              ].join(' ')}
              aria-pressed={active}
              aria-label={`${n} of 10`}
            >
              {n}
            </button>
          );
        })}
      </div>
      <div className="flex justify-between mt-1.5 font-mono text-[9px] text-[var(--ink-3)] tracking-[0.5px] uppercase">
        <span>{lowLabel}</span>
        <span>{highLabel}</span>
      </div>
    </div>
  );
}

/**
 * Post-session check-in shown after Commit Session. Captures a self-reported
 * session quality + how the athlete felt (both 1–10) and lets them add notes —
 * all tracked per day for Metrics trends. Fully skippable.
 */
export function SessionRatingModal({ open, initial, onSave, onClose }: {
  open: boolean;
  initial: SessionRating;
  onSave: (v: SessionRating) => void;
  onClose: () => void;
}) {
  const [rating, setRating] = useState(0);
  const [feel,   setFeel]   = useState(0);
  const [notes,  setNotes]  = useState('');

  // Re-seed from the day's existing values each time it opens.
  useEffect(() => {
    if (!open) return;
    setRating(initial.rating || 0);
    setFeel(initial.feel || 0);
    setNotes(initial.notes || '');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = () => onSave({ rating, feel, notes: notes.trim() });

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[400] flex items-end md:items-center justify-center backdrop-blur-sm px-3 md:px-0"
          style={{ background: 'rgba(7,8,10,0.88)' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={e => { if (e.target === e.currentTarget) onClose(); }}
        >
          <motion.div
            className="w-full md:max-w-[440px] rounded-t-2xl md:rounded-2xl border border-[var(--line-2)] bg-[var(--bg-1)] overflow-hidden"
            initial={{ opacity: 0, y: 48 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 48 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            style={{ boxShadow: '0 0 0 1px var(--line-2), 0 -2px 0 0 var(--positive), 0 40px 80px rgba(0,0,0,0.6)' }}
          >
            <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-[var(--line)]">
              <div>
                <h3 className="font-display text-[20px] tracking-[1.5px] uppercase text-[var(--ink-0)]">Session logged</h3>
                <p className="font-mono text-[9px] text-[var(--ink-3)] tracking-[0.5px] mt-0.5">Quick check-in — tracked for your trends</p>
              </div>
              <button onClick={onClose} aria-label="Skip" className="text-[var(--ink-2)] hover:text-[var(--accent)] transition-colors p-1">
                <X size={18} />
              </button>
            </div>

            <div className="p-5 space-y-5">
              <div>
                <label className="que-label mb-2">How was this session?</label>
                <Scale10 value={rating} onChange={setRating} lowLabel="Rough" highLabel="Elite" />
              </div>
              <div>
                <label className="que-label mb-2">How did you feel?</label>
                <Scale10 value={feel} onChange={setFeel} lowLabel="Drained" highLabel="Strong" />
              </div>
              <div>
                <label className="que-label mb-2">Session notes</label>
                <textarea
                  value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                  placeholder="energy, sleep, what worked…"
                  className="que-input resize-y min-h-[60px] font-sans !text-[13px] tracking-normal"
                />
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  type="button" onClick={onClose}
                  className="flex-1 py-3 rounded-lg font-mono text-[10px] font-bold tracking-[1px] uppercase text-[var(--ink-3)]"
                  style={{ background: 'var(--bg-3)', border: '1px solid var(--line-2)' }}
                >
                  Skip
                </button>
                <button
                  type="button" onClick={save}
                  className="flex-[2] py-3 rounded-lg font-mono text-[10px] font-bold tracking-[1px] uppercase flex items-center justify-center gap-1.5"
                  style={{ background: 'var(--positive)', color: 'var(--accent-ink)' }}
                >
                  <Check size={13} /> Save check-in
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
