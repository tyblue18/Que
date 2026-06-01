'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Camera, X, Trash2, Lock } from 'lucide-react';
import { useApp } from '@/lib/AppContext';
import {
  savePhoto, getPhoto, deletePhoto, listPhotoDates, compressProgressPhoto,
} from '@/lib/progressPhotos';

const GALLERY_LIMIT = 12; // recent thumbnails to load eagerly

function fmtShort(ds: string): string {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Per-day progress photos, stored device-locally in IndexedDB (private — never
 * uploaded or synced). Capture today's, browse a dated gallery, view large,
 * delete. The before/after journey alongside the numeric metrics.
 */
export function ProgressPhoto() {
  const { todayStr } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dates,   setDates]   = useState<string[]>([]);
  const [photos,  setPhotos]  = useState<Record<string, string>>({});
  const [viewing, setViewing] = useState<string | null>(null);
  const [busy,    setBusy]    = useState(false);

  const refresh = useCallback(async () => {
    const ds = await listPhotoDates();
    setDates(ds);
    const recent = ds.slice(0, GALLERY_LIMIT);
    const loaded: Record<string, string> = {};
    await Promise.all(recent.map(async d => { const p = await getPhoto(d); if (p) loaded[d] = p; }));
    setPhotos(loaded);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await compressProgressPhoto(file);
      await savePhoto(todayStr, dataUrl);
      await refresh();
    } catch { /* bad image / no IndexedDB — silently no-op */ }
    finally { setBusy(false); }
  };

  const remove = async (date: string) => {
    try { await deletePhoto(date); } catch { /* IndexedDB unavailable — nothing to do */ }
    setViewing(null);
    await refresh();
  };

  const todayPhoto = photos[todayStr];

  return (
    <div className="mt-4 pt-4 border-t border-[var(--line)]">
      <span className="que-label">Progress Photos</span>
      <p className="font-mono text-[9px] text-[var(--ink-3)] leading-relaxed tracking-[0.3px] mb-2.5 flex items-start gap-1.5">
        <Lock size={11} className="text-[var(--ink-2)] flex-shrink-0 mt-px" aria-hidden />
        <span>Saved <strong className="text-[var(--ink-2)]">only on this device</strong> — never uploaded, synced, or seen by anyone else. Completely private to you.</span>
      </p>

      <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onPick} />

      {/* Today */}
      <button
        type="button" onClick={() => fileRef.current?.click()} disabled={busy}
        className="w-full flex items-center justify-center gap-2 rounded border border-dashed border-[var(--line-2)] bg-[var(--bg-2)] py-3 font-mono text-[10px] font-bold uppercase tracking-[1.5px] text-[var(--ink-2)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-all disabled:opacity-50"
      >
        <Camera size={14} /> {busy ? 'Saving…' : todayPhoto ? "Retake today's photo" : "Add today's photo"}
      </button>

      {/* Gallery */}
      {dates.length > 0 && (
        <div className="flex gap-2 mt-3 overflow-x-auto pb-1">
          {dates.slice(0, GALLERY_LIMIT).map(d => (
            <button
              key={d} type="button" onClick={() => setViewing(d)}
              className="flex-shrink-0 relative rounded-md overflow-hidden border border-[var(--line-2)]"
              style={{ width: 64, height: 80 }}
            >
              {photos[d]
                ? <img src={photos[d]} alt={`Progress ${d}`} className="w-full h-full object-cover" />
                : <div className="w-full h-full bg-[var(--bg-3)]" />}
              <span className="absolute bottom-0 inset-x-0 bg-[rgba(7,8,10,0.7)] font-mono text-[7px] text-[var(--ink-1)] text-center py-0.5 tracking-[0.5px]">
                {fmtShort(d)}{d === todayStr ? ' ·now' : ''}
              </span>
            </button>
          ))}
          {dates.length > GALLERY_LIMIT && (
            <span className="flex-shrink-0 self-center font-mono text-[9px] text-[var(--ink-3)] px-1">+{dates.length - GALLERY_LIMIT}</span>
          )}
        </div>
      )}

      {/* Full viewer */}
      <AnimatePresence>
        {viewing && (
          <motion.div
            className="fixed inset-0 z-[450] flex items-center justify-center backdrop-blur-sm p-4"
            style={{ background: 'rgba(7,8,10,0.92)' }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={e => { if (e.target === e.currentTarget) setViewing(null); }}
          >
            <div className="relative max-w-[90vw] max-h-[85vh] flex flex-col items-center gap-3">
              <img
                src={photos[viewing] ?? ''} alt={`Progress ${viewing}`}
                className="max-w-full max-h-[72vh] object-contain rounded-lg"
              />
              <div className="flex items-center gap-4">
                <span className="font-mono text-[11px] text-[var(--ink-1)] tracking-[0.5px]">{fmtShort(viewing)}</span>
                <button
                  type="button" onClick={() => remove(viewing)}
                  className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-[1px] text-[var(--danger)] hover:opacity-80"
                >
                  <Trash2 size={13} /> Delete
                </button>
              </div>
              <button
                type="button" onClick={() => setViewing(null)} aria-label="Close"
                className="absolute -top-1 -right-1 w-9 h-9 flex items-center justify-center rounded-full bg-[var(--bg-2)] border border-[var(--line-2)] text-[var(--ink-1)]"
              >
                <X size={16} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
