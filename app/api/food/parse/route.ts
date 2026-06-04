/**
 * POST /api/food/parse — natural-language meal → grounded food items.
 *
 * "2 eggs and a banana" → [{ Egg ×2 }, { Banana ×1 }], each with REAL macros.
 *
 * ── Hybrid grounding (AI estimate, DB-confirmed when confident) ─────────────
 * The LLM extracts each food ({ query, quantity, unit }), estimates its PORTION
 * (grams), AND estimates its macros. We then look the food up in the same USDA +
 * Open Food Facts DB the manual search uses (/api/food/search) and PREFER the DB
 * macros ONLY when it is confidently the SAME food — the DB name matches the query
 * AND its energy density agrees with the estimate (or it is a USDA whole-food with
 * a strong name match). Otherwise we keep the AI estimate.
 *
 * Why hybrid: pure DB-grounding was brittle — the search often ranked a wrong
 * Open Food Facts item first (e.g. "banana" → a branded "Banana" candy), so a
 * confidently-WRONG "grounded" number got shown. The AI estimate is accurate for
 * common foods and never shows the wrong food; the DB cross-check upgrades it to
 * lab-accurate numbers when it clearly matches, and catches a bad estimate too.
 * Items are tagged `source: 'db' | 'ai'` so the UI can label AI estimates
 * honestly. Portion is per-unit grams, so "2 eggs" logs ~100 g (≈140 kcal), not
 * the old `quantity × 100 g` (≈286 kcal).
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

/** Cheap capability probe — the client calls this on open to decide whether to
 *  show the Quick Log tab at all (no model call, no auth needed). */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ configured: aiConfigured() });
}

// Small, cheap, fast — parsing is a trivial task for a mini model. The OpenAI
// provider reads OPENAI_API_KEY from the environment.
const PARSE_MODEL = openai('gpt-4o-mini');

// What the LLM returns — intent + portion + an ESTIMATE of macros (which the DB
// can confirm/override). The model is a generalist that knows common foods well.
const parsedSchema = z.object({
  items: z.array(z.object({
    query:    z.string().describe('a concise, generic, searchable food name, e.g. "egg", "banana", "greek yogurt", "white rice cooked" (drop brands/adjectives unless essential)'),
    quantity: z.number().positive().describe('the COUNT of units eaten; default 1 if unstated ("a"/"an"/"some" → 1)'),
    unit:     z.string().describe('short label for ONE unit: "egg", "slice", "cup", "g", "oz", or "serving"'),
    grams:    z.number().positive().describe('best estimate of the TOTAL grams eaten for this item. e.g. 2 eggs ≈ 100, a banana ≈ 120, a cup of cooked rice ≈ 158'),
    kcal:     z.number().nonnegative().describe('estimated TOTAL calories for the amount eaten, using standard nutrition values for the food'),
    protein:  z.number().nonnegative().describe('estimated TOTAL protein in grams'),
    carbs:    z.number().nonnegative().describe('estimated TOTAL carbohydrates in grams'),
    fat:      z.number().nonnegative().describe('estimated TOTAL fat in grams'),
  })).max(15),
});

interface LlmItem {
  query: string; quantity: number; unit: string; grams: number;
  kcal: number; protein: number; carbs: number; fat: number;
}

interface NormalizedProduct {
  product_name:     string;
  brands?:          string;
  serving_size:     string;
  serving_quantity: number;
  source:           string;        // 'usda' | 'off' | 'ai'
  nutriments: Record<string, number>;
}
interface ParsedItem {
  query:    string;
  quantity: number;
  unit?:    string;
  grams?:   number;
  matched:  boolean;
  source?:  'db' | 'ai';           // where the shown macros came from
  product?: NormalizedProduct;     // serving rewritten to the per-unit portion
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const titleCase = (s: string) => s.replace(/\b\w/g, c => c.toUpperCase());

/** Build the serving label + grams-per-unit from the LLM's unit + per-unit grams.
 *  serving_quantity is grams of ONE unit, so the client's `servings = quantity`
 *  yields macros = density_100g × (gramsPerUnit/100) × quantity = the real portion. */
function buildServing(unit: string, gramsPerUnit: number): { serving_size: string; serving_quantity: number } {
  const g = Math.round(gramsPerUnit);
  const u = (unit ?? '').trim().toLowerCase();
  const weightLike = !u || u === 'g' || u === 'gram' || u === 'grams' || u === 'oz' || u === 'serving';
  return { serving_size: weightLike ? `${g} g` : `1 ${u} (~${g} g)`, serving_quantity: g };
}

/** Per-100g density from the LLM's TOTAL macros + estimated total grams. */
function densityFromTotals(m: { kcal: number; protein: number; carbs: number; fat: number }, grams: number): Record<string, number> {
  const f = grams > 0 ? 100 / grams : 1;
  return {
    'energy-kcal_100g':  Math.round(Math.max(0, m.kcal) * f),
    proteins_100g:       Math.round(Math.max(0, m.protein) * f * 10) / 10,
    carbohydrates_100g:  Math.round(Math.max(0, m.carbs)   * f * 10) / 10,
    fat_100g:            Math.round(Math.max(0, m.fat)     * f * 10) / 10,
  };
}

/**
 * Ground one item: start from the AI estimate, then UPGRADE to the DB's macros
 * only when the DB top hit is confidently the same food. The serving is always
 * rewritten to the per-unit portion so the logged calories reflect the amount eaten.
 */
async function groundItem(item: LlmItem, origin: string): Promise<ParsedItem> {
  const query    = item.query;
  const quantity = item.quantity > 0 ? item.quantity : 1;
  const totalGrams   = item.grams && item.grams > 0 ? clamp(item.grams, 1, 3000) : 100 * quantity;
  const gramsPerUnit = clamp(totalGrams / quantity, 1, 3000);
  const serving = buildServing(item.unit ?? '', gramsPerUnit);
  const base = { query, quantity, unit: item.unit, grams: Math.round(totalGrams) };

  const aiDensity = densityFromTotals(item, totalGrams);
  const aiKcal    = aiDensity['energy-kcal_100g'];
  const aiProduct: NormalizedProduct = {
    product_name: titleCase(query),
    serving_size: serving.serving_size,
    serving_quantity: serving.serving_quantity,
    source: 'ai',
    nutriments: aiDensity,
  };

  // Try the DB; failure or no hit just means we keep the AI estimate.
  let top: NormalizedProduct | null = null;
  try {
    const res = await fetch(`${origin}/api/food/search?q=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json() as { products?: NormalizedProduct[] };
      top = data.products?.[0] ?? null;
    }
  } catch { /* search down → AI estimate */ }

  if (top) {
    const name    = top.product_name.toLowerCase();
    const qWords  = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    const nameMatch = qWords.length > 0 && qWords.every(w => name.includes(w));
    const exactish  = name === query.toLowerCase() || name.startsWith(query.toLowerCase());
    const dbKcal    = top.nutriments['energy-kcal_100g'] ?? 0;
    // DB density must agree with the estimate (catches "banana" → banana bread),
    // unless it's a USDA whole-food with a strong name match (lab-authoritative).
    const densityClose = aiKcal <= 0 || Math.abs(dbKcal - aiKcal) <= Math.max(50, aiKcal * 0.45);
    const trustDb = nameMatch && (densityClose || (top.source === 'usda' && exactish));
    if (trustDb) {
      return { ...base, matched: true, source: 'db', product: { ...top, ...serving } };
    }
  }

  return { ...base, matched: aiKcal > 0, source: 'ai', product: aiKcal > 0 ? aiProduct : undefined };
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
  const cacheKey = `foodparse:v3:${text.toLowerCase()}`;
  try {
    const cached = await redis.get<{ items: ParsedItem[] }>(cacheKey);
    if (cached) return NextResponse.json({ ...cached, configured: true, cached: true });
  } catch { /* redis down — parse live */ }

  // ── 1. LLM: free text → structured intent + PORTION SIZE (never calories) ──
  let items: LlmItem[];
  try {
    const { object } = await generateObject({
      model:  PARSE_MODEL,
      schema: parsedSchema,
      system:
        'You convert a short meal description into a structured list of foods. For each food return: ' +
        'query (a concise, generic, searchable name — drop brands/adjectives unless essential), ' +
        'quantity (the count of units, default 1; "a"/"an"/"some" → 1), unit (a short label for ONE ' +
        'unit: "egg", "slice", "cup", "g", "oz", "serving"), grams (your best estimate of the TOTAL ' +
        'grams eaten), and the estimated TOTAL macros for that amount: kcal, protein, carbs, fat (grams). ' +
        'Split combined foods ("eggs and toast" → two items). Use typical portion weights: 1 large egg ' +
        '≈ 50 g, 1 medium banana ≈ 120 g, 1 slice bread ≈ 30 g, 1 cup cooked rice ≈ 158 g, 1 cup cooked ' +
        'pasta ≈ 140 g, 1 chicken breast ≈ 170 g, 1 tbsp oil ≈ 14 g, 1 cup milk ≈ 244 g, 1 apple ≈ 180 g. ' +
        'If the user states an explicit weight ("200 g pasta", "8 oz chicken"), use it (1 oz ≈ 28 g) with ' +
        'unit "g" and quantity 1. Base macros on standard nutrition values for the food and the portion ' +
        'size. Ignore non-food text (greetings, feelings).',
      prompt: text,
      // Hard cap so a pathological input can't run up tokens.
      maxOutputTokens: 600,
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
  const grounded = await Promise.all(items.map(i => groundItem(i, origin)));

  const result = { items: grounded };
  // Cache only when at least one item matched (a total miss may be a transient
  // search hiccup we don't want to pin for 24h).
  if (grounded.some(i => i.matched)) {
    try { await redis.setex(cacheKey, 86_400, JSON.stringify(result)); } catch { /* best-effort */ }
  }

  return NextResponse.json({ ...result, configured: true });
}
