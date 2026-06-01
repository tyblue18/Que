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

describe('conflict adoption — merge vs. deferred', () => {
  const D = '2026-02-01';
  const userEdit = { weight: '999', _fieldEditedAt: { weight: '2026-02-01T10:00:00Z' } };

  it('a MERGE conflict overwrites localStorage with the server merged day', async () => {
    const serverMerged = { weight: '180', foods: '[server]', _syncedAt: 'x' };
    fetchMock.mockReturnValue(resp(200, {
      syncedAt: 'x',
      conflicts: [{ date: D, data: serverMerged }], // no `deferred` → merge
    }));
    store[ 'ironmanCoreDB_v2' ] = JSON.stringify({ [D]: userEdit });
    const sync = await loadSync();
    sync.pushNow({ localDB: { [D]: userEdit } });
    await vi.runAllTimersAsync();

    const db = JSON.parse(store['ironmanCoreDB_v2']);
    expect(db[D]).toMatchObject(serverMerged); // adopted the server merge
  });

  it('GUARD: a DEFERRED conflict leaves the local edit UNTOUCHED (it must re-send)', async () => {
    fetchMock.mockReturnValue(resp(200, {
      syncedAt: 'x',
      conflicts: [{ date: D, data: null, deferred: true }],
    }));
    // The user's pending edit is in localStorage before the deferred response.
    store['ironmanCoreDB_v2'] = JSON.stringify({ [D]: userEdit });
    const sync = await loadSync();
    sync.pushNow({ localDB: { [D]: userEdit } });
    await vi.runAllTimersAsync();

    const db = JSON.parse(store['ironmanCoreDB_v2']);
    // Assertion 1 (the one doing the real work): localStorage still holds the
    // USER'S edit with its honest field-stamp — NOT overwritten with null/server
    // state. This fails against the old delete-and-overwrite behavior.
    expect(db[D]).toEqual(userEdit);
    expect(db[D]._fieldEditedAt.weight).toBe('2026-02-01T10:00:00Z'); // honest timestamp intact
  });

  it('passes the deferred flag through the que-conflict event (so AppContext keeps it dirty)', async () => {
    fetchMock.mockReturnValue(resp(200, {
      syncedAt: 'x',
      conflicts: [{ date: D, data: null, deferred: true }],
    }));
    store['ironmanCoreDB_v2'] = JSON.stringify({ [D]: userEdit });
    const sync = await loadSync();
    sync.pushNow({ localDB: { [D]: userEdit } });
    await vi.runAllTimersAsync();

    const evt = dispatched.find(d => d.type === 'que-conflict');
    expect(evt).toBeTruthy();
    const detail = evt!.detail as Array<{ date: string; deferred?: boolean }>;
    expect(detail[0]).toMatchObject({ date: D, deferred: true });
  });
});
