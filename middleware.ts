/**
 * middleware.ts
 *
 * Runs on the Edge runtime before every matched request. Two jobs:
 *
 *  1. Routing/auth gating:
 *       /          → public landing; authenticated users are redirected to /app
 *       /app/*     → protected; unauthenticated users are sent to /auth/signin
 *       /profile/* → public read-only profiles; no auth required
 *
 *  2. Content-Security-Policy with a per-request nonce. We generate a fresh
 *     nonce, expose it to Next via a REQUEST header (`x-nonce`) so Next stamps
 *     it onto every inline script it emits, and set the CSP on the RESPONSE so
 *     the browser enforces (or, while CSP_REPORT_ONLY, just reports) it.
 *     See lib/csp.ts for the policy + rollout notes.
 *
 * ⚠️  PWA CRITICAL — the following must NEVER be intercepted:
 *   sw.js          Service worker must be reachable by the browser at all times.
 *   manifest.json  Browser fetches this without cookies.
 *   Que_logo.png   Icons referenced by the manifest must load unauthenticated.
 */
import { getToken } from 'next-auth/jwt';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { buildCspValue, CSP_HEADER_NAME } from '@/lib/csp';

export default async function middleware(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  const { pathname } = req.nextUrl;

  // ── Per-request CSP nonce ──────────────────────────────────────────────────
  // base64 of 16 random bytes. Exposed to Next via a request header so its
  // inline scripts inherit it; echoed onto the response for the browser.
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const csp   = buildCspValue(nonce);

  // Authenticated users hitting the landing page → skip it, go straight to the app.
  // Carry an ?invite= code through so existing users who follow a friend's link
  // still get auto-connected (the app reads it post-redirect).
  if (pathname === '/' && token) {
    const dest   = new URL('/app', req.url);
    const invite = req.nextUrl.searchParams.get('invite');
    if (invite) dest.searchParams.set('invite', invite);
    return NextResponse.redirect(dest);
  }

  // /app routes are protected — send unauthenticated users to sign-in
  if (pathname.startsWith('/app') && !token) {
    const signInUrl = new URL('/auth/signin', req.url);
    signInUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(signInUrl);
  }

  // Forward the nonce to the app via a request header (Next reads `x-nonce`
  // off the incoming headers and stamps it on the scripts it renders).
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set(CSP_HEADER_NAME, csp);
  return res;
}

export const config = {
  matcher: [
    '/((?!api/auth|api/admin|auth/|ingest/|_next/static|_next/image|favicon\\.ico|icon|apple-icon|manifest\\.json|sw\\.js|Que_logo\\.png|placeholder).*)',
  ],
};
