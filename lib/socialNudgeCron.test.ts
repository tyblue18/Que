/**
 * lib/socialNudgeCron.test.ts
 *
 * Locks the social-nudge cron's selection + priority logic:
 *   • requires the CRON_SECRET
 *   • a battle ending today → "battle-deadline" push (takes priority)
 *   • season ending + opted in → "season-end" push (with or without a rank)
 *   • only push-subscribed users are nudged; at most one push each
 *   • nothing fires on an ordinary day with no battles
 *
 * Redis + push are mocked; Prisma is the in-memory fake. The clock is frozen to
 * a Sunday so the weekly season is "ending" (daysLeft 0) deterministically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeFakePrisma, type FakePrisma } from '@/lib/test-fakes';

vi.mock('@upstash/redis', () => ({ Redis: class { async get() { return null; } async setex() { /* no-op */ } } }));

const pushMock = vi.fn();
vi.mock('@/lib/push', () => ({ sendPushToUser: (...a: unknown[]) => pushMock(...a) }));

const h = vi.hoisted(() => ({ db: null as unknown as FakePrisma }));
vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy({}, { get: (_t, prop) => (h.db as unknown as Record<PropertyKey, unknown>)[prop] }),
}));

import { GET } from '@/app/api/cron/social-nudge/route';

const SUNDAY = '2026-01-11'; // a Sunday → leaderboard season ends today (daysLeft 0)
const req = (secret = 'test-secret') =>
  new Request('http://x/api/cron/social-nudge', { headers: { authorization: `Bearer ${secret}` } });

beforeEach(() => {
  h.db = makeFakePrisma();
  pushMock.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${SUNDAY}T12:00:00Z`));
  process.env.CRON_SECRET = 'test-secret';
});
afterEach(() => { vi.useRealTimers(); });

describe('social-nudge cron', () => {
  it('rejects a request without the cron secret', async () => {
    const res = await GET(new Request('http://x/api/cron/social-nudge'));
    expect(res.status).toBe(401);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('prioritizes battle-deadline over season, and only nudges subscribed users', async () => {
    h.db.seedUser({ id: 'u1', username: 'alice', leaderboardOptIn: true });
    h.db.seedUser({ id: 'u2', username: 'bob',   leaderboardOptIn: true });
    h.db.seedUser({ id: 'u3', username: 'carol', leaderboardOptIn: false });
    h.db.seedUser({ id: 'u4', username: 'dave',  leaderboardOptIn: true });
    h.db.seedSub('u1'); h.db.seedSub('u2'); h.db.seedSub('u4'); // carol NOT subscribed
    // alice has a battle ending today (vs carol).
    h.db.seedChallenge({
      id: 'c1', challengerId: 'u1', challengeeId: 'u3', wager: 10, status: 'active',
      type: 'typed', categories: ['cardio.steps'], startDate: '2026-01-05', endDate: SUNDAY,
    });
    h.db.seedDay('u2', SUNDAY, { steps: '5000' }); // bob is ranked

    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);

    const tagByUser = new Map(pushMock.mock.calls.map(c => [c[0] as string, (c[1] as { tag: string }).tag]));
    expect(tagByUser.get('u1')).toBe('battle-deadline'); // battle beats season
    expect(tagByUser.get('u2')).toBe('season-end');       // ranked
    expect(tagByUser.get('u4')).toBe('season-end');       // opted in, no data
    expect(tagByUser.has('u3')).toBe(false);              // not subscribed
    expect(body).toMatchObject({ ok: true, battle: 1, season: 2 });
  });

  it('sends nothing on an ordinary day with no battles ending', async () => {
    vi.setSystemTime(new Date('2026-01-07T12:00:00Z')); // Wednesday → season not ending
    h.db.seedUser({ id: 'u1', username: 'alice', leaderboardOptIn: true });
    h.db.seedSub('u1');
    h.db.seedDay('u1', '2026-01-07', { steps: '5000' });

    const res = await GET(req());
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, battle: 0, season: 0 });
    expect(pushMock).not.toHaveBeenCalled();
  });
});
