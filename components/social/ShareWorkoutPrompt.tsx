'use client';

import { useState, useEffect, useMemo } from 'react';
import { X, Users, Check } from 'lucide-react';
import type { DayRecord } from '@/lib/AppContext';
import { summarizeDay, toPostPayload } from '@/lib/shareWorkout';

interface GroupLite { id: string; name: string }

/**
 * Post-commit prompt: after a session is committed, asks whether to share the
 * workout to any of the user's groups (multi-select → one POST /api/posts).
 *
 * Self-gating: while groups load it renders nothing; if the user is in NO groups
 * (or the day has nothing shareable) it closes silently — so users without
 * groups never see an empty popup.
 */
export function ShareWorkoutPrompt({ date, localDB, onClose }: {
  date: string;
  localDB: Record<string, DayRecord>;
  onClose: () => void;
}) {
  const summary = useMemo(() => summarizeDay(localDB[date]), [localDB, date]);
  const [groups, setGroups] = useState<GroupLite[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/groups', { credentials: 'include' });
        const d = r.ok ? (await r.json()) as { groups: GroupLite[] } : null;
        if (alive) setGroups(d?.groups ?? []);
      } catch { if (alive) setGroups([]); }
    })();
    return () => { alive = false; };
  }, []);

  // No groups (once loaded) or nothing to share → don't show a prompt at all.
  useEffect(() => {
    if (groups && (groups.length === 0 || !summary.hasContent)) onClose();
  }, [groups, summary.hasContent, onClose]);

  if (!groups || groups.length === 0 || !summary.hasContent) return null;

  const toggle = (id: string) => setSel(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const share = async () => {
    const groupIds = [...sel];
    if (groupIds.length === 0) { setError('Pick at least one group'); return; }
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/posts', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupIds, date, payload: toPostPayload(summary), note: note.trim() || undefined }),
      });
      if (!res.ok) { setError((await res.json().catch(() => null))?.error ?? 'Could not share'); return; }
      setDone(true);
      setTimeout(onClose, 950);
    } catch {
      setError('Could not share — check your connection');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[480] flex items-end sm:items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div
        className="w-full max-w-[420px] max-h-[88dvh] flex flex-col rounded-t-2xl sm:rounded-2xl bg-[var(--bg-1)] border border-[var(--line-2)] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Users size={18} className="text-[var(--accent)]" />
            <h3 className="font-display text-[18px] tracking-[1.5px] uppercase text-[var(--ink-0)]">Share workout?</h3>
          </div>
          <button onClick={onClose} className="text-[var(--ink-3)] hover:text-[var(--ink-0)]"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-5">
          <p className="font-mono text-[10px] text-[var(--ink-2)] mb-3">
            Nice work — post this session to your groups?
          </p>

          {/* Workout preview */}
          <div className="rounded-md border border-[var(--line)] bg-[var(--bg-2)] p-3 mb-4 space-y-0.5">
            <p className="font-mono text-[10px] font-bold text-[var(--ink-0)] mb-0.5">{summary.title || 'Workout'}</p>
            {summary.lines.slice(0, 5).map((l, i) => (
              <p key={i} className="font-mono text-[9px] text-[var(--ink-1)]">{l}</p>
            ))}
            {summary.lines.length > 5 && (
              <p className="font-mono text-[9px] text-[var(--ink-3)]">+{summary.lines.length - 5} more</p>
            )}
          </div>

          {/* Group multi-select */}
          <label className="que-label">Groups</label>
          <div className="space-y-1.5 mb-4">
            {groups.map(g => {
              const on = sel.has(g.id);
              return (
                <button key={g.id} type="button" onClick={() => toggle(g.id)}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md border transition-all text-left"
                  style={{ borderColor: on ? 'var(--accent)' : 'var(--line)', background: on ? 'var(--accent-12)' : 'var(--bg-2)' }}>
                  <span className={`w-4 h-4 rounded-sm border flex items-center justify-center flex-shrink-0 ${on ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--line-3)]'}`}>
                    {on && <Check size={11} className="text-[var(--bg-0)]" />}
                  </span>
                  <span className="font-mono text-[12px] font-bold truncate" style={{ color: on ? 'var(--accent)' : 'var(--ink-0)' }}>{g.name}</span>
                </button>
              );
            })}
          </div>

          <label className="que-label">Caption (optional)</label>
          <input type="text" className="que-input mb-2" placeholder="How'd it go?" value={note} maxLength={280} onChange={e => setNote(e.target.value)} />

          {error && <p className="font-mono text-[9px] text-[var(--danger)] mb-1">{error}</p>}
        </div>

        {/* Actions (pinned, clear safe area) */}
        <div className="flex gap-2 px-5 pt-3 flex-shrink-0 border-t border-[var(--line)]"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>
          <button type="button" onClick={onClose}
            className="rounded-lg border border-[var(--line-2)] px-4 py-2.5 font-mono text-[11px] font-bold uppercase tracking-[1px] text-[var(--ink-3)]">
            Not now
          </button>
          <button type="button" onClick={share} disabled={busy || done || sel.size === 0}
            className="que-btn-primary flex-1 py-2.5 disabled:opacity-40">
            {done ? '✓ Shared' : busy ? 'Sharing…' : `Share${sel.size > 0 ? ` to ${sel.size}` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
