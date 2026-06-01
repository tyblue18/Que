/**
 * POST /api/csp-report
 *
 * Sink for Content-Security-Policy violation reports (the `report-uri` target
 * in lib/csp.ts). Browsers POST here when a resource would be blocked — while
 * we run CSP in Report-Only mode this is how we SEE what a real enforcing
 * policy would break, before flipping the switch.
 *
 * Logs one grep-friendly line per violation to the Vercel function logs. No
 * auth (the browser sends these unauthenticated); rate-limited per-IP so a
 * misbehaving page or a forged flood can't fill the log stream.
 *
 * Browsers send one of two shapes depending on age:
 *   • legacy:  { "csp-report": { "violated-directive", "blocked-uri", … } }
 *   • Reporting API: [{ "type": "csp-violation", "body": { … } }]
 */

import { NextResponse } from 'next/server';
import { Ratelimit }    from '@upstash/ratelimit';
import { Redis }        from '@upstash/redis';

const redis = Redis.fromEnv();
const reportLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.fixedWindow(60, '1 m'),
  prefix:  'rl:csp',
});

export async function POST(req: Request): Promise<NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'anon';
  const { success } = await reportLimit.limit(ip);
  if (!success) return new NextResponse(null, { status: 429 });

  let body: unknown;
  try { body = await req.json(); }
  catch { return new NextResponse(null, { status: 204 }); }

  // Normalize both report shapes to the fields we care about.
  const reports = Array.isArray(body) ? body : [body];
  for (const r of reports) {
    const rec = (r ?? {}) as Record<string, unknown>;
    const v   = (rec['csp-report'] ?? rec['body'] ?? rec) as Record<string, unknown>;
    console.warn('[csp-report]', JSON.stringify({
      directive:  v['violated-directive'] ?? v['effectiveDirective'] ?? null,
      blockedUri: v['blocked-uri']        ?? v['blockedURL']         ?? null,
      documentUri:v['document-uri']       ?? v['documentURL']        ?? null,
    }));
  }

  // 204 No Content — the browser doesn't read the body.
  return new NextResponse(null, { status: 204 });
}
