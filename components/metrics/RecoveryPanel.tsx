'use client';

import { useMemo, useState } from 'react';
import { useApp, type DayRecord } from '@/lib/AppContext';
import { fmtDuration } from '@/lib/units';
import { toDateStr } from '@/lib/metricsTypes';
import { computeReadiness, type ReadinessTier } from '@/lib/readiness';

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

const TIER_COPY: Record<ReadinessTier, { label: string; hint: string; color: string }> = {
  ready:    { label: 'Ready to train',  hint: 'Recovery markers look good — train as planned.', color: 'var(--positive)' },
  moderate: { label: 'Train, but easy on intensity', hint: 'Some recovery markers are off — a normal session is fine, save the max efforts.', color: 'var(--warn)' },
  low:      { label: 'Low recovery',    hint: 'Multiple markers are down — consider an easy day or extra rest.', color: 'var(--danger)' },
};

export function RecoveryPanel() {
  const { localDB, todayStr } = useApp();
  // null = user hasn't toggled → default OPEN whenever there's data to show
  // (a collapsed-by-default panel is how this feature went unnoticed).
  const [openState, setOpenState] = useState<boolean | null>(null);

  const readiness = useMemo(
    () => computeReadiness(localDB as Record<string, DayRecord>, todayStr),
    [localDB, todayStr],
  );

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

  const open = openState ?? model.hasAny;

  return (
    <div className="que-card mb-4">
      <div className="p-5">
        <button
          type="button"
          onClick={() => setOpenState(!open)}
          className="w-full flex items-center justify-between"
        >
          <h2 className="que-section-label"><span className="dot" />RECOVERY
            {readiness.available && (
              <span className="ml-2 normal-case tracking-normal font-mono text-[11px] font-bold" style={{ color: TIER_COPY[readiness.tier].color }}>
                ● {readiness.score}/100
              </span>
            )}
          </h2>
          <span className="font-mono text-[11px] text-[var(--ink-3)]">{open ? '–' : '+'}</span>
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
                {/* Today's readiness — the actionable summary of the tiles below. */}
                {readiness.available && (
                  <div
                    className="rounded border p-2.5"
                    style={{ borderColor: `color-mix(in srgb, ${TIER_COPY[readiness.tier].color} 45%, transparent)`,
                             background:  `color-mix(in srgb, ${TIER_COPY[readiness.tier].color} 9%, transparent)` }}
                  >
                    <p className="font-mono text-[10px] font-bold tracking-[0.5px]" style={{ color: TIER_COPY[readiness.tier].color }}>
                      {TIER_COPY[readiness.tier].label} · {readiness.score}/100
                    </p>
                    <p className="font-mono text-[8px] text-[var(--ink-2)] leading-relaxed tracking-[0.3px] mt-0.5">
                      {readiness.reasons.length
                        ? readiness.reasons.join(' · ')
                        : TIER_COPY[readiness.tier].hint}
                    </p>
                  </div>
                )}

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
