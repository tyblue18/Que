'use client';

import { useState, useEffect, useMemo } from 'react';
import { useApp, type DayRecord } from '@/lib/AppContext';
import { useUnits } from '@/lib/units';

type MeasureKey = 'waist' | 'chest' | 'arms' | 'thighs' | 'hips' | 'bodyFat';
const FIELDS: { key: MeasureKey; label: string; circ: boolean }[] = [
  { key: 'waist',   label: 'Waist',    circ: true  },
  { key: 'chest',   label: 'Chest',    circ: true  },
  { key: 'arms',    label: 'Arms',     circ: true  },
  { key: 'thighs',  label: 'Thighs',   circ: true  },
  { key: 'hips',    label: 'Hips',     circ: true  },
  { key: 'bodyFat', label: 'Body Fat', circ: false }, // %
];

/**
 * Optional body-measurement logging inside the Athlete Profile — available to
 * update whenever the user measures, not a daily ask. Values store on the
 * DayRecord (canonical inches for circumferences, raw % for body fat) keyed by
 * the day they were entered, so history is preserved. Inputs prefill from the
 * most recent logged value.
 */
export function Measurements() {
  const { localDB, todayStr, updateDayRecord } = useApp();
  const u = useUnits();

  // Most recent logged value per field (canonical).
  const latest = useMemo(() => {
    const out: Partial<Record<MeasureKey, number>> = {};
    const dates = Object.keys(localDB).sort().reverse();
    for (const f of FIELDS) {
      for (const d of dates) {
        const v = Number((localDB[d] as DayRecord)?.[f.key]) || 0;
        if (v > 0) { out[f.key] = v; break; }
      }
    }
    return out;
  }, [localDB]);

  const [vals, setVals] = useState<Record<string, string>>({});
  useEffect(() => {
    const seeded: Record<string, string> = {};
    for (const f of FIELDS) {
      const v = latest[f.key];
      seeded[f.key] = v ? (f.circ ? u.dispHeight(v, 1) : String(v)) : '';
    }
    setVals(seeded);
  }, [latest, u.system]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (key: MeasureKey, circ: boolean) => {
    const raw = (vals[key] ?? '').trim();
    if (!raw) return;
    const n = parseFloat(raw);
    if (!(n > 0)) return;
    updateDayRecord(todayStr, { [key]: circ ? Number(u.toStoredHeight(n).toFixed(2)) : n });
  };

  return (
    <div className="mt-4 pt-4 border-t border-[var(--line)]">
      <div className="flex items-baseline justify-between mb-2">
        <span className="que-label !mb-0">Measurements</span>
        <span className="font-mono text-[8px] text-[var(--ink-3)] tracking-[0.5px] uppercase">Optional · update anytime</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {FIELDS.map(({ key, label, circ }) => (
          <div key={key}>
            <label className="que-label !text-[8px]">{label} / {circ ? u.heightUnit : '%'}</label>
            <input
              type="number" inputMode="decimal" className="que-input"
              value={vals[key] ?? ''}
              onChange={e => setVals(v => ({ ...v, [key]: e.target.value }))}
              onBlur={() => commit(key, circ)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
