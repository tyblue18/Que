'use client';

import { useMemo, useState } from 'react';
import { useApp, type DayRecord } from '@/lib/AppContext';
import { fmtDuration } from '@/lib/units';
import { toDateStr } from '@/lib/metricsTypes';

/**
 * Recovery — daily wellness from a linked Garmin sync (resting HR, overnight
 * HRV, sleep, body battery), imported via /api/health/wellness onto DayRecords.
 *
 * Collapsible like the other Metrics panels. Each tile shows the latest value
 * plus a 7-day-vs-prior-7-day trend, colored by whether the change is GOOD for
 * recovery (HRV up = good, resting HR down = good, …) — the framing that makes
 * these numbers actionable rather than just decorative.
 */

interface MetricDef {
  key:   'restingHr' | 'hrv' | 'sleepScore' | 'bodyBattery';
  label: string;
  unit:  string;
  /** true when a HIGHER value means better recovery. */
  higherIsBetter: boolean;
}

const METRICS: MetricDef[] = [
  { key: 'hrv',         label: 'HRV',          unit: 'ms',  higherIsBetter: true  },
  { key: 'restingHr',   label: 'Resting HR',   unit: 'bpm', higherIsBetter: false },
  { key: 'sleepScore',  label: 'Sleep score',  unit: '',    higherIsBetter: true  },
  { key: 'bodyBattery', label: 'Body battery', unit: '',    higherIsBetter: true  },
];

const num = (v: unknown): number => {
  const n = parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
};

/** Last `n` calendar dates ending today, as YYYY-MM-DD. */
function lastDates(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    out.push(toDateStr(d));
    d.setDate(d.getDate() - 1);
  }
  return out;
}

function avg(vals: number[]): number | null {
  const v = vals.filter(x => x > 0);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

export function RecoveryPanel() {
  const { localDB } = useApp();
  const [open, setOpen] = useState(false);

  const model = useMemo(() => {
    const days = lastDates(14).map(ds => ({ ds, rec: (localDB[ds] ?? {}) as DayRecord }));
    const thisWeek = days.slice(0, 7);
    const lastWeek = days.slice(7, 14);

    // Latest = most recent day carrying the metric (sleep syncs on wake, HRV
    // overnight — "today" is often empty until morning).
    const latestOf = (key: MetricDef['key']) => {
      for (const d of days) { const v = num(d.rec[key]); if (v > 0) return { v, ds: d.ds }; }
      return null;
    };

    const tiles = METRICS.map(m => {
      const latest = latestOf(m.key);
      const cur  = avg(thisWeek.map(d => num(d.rec[m.key])));
      const prev = avg(lastWeek.map(d => num(d.rec[m.key])));
      const delta = cur !== null && prev !== null ? cur - prev : null;
      // A change under ~2% of the prior average is noise, not a trend.
      const meaningful = delta !== null && prev !== null && Math.abs(delta) >= prev * 0.02;
      const improving  = meaningful ? (delta! > 0) === m.higherIsBetter : null;
      return { ...m, latest, delta, improving };
    });

    const sleep = latestOf('sleepScore');
    const sleepMin = sleep ? num((localDB[sleep.ds] ?? {}).sleepMin) : 0;
    const hasAny = tiles.some(t => t.latest !== null);
    return { tiles, sleepMin, hasAny };
  }, [localDB]);

  return (
    <div className="mt-3">
      <div className="rounded border border-[var(--line)] bg-[var(--bg-2)] p-3">
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="w-full flex items-center justify-between font-mono text-[9px] font-bold tracking-[1px] uppercase text-[var(--accent)]"
        >
          <span>
            Recovery
            {model.hasAny && (() => {
              const hrv = model.tiles.find(t => t.key === 'hrv');
              return hrv?.latest
                ? <span className="ml-1.5 text-[var(--ink-2)] normal-case tracking-normal">HRV {hrv.latest.v}ms</span>
                : null;
            })()}
          </span>
          <span className="text-[var(--ink-3)]">{open ? '–' : '+'}</span>
        </button>

        {open && (
          <div className="mt-2 border-t border-[var(--line)] pt-2 space-y-2">
            {!model.hasAny ? (
              <p className="font-mono text-[9px] text-[var(--ink-3)] leading-relaxed tracking-[0.3px]">
                No recovery data yet — it fills in automatically from your Garmin
                (resting HR, overnight HRV, sleep, body battery) on each sync.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-1.5">
                  {model.tiles.map(t => (
                    <div key={t.key} className="rounded border border-[var(--line)] bg-[var(--bg-3)] p-2.5">
                      <div className="flex items-baseline justify-between">
                        <p className="font-display text-[22px] leading-none text-[var(--ink-0)]">
                          {t.latest ? t.latest.v : '—'}
                          {t.latest && t.unit && (
                            <span className="font-mono text-[9px] text-[var(--ink-3)] ml-1">{t.unit}</span>
                          )}
                        </p>
                        {t.improving !== null && (
                          <span
                            className="font-mono text-[9px] font-bold"
                            style={{ color: t.improving ? 'var(--positive)' : 'var(--warn)' }}
                            title="7-day average vs the week before"
                          >
                            {t.delta! > 0 ? '▲' : '▼'} {Math.abs(Math.round(t.delta!))}
                          </span>
                        )}
                      </div>
                      <p className="font-mono text-[7px] uppercase tracking-[1px] text-[var(--ink-3)] mt-1">
                        {t.label}
                        {t.key === 'sleepScore' && model.sleepMin > 0 && (
                          <span className="normal-case tracking-normal"> · {fmtDuration(model.sleepMin)}</span>
                        )}
                      </p>
                    </div>
                  ))}
                </div>
                <p className="font-mono text-[8px] text-[var(--ink-3)] tracking-[0.3px] leading-relaxed">
                  Latest reading, with the 7-day average vs the week before —
                  <span style={{ color: 'var(--positive)' }}> ▲▼ green</span> = trending better for recovery,
                  <span style={{ color: 'var(--warn)' }}> amber</span> = worse. Syncs from Garmin daily.
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
