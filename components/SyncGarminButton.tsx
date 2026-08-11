'use client';

import { useState, useEffect, useCallback } from 'react';
import { useApp } from '@/lib/AppContext';

/**
 * Home-shell "Sync Garmin" button. Renders NOTHING unless the user has a
 * data_tracker connected (checked once via /api/datatracker) — so it only ever
 * appears for people who've set it up. Clicking it triggers the tracker's Garmin
 * pull (which pushes new cardio into Que server-side), then re-pulls the cloud
 * snapshot so the workouts show up immediately without a reload.
 */
export function SyncGarminButton() {
  const { refreshFromCloud } = useApp();
  const [connected, setConnected] = useState(false);
  const [syncing,   setSyncing]   = useState(false);
  const [msg,       setMsg]       = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/datatracker')
      .then(r => (r.ok ? r.json() : { connected: false }))
      .then((d: { connected?: boolean }) => { if (!cancelled) setConnected(!!d.connected); })
      .catch(() => { /* leave hidden */ });
    return () => { cancelled = true; };
  }, []);

  const sync = useCallback(async () => {
    setMsg(''); setSyncing(true);
    try {
      const r = await fetch('/api/datatracker/sync', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { setMsg(d.error ?? 'Sync failed'); return; }
      await refreshFromCloud();
      const added = d.result?.que?.sent;
      setMsg(typeof added === 'number'
        ? (added > 0 ? `Added ${added} workout${added === 1 ? '' : 's'}` : 'Up to date')
        : 'Synced');
      setTimeout(() => setMsg(''), 4000);
    } catch {
      setMsg('Sync failed — check your connection');
    } finally {
      setSyncing(false);
    }
  }, [refreshFromCloud]);

  if (!connected) return null; // only for users who've connected a data_tracker

  return (
    <div className="flex items-center gap-2 px-4 md:px-6 pt-3">
      <button
        type="button"
        onClick={sync}
        disabled={syncing}
        className="flex items-center gap-1.5 font-mono text-[10px] font-bold tracking-[1px] uppercase text-[var(--accent)] border border-[var(--accent)]/40 rounded-full px-3 py-1.5 hover:bg-[var(--accent)]/10 transition-all disabled:opacity-50"
      >
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={syncing ? 'animate-spin' : ''} aria-hidden
        >
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <polyline points="21 3 21 9 15 9" />
        </svg>
        {syncing ? 'Syncing…' : 'Sync Garmin'}
      </button>
      {msg && <span className="font-mono text-[9px] text-[var(--ink-3)]">{msg}</span>}
    </div>
  );
}
