/**
 * lib/csp.ts
 *
 * Content-Security-Policy builder. The policy is nonce-based with
 * `'strict-dynamic'`, which is the modern, robust approach for Next.js:
 *
 *   • Next injects its own inline bootstrap/streaming scripts. When the REQUEST
 *     carries a CSP header with a nonce, Next stamps that nonce onto every
 *     script it emits, and `'strict-dynamic'` then trusts anything those nonced
 *     scripts load (the chunk graph). So we never need to allowlist script
 *     hosts — `'self'` + nonce + strict-dynamic covers the whole bundle.
 *   • The one hand-written inline script (the blocking theme setter in
 *     app/layout.tsx) gets the same nonce, threaded in via headers().
 *
 * Why the rest is so small: analytics/error hosts are all SAME-ORIGIN here —
 * PostHog is reverse-proxied through /ingest, Sentry tunnels through
 * /monitoring, Vercel Analytics posts to /_vercel — so `connect-src 'self'`
 * covers them. next/font self-hosts fonts at build time, so `font-src 'self'`.
 * The only cross-origin need is profile-photo IMAGES (avatars + Vercel Blob).
 *
 * ── Rollout ────────────────────────────────────────────────────────────────
 * Ships in REPORT-ONLY mode (CSP_REPORT_ONLY = true): browsers report
 * violations to /api/csp-report but block nothing. Verify a preview deploy
 * (click through every tab, scan a barcode, upload a photo, sign in/out, run a
 * battle), confirm the report log is quiet, THEN flip CSP_REPORT_ONLY to false
 * to enforce. Nothing about the app breaks while this stays true.
 */

const isDev = process.env.NODE_ENV === 'development';

/** Enforcing. Verified clean on a production build (`npm run build && start`):
 *  full click-through of every tab, barcode scanner, photo upload, auth, battles,
 *  and Lottie animations produced no violations after aliasing lottie-web to its
 *  eval-free light build. Set back to `true` if you add a feature that needs
 *  re-verification (it reports without blocking). */
export const CSP_REPORT_ONLY = false;

export const CSP_HEADER_NAME = CSP_REPORT_ONLY
  ? 'Content-Security-Policy-Report-Only'
  : 'Content-Security-Policy';

/** Image hosts that serve user content (avatars + uploaded profile photos). */
const IMG_HOSTS = [
  'https://avatars.githubusercontent.com',
  'https://lh3.googleusercontent.com',
  'https://*.public.blob.vercel-storage.com',
];

/**
 * Build the CSP directive string for a given per-request nonce.
 * Returns the value only; the caller picks the header name (CSP_HEADER_NAME for
 * the browser-facing response; a plain `content-security-policy` on the request
 * so Next can read the nonce — see middleware.ts).
 */
export function buildCspValue(nonce: string): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    // Dev only: React Fast Refresh / webpack eval the bundle.
    isDev ? "'unsafe-eval'" : '',
  ].filter(Boolean).join(' ');

  const connectSrc = [
    "'self'",
    // Dev only: HMR websocket.
    isDev ? 'ws:' : '',
  ].filter(Boolean).join(' ');

  const directives = [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    // framer-motion + Recharts set inline style attributes; next/font injects a
    // <style>. Style injection is far lower-risk than script injection.
    `style-src 'self' 'unsafe-inline'`,
    // data: = canvas-cropped badge data URLs (AutoCropImage); blob: = object URLs.
    `img-src 'self' data: blob: ${IMG_HOSTS.join(' ')}`,
    `font-src 'self'`,
    `connect-src ${connectSrc}`,
    `worker-src 'self'`,        // service worker (/sw.js)
    `manifest-src 'self'`,
    `media-src 'self' blob:`,   // barcode-scanner camera stream
    `frame-src 'none'`,
    `frame-ancestors 'none'`,   // clickjacking (complements X-Frame-Options)
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `report-uri /api/csp-report`,
    // Don't force https upgrades in dev (http://localhost).
    isDev ? '' : 'upgrade-insecure-requests',
  ].filter(Boolean);

  return directives.join('; ');
}
