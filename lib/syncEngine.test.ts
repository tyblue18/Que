/**
 * lib/syncEngine.test.ts
 *
 * Locks the sync-failure RECOVERY contract — the data-safety guarantee that a
 * push which fails doesn't silently lose the user's unsaved days:
 *   • transient 5xx retries twice, then remembers the failed days (hasFailedSync)
 *   • 401 doesn't retry but is still remembered for a manual Retry
 *   • retrySync() re-sends the remembered days and clears the failed state on success
 *   • a clean success leaves no failed state
 *
 * syncEngine is browser-coupled (window/localStorage/fetch), so we stub those +
 * fake timers, and reset the module between tests so its in-memory state is fresh.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let store: Record<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;
let dispatched: Array<{ type: string; detail: unknown }>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  store = {};
  dispatched = [];
  vi.stubGlobal('localStorage', {
    getItem:    (k: string) => store[k] ?? null,
    setItem:    (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
  vi.stubGlobal('window', {
    dispatchEvent: (e: { type: string; detail?: unknown }) => { dispatched.push({ type: e.type, detail: e.detail }); return true; },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal('CustomEvent', class { type: string; detail: unknown; constructor(t: string, i?: { detail?: unknown }) { this.type = t; this.detail = i?.detail; } });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function resp(status: number, body: unknown = {}) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
}
const loadSync = () => import('@/lib/syncEngine');
const day = (d: string) => ({ localDB: { [d]: { weight: '180' } } });

describe('sync failure recovery', () => {
  it('retries a 5xx twice then remembers the failed days', async () => {
    fetchMock.mockReturnValue(resp(500));
    const sync = await loadSync();
    sync.pushNow(day('2026-01-01'));
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(sync.hasFailedSync()).toBe(true);
    expect(sync.getSyncStatus()).toBe('error');
    expect(dispatched.some(d => d.type === 'que-sync' && d.detail === 'error')).toBe(true);
  });

  it('does not retry a 401 but still remembers it for manual retry', async () => {
    fetchMock.mockReturnValue(resp(401));
    const sync = await loadSync();
    sync.pushNow(day('2026-01-02'));
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
    expect(sync.hasFailedSync()).toBe(true);
  });

  it('retrySync re-sends the remembered days and clears on success', async () => {
    fetchMock.mockReturnValue(resp(500));
    const sync = await loadSync();
    sync.pushNow(day('2026-01-03'));
    await vi.runAllTimersAsync();
    expect(sync.hasFailedSync()).toBe(true);

    fetchMock.mockReturnValue(resp(200, { syncedAt: '2026-01-03T00:00:00Z' }));
    sync.retrySync();
    await vi.runAllTimersAsync();

    expect(sync.hasFailedSync()).toBe(false);
    expect(sync.getSyncStatus()).toBe('ok');
    // The retry actually re-sent the day that had failed.
    const lastBody = JSON.parse((fetchMock.mock.calls.at(-1)![1] as { body: string }).body);
    expect(lastBody.localDB['2026-01-03']).toBeTruthy();
  });

  it('a clean success leaves no failed state', async () => {
    fetchMock.mockReturnValue(resp(200, { syncedAt: 'x' }));
    const sync = await loadSync();
    sync.pushNow(day('2026-01-04'));
    await vi.runAllTimersAsync();

    expect(sync.hasFailedSync()).toBe(false);
    expect(sync.getSyncStatus()).toBe('ok');
  });
});
