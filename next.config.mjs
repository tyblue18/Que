/** @type {import('next').NextConfig} */
const nextConfig = {
  // Build timestamp, baked into the client bundle at build time. The client
  // compares it to the last value it saw and shows an "Updated" confirmation
  // when it increases — a reliable signal that survives the service-worker
  // lifecycle (which silently swaps versions between mobile sessions).
  env: {
    NEXT_PUBLIC_BUILD_TIME: String(Date.now()),
  },

  // Alias lottie-web → its LIGHT build. The full build ships an animation-
  // expression engine that uses eval()/new Function(), which forces
  // `'unsafe-eval'` into our CSP script-src (defeating the point of a strict
  // policy). The light build drops that evaluator (and the unused canvas/html
  // renderers) but keeps loadAnimation + the SVG renderer, so our expression-
  // free Lottie files (lottie-react only calls loadAnimation) render
  // identically — with zero eval in the bundle.
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      'lottie-web': 'lottie-web/build/player/lottie_light.js',
    };
    return config;
  },

  // Skip ESLint during `next build` — it's a meaningful chunk of build time on
  // the Hobby plan's limited CPU and is redundant with editor/CI linting.
  // Type-checking stays ON (Next still type-checks the build) so we never ship
  // type errors. Run `npm run lint` locally/in CI to keep lint coverage.
  eslint: {
    ignoreDuringBuilds: true,
  },

  // REMOVED: output: 'export'
  //    NextAuth API routes require a Node.js server runtime.
  //    Static export (output: 'export') compiles to plain HTML/JS and
  //    cannot run /api/auth/[...nextauth] at request time.
  //
  // REMOVED: basePath: '/Gym_Plan'
  //    The registered GitHub OAuth callback is:
  //     http://localhost:3000/api/auth/callback/github
  //    With basePath active the route would resolve to:
  //     http://localhost:3000/Gym_Plan/api/auth/callback/github   ← mismatch

  images: {
    // Whitelist external CDNs to serve user avatars safely
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
        pathname: '/u/**',
      },
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
        pathname: '/**',
      },
    ],
  },

  // Reverse-proxy PostHog analytics through our own origin so ad/privacy
  // blockers that block posthog.com can't drop funnel events. The client is
  // configured with api_host '/ingest' (see lib/analytics-posthog.ts).
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      { source: '/ingest/static/:path*', destination: 'https://us-assets.i.posthog.com/static/:path*' },
      { source: '/ingest/:path*',        destination: 'https://us.i.posthog.com/:path*' },
    ];
  },

  async headers() {
    return [
      {
        // Never let the CDN/browser serve a stale service worker script — the SW
        // update check must always see fresh bytes, otherwise new deploys are
        // never detected and the "New version" prompt won't appear.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      {
        // Baseline security headers on every response. The Content-Security-
        // Policy is NOT here — it's nonce-based and set per-request in
        // middleware.ts (lib/csp.ts), since a static header can't carry a
        // per-request nonce. `camera=(self)` is required so the barcode
        // scanner's getUserMedia works.
        source: '/(.*)',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Content-Type-Options',    value: 'nosniff' },
          // DENY matches the CSP `frame-ancestors 'none'` set in middleware —
          // the app is never meant to be embedded in a frame.
          { key: 'X-Frame-Options',           value: 'DENY' },
          { key: 'Referrer-Policy',           value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy',        value: 'camera=(self), microphone=(), geolocation=()' },
          { key: 'X-DNS-Prefetch-Control',    value: 'on' },
        ],
      },
    ];
  },
};

export default nextConfig;