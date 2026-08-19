/**
 * app/api/health/batch/route.test.ts
 *
 * The batched sync contract: auth, the at-least-one-entry validation, per-DATE
 * grouping (each day read+written exactly once regardless of how many entries
 * target it), activities + wellness applied through the real engines in one
 * pass, and the per-day changed flags in the response.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  TOKEN: 'tok-123',
  rlSuccess: true,
  days: new Map<string, { data: Record<string, unknown> }>(),
  upserts: [] as string[],
  reads: [] as string[],
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
      findUnique: async ({ where }: { where: { userId_date: { date: string } } }) => {
        h.reads.push(where.userId_date.date);
        return h.days.get(where.userId_date.date) ?? null;
      },
      upsert: async (args: { where: { userId_date: { date: string } };
                             update: { data: Record<string, unknown> } }) => {
        h.upserts.push(args.where.userId_date.date);
        h.days.set(args.where.userId_date.date, { data: args.update.data });
        return {};
      },
    },
  },
}));

import { POST } from '@/app/api/health/batch/route';

const req = (body: unknown, token: string | null = h.TOKEN) =>
  new Request('http://localhost/api/health/batch', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.days.clear(); h.upserts = []; h.reads = []; h.rlSuccess = true;
});

describe('POST /api/health/batch', () => {
  it('rejects missing token / empty batch', async () => {
    expect((await POST(req({ activities: [] }, null))).status).toBe(401);
    expect((await POST(req({ activities: [], wellness: [] }))).status).toBe(400);
  });

  it('groups by date: one read + one write per day, however many entries', async () => {
    const res = await POST(req({
      activities: [
        { type: 'run',  distance: 3, time: 25, calories: 300, date: '2026-08-10', externalId: 'a' },
        { type: 'bike', distance: 15, time: 62, calories: 465, date: '2026-08-10', externalId: 'b' },
        { type: 'swim', time: 20, calories: 149, date: '2026-08-11', externalId: 'c' },
      ],
      wellness: [
        { date: '2026-08-10', hrv: 62, sleepScore: 81 },
        { date: '2026-08-12', steps: 9000 },
      ],
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalDays).toBe(3);
    expect(body.changedDays).toBe(3);
    expect(body.days).toEqual({ '2026-08-10': true, '2026-08-11': true, '2026-08-12': true });
    // exactly one read and one write per distinct date
    expect(h.reads.sort()).toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
    expect(h.upserts.sort()).toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
    // both engines applied into the SAME day record
    const day10 = h.days.get('2026-08-10')!.data;
    expect(day10.garminRunKcal).toBe(300);
    expect(day10.garminBikeKcal).toBe(465);
    expect(day10.hrv).toBe(62);
  });

  it('a fully-unchanged batch reports changed=false days and writes nothing', async () => {
    const batch = {
      activities: [{ type: 'run', distance: 3, time: 25, calories: 300, date: '2026-08-10', externalId: 'a' }],
      wellness:   [{ date: '2026-08-10', hrv: 62 }],
    };
    await POST(req(batch));
    h.upserts = [];
    const res = await POST(req(batch));
    const body = await res.json();
    expect(body.changedDays).toBe(0);
    expect(body.days['2026-08-10']).toBe(false);
    expect(h.upserts).toEqual([]); // idempotent — no rewrite
  });

  it('rejects an invalid entry inside the batch (schema runs per item)', async () => {
    const res = await POST(req({ activities: [{ type: 'run', distance: 3 }] })); // no time
    expect(res.status).toBe(400);
  });

  it('returns 429 when rate limited', async () => {
    h.rlSuccess = false;
    expect((await POST(req({ wellness: [{ steps: 1 }] }))).status).toBe(429);
  });
});
