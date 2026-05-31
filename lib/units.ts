'use client';

/**
 * lib/units.ts
 *
 * Display/input unit system (imperial ↔ metric). Storage stays CANONICAL and
 * imperial everywhere — body weight in lb, height in inches, distances in miles
 * — so every formula (Mifflin BMR, ACSM/MET cardio, battle scoring, plan math)
 * is untouched and no data migration is needed. We only convert at the UI edge:
 *
 *   • display: fromStored*(canonical) → number shown to the user
 *   • input:   toStored*(typed)       → canonical number we persist
 *
 * The preference lives in localStorage (UNITS_KEY), syncs across devices via the
 * settings blob, and broadcasts `que-units-changed` so every mounted screen
 * re-renders in the chosen system.
 */

import { useCallback, useEffect, useState } from 'react';
import { UNITS_KEY } from '@/lib/constants';
import { queueSync, gatherSettings } from '@/lib/syncEngine';

export type UnitSystem = 'imperial' | 'metric';

// Exact-ish conversion constants.
const LB_PER_KG = 2.2046226218;
const KM_PER_MI = 1.609344;
const CM_PER_IN = 2.54;

// ── raw conversions ──────────────────────────────────────────────────────────
export const lbToKg = (lb: number) => lb / LB_PER_KG;
export const kgToLb = (kg: number) => kg * LB_PER_KG;
export const miToKm = (mi: number) => mi * KM_PER_MI;
export const kmToMi = (km: number) => km / KM_PER_MI;
export const inToCm = (inch: number) => inch * CM_PER_IN;
export const cmToIn = (cm: number) => cm / CM_PER_IN;

// ── labels ───────────────────────────────────────────────────────────────────
export const weightUnit   = (s: UnitSystem) => (s === 'metric' ? 'kg' : 'lb');
export const heightUnit   = (s: UnitSystem) => (s === 'metric' ? 'cm' : 'in');
export const distanceUnit = (s: UnitSystem) => (s === 'metric' ? 'km' : 'mi');

// ── stored (imperial) → display ───────────────────────────────────────────────
export const fromStoredWeight   = (lb: number, s: UnitSystem) => (s === 'metric' ? lbToKg(lb) : lb);
export const fromStoredHeight   = (inch: number, s: UnitSystem) => (s === 'metric' ? inToCm(inch) : inch);
export const fromStoredDistance = (mi: number, s: UnitSystem) => (s === 'metric' ? miToKm(mi) : mi);

// ── display (typed) → stored (imperial) ───────────────────────────────────────
export const toStoredWeight   = (v: number, s: UnitSystem) => (s === 'metric' ? kgToLb(v) : v);
export const toStoredHeight   = (v: number, s: UnitSystem) => (s === 'metric' ? cmToIn(v) : v);
export const toStoredDistance = (v: number, s: UnitSystem) => (s === 'metric' ? kmToMi(v) : v);

// ── formatting (stored value in → "72.6 kg" out) ──────────────────────────────
function trimNum(n: number, digits: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = n.toFixed(digits);
  return r.replace(/\.?0+$/, ''); // 72.0 → "72", 72.60 → "72.6"
}
export const fmtWeight = (lb: number, s: UnitSystem, digits = 1) =>
  `${trimNum(fromStoredWeight(lb, s), digits)} ${weightUnit(s)}`;
export const fmtDistance = (mi: number, s: UnitSystem, digits = 1) =>
  `${trimNum(fromStoredDistance(mi, s), digits)} ${distanceUnit(s)}`;

/** Display number only (no unit), rounded — for prefilling inputs. */
export const dispWeight   = (lb: number, s: UnitSystem, digits = 1) => trimNum(fromStoredWeight(lb, s), digits);
export const dispHeight   = (inch: number, s: UnitSystem, digits = 0) => trimNum(fromStoredHeight(inch, s), digits);
export const dispDistance = (mi: number, s: UnitSystem, digits = 2) => trimNum(fromStoredDistance(mi, s), digits);

// ── preference storage ─────────────────────────────────────────────────────────
export function loadUnits(): UnitSystem {
  if (typeof window === 'undefined') return 'imperial';
  return localStorage.getItem(UNITS_KEY) === 'metric' ? 'metric' : 'imperial';
}

/** Best-guess default for a brand-new user (US/Liberia/Myanmar → imperial). Used
 *  only to seed the onboarding toggle; existing users keep their saved choice. */
export function detectDefaultUnits(): UnitSystem {
  if (typeof navigator === 'undefined') return 'imperial';
  const lang = (navigator.language || 'en-US').toLowerCase();
  return /^(en-us|en-lr|my)/.test(lang) ? 'imperial' : 'metric';
}

export function setUnits(system: UnitSystem): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(UNITS_KEY, system); } catch { /* quota */ }
  window.dispatchEvent(new CustomEvent('que-units-changed', { detail: system }));
  queueSync({ settings: gatherSettings() }); // persist the preference across devices
}

/**
 * Reactive accessor. Re-reads on `que-units-changed` (this device) and
 * `que-settings-restored` (a cloud pull from another device). Returns the
 * current system, a setter, and helpers already bound to the system so call
 * sites read `u.fmtWeight(lb)` without threading the system through.
 */
export function useUnits() {
  const [system, setSystem] = useState<UnitSystem>('imperial');

  useEffect(() => {
    setSystem(loadUnits());
    const refresh = () => setSystem(loadUnits());
    window.addEventListener('que-units-changed', refresh);
    window.addEventListener('que-settings-restored', refresh);
    return () => {
      window.removeEventListener('que-units-changed', refresh);
      window.removeEventListener('que-settings-restored', refresh);
    };
  }, []);

  const change = useCallback((s: UnitSystem) => { setUnits(s); setSystem(s); }, []);

  return {
    system,
    isMetric: system === 'metric',
    setSystem: change,
    weightUnit:   weightUnit(system),
    heightUnit:   heightUnit(system),
    distanceUnit: distanceUnit(system),
    fromStoredWeight:   (lb: number)   => fromStoredWeight(lb, system),
    fromStoredHeight:   (inch: number) => fromStoredHeight(inch, system),
    fromStoredDistance: (mi: number)   => fromStoredDistance(mi, system),
    toStoredWeight:   (v: number) => toStoredWeight(v, system),
    toStoredHeight:   (v: number) => toStoredHeight(v, system),
    toStoredDistance: (v: number) => toStoredDistance(v, system),
    fmtWeight:   (lb: number, d?: number) => fmtWeight(lb, system, d),
    fmtDistance: (mi: number, d?: number) => fmtDistance(mi, system, d),
    dispWeight:   (lb: number, d?: number)   => dispWeight(lb, system, d),
    dispHeight:   (inch: number, d?: number) => dispHeight(inch, system, d),
    dispDistance: (mi: number, d?: number)   => dispDistance(mi, system, d),
  };
}
