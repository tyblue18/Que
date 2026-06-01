/**
 * lib/syncEngine.ts — Cloud Sync for Que
 *
 * Strategy:
 *  • localStorage is the primary source of truth (offline-first).
 *  • Every localDB change queues a debounced push (includes settings snapshot).
 *  • On app start (after localStorage hydration), pullFromCloud() is called.
 *    Remote data is merged in — remote wins, so the most recently-synced device wins.
 *  • Transient failures retry silently (2× with backoff). A push that still
 *    fails surfaces a persistent "couldn't save — Retry" banner and is held in
 *    lastFailedDB for re-send; the app keeps working offline either way.
 *
 * Debounce: 4 s — prevents hitting the API on every keystroke.
 */

export type SyncPayload = {
  localDB?:  Record<string, unknown>;
  profile?:  Record<string, unknown>;
  settings?: Record<string, unknown>;
};

type SyncStatus = 'idle' | 'syncing' | 'error' | 'ok';

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingLocalDB: Record<string, unknown> = {};
let _status: SyncStatus = 'idle';

// Days whose push terminally failed (after retries). Held in memory so the user
// can hit "Retry" and we re-send the exact data instead of losing it. The data
// itself is still safe in localStorage; this just remembers WHICH days need a
// re-push, since pendingLocalDB was already drained when the failed push fired.
let lastFailedDB: Record<string, unknown> = {};

const DEBOUNCE_MS = 4_000;

import {
  ATHLETE_PLAN_KEY, PLAN_HISTORY_KEY, WORKOUT_PRESETS_KEY, TEMPLATES_KEY, EXERCISE_USAGE_KEY,
  CUSTOM_EXERCISES_KEY,
  LAST_STREAK_KEY, LIFT_PRS_KEY, MILLION_GROUPS_KEY, MACRO_GOALS_KEY,
  COIN_KEY, PROFILE_PHOTO_KEY, UNITS_KEY, DB_KEY, PENDING_BADGE_POPUPS_KEY,
  LIFTING_PROGRAM_KEY,
} from '@/lib/constants';
import { trackEvent } from '@/lib/telemetry';

type EarnedBadge = { slug: string; label: string; icon: string; category: string };

/**
 * Server-confirmed badges arrive exactly once (the API drains them from Redis
 * with getdel). A bare DOM event is lost if no listener is mounted at that
 * instant — a frozen PWA tab, a background sync, or a render race all drop it,
 * and the badge is gone from Redis forever. So we PERSIST them to a localStorage
 * queue first, then fire the event as a wake-up. BadgeCelebration drains the
 * queue on the event AND on every mount, so a missed event still surfaces the
 * popup the next time the app opens. Dedup against already-shown popups happens
 * in BadgeCelebration via queShownBadgePopups.
 */
function enqueueBadgePopups(badges: EarnedBadge[]): void {
  if (typeof window === 'undefined' || !badges?.length) return;
  try {
    const raw      = localStorage.getItem(PENDING_BADGE_POPUPS_KEY);
    const existing = raw ? (JSON.parse(raw) as EarnedBadge[]) : [];
    const bySlug   = new Map(existing.map(b => [b.slug, b]));
    for (const b of badges) bySlug.set(b.slug, b);
    localStorage.setItem(PENDING_BADGE_POPUPS_KEY, JSON.stringify([...bySlug.values()]));
  } catch { /* storage full — the event below still delivers for the live case */ }
  window.dispatchEvent(new CustomEvent('que-badge-earned', { detail: badges }));
}

// All localStorage keys that belong in the synced "settings" blob
const SETTINGS_KEYS = [
  ATHLETE_PLAN_KEY,        // cut/bulk plan
  PLAN_HISTORY_KEY,        // archive of past plans (the journey)
  WORKOUT_PRESETS_KEY,     // saved workout presets
  TEMPLATES_KEY,           // custom templates
  EXERCISE_USAGE_KEY,      // exercise frequency (for sorting)
  CUSTOM_EXERCISES_KEY,    // user-added exercises + the muscles they hit
  LAST_STREAK_KEY,         // calorie streak
  LIFT_PRS_KEY,            // all-time lift maxes — read by badge engine server-side
  MILLION_GROUPS_KEY,      // muscle groups that have crossed 1,000,000 lbs lifetime volume
  MACRO_GOALS_KEY,         // macro targets — sync across devices
  COIN_KEY,                // coin balance — used for battle wagering later
  PROFILE_PHOTO_KEY,       // profile photo URL (Vercel Blob) or base64 fallback
  UNITS_KEY,               // imperial/metric display preference — synced across devices
  LIFTING_PROGRAM_KEY,     // structured lifting program (split + prescribed sets/reps)
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads all synced settings keys from localStorage and returns them as an object.
 * Included in every push so settings are always up-to-date on every device.
 */
export function gatherSettings(): Record<string, unknown> {
  if (typeof window === 'undefined') return {};
  const out: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    try { out[key] = JSON.parse(raw); }
    catch { out[key] = raw; } // keep as string if not valid JSON
  }
  // Stamp the device's current UTC offset (minutes; local = UTC − offset) so the
  // server-side reminder crons can resolve each user's LOCAL date and hour —
  // e.g. fire the food-log nudge at ~8pm local and check the right day's data.
  out.queTzOffset = new Date().getTimezoneOffset();
  return out;
}

/**
 * Restores all settings keys from a remote settings object into localStorage
 * and fires any necessary events (e.g. profile photo change).
 */
export function restoreSettings(settings: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  for (const [key, val] of Object.entries(settings)) {
    if (val === null || val === undefined) continue;
    try {
      const str = typeof val === 'string' ? val : JSON.stringify(val);
      localStorage.setItem(key, str);
    } catch { /* storage full */ }
  }
  if (settings[PROFILE_PHOTO_KEY]) {
    window.dispatchEvent(new Event('queProfilePhotoChanged'));
  }
  // Let UI that derives from synced settings (e.g. the WorkoutLogger exercise
  // picker, which reads usage + custom exercises) recompute now that the
  // restore has landed — otherwise cross-device additions wouldn't appear until
  // an unrelated state change.
  window.dispatchEvent(new Event('que-settings-restored'));
}

/**
 * Queue a debounced push. Always includes a fresh settings snapshot so
 * profile photo, presets, and plan stay in sync across devices.
 */
export function queueSync(payload: SyncPayload): void {
  if (typeof window === 'undefined') return;
  // Accumulate localDB days so rapid successive calls don't lose earlier data
  if (payload.localDB) {
    pendingLocalDB = { ...pendingLocalDB, ...payload.localDB };
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void _push({ localDB: pendingLocalDB, settings: gatherSettings() });
    pendingLocalDB = {};
    debounceTimer = null;
  }, DEBOUNCE_MS);
}

/**
 * Immediate push — bypasses debounce. Drains any accumulated pending data too.
 * Use for photo uploads, preset saves, and other one-shot settings changes.
 */
export function pushNow(payload: SyncPayload): void {
  if (typeof window === 'undefined') return;
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  void _push({
    localDB: { ...pendingLocalDB, ...(payload.localDB ?? {}) },
    settings: { ...gatherSettings(), ...(payload.settings ?? {}) },
  });
  pendingLocalDB = {};
}

/**
 * Flush any pending debounced sync immediately (e.g. on visibilitychange).
 * No-op if nothing is queued.
 */
export function flushPending(): void {
  if (!debounceTimer && Object.keys(pendingLocalDB).length === 0) return;
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  void _push({ localDB: pendingLocalDB, settings: gatherSettings() });
  pendingLocalDB = {};
}

/**
 * Pull the latest cloud snapshot.
 * Returns null if not authenticated or network is unavailable.
 * Also fires que-badge-earned if the server had pending badges from a prior push's after().
 */
export async function pullFromCloud(): Promise<SyncPayload | null> {
  if (typeof window === 'undefined') return null;
  try {
    const res = await fetch('/api/sync', { credentials: 'include' });
    if (res.status === 401) return null;
    if (!res.ok) return null;
    const json = await res.json() as SyncPayload & {
      newBadges?: Array<{ slug: string; label: string; icon: string; category: string }>;
    };
    if (json.newBadges?.length) {
      enqueueBadgePopups(json.newBadges);
    }
    return json;
  } catch {
    return null;
  }
}

export function getSyncStatus(): SyncStatus { return _status; }

/** True if a previous push terminally failed and its data is still unsaved on
 *  the server. Drives the persistent "couldn't save" banner + Retry button. */
export function hasFailedSync(): boolean {
  return Object.keys(lastFailedDB).length > 0;
}

/**
 * Re-push the data from the last failed sync (plus anything queued since).
 * User-initiated via the Retry button, and auto-fired on reconnect. Clears the
 * failed set optimistically; if it fails again, _push repopulates it.
 */
export function retrySync(): void {
  if (typeof window === 'undefined') return;
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  const localDB = { ...lastFailedDB, ...pendingLocalDB };
  lastFailedDB   = {};
  pendingLocalDB = {};
  void _push({ localDB, settings: gatherSettings() });
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL
// ─────────────────────────────────────────────────────────────────────────────

function dispatch(status: SyncStatus) {
  _status = status;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('que-sync', { detail: status }));
  }
}

async function _push(payload: SyncPayload, attempt = 0): Promise<void> {
  dispatch('syncing');
  try {
    const res  = await fetch('/api/sync', {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify(payload),
    });

    if (res.ok) {
      const json = await res.json() as {
        syncedAt?:      string;
        conflicts?:     Array<{ date: string; data: unknown; deferred?: boolean; attempts?: number }>;
        newBadges?:     Array<{ slug: string; label: string; icon: string; category: string }>;
        revokedBadges?: Array<{ slug: string; label: string; icon: string; category: string }>;
        newCoins?:      Array<{ date: string; coins: number }>;
        walletBalance?: number;
      };
      if (json.conflicts?.length) {
        // Two kinds (see /api/sync): a MERGE conflict carries the server's merged
        // day → adopt it into localStorage. A DEFERRED one (deferred: true) carries
        // NO data → we must NOT touch localStorage for it (the user's pending edit
        // is still there and must re-send unchanged). Only merge conflicts are
        // written back here; both kinds are passed to AppContext, which keeps a
        // deferred date dirty so the debounced sync retries it.
        try {
          const raw = localStorage.getItem(DB_KEY);
          const db  = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
          let wrote = false;
          for (const { date, data, deferred, attempts } of json.conflicts) {
            if (deferred) {
              // Server-truth observability for the one silent path: it gave up a
              // day's write after `attempts` CAS losses. Astronomically rare;
              // the date + count let a future spike read as one-date-hammered
              // (client loop) vs. scattered (genuine contention we under-modeled).
              trackEvent('sync_deferred', { date, attempts: attempts ?? 0 });
              continue;                       // leave the pending edit untouched
            }
            db[date] = data;
            wrote = true;
          }
          if (wrote) localStorage.setItem(DB_KEY, JSON.stringify(db));
          window.dispatchEvent(new CustomEvent('que-conflict', { detail: json.conflicts }));
        } catch { /* storage full — skip */ }
      }
      if (json.newBadges?.length) {
        enqueueBadgePopups(json.newBadges);
      }
      if (json.revokedBadges?.length) {
        window.dispatchEvent(new CustomEvent('que-badges-revoked', { detail: json.revokedBadges }));
      }
      if (json.newCoins?.length) {
        // Server confirmed these dates — add them to queCalorieCoins.awardedDates
        // so the client never double-shows the coin animation.
        try {
          const stored = JSON.parse(localStorage.getItem(COIN_KEY) ?? 'null')
            ?? { total: 0, awardedDates: [] };
          const known = new Set<string>(stored.awardedDates);
          for (const { date } of json.newCoins) known.add(date);
          localStorage.setItem(COIN_KEY, JSON.stringify({ ...stored, awardedDates: Array.from(known) }));
        } catch { /* storage full */ }
        window.dispatchEvent(new CustomEvent('que-coins-awarded', {
          detail: { newCoins: json.newCoins, walletBalance: json.walletBalance },
        }));
      }
      // Notify AppContext to stamp _syncedAt on the pushed dates so subsequent
      // pushes in the same session don't trigger false conflicts. Use the
      // server-supplied timestamp — the client's clock may be skewed, and
      // server-side conflict detection now rejects future-dated client claims.
      if (payload.localDB && Object.keys(payload.localDB).length > 0) {
        const syncedAt = json.syncedAt ?? new Date().toISOString();
        window.dispatchEvent(new CustomEvent('que-sync-ack', {
          detail: { dates: Object.keys(payload.localDB), syncedAt },
        }));
      }
      lastFailedDB = {}; // this push (and any earlier failures it carried) landed
      dispatch('ok');
    } else if (res.status === 401 || res.status === 429) {
      // Auth failure or rate limit — don't auto-retry, but keep the data so the
      // user can Retry (after re-auth / once the limit clears).
      rememberFailure(payload);
      dispatch('error');
    } else if (attempt < 2) {
      // Server error — retry with backoff (3s, then 9s).
      // Re-gather settings so a weight correction between failure and retry
      // uses the current queLiftPRs, not the stale value from the original push.
      const retryPayload = { ...payload, settings: gatherSettings() };
      setTimeout(() => void _push(retryPayload, attempt + 1), 3000 * (attempt + 1));
    } else {
      rememberFailure(payload);
      dispatch('error');
    }
  } catch {
    // Network error — retry with backoff (3s, then 9s)
    if (attempt < 2) {
      const retryPayload = { ...payload, settings: gatherSettings() };
      setTimeout(() => void _push(retryPayload, attempt + 1), 3000 * (attempt + 1));
    } else {
      rememberFailure(payload);
      dispatch('error');
    }
  }
}

/** Remember the days a terminally-failed push was carrying so Retry can re-send
 *  them. Accumulates across failures so a second failing push can't drop the
 *  first's unsaved days. */
function rememberFailure(payload: SyncPayload): void {
  if (payload.localDB) lastFailedDB = { ...lastFailedDB, ...payload.localDB };
}
