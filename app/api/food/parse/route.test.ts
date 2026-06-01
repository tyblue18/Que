/**
 * app/api/food/parse/route.test.ts
 *
 * Locks the grounding contract of the natural-language food parser — the
 * property that makes it trustworthy: the LLM only produces { query, quantity },
 * and macros ALWAYS come from the food DB (the mocked /api/food/search), never
 * the model. Also: unmatched items degrade to matched:false (never invented),
 * and a missing AI key degrades cleanly to { configured: false }.
 *
 * The LLM (generateObject), Redis, auth, and the internal food-search fetch are
 * all mocked — this tests the route's wiring, not the model.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────
const genMock = vi.fn();
vi.mock('ai', () => ({ generateObject: (...a: unknown[]) => genMock(...a) }));

vi.mock('@upstash/redis', () => ({
  Redis: class { async get() { return null; } async setex() { /* no-op */ } },
}));
vi.mock('@/lib/ratelimit', () => ({ foodParseLimit: { limit: async () => ({ success: true }) } }));
vi.mock('next-auth/next', () => ({ getServerSession: async () => ({ user: { id: 'u1' } }) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

import { POST, GET } from '@/app/api/food/parse/route';

const req = (body: unknown) =>
  new Request('http://localhost/api/food/parse', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// Mocked food-search response: "egg" matches, "unobtainium" does not.
const fetchMock = vi.fn();
beforeEach(() => {
  genMock.mockReset();
  process.env.OPENAI_API_KEY = 'test-key';
  fetchMock.mockImplementation((url: string) => {
    const q = new URL(url).searchParams.get('q') ?? '';
    const products = q.includes('egg')
      ? [{ product_name: 'Egg', serving_size: '100g', serving_quantity: 100, source: 'usda',
           nutriments: { 'energy-kcal_100g': 155, proteins_100g: 13, carbohydrates_100g: 1, fat_100g: 11 } }]
      : [];
    return Promise.resolve({ ok: true, json: async () => ({ products }) });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.OPENAI_API_KEY; });

describe('POST /api/food/parse', () => {
  it('grounds matched items with DB macros, never the model', async () => {
    genMock.mockResolvedValue({ object: { items: [{ query: 'egg', quantity: 2 }] } });
    const res = await POST(req({ text: '2 eggs' }));
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ query: 'egg', quantity: 2, matched: true });
    // Macros are the DB's, not anything the model emitted (the model emits none).
    expect(body.items[0].product.nutriments['energy-kcal_100g']).toBe(155);
  });

  it('marks an item the DB can’t find as matched:false (never invents macros)', async () => {
    genMock.mockResolvedValue({ object: { items: [{ query: 'unobtainium bar', quantity: 1 }] } });
    const res = await POST(req({ text: 'an unobtainium bar' }));
    const body = await res.json();
    expect(body.items[0]).toMatchObject({ matched: false });
    expect(body.items[0].product).toBeUndefined();
  });

  it('handles a mixed meal — some matched, some not', async () => {
    genMock.mockResolvedValue({ object: { items: [
      { query: 'egg', quantity: 2 },
      { query: 'unobtainium', quantity: 1 },
    ] } });
    const res = await POST(req({ text: '2 eggs and unobtainium' }));
    const body = await res.json();
    expect(body.items.map((i: { matched: boolean }) => i.matched)).toEqual([true, false]);
  });

  it('degrades to configured:false when no AI key is set (feature hidden)', async () => {
    delete process.env.OPENAI_API_KEY;
    const res = await POST(req({ text: '2 eggs' }));
    const body = await res.json();
    expect(body.configured).toBe(false);
    expect(genMock).not.toHaveBeenCalled(); // never calls the model
  });

  it('rejects empty / oversized input', async () => {
    expect((await POST(req({ text: '' }))).status).toBe(400);
    expect((await POST(req({ text: 'x'.repeat(301) }))).status).toBe(400);
  });

  it('returns 502 when the model call throws (no crash, clean error)', async () => {
    genMock.mockRejectedValue(new Error('model down'));
    const res = await POST(req({ text: '2 eggs' }));
    expect(res.status).toBe(502);
  });

  it('defaults a non-positive quantity to 1', async () => {
    genMock.mockResolvedValue({ object: { items: [{ query: 'egg', quantity: 0 }] } });
    const res = await POST(req({ text: 'egg' }));
    const body = await res.json();
    expect(body.items[0].quantity).toBe(1);
  });

  it('GET probe reports configured state (drives whether the tab shows)', async () => {
    const on = await (await GET()).json();
    expect(on.configured).toBe(true);
    delete process.env.OPENAI_API_KEY;
    const off = await (await GET()).json();
    expect(off.configured).toBe(false);
  });
});
