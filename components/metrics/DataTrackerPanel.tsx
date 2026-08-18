'use client';

import { useState, useEffect, useCallback } from 'react';
import { useApp } from '@/lib/AppContext';

// ── Types (defensive — the tracker snapshot is loosely shaped) ────────────────
interface TrackerHealth { ok: boolean; garminTokens: number; lastActivity: string | null; quePushConfigured: boolean }
interface Status { connected: boolean; baseUrl: string | null; lastSyncAt: string | null; health?: TrackerHealth | null }
type Snapshot = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);

/** Pull the last fitness/fatigue row (CTL / ATL / TSB) out of the snapshot. */
function loadForm(s: Snapshot | null): { ctl: number | null; atl: number | null; tsb: number | null } {
  const ff = s?.fitness_fatigue;
  const last = Array.isArray(ff) && ff.length ? ff[ff.length - 1] as Record<string, unknown> : null;
  return { ctl: num(last?.ctl), atl: num(last?.atl), tsb: num(last?.tsb) };
}

function fmtWhen(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString();
}

export function DataTrackerPanel() {
  const { refreshFromCloud } = useApp();
  const [status,  setStatus]  = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [open,    setOpen]    = useState(false);

  // connect form
  const [url,        setUrl]        = useState('');
  const [secret,     setSecret]     = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error,      setError]      = useState('');

  // connected actions
  const [syncing,   setSyncing]   = useState(false);
  const [syncMsg,   setSyncMsg]   = useState('');
  const [snapshot,  setSnapshot]  = useState<Snapshot | null>(null);
  const [metricsErr, setMetricsErr] = useState('');

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/datatracker');
      if (r.ok) setStatus(await r.json());
    } catch { /* offline — leave as-is */ }
    finally { setLoading(false); }
  }, []);

  const loadMetrics = useCallback(async () => {
    setMetricsErr('');
    try {
      const r = await fetch('/api/datatracker/metrics');
      const d = await r.json();
      if (r.ok) setSnapshot(d.snapshot as Snapshot);
      else setMetricsErr(d.error ?? 'Could not load metrics.');
    } catch { setMetricsErr('Could not load metrics.'); }
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);
  useEffect(() => { if (status?.connected && open && !snapshot) void loadMetrics(); }, [status?.connected, open, snapshot, loadMetrics]);

  const connect = useCallback(async () => {
    setError(''); setConnecting(true);
    try {
      const r = await fetch('/api/datatracker', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: url.trim(), secret: secret.trim() }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error ?? 'Could not connect.'); return; }
      setSecret(''); setStatus({ connected: true, baseUrl: d.baseUrl, lastSyncAt: null });
      void loadMetrics();
    } catch { setError('Could not connect — check your connection.'); }
    finally { setConnecting(false); }
  }, [url, secret, loadMetrics]);

  const syncNow = useCallback(async (full = false) => {
    setSyncMsg(''); setSyncing(true);
    try {
      const r = await fetch(`/api/datatracker/sync${full ? '?full=1' : ''}`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { setSyncMsg(d.error ?? 'Sync failed.'); return; }
      // Re-pull the cloud so newly-imported/backfilled cardio (and its calories)
      // shows immediately — without this the budget keeps the stale number.
      await refreshFromCloud();
      await refreshStatus();
      await loadMetrics();
      const sent = d.result?.que?.sent;
      setSyncMsg(typeof sent === 'number'
        ? `Synced — ${sent} workout${sent === 1 ? '' : 's'} ${full ? 'refreshed' : 'added'}.`
        : 'Synced.');
    } catch { setSyncMsg('Sync failed — check your connection.'); }
    finally { setSyncing(false); }
  }, [refreshFromCloud, refreshStatus, loadMetrics]);

  const disconnect = useCallback(async () => {
    await fetch('/api/datatracker', { method: 'DELETE' }).catch(() => {});
    setStatus({ connected: false, baseUrl: null, lastSyncAt: null });
    setSnapshot(null); setUrl('');
  }, []);

  if (loading) return null; // nothing until we know the state (avoids a flash)

  const form = loadForm(snapshot);
  const meta = (snapshot?.meta ?? {}) as Record<string, unknown>;
  const prog = (snapshot?.progression_score ?? null) as Record<string, unknown> | null;
  const intensity = (snapshot?.intensity_summary ?? null) as Record<string, unknown> | null;

  const Tile = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
    <div className="rounded border border-[var(--line)] bg-[var(--bg-2)] p-2.5 text-center">
      <p className="font-display text-[22px] leading-none text-[var(--accent)]">{value}</p>
      <p className="font-mono text-[7px] uppercase tracking-[1px] text-[var(--ink-3)] mt-1">{label}</p>
      {hint && <p className="font-mono text-[7px] text-[var(--ink-3)] opacity-70">{hint}</p>}
    </div>
  );

  return (
    <div className="mt-3">
      <div className="rounded border border-[var(--line)] bg-[var(--bg-2)] p-3">
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="w-full flex items-center justify-between font-mono text-[9px] font-bold tracking-[1px] uppercase text-[var(--accent)]"
        >
          <span>
            Garmin via Data Tracker
            {status?.connected && <span className="ml-1.5 text-[var(--positive)]">● connected</span>}
          </span>
          <span className="text-[var(--ink-3)]">{open ? '–' : '+'}</span>
        </button>

        {open && (
          <div className="mt-2 border-t border-[var(--line)] pt-2 space-y-2">
            {!status?.connected ? (
              // ── Not connected: the connect form ──
              <>
                <p className="font-mono text-[9px] text-[var(--ink-2)] leading-relaxed tracking-[0.2px]">
                  Connect your own <span className="text-[var(--ink-0)]">data_tracker</span> (it logs into <em>your</em> Garmin — Que never sees your credentials).
                  A tap on <span className="text-[var(--ink-0)]">Sync now</span> then auto-logs your runs/rides/swims and shows your training metrics here.
                </p>
                <div>
                  <label className="que-label">Your data_tracker URL</label>
                  <input type="url" inputMode="url" className="que-input" placeholder="https://your-tracker.vercel.app"
                    value={url} onChange={e => setUrl(e.target.value)} />
                </div>
                <div>
                  <label className="que-label">Shared secret (its CRON_SECRET)</label>
                  <input type="password" className="que-input" placeholder="paste the tracker's CRON_SECRET"
                    value={secret} onChange={e => setSecret(e.target.value)} />
                </div>
                {error && <p className="font-mono text-[9px] text-[var(--danger)]">{error}</p>}
                <button type="button" onClick={connect} disabled={connecting || !url.trim() || !secret.trim()}
                  className="que-btn-primary w-full py-2.5 text-[10px] disabled:opacity-40">
                  {connecting ? 'Connecting…' : 'Connect'}
                </button>
              </>
            ) : (
              // ── Connected: sync + metrics ──
              <>
                <div className="flex items-center justify-between gap-2">
                  <p className="font-mono text-[9px] text-[var(--ink-2)] truncate">
                    {status.baseUrl?.replace(/^https:\/\//, '')}
                    <span className="text-[var(--ink-3)]"> · last sync {fmtWhen(status.lastSyncAt)}</span>
                  </p>
                  <button type="button" onClick={disconnect}
                    className="font-mono text-[8px] uppercase tracking-[0.5px] text-[var(--ink-3)] hover:text-[var(--danger)] flex-shrink-0">
                    Disconnect
                  </button>
                </div>

                {/* Tracker health — explains a dead sync before the user hits it. */}
                {status.health && (!status.health.ok || status.health.garminTokens === 0 || !status.health.quePushConfigured) && (
                  <div className="rounded border border-[var(--warn)]/50 bg-[var(--warn)]/10 px-2.5 py-2">
                    <p className="font-mono text-[9px] text-[var(--warn)] leading-relaxed tracking-[0.3px]">
                      {status.health.garminTokens === 0
                        ? <>Your tracker has no Garmin login — run <code className="text-[var(--ink-1)]">python track.py tokens</code> (after a local sync) to seed it, or syncs will fail.</>
                        : !status.health.quePushConfigured
                          ? <>Your tracker isn&apos;t configured to push into Que — set QUE_ACTIVITY_URL and QUE_ACTIVITY_TOKEN on its deployment.</>
                          : <>Your tracker is reporting an error — check its /api/health.</>}
                    </p>
                  </div>
                )}

                <button type="button" onClick={() => syncNow(false)} disabled={syncing}
                  className="que-btn-primary w-full py-2.5 text-[10px] disabled:opacity-50">
                  {syncing ? 'Syncing Garmin…' : 'Sync now'}
                </button>
                {/* Forces a re-send of ALL recent activities so Que backfills
                    fields added after they were first imported (e.g. Garmin's
                    measured calories). Use it once after enabling accurate calories. */}
                <button type="button" onClick={() => syncNow(true)} disabled={syncing}
                  className="que-btn-ghost w-full py-2 text-[9px] disabled:opacity-50">
                  Re-sync all history (fix calories)
                </button>
                {syncMsg && <p className="font-mono text-[9px] text-[var(--ink-2)] text-center">{syncMsg}</p>}

                {/* Headline training metrics from the tracker snapshot */}
                {metricsErr ? (
                  <p className="font-mono text-[9px] text-[var(--warn)]">{metricsErr}</p>
                ) : snapshot ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-3 gap-1.5">
                      <Tile label="Form (TSB)" value={form.tsb != null ? form.tsb.toFixed(0) : '—'} />
                      <Tile label="Fitness (CTL)" value={form.ctl != null ? form.ctl.toFixed(0) : '—'} />
                      <Tile label="Fatigue (ATL)" value={form.atl != null ? form.atl.toFixed(0) : '—'} />
                    </div>
                    {(num(prog?.score) != null || typeof intensity?.label === 'string') && (
                      <div className="grid grid-cols-2 gap-1.5">
                        {num(prog?.score) != null &&
                          <Tile label="Progression" value={String(Math.round(num(prog?.score)!))} />}
                        {typeof intensity?.label === 'string' &&
                          <Tile label="Intensity mix" value={intensity.label as string} />}
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <p className="font-mono text-[8px] text-[var(--ink-3)]">
                        {num((meta.counts as Record<string, unknown>)?.activities) ?? '—'} activities
                        {num(meta.days_stale) != null && <> · {num(meta.days_stale)}d stale</>}
                      </p>
                      {status.baseUrl && (
                        <a href={status.baseUrl} target="_blank" rel="noopener noreferrer"
                          className="font-mono text-[8px] font-bold uppercase tracking-[0.5px] text-[var(--accent)]">
                          Open full dashboard →
                        </a>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="font-mono text-[9px] text-[var(--ink-3)] animate-pulse text-center">Loading metrics…</p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
