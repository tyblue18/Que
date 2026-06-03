/**
 * lib/shareWorkout.ts
 *
 * Builds the shareable summary/payload for a day's workout — the SINGLE source
 * used both by the group feed's share sheet AND the post-commit "share to your
 * groups" prompt, so what gets posted always matches what the feed renders.
 *
 * Pure (no React) so it can be unit-tested and reused anywhere.
 */

import type { DayRecord, ExerciseEntry } from '@/lib/AppContext';

export interface CardioSeg { kind: 'run' | 'bike' | 'swim'; dist: number; time: number }
export interface WorkoutItem { kind: 'lift' | 'run' | 'bike' | 'swim'; name: string; detail: string; group: string }
export interface DaySummary {
  title: string;
  items: WorkoutItem[];
  lines: string[];
  exercises: string;
  liftCount: number;
  setCount: number;
  volume: number;
  cardio: CardioSeg[];
  hasContent: boolean;
}

export const num = (v: unknown): number => {
  const n = parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
};

/** Build a structured, shareable summary + raw exercises from a day's record. */
export function summarizeDay(rec: DayRecord | undefined): DaySummary {
  const empty: DaySummary = { title: '', items: [], lines: [], exercises: '[]', liftCount: 0, setCount: 0, volume: 0, cardio: [], hasContent: false };
  if (!rec) return empty;
  let exs: ExerciseEntry[] = [];
  try { exs = JSON.parse(rec.exercises ?? '[]'); } catch { /* corrupt */ }
  const lifts  = Array.isArray(exs) ? exs.filter(e => e.k === 'lift') : [];
  const groups = new Set<string>();
  const items: WorkoutItem[] = [];
  const lines: string[] = [];
  let setCount = 0;
  let volume = 0;
  for (const ex of lifts) {
    if (ex.g) groups.add(ex.g);
    const sets = Array.isArray(ex.sets) && ex.sets.length
      ? ex.sets
      : (ex.s ? Array.from({ length: parseInt(ex.s) || 1 }, () => ({ r: ex.r ?? '', w: ex.w ?? '' })) : []);
    setCount += sets.length;
    volume += sets.reduce((sum, s) => sum + (parseFloat(String(s.r ?? '')) || 0) * (parseFloat(String(s.w ?? '')) || 0), 0);
    const detail = sets.length ? sets.map(s => (s.w ? `${s.r}×${s.w}` : `${s.r}`)).filter(Boolean).join(', ') : '';
    const name = ex.n ?? 'Exercise';
    items.push({ kind: 'lift', name, detail, group: ex.g || 'Other' });
    lines.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
  const cardio: CardioSeg[] = [];
  const run = num(rec.runDist), runT = num(rec.runTime);
  if (run > 0) { items.push({ kind: 'run', name: 'Run', detail: `${run} mi${runT ? ` · ${runT} min` : ''}`, group: 'Cardio' }); lines.push(`Ran ${run} mi`); cardio.push({ kind: 'run', dist: run, time: runT }); }
  const bike = num(rec.bikeDist), bikeT = num(rec.bikeTime);
  if (bike > 0) { items.push({ kind: 'bike', name: 'Bike', detail: `${bike} mi${bikeT ? ` · ${bikeT} min` : ''}`, group: 'Cardio' }); lines.push(`Biked ${bike} mi`); cardio.push({ kind: 'bike', dist: bike, time: bikeT }); }
  const swim = num(rec.swimDist), swimT = num(rec.swimTime);
  if (swim > 0 || swimT > 0) { items.push({ kind: 'swim', name: 'Swim', detail: `${swim ? `${swim} mi` : ''}${swimT ? `${swim ? ' · ' : ''}${swimT} min` : ''}`, group: 'Cardio' }); lines.push('Swam'); cardio.push({ kind: 'swim', dist: swim, time: swimT }); }
  const title = groups.size ? Array.from(groups).slice(0, 3).join(' · ') : (items.length ? 'Workout' : '');
  return { title, items, lines, exercises: rec.exercises ?? '[]', liftCount: lifts.length, setCount, volume: Math.round(volume), cardio, hasContent: items.length > 0 };
}

/** The exact payload object posted to /api/posts (a subset of the summary). */
export function toPostPayload(s: DaySummary) {
  return {
    title: s.title, items: s.items, lines: s.lines, exercises: s.exercises,
    liftCount: s.liftCount, setCount: s.setCount, volume: s.volume, cardio: s.cardio,
  };
}
