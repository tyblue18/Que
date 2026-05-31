'use client';

import { useMemo } from 'react';
import { TrendingUp, TrendingDown, Minus, Swords } from 'lucide-react';
import { useApp } from '@/lib/AppContext';
import { computeBeatLastWeek, type WeekCompare } from '@/lib/beatLastWeek';

function fmtVal(v: number | null, unit: string): string {
  if (v === null) return '—';
  const n = unit === 'mi' ? v.toFixed(1) : Math.round(v).toLocaleString();
  return unit ? `${n} ${unit}` : n;
}

function Row({ c }: { c: WeekCompare }) {
  const color = c.outcome === 'ahead' ? 'var(--positive)' : c.outcome === 'behind' ? 'var(--danger)' : 'var(--ink-3)';
  const Icon  = c.outcome === 'ahead' ? TrendingUp : c.outcome === 'behind' ? TrendingDown : Minus;
  return (
    <div className="flex items-center justify-between py-2 border-b border-[var(--line)] last:border-0">
      <span className="font-mono text-[11px] text-[var(--ink-1)]">{c.label}</span>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12px] font-bold tabular-nums text-[var(--ink-0)]">{fmtVal(c.thisWeek, c.unit)}</span>
        <Icon size={13} style={{ color }} aria-hidden />
        <span className="font-mono text-[9px] tabular-nums text-[var(--ink-3)] w-[64px] text-right">
          vs {fmtVal(c.lastWeek, c.unit)}
        </span>
      </div>
    </div>
  );
}

/**
 * Solo "Beat Last Week" card — a competitive hook that works before the user
 * has any friends. Compares this week's pace to last week's same elapsed days.
 */
export function BeatLastWeek() {
  const { localDB, todayStr } = useApp();
  const r = useMemo(() => computeBeatLastWeek(localDB, todayStr), [localDB, todayStr]);

  const daysLeftLabel = r.daysLeft <= 0 ? 'last day' : `${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'} left`;

  // Headline status. Leads with the score once anything is decided; otherwise
  // teaches what the card is for.
  const status =
    r.decided === 0
      ? (r.hasThisWeek ? 'Building this week’s pace' : 'Log this week to start racing yourself')
      : r.ahead > r.behind ? `Ahead in ${r.ahead} of ${r.decided}`
      : r.behind > r.ahead ? `Behind in ${r.behind} of ${r.decided}`
      : `Even — ${r.ahead} all`;
  const statusColor = r.decided === 0 ? 'var(--ink-2)'
    : r.ahead > r.behind ? 'var(--positive)'
    : r.behind > r.ahead ? 'var(--danger)' : 'var(--accent)';

  return (
    <div className="que-card mb-4">
      <div className="px-5 pt-5 pb-4">
        <div className="flex items-center justify-between mb-1">
          <h2 className="que-section-label">
            <span className="dot" style={{ background: 'var(--accent)' }} />
            VS. LAST WEEK
          </h2>
          <span className="font-mono text-[9px] font-bold tracking-[1px] uppercase text-[var(--ink-3)] bg-[var(--bg-2)] border border-[var(--line)] rounded-full px-2.5 py-1">
            {daysLeftLabel}
          </span>
        </div>

        <p className="font-mono text-[12px] font-bold tracking-[0.5px] mb-3" style={{ color: statusColor }}>
          {status}
        </p>

        {r.categories.length > 0 ? (
          <div>
            {r.categories.map(c => <Row key={c.slug} c={c} />)}
          </div>
        ) : (
          <div className="flex items-start gap-2.5 rounded-md border border-dashed border-[var(--line-2)] bg-[var(--bg-2)] px-3 py-3">
            <Swords size={15} className="text-[var(--accent)] flex-shrink-0 mt-0.5" aria-hidden />
            <p className="font-mono text-[10px] text-[var(--ink-2)] leading-relaxed">
              No friends needed. Log workouts and meals this week — next week you&apos;ll race your own
              pace here, the same way friend battles are scored.
            </p>
          </div>
        )}

        {r.categories.length > 0 && !r.hasLastWeek && (
          <p className="font-mono text-[9px] text-[var(--ink-3)] tracking-[0.5px] mt-3">
            No last week yet — you&apos;re setting the baseline to beat.
          </p>
        )}
      </div>
    </div>
  );
}
