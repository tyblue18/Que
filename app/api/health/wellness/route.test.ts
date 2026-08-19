/**
 * app/api/health/wellness/route.test.ts
 *
 * HTTP wiring of the daily wellness push: auth, the at-least-one-metric
 * validation, the applyWellness write path (real engine), and the no-op
 * idempotency that protects manual edits from daily re-pushes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  TOKEN: 'tok-123',
  rlSuccess: true,
  days: new Map<string, { data: Record<string, unknown> }>(),
  upserts: 0,
}));

vi.mock('@/lib/ratelimit', () => ({
  wellnessLimit: { limit: async () => ({ success: h.rlSuccess }) },
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
                             update: { data: Record<string, unknown> } }) => {
        h.upserts++;
        h.days.set(args.where.userId_date.date, { data: args.update.data });
        return {};
      },
    },
  },
}));

import { POST } from '@/app/api/health/wellness/route';

const req = (body: unknown, token: string | null = h.TOKEN) =>
  new Request('http://localhost/api/health/wellness', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

beforeEach(() => { h.days.clear(); h.upserts = 0; h.rlSuccess = true; });

describe('POST /api/health/wellness', () => {
  it('rejects missing/unknown tokens with 401', async () => {
    expect((await POST(req({ steps: 100 }, null))).status).toBe(401);
    expect((await POST(req({ steps: 100 }, 'wrong'))).status).toBe(401);
  });

  it('rejects a body with no metrics at all (date alone is not a payload)', async () => {
    const res = await POST(req({ date: '2026-08-10' }));
    expect(res.status).toBe(400);
  });

  it('rejects implausible values (schema bounds)', async () => {
    expect((await POST(req({ restingHr: 500 }))).status).toBe(400);
    expect((await POST(req({ weightLb: 5 }))).status).toBe(400);
  });

  it('writes the metrics; weight lands as the lb string the manual path uses', async () => {
    const res = await POST(req({
      date: '2026-08-10', steps: 9200, weightLb: 180.44, restingHr: 47,
      hrv: 62, sleepScore: 81, sleepMin: 442, bodyBattery: 88,
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).changed).toBe(true);
    const stored = h.days.get('2026-08-10')!.data;
    expect(stored.steps).toBe(9200);
    expect(stored.weight).toBe('180.4');
    expect(stored.hrv).toBe(62);
    expect(stored.sleepMin).toBe(442);
  });

  it('an unchanged re-push is a no-op (no upsert, stamps preserved)', async () => {
    const payload = { date: '2026-08-11', steps: 5000, hrv: 60 };
    await POST(req(payload));
    expect(h.upserts).toBe(1);
    const res = await POST(req(payload));
    expect((await res.json()).changed).toBe(false);
    expect(h.upserts).toBe(1);
  });

  it('returns 429 when rate limited', async () => {
    h.rlSuccess = false;
    expect((await POST(req({ steps: 100 }))).status).toBe(429);
  });
});
