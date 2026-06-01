/**
 * POST /api/food/parse — natural-language meal → grounded food items.
 *
 * "2 eggs and a banana" → [{ Egg ×2 }, { Banana ×1 }], each with REAL macros.
 *
 * ── The grounding contract (why this is trustworthy + cheap) ────────────────
 * The LLM does ONE job: turn messy free text into structured intent
 * ({ query, quantity }). It NEVER produces nutrition numbers — those are looked
 * up from the same USDA + Open Food Facts DB the manual search uses (via the
 * existing /api/food/search, reusing its ranking, plausibility guard, and Redis
 * cache). So a hallucinated calorie count is structurally impossible: the model
 * can only name a food; the macros come from the database. An item the DB can't
 * match is returned as `matched: false` for manual search — never invented.
 *
 * Cost is bounded: input capped at 300 chars (validator), structured output only
 * (no free-form generation), a small/cheap model (gpt-4o-mini), and identical
 * phrases are Redis-cached 24h. Rate-limited per user.
 *
 * Degrades cleanly: with no OPENAI_API_KEY configured the route returns
 * `{ configured: false }` and the client simply hides the feature.
 *
 * Same-origin POST → allowed by CSP `connect-src 'self'`.
 */

import { NextResponse }     from 'next/server';
import { getServerSession } from 'next-auth/next';
import { generateObject }   from 'ai';
import { openai }           from '@ai-sdk/openai';
import { z }                from 'zod';
import { Redis }            from '@upstash/redis';
import { authOptions }      from '@/lib/auth';
import { foodParseLimit }   from '@/lib/ratelimit';
import { foodParseSchema }  from '@/lib/validators';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

// Feature is "configured" when an OpenAI key is present; absent → feature hidden.
const aiConfigured = () => !!process.env.OPENAI_API_KEY;

// Small, cheap, fast — parsing is a trivial task for a mini model. The OpenAI
// provider reads OPENAI_API_KEY from the environment.
const PARSE_MODEL = openai('gpt-4o-mini');

// What the LLM returns — INTENT ONLY, never macros.
const parsedSchema = z.object({
  items: z.array(z.object({
    query:    z.string().describe('a concise, searchable food name, e.g. "egg", "banana", "greek yogurt"'),
    quantity: z.number().positive().describe('how many servings/units the user ate; default 1 if unstated'),
  })).max(15),
});

interface NormalizedProduct {
  product_name:     string;
  brands?:          string;
  serving_size:     string;
  serving_quantity: number;
  source:           string;
  nutriments: Record<string, number>;
}
interface ParsedItem {
  query:    string;
  quantity: number;
  matched:  boolean;
  product?: NormalizedProduct; // the top DB hit (real macros) when matched
}

/** Ground one parsed item against the existing food-search endpoint (same
 *  ranking + plausibility + cache). Returns the top hit, or matched:false. */
async function groundItem(query: string, quantity: number, origin: string): Promise<ParsedItem> {
  try {
    const res = await fetch(`${origin}/api/food/search?q=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { query, quantity, matched: false };
    const data = await res.json() as { products?: NormalizedProduct[] };
    const top  = data.products?.[0];
    return top ? { query, quantity, matched: true, product: top } : { query, quantity, matched: false };
  } catch {
    return { query, quantity, matched: false };
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json(null, { status: 401 });

  if (!aiConfigured()) return NextResponse.json({ configured: false });

  const { success } = await foodParseLimit.limit(session.user.id);
  if (!success) return NextResponse.json({ error: 'Too many requests — slow down' }, { status: 429 });

  const parsed = foodParseSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Tell me what you ate' }, { status: 400 });
  const text = parsed.data.text;

  // Cache identical phrases (the parse is deterministic enough; macros refresh
  // via the search cache underneath). Keyed on lowercased text.
  const cacheKey = `foodparse:${text.toLowerCase()}`;
  try {
    const cached = await redis.get<{ items: ParsedItem[] }>(cacheKey);
    if (cached) return NextResponse.json({ ...cached, configured: true, cached: true });
  } catch { /* redis down — parse live */ }

  // ── 1. LLM: free text → structured intent (no macros) ──────────────────────
  let items: Array<{ query: string; quantity: number }>;
  try {
    const { object } = await generateObject({
      model:  PARSE_MODEL,
      schema: parsedSchema,
      system:
        'You extract individual foods and how many servings the user ate from a ' +
        'short meal description. Return a concise searchable name per food and a ' +
        'positive quantity (default 1 if unstated). Split combined items ("eggs ' +
        'and toast" → two). Do NOT estimate calories or macros — only name and ' +
        'count. Ignore non-food text.',
      prompt: text,
      // Hard cap so a pathological input can't run up tokens.
      maxOutputTokens: 500,
    });
    items = object.items;
  } catch {
    return NextResponse.json({ error: 'Could not read that — try rephrasing or search manually' }, { status: 502 });
  }

  if (items.length === 0) {
    return NextResponse.json({ configured: true, items: [] });
  }

  // ── 2. Ground each item against the real food DB (parallel) ─────────────────
  // Derive origin from the request so the internal /api/food/search call hits
  // this same deployment (preview or prod), with NEXTAUTH_URL as a fallback.
  const origin = new URL(req.url).origin || process.env.NEXTAUTH_URL || '';
  const grounded = await Promise.all(items.map(i => groundItem(i.query, i.quantity > 0 ? i.quantity : 1, origin)));

  const result = { items: grounded };
  // Cache only when at least one item matched (a total miss may be a transient
  // search hiccup we don't want to pin for 24h).
  if (grounded.some(i => i.matched)) {
    try { await redis.setex(cacheKey, 86_400, JSON.stringify(result)); } catch { /* best-effort */ }
  }

  return NextResponse.json({ ...result, configured: true });
}
