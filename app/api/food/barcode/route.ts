/**
 * GET /api/food/barcode?code=<digits>
 *
 * Same-origin proxy for the Open Food Facts barcode lookup. The client used to
 * fetch world.openfoodfacts.org DIRECTLY from the browser, but the app's CSP
 * (`connect-src 'self'`) blocks cross-origin client fetches — which broke the
 * scanner with a "network error" even though detection worked. Routing the
 * lookup through our own origin fixes that, and (like /api/food/search) also
 * dodges ad/privacy blockers and gets a 24h Redis cache for free.
 *
 * NOTE: this is a POST-DETECTION reliability change, the only place the barcode
 * scanner's CLAUDE.md guard permits edits — the camera/getUserMedia setup is
 * untouched.
 *
 * Returns OFF's native shape `{ status, product }` so the client's existing
 * candidate-retry loop is unchanged: status === 1 + a product_name = a hit.
 */

import { NextResponse }  from 'next/server';
import { foodLimit }     from '@/lib/ratelimit';
import { Redis }         from '@upstash/redis';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

interface OFFProduct {
  product_name?:    string;
  brands?:          string;
  serving_size?:    string;
  serving_quantity?: number | string;
  nutriments?:      Record<string, number>;
}
type BarcodeResult = { status: 0 | 1; product?: OFFProduct };

export async function GET(req: Request): Promise<NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'anon';
  const { success } = await foodLimit.limit(ip);
  if (!success) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const code = new URL(req.url).searchParams.get('code')?.trim() ?? '';
  // Barcodes are short digit strings; reject anything else before hitting OFF.
  if (!/^\d{6,14}$/.test(code)) {
    return NextResponse.json({ status: 0, error: 'Invalid barcode' }, { status: 400 });
  }

  const cacheKey = `barcode:${code}`;
  try {
    const cached = await redis.get<BarcodeResult>(cacheKey);
    if (cached) return NextResponse.json(cached);
  } catch { /* redis down — fall through to a live fetch */ }

  let body: BarcodeResult;
  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v0/product/${code}.json`,
      { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Que/1.0 (fitness app)' } },
    );
    if (!res.ok) {
      // Upstream hiccup — report it so the client shows a real error, not "not found".
      return NextResponse.json({ status: 0, error: 'Lookup failed' }, { status: 502 });
    }
    const data = await res.json() as { status?: number; product?: OFFProduct };
    body = data.status === 1 && data.product
      ? { status: 1, product: {
          product_name:     data.product.product_name,
          brands:           data.product.brands,
          serving_size:     data.product.serving_size,
          serving_quantity: data.product.serving_quantity,
          nutriments:       data.product.nutriments,
        } }
      : { status: 0 };
  } catch {
    return NextResponse.json({ status: 0, error: 'Lookup failed' }, { status: 502 });
  }

  // Cache both hits and misses 24h (a miss rarely flips to a hit; saves OFF calls).
  try { await redis.setex(cacheKey, 86_400, JSON.stringify(body)); } catch { /* best-effort */ }
  return NextResponse.json(body);
}
