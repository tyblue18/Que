# Que

A mobile-first, offline-first PWA for personal training, nutrition tracking, and friend-vs-friend fitness competition.

**Live:** https://que-tanishqs.vercel.app/app
**Status:** Deployed on Vercel and in active use by a small base of real users. Usage (total / new / active users, push-syncs per day) is tracked via an owner-only `/api/admin/stats` endpoint.

> The deployed app opens to a public landing page with a PWA install prompt. Signed-in users land on the authenticated dashboard at `/app` — a tab shell hosting the calendar, calorie tracker, metrics, workout protocol, and social tabs. Anyone with the link can view a user's public profile and badge showcase at `/profile/<username>`.

## Why this exists

Que is a training OS built to consolidate workout logging, calorie tracking, and weight-management projections into one offline-first app that works at the gym, in the kitchen, and on the trail without depending on a network. It grew into a multi-device social platform with 1v1 and team/FFA battles, friend groups with a Strava-style activity feed, server-side badge and coin economies, cardio-aware cut/bulk plan projections, and a Jack Daniels VDOT running-plan generator. The goal is a working personal trainer in your pocket without the noise of mainstream fitness apps — no ads, no upsells, no engagement-bait.

## Tech stack

| Layer              | Choice                                                                 |
| ------------------ | ---------------------------------------------------------------------- |
| Framework          | Next.js 15 (App Router) on Node 20+                                    |
| Language           | TypeScript 5.7                                                         |
| UI                 | React 19, Tailwind CSS v4, shadcn/ui + Radix primitives                |
| State              | Custom React Context with `localStorage` as source of truth            |
| Database           | PostgreSQL via Prisma 5 (Neon)                                         |
| Auth               | NextAuth 4 (GitHub + Google OAuth, JWT sessions)                       |
| Hosting            | Vercel (serverless functions + 4 cron jobs)                            |
| Rate limiting / locks | Upstash Redis (sliding-window limits, sync locks, pending-award queue) |
| File storage       | Vercel Blob (profile photos)                                          |
| Push               | Web Push API with VAPID                                               |
| Step sync          | Manual entry + a per-user bearer-token endpoint (iOS Shortcut / Tasker) |
| Product analytics  | `@vercel/analytics` page views + PostHog, via a typed `trackEvent()` wrapper that dual-sends |
| Error tracking     | Sentry (`@sentry/nextjs`), tunnelled through a same-origin route; in-house reporter as a secondary sink |
| Animation          | Framer Motion + Lottie                                                |
| Charts             | Recharts plus raw canvas for perf-critical plan charts                |
| Barcode scanning   | `@zxing/browser` with a native `BarcodeDetector` fallback             |
| Testing            | Vitest (unit coverage, starting with the pure calorie/diet math)      |

## Architecture overview

```
Browser (localStorage, Service Worker)
        ↕  debounced sync (4 s)
Next.js App Router (/ landing, /app dashboard, /profile/[username])
        ↕  JWT auth via NextAuth
Next.js API Routes
        ↕  Prisma
PostgreSQL (Neon)
```

**Offline-first with per-day newer-wins conflict resolution.** `localStorage` is the authoritative source for the active session, so the app is fully functional with no network. Every edit through `updateDayRecord()` stamps the day with an `_editedAt` ISO timestamp and queues a debounced push (4 s) to `/api/sync`. The server and the pull-merge both keep the higher `_editedAt` per day (with a 60 s future-clock tolerance), which is what makes multi-device usage safe: a phone editing Monday at 10:30 wins over a laptop that synced later from stale 10:01 data. Every server-side conflict is returned in a `conflicts[]` array and surfaced to the user through a `que-conflict` event → bottom toast, so a merge is never silent.

**Background, server-authoritative badge + coin engine.** Badges and calorie-coins are evaluated against the user's full `DayRecord` history in Next's `after()` (post-response), guarded by a 30 s per-user Redis lock so a burst of syncs scans history once rather than per push. Newly awarded items are stashed in Redis (`pending:badges:<userId>`, `pending:extra:<userId>`) and delivered on the user's next sync; the client shows celebration popups optimistically the moment a threshold is crossed, so the delay is invisible. The DB enforces `@@unique [userId, slug]` so the award path is idempotent across all callers (sync, battle resolution, invite redemption).

**Idempotent, transactional competitive settlement.** 1v1 and team/FFA battles wager in-app coins. Resolution runs inside a Prisma `$transaction`; the pot transfer uses `updateMany` with a `where: { status: 'active' }` compare-and-set guard so a cron retry or manual replay cannot double-pay. Wager deduction reads the post-decrement balance and throws to roll back if it would overdraft. Coin transactions are append-only with a `reason` enum and a `refId` dedupe key, so the wallet is fully auditable.

**Service worker update flow.** The SW never calls `skipWaiting()` on its own. When a fresh SW reaches `installed` with an existing controller (a real update, not first install), `sw-register.tsx` shows an in-app "New version ready — Update" prompt; only on click does the client post `{ type: 'SKIP_WAITING' }` and reload on `controllerchange`. This avoids the common PWA failure where a tab silently picks up new JS mid-session and crashes on a stale React tree.

## Key systems

### Sync engine — `lib/syncEngine.ts`, `app/api/sync/route.ts`
Debounced `queueSync()` accumulates dirty days and pushes them with a fresh settings snapshot. The POST handler compares incoming `_editedAt` against the stored row, returns rejected writes as `conflicts`, writes accepted upserts to per-day `DayRecord` rows, and kicks off badge/coin evaluation in `after()`. The pull-merge on load applies remote days per-day newer-wins, never clobbering days edited this session (`dirtyDaysRef`).

### Badge engine — `lib/badgeEngine.ts`, `lib/badgeCatalog.ts`
60+ badges across lift, cardio, and nutrition. `checkAndAwardBadges()` loads full history plus live battle-win and referral counts, runs every `check()`, and writes new badges with `skipDuplicates`. Lift/cardio badges revoke on data correction; nutrition and battle-win badges are permanent. Adding a badge is a server `BADGE_DEFS` entry + a client `BADGE_CATALOG` entry — no migration. (See the full integration guide in `CLAUDE.md`.)

### Plan engine — `lib/metricsTypes.ts`, `components/metrics/MetricsModals.tsx`
Cut/bulk plans with cardio-adjusted projections. `getEffectiveDailyKcal()` accounts for the 40 % of cardio burn that isn't eaten back, `getPlanBaseline()` resolves the true starting weight from the first in-window weigh-in, and `getPlanCompliance()` walks each logged day to compute real caloric balance vs. true maintenance. Bulk plans store their surplus as a negative `profile.deficit` so a single budget formula handles both directions without branching.

### Food search — `app/api/food/search/route.ts`
Dual-source (USDA FoodData Central + Open Food Facts), queried in parallel, normalized to one shape, relevance-ranked, de-duped, plausibility-checked, and cached 24 h in Redis. Barcode scanning uses ZXing with a native `BarcodeDetector` race; reliability fixes live in `lookupBarcode` (post-detection), never in the camera setup. The picker surfaces Recents/Frequents from a 200-entry LRU (`lib/foodUsage.ts`).

### Battles — `lib/battleEngine.ts`, `lib/battle-categories.ts`, `app/api/cron/resolve-battles/route.ts`
Two 1v1 flavors on the `Challenge` row: classic (badge-count, resolved inline) and typed (pick `bestOf` categories over a `day`/`3day`/`week` window). Team battles (`TeamBattle`) run the same category engine in `teams` (summed scores) or `ffa` (per-player) mode within a group. Each category is a pure `score(rows)` function. A 03:00 UTC cron resolves every active battle past its `endDate`, transfers pots atomically, awards battle-count badges, and pushes win/loss/tie notifications. `computeStandings()` powers a read-only live leaderboard.

### Groups & group feed — `lib/groupAccess.ts`, `components/social/`
User-created rosters (max 12, friends only). A Strava-style activity feed lets members share a workout as a `GroupPost` whose `payload` is a client-built snapshot (stays intact if the source day is later edited), with likes and comments. All feed reads/writes verify membership.

### Invite / referral loop — `lib/invite.ts`, `app/api/invite/*`
An invite "code" is the inviter's username, so the link is `/?invite=<username>` — no token table. Redemption is idempotent: it establishes a two-way friendship, credits the inviter 10 and the invitee 5 coins, push-notifies the inviter, and re-runs the badge engine. The invitee's `referral_received` row dedupes one redemption per account.

### Step tracking — `app/api/health/{token,steps}/route.ts`
Google Fit was removed when Google deprecated it (and its sensitive OAuth scope). Steps now come from manual entry or a per-user bearer token: `GET /api/health/token` issues the token; `POST /api/health/steps` accepts `{ steps, date }` from an iOS Shortcut / Tasker automation and writes the day's `DayRecord`. Google sign-in uses default scopes only, so no Google verification burden.

### Push notifications — `lib/push.ts`, `app/api/cron/*`
Web Push with VAPID. Four daily/weekly crons: weigh-in reminder, evening daily-nudge (gated on the user's *local* hour via `queTzOffset`), weekly recap, and battle resolution. Subscriptions are stored per-user with the endpoint as dedupe key; failed deliveries are dropped without bubbling.

### Error tracking — `instrumentation*.ts`, `lib/errorReporter.ts`, `components/ErrorBoundary.tsx`
Sentry is the primary sink; client events are tunnelled through the same-origin `/monitoring` route so ad/privacy blockers can't drop them. Each tab in `/app` wraps its content in an `<ErrorBoundary>` so one crash isolates to that subtree. `errorReporter` dedupes within a 5 s window, caps at 50/session, forwards to Sentry, and POSTs to a rate-limited `/api/log/error` secondary sink (structured JSON in Vercel logs).

### Telemetry — `lib/telemetry.ts`
A typed `trackEvent()` wrapper that dual-sends every event to both `@vercel/analytics` and PostHog (reverse-proxied via `/ingest`). The full event catalog is one TypeScript union, so call sites can't send untyped strings. Prod-only; `trackOnce()` fires "first time X" milestones at most once per device.

## Getting started

### Prerequisites

- Node 20 or newer
- A PostgreSQL database (Neon, Supabase, or local)
- An Upstash Redis instance (rate limiting, sync locks, pending-award queue, food-search cache)

### Setup

```bash
git clone https://github.com/tyblue18/Que.git
cd Que
npm install

# Create .env.local with the variables listed below

npx prisma migrate dev            # initial schema migration
npm run dev                       # starts on http://localhost:3000
```

For OAuth sign-in locally, register `http://localhost:3000/api/auth/callback/<provider>` as the redirect URI on your GitHub and Google OAuth apps.

### Environment variables

| Variable                                   | Purpose                                                          |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `DATABASE_URL`                             | Postgres connection string (pooled)                             |
| `DIRECT_URL`                               | Postgres direct URL (migrations, read-after-write)              |
| `NEXTAUTH_SECRET`                          | NextAuth JWT signing secret (`openssl rand -base64 32`)         |
| `NEXTAUTH_URL`                             | Canonical app URL for OAuth callbacks                           |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth app credentials                                    |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth credentials (sign-in only, default scopes)         |
| `USDA_API_KEY`                             | USDA FoodData Central key (falls back to `DEMO_KEY`, 30 req/hr) |
| `CRON_SECRET`                              | Bearer token Vercel sends to all cron routes                    |
| `STATS_SECRET`                             | Optional token for `/api/admin/stats` (falls back to `CRON_SECRET`) |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN`     | Upstash Redis (rate limits, sync locks, `pending:*` queues, food cache) |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`             | VAPID public key for web push                                   |
| `VAPID_PRIVATE_KEY`                        | VAPID private key (server only)                                 |
| `BLOB_READ_WRITE_TOKEN`                    | Vercel Blob token for profile photos                            |
| `NEXT_PUBLIC_SENTRY_DSN`                   | Sentry DSN (error tracking is inert if unset)                   |
| `NEXT_PUBLIC_POSTHOG_KEY`                  | PostHog project key (analytics inert if unset)                  |

### Scripts

| Command           | What it does                                          |
| ----------------- | ----------------------------------------------------- |
| `npm run dev`     | Start the Next.js dev server                          |
| `npm run build`   | `prisma generate` then a production build             |
| `npm start`       | Start the production server (after `npm run build`)   |
| `npm run lint`    | Run ESLint across the repo                            |
| `npm test`        | Run the Vitest suite once                             |
| `npm run test:watch` | Run Vitest in watch mode                           |

## Project structure

```
app/
  app/                       Authenticated dashboard (5 tabs, each in its own ErrorBoundary)
  profile/[username]/        Public read-only profile pages with per-user OG images
  monitoring/                Sentry tunnel endpoint (rate-limited)
  api/
    sync/                    GET pull, POST push with _editedAt conflict resolution
    badges/                  GET earned badges; admin re-evaluation / cleanup
    challenges/              1v1 battle create, accept, decline, resolve
    team-battles/            Team & FFA battle create / accept / standings
    groups/                  Group rosters + activity-feed posts
    posts/                   Group-post likes and comments
    invite/                  Referral redeem + public inviter info
    food/search/             USDA + Open Food Facts dual-source search
    health/{token,steps}/    Personal step-sync token + ingest endpoint
    user/, friends/          Profile + friendship management
    admin/stats/             Owner-only usage dashboard
    cron/                    4 scheduled jobs (battle resolution + 3 push reminders)
    log/error/               Client error sink, rate-limited
  layout.tsx                 Root layout, providers, fonts, PWA meta
  page.tsx                   Public landing page

lib/
  AppContext.tsx             Global React context; localStorage I/O; _editedAt stamping
  syncEngine.ts              Debounced cloud sync and pull-merge
  badgeEngine.ts             Server-side badge evaluation + revocation
  badgeCatalog.ts            Client-accessible badge display catalog
  battleEngine.ts            1v1 + team/FFA resolution (pure compute + transactional commit)
  battle-categories.ts       Registry of every battle category with a pure score function
  coinEngine.ts              Server-side calorie-coin awards
  metricsTypes.ts            Plan engine: budget metrics, baseline, compliance
  errorReporter.ts           Client error reporter (dedupe + keepalive POST + Sentry)
  telemetry.ts               Typed trackEvent() — dual-sends to Vercel Analytics + PostHog
  invite.ts, groupAccess.ts  Referral helpers + group/feed access checks
  running/                   VDOT-based training plan generator (Jack Daniels methodology)
  push.ts, ratelimit.ts, prisma.ts, validators.ts, auth.ts, calorie-utils.ts, ...

components/
  WorkoutLogger.tsx          Lift/cardio entry, outlier guards, rest timer, badge popups
  CalorieTracker.tsx         Meal sections, food picker, macros, copy-yesterday
  MetricsDashboard.tsx       Charts, plan tile, streaks, PRs, data export
  CalendarScheduler.tsx      Month/week/day calendar with workout indicators
  SocialTab.tsx              Friends, 1v1 + team battles, groups, feed, invites
  ProfileCard.tsx            Public profile + drag-and-drop badge showcase
  ErrorBoundary.tsx          Per-tab error isolation
  ConflictToast.tsx          Surfaces multi-device sync conflicts
  sw-register.tsx            SW registration + "New version" update prompt
  AutoCropImage.tsx          Badge background removal with LRU cache + IntersectionObserver
  social/, calorie/, metrics/, workout/, running/, landing/   Feature-scoped subcomponents

prisma/
  schema.prisma              17 models: AppUser, WorkoutData, DayRecord, Badge, CoinWallet,
                             CoinTransaction, Challenge, Friendship, Group, GroupMember,
                             TeamBattle, TeamBattleParticipant, GroupPost, PostLike,
                             PostComment, PushSubscription, HealthConnection (deprecated)

public/
  sw.js                      Service worker (network-first JS, cache-first assets, SKIP_WAITING)
  Badges/                    60+ achievement badge images
  manifest.json              PWA manifest
```

## Notable engineering details

**Per-day newer-wins sync conflict resolution.** Every `updateDayRecord` stamps `_editedAt` before persisting. The server POST and the client pull-merge both keep the newer-edited day (ties → remote so cron-side writes still propagate), replacing the naive "last device to sync wins" model that drops real edits from slower-syncing devices. Conflicts return in a `conflicts[]` array the client writes back and surfaces as a toast.

**Background badge/coin engine behind a Redis lock.** Evaluation runs post-response in `after()` and a 30 s per-user lock collapses a sync burst into a single full-history scan. Awards are queued in Redis and drained on the next sync, hidden behind optimistic client popups.

**Idempotent coin settlement.** Battle resolution transfers pots inside a Prisma `$transaction` using `updateMany` with a `status:'active'` compare-and-set guard, so a cron retry or manual replay can't double-pay; wager debits roll back on overdraft.

**`AutoCropImage` with IntersectionObserver + LRU cache.** Badge images get a corner-sampled flood-fill background removal on first render; the result is cached in `localStorage` (LRU 100) and a module-level `Map`, and the canvas work is deferred via `IntersectionObserver` (200 px rootMargin) so a 50-badge grid doesn't block the main thread on open.

## Roadmap and known limitations

- **Sync merge is per-day, not per-field.** If two devices edit different fields of the same day independently, the newer-edited day wins entirely and the other field is lost. A field-level merge is the next step.
- **Plan history:** one plan is active at a time, but a superseded plan (a cut↔bulk switch, or an explicit "start a new plan") is archived read-only to a Plan History timeline, so the cut/bulk journey is preserved instead of overwritten.
- **Test coverage is growing.** A Vitest suite covers the pure calorie/diet math, the battle/coin settlement engines (win/tie/double-pay/overdraft), and the "Beat Last Week" pace logic; broader coverage is ongoing.
- No reduced-motion accessibility audit; viewport is locked (`maximumScale: 1`).

## License

MIT

## Author

Tanishq Somani
