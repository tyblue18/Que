import { Ratelimit } from '@upstash/ratelimit';
import { Redis }     from '@upstash/redis';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

// 15 syncs per user per minute
export const syncLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(15, '1 m'),
  prefix:  'rl:sync',
});

// 30 food searches per IP per minute
export const foodLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, '1 m'),
  prefix:  'rl:food',
});

// 10 natural-language meal parses per user per minute. Each call hits an LLM, so
// this is a COST guardrail (not just abuse prevention) — tighter than plain food
// search. A real user parses a meal a handful of times a day; 10/min is ample.
export const foodParseLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '1 m'),
  prefix:  'rl:foodparse',
});

// 20 token-based step pushes per IP per minute. Generous for legit external
// clients (iOS Shortcut / Tasker), but stops a brute-force of the step token
// and the per-request DB token lookup from being hammered.
export const stepLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, '1 m'),
  prefix:  'rl:step',
});

// 20 token-based cardio activity pushes per IP per minute. Same class as the step
// push (external automation with the personal token) — its own bucket so a burst
// of activity syncs doesn't starve step syncs and vice-versa.
export const activityLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, '1 m'),
  prefix:  'rl:activity',
});

// 30 token-based wellness pushes per IP per minute. A sync re-pushes ~a week of
// daily metrics each run (they change through the day), so this is roomier than
// the activity bucket while still capping token brute-force.
export const wellnessLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, '1 m'),
  prefix:  'rl:wellness',
});

// 20 data_tracker connect/status/metrics reads per user per minute — plenty for
// the connect form + polling the metrics view, but caps probing of the
// server-side URL fetch (SSRF surface).
export const dataTrackerLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, '1 m'),
  prefix:  'rl:dtrack',
});

// 6 tracker-triggered Garmin syncs per user per minute. A sync spends the user's
// finite Garmin API budget, so this is tighter than the read limiter.
export const dataTrackerSyncLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(6, '1 m'),
  prefix:  'rl:dtrack-sync',
});

// 30 Sentry tunnel envelopes per IP per minute. Errors are rare in normal use
// (and the client SDK dedupes), so this is plenty — it exists to stop forged
// envelopes from flooding (and exhausting) the Sentry project quota.
export const monitoringLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, '1 m'),
  prefix:  'rl:monitoring',
});

// 20 friend-graph writes per user per minute (send / cancel / accept / decline).
// Generous enough for legitimate use, prevents scripted spam.
export const friendLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, '1 m'),
  prefix:  'rl:friend',
});

// 10 challenge writes per user per minute (create / accept / decline).
// Each create deducts coins, so abuse has cost — but a tighter limit prevents
// spam-notification annoyance to friends.
export const challengeLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '1 m'),
  prefix:  'rl:challenge',
});

// 5 invite redemptions per user per minute. A real client fires this once on
// first auth after following an invite link; the tight cap stops a script from
// probing usernames or hammering the redeem path.
export const inviteLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, '1 m'),
  prefix:  'rl:invite',
});

// 20 group writes per user per minute (create / rename / add / remove / leave).
export const groupLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, '1 m'),
  prefix:  'rl:group',
});

// 40 feed writes per user per minute (share posts, likes, comments). Likes can
// be tapped quickly, so this is more generous than other write limits.
export const feedLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(40, '1 m'),
  prefix:  'rl:feed',
});

// 30 leaderboard reads per user per minute. It's a cached read (10 min TTL), so
// this only guards against a runaway client, not real load.
export const leaderboardLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, '1 m'),
  prefix:  'rl:leaderboard',
});

// 10 profile-photo uploads per user per minute. Each upload writes to Vercel
// Blob (storage + bandwidth quota), so an authenticated user shouldn't be able
// to loop the endpoint and burn the project's storage budget.
export const photoLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '1 m'),
  prefix:  'rl:photo',
});

// 20 profile updates per user per minute (username / status / showcase). Caps
// username-squatting probes and status spam; generous for real editing.
export const userLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, '1 m'),
  prefix:  'rl:user',
});

// 10 badge re-scans per user per minute. /api/badges/cleanup runs a full
// DayRecord-history re-evaluation, so an unbounded caller could load the DB.
export const badgeLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '1 m'),
  prefix:  'rl:badge',
});

// 10 self-test pushes per user per minute. Only ever notifies the caller, so
// impact is low, but a cap stops a script from looping the push service.
export const pushTestLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '1 m'),
  prefix:  'rl:pushtest',
});

// 5 suggestion submissions per user per minute. Each one pushes a notification
// to the app owner, so a tight cap stops a single user from spamming the owner.
export const feedbackLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, '1 m'),
  prefix:  'rl:feedback',
});
