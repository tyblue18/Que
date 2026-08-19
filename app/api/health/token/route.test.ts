/**
 * app/api/health/token/route.test.ts
 *
 * The personal token lifecycle: session auth, first-call generation +
 * persistence, GET stability (same token back), POST rotation (new token,
 * old invalidated), and the rotate → tracker re-provision handshake.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sessionUserId: 'u1' as string | null,
  settings: {} as Record<string, unknown>,
  connection: null as { baseUrl: string; secret: string } | null,
  provisionCalls: [] as Array<{ url: string; body: unknown }>,
}));

vi.mock('next-auth/next', () => ({
  getServerSession: async () => (h.sessionUserId ? { user: { id: h.sessionUserId } } : null),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    workoutData: {
      findUnique: async () => ({ userId: 'u1', settings: h.settings }),
      upsert: async (args: { update: { settings: Record<string, unknown> } }) => {
        h.settings = args.update.settings;
        return {};
      },
    },
    dataTrackerConnection: {
      findUnique: async () => h.connection,
    },
  },
}));

import { GET, POST } from '@/app/api/health/token/route';

beforeEach(() => {
  h.sessionUserId = 'u1';
  h.settings = {};
  h.connection = null;
  h.provisionCalls = [];
  process.env.NEXTAUTH_URL = 'https://que.test';
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    h.provisionCalls.push({ url: String(url), body: JSON.parse(String(init?.body ?? 'null')) });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

describe('/api/health/token', () => {
  it('requires a session', async () => {
    h.sessionUserId = null;
    expect((await GET()).status).toBe(401);
    expect((await POST()).status).toBe(401);
  });

  it('GET generates once, persists, and returns the same token thereafter', async () => {
    const first = await (await GET()).json();
    expect(first.token).toMatch(/^[0-9a-f]{48}$/);
    expect(first.activityEndpoint).toBe('https://que.test/api/health/activity');
    expect(h.settings.stepApiToken).toBe(first.token); // persisted
    const second = await (await GET()).json();
    expect(second.token).toBe(first.token);            // stable
  });

  it('POST rotates: a new token replaces the old one', async () => {
    const before = (await (await GET()).json()).token;
    const after = await (await POST()).json();
    expect(after.token).toMatch(/^[0-9a-f]{48}$/);
    expect(after.token).not.toBe(before);
    expect(h.settings.stepApiToken).toBe(after.token);  // old token dead
    expect(after.trackerReprovisioned).toBe(false);     // no tracker connected
  });

  it('POST re-provisions a connected tracker with the NEW token', async () => {
    h.connection = { baseUrl: 'https://tracker.test', secret: 's3cret' };
    const res = await (await POST()).json();
    expect(res.trackerReprovisioned).toBe(true);
    expect(h.provisionCalls).toHaveLength(1);
    expect(h.provisionCalls[0].url).toBe('https://tracker.test/api/que-config');
    expect(h.provisionCalls[0].body).toEqual({
      activityUrl: 'https://que.test/api/health/activity',
      token: res.token, // the rotated token, not the old one
    });
  });
});
