'use client';

import { useMemo } from 'react';
import { useApp, type DayRecord } from '@/lib/AppContext';
import { computeReadiness, type ReadinessTier } from '@/lib/readiness';

/**
 * Compact home-shell readiness pill — "how should I train today", visible the
 * moment the app opens (the full Recovery card lives in Metrics; this is its
 * front door). Renders nothing until Garmin wellness data exists.
 */

const TIER_LABEL: Record<ReadinessTier, string> = {
  ready:    'Ready',
  moderate: 'Train easy',
  low:      'Low recovery',
};
const TIER_COLOR: Record<ReadinessTier, string> = {
  ready:    'var(--positive)',
  moderate: 'var(--warn)',
  low:      'var(--danger)',
};

export function ReadinessChip({ onOpen }: { onOpen: () => void }) {
  const { localDB, todayStr } = useApp();
  const readiness = useMemo(
    () => computeReadiness(localDB as Record<string, DayRecord>, todayStr),
    [localDB, todayStr],
  );

  if (!readiness.available) return null;
  const color = TIER_COLOR[readiness.tier];

  return (
    <button
      type="button"
      onClick={onOpen}
      title={readiness.reasons.join(' · ') || 'Recovery markers look good'}
      className="flex items-center gap-1.5 font-mono text-[10px] font-bold tracking-[1px] uppercase rounded-full px-3 py-1.5 transition-all hover:brightness-110"
      style={{
        color,
        border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
        background: `color-mix(in srgb, ${color} 9%, transparent)`,
      }}
    >
      <span aria-hidden>●</span>
      {readiness.score} · {TIER_LABEL[readiness.tier]}
    </button>
  );
}
