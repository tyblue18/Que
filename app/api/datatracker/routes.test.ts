/**
 * app/api/datatracker/routes.test.ts
 *
 * The tracker-connection surface across all three routes: session auth, the
 * SSRF guard on user-supplied URLs, verify-before-save on connect (a rejected
 * secret must never persist), the auto-provision handover, the health probe on
 * status, sync triggering (incl. ?full=1 resend), and the metrics proxy.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sessionUserId: 'u1' as string | null,
  rlSuccess: true,
  connection: null as { baseUrl: string; secret: string; lastSyncAt: Date | null } | null,
  settings: { stepApiToken: 'tok-abc' } as Record<string, unknown>,
  // Programmable fake tracker: path → responder.
  fetches: [] as Array<{ url: string; method: string; body: unknown }>,
  respond: {} as Record<string, { status: number; body?: unknown }>,
}));

vi.mock('next-auth/next', () => ({
  getServerSession: async () => (h.sessionUserId ? { user: { id: h.sessionUserId } } : null),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/ratelimit', () => ({
  dataTrackerLimit:     { limit: async () => ({ success: h.rlSuccess }) },
  dataTrackerSyncLimit: { limit: async () => ({ success: h.rlSuccess }) },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    dataTrackerConnection: {
      findUnique: async () => h.connection,
      upsert: async (args: { create: { baseUrl: string; secret: string } }) => {
        h.connection = { ...args.create, lastSyncAt: null };
        return h.connection;
      },
      deleteMany: async () => { h.connection = null; return { count: 1 }; },
      update: async (args: { data: { lastSyncAt: Date } }) => {
        if (h.connection) h.connection.lastSyncAt = args.data.lastSyncAt;
        return h.connection;
      },
    },
    workoutData: {
      findUnique: async () => ({ userId: 'u1', settings: h.settings }),
      upsert: async (args: { update: { settings: Record<string, unknown> } }) => {
        h.settings = args.update.settings; return {};
      },
    },
  },
}));

import { GET, POST, DELETE } from '@/app/api/datatracker/route';
import { POST as SYNC }      from '@/app/api/datatracker/sync/route';
import { GET as METRICS }    from '@/app/api/datatracker/metrics/route';

const jreq = (body: unknown) =>
  new Request('http://localhost/api/datatracker', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.sessionUserId = 'u1';
  h.rlSuccess = true;
  h.connection = null;
  h.settings = { stepApiToken: 'tok-abc' };
  h.fetches = [];
  h.respond = {
    '/api/snapshot':   { status: 200, body: { fitness_fatigue: [] } },
    '/api/que-config': { status: 200, body: { ok: true } },
    '/api/health':     { status: 200, body: { ok: true, garmin_tokens: 1, counts: { last_activity: '2026-08-17' }, que_push_configured: true } },
    '/api/sync':       { status: 200, body: { activities: 2, que: { sent: 2 } } },
  };
  process.env.NEXTAUTH_URL = 'https://que.test';
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const key = u.pathname;
    h.fetches.push({ url: String(url), method: init?.method ?? 'GET',
                     body: init?.body ? JSON.parse(String(init.body)) : null });
    const r = h.respond[key] ?? { status: 404, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status, headers: { 'content-type': 'application/json' },
    });
  });
});

describe('POST /api/datatracker (connect)', () => {
  it('requires a session', async () => {
    h.sessionUserId = null;
    expect((await POST(jreq({ baseUrl: 'https://t.test', secret: 's' }))).status).toBe(401);
  });

  it('SSRF guard: refuses private/loopback/http URLs with 400, no fetch made', async () => {
    for (const baseUrl of ['http://tracker.test', 'https://localhost:3000', 'https://192.168.1.10', 'https://169.254.169.254']) {
      const res = await POST(jreq({ baseUrl, secret: 's' }));
      expect(res.status).toBe(400);
    }
    expect(h.fetches).toHaveLength(0);
    expect(h.connection).toBeNull();
  });

  it('verify-before-save: a rejected secret is NEVER persisted', async () => {
    h.respond['/api/snapshot'] = { status: 401 };
    const res = await POST(jreq({ baseUrl: 'https://tracker.test', secret: 'bad' }));
    expect(res.status).toBe(401);
    expect(h.connection).toBeNull();
  });

  it('connect verifies, saves the canonical origin, and auto-provisions the push', async () => {
    const res = await POST(jreq({ baseUrl: 'https://tracker.test/some/path?x=1', secret: 's3cret' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.baseUrl).toBe('https://tracker.test'); // canonicalised origin
    expect(body.pushProvisioned).toBe(true);
    expect(h.connection?.secret).toBe('s3cret');
    const prov = h.fetches.find(f => f.url.includes('/api/que-config'))!;
    expect(prov.body).toEqual({ activityUrl: 'https://que.test/api/health/activity', token: 'tok-abc' });
  });

  it('an older tracker without /api/que-config still connects (provision is best-effort)', async () => {
    delete h.respond['/api/que-config'];
    const res = await POST(jreq({ baseUrl: 'https://tracker.test', secret: 's' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.pushProvisioned).toBe(false);
  });
});

describe('GET /api/datatracker (status)', () => {
  it('reports not-connected without probing anything', async () => {
    const body = await (await GET()).json();
    expect(body.connected).toBe(false);
    expect(h.fetches).toHaveLength(0);
  });

  it('probes the tracker health when connected, and survives a dead tracker', async () => {
    h.connection = { baseUrl: 'https://tracker.test', secret: 's', lastSyncAt: null };
    const body = await (await GET()).json();
    expect(body.health).toEqual({ ok: true, garminTokens: 1, lastActivity: '2026-08-17', quePushConfigured: true });

    h.respond['/api/health'] = { status: 500 };
    const dead = await (await GET()).json();
    expect(dead.connected).toBe(true);   // status still works
    expect(dead.health).toBeNull();      // probe failure is non-fatal
  });
});

describe('POST /api/datatracker/sync', () => {
  it('400s without a connection', async () => {
    expect((await SYNC(new Request('http://localhost/api/datatracker/sync', { method: 'POST' }))).status).toBe(400);
  });

  it('triggers the tracker sync, stamps lastSyncAt, and relays the result', async () => {
    h.connection = { baseUrl: 'https://tracker.test', secret: 's', lastSyncAt: null };
    const res = await SYNC(new Request('http://localhost/api/datatracker/sync', { method: 'POST' }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.que.sent).toBe(2);
    expect(h.connection.lastSyncAt).toBeInstanceOf(Date);
    expect(h.fetches[0].url).toBe('https://tracker.test/api/sync');
  });

  it('?full=1 asks the tracker for a wide resend (the backfill path)', async () => {
    h.connection = { baseUrl: 'https://tracker.test', secret: 's', lastSyncAt: null };
    h.respond['/api/sync'] = { status: 200, body: { ok: true } };
    await SYNC(new Request('http://localhost/api/datatracker/sync?full=1', { method: 'POST' }));
    expect(h.fetches[0].url).toBe('https://tracker.test/api/sync?resend=true&days=120');
  });
});

describe('GET /api/datatracker/metrics', () => {
  it('proxies the snapshot server-side (secret never reaches the browser)', async () => {
    h.connection = { baseUrl: 'https://tracker.test', secret: 's', lastSyncAt: null };
    const body = await (await METRICS()).json();
    expect(body.ok).toBe(true);
    expect(body.snapshot).toEqual({ fitness_fatigue: [] });
    expect(JSON.stringify(body)).not.toContain('"secret"');
  });
});
