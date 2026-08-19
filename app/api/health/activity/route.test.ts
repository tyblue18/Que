/**
 * app/api/health/activity/route.test.ts
 *
 * Locks the HTTP wiring of the cardio push: bearer-token auth (the settings
 * lookup), Zod validation, the tz-aware default date, the applyActivity
 * write path (real engine — only IO is mocked), idempotent re-sends, and the
 * rate-limit gate. Prisma + the limiter are in-memory fakes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  TOKEN: 'tok-123',
  rlSuccess: true,
  days: new Map<string, { data: Record<string, unknown> }>(),
  upserts: 0,
}));

vi.mock('@/lib/ratelimit', () => ({
  activityLimit: { limit: async () => ({ success: h.rlSuccess }) },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    workoutData: {
      findFirst: async ({ where }: { where: { settings: { equals: string } } }) =>
        where.settings.equals === h.TOKEN
          ? { userId: 'u1', settings: { stepApiToken: h.TOKEN, queTzOffset: 0 } }
          : null,
    },
    dayRecord: {
      findUnique: async ({ where }: { where: { userId_date: { date: string } } }) =>
        h.days.get(where.userId_date.date) ?? null,
      upsert: async (args: { where: { userId_date: { date: string } };
                             create: { data: Record<string, unknown> };
                             update: { data: Record<string, unknown> } }) => {
        h.upserts++;
        h.days.set(args.where.userId_date.date, { data: args.update.data });
        return {};
      },
    },
  },
}));

import { POST } from '@/app/api/health/activity/route';

const req = (body: unknown, token: string | null = h.TOKEN) =>
  new Request('http://localhost/api/health/activity', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

beforeEach(() => { h.days.clear(); h.upserts = 0; h.rlSuccess = true; });

describe('POST /api/health/activity', () => {
  it('rejects a missing bearer token with 401', async () => {
    const res = await POST(req({ type: 'run', distance: 3, time: 25 }, null));
    expect(res.status).toBe(401);
  });

  it('rejects an unknown token with 401 and writes nothing', async () => {
    const res = await POST(req({ type: 'run', distance: 3, time: 25 }, 'wrong'));
    expect(res.status).toBe(401);
    expect(h.upserts).toBe(0);
  });

  it('rejects an invalid body with 400 (schema violation)', async () => {
    const res = await POST(req({ type: 'run', distance: 3 })); // no time
    expect(res.status).toBe(400);
  });

  it('writes a run through the real engine and reports the day totals', async () => {
    const res = await POST(req({ type: 'run', distance: 5, unit: 'km', time: 25, calories: 300, date: '2026-08-10', externalId: 'g1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.date).toBe('2026-08-10');
    expect(body.changed).toBe(true);
    expect(body.runDist).toBeCloseTo(3.11, 2); // km converted to stored miles
    const stored = h.days.get('2026-08-10')!.data;
    expect(stored.garminRunKcal).toBe(300);
    expect(stored.burn).toBe(300);
    expect(JSON.parse(String(stored.exercises))).toHaveLength(1); // calendar mirror
  });

  it('an identical re-send is a no-op: changed=false, no second upsert', async () => {
    const payload = { type: 'bike', distance: 20, time: 60, calories: 465, date: '2026-08-11', externalId: 'g2' };
    await POST(req(payload));
    expect(h.upserts).toBe(1);
    const res = await POST(req(payload));
    const body = await res.json();
    expect(body.changed).toBe(false);
    expect(h.upserts).toBe(1); // unchanged day never re-written
  });

  it('defaults the date to the user local today (tzOffset 0 → UTC date)', async () => {
    const res = await POST(req({ type: 'swim', time: 30 }));
    const body = await res.json();
    expect(body.date).toBe(new Date().toISOString().slice(0, 10));
  });

  it('returns 429 when the rate limiter says no', async () => {
    h.rlSuccess = false;
    const res = await POST(req({ type: 'run', distance: 3, time: 25 }));
    expect(res.status).toBe(429);
  });
});
