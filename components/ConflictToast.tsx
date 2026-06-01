'use client';

/**
 * components/ConflictToast.tsx
 *
 * Surfaces multi-device sync RECONCILIATIONS to the user. The sync engine fires
 * a `que-conflict` event with `detail: [{ date, data, deferred? }, …]`. Under
 * field-level merge no field is lost — the server reconciled two devices' edits
 * to the same day — so the toast is INFORMATIONAL ("reconciled across devices"),
 * not a data-loss warning.
 *
 * DEFERRED entries (CAS exhausted; the edit silently retries next sync) are
 * filtered out — from the user's perspective nothing happened and the edit lands
 * momentarily, so toasting it would alarm about a transient that self-heals. If
 * an event carries only deferred entries, the toast stays silent.
 *
 * Auto-dismisses after 8 s. Stack-aware: a second conflict during the
 * display window replaces the message and resets the timer rather than
 * accumulating.
 */

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';

interface ConflictDetail {
  date: string;
  data: unknown;
  deferred?: boolean;
}

function fmtDate(ds: string): string {
  const d = new Date(ds + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function ConflictToast() {
  const [conflicts, setConflicts] = useState<ConflictDetail[] | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ConflictDetail[]>).detail;
      if (!Array.isArray(detail)) return;
      // Only genuine merge reconciliations surface; deferred retries stay silent.
      const visible = detail.filter(c => !c.deferred);
      if (visible.length === 0) return;
      setConflicts(visible);
    };
    window.addEventListener('que-conflict', handler);
    return () => window.removeEventListener('que-conflict', handler);
  }, []);

  // Auto-dismiss timer — reset every time `conflicts` changes (new event wins).
  useEffect(() => {
    if (!conflicts) return;
    const id = setTimeout(() => setConflicts(null), 8_000);
    return () => clearTimeout(id);
  }, [conflicts]);

  return (
    <AnimatePresence>
      {conflicts && (
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 40 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="fixed left-1/2 -translate-x-1/2 z-[70] flex items-start gap-3 max-w-[92vw] md:max-w-[420px] rounded-lg border bg-[var(--bg-1)] px-4 py-3"
          style={{
            bottom:      'calc(80px + env(safe-area-inset-bottom))',
            borderColor: 'var(--accent)',
            boxShadow:   '0 0 0 1px var(--accent-12), 0 18px 40px rgba(0,0,0,0.55)',
          }}
        >
          <div className="flex-1 min-w-0">
            <p className="font-mono text-[9px] font-bold tracking-[2px] uppercase text-[var(--accent)] mb-1">
              Synced from another device
            </p>
            <p className="font-mono text-[10px] text-[var(--ink-1)] leading-relaxed tracking-[0.3px]">
              {conflicts.length === 1 ? (
                <>Merged your edits to <strong className="text-[var(--ink-0)]">{fmtDate(conflicts[0].date)}</strong> with changes from another device.</>
              ) : (
                <>Merged <strong className="text-[var(--ink-0)]">{conflicts.length} days</strong> with changes from another device ({fmtDate(conflicts[0].date)}–{fmtDate(conflicts[conflicts.length - 1].date)}).</>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setConflicts(null)}
            className="text-[var(--ink-3)] hover:text-[var(--ink-0)] transition-colors flex-shrink-0 -mt-0.5"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
