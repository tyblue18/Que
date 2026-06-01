/**
 * lib/cronAuth.ts
 *
 * Shared authorization for the Vercel cron routes. Vercel sends
 * `Authorization: Bearer <CRON_SECRET>` on every scheduled invocation, but the
 * cron endpoints are publicly reachable URLs — so the check must be:
 *
 *   • FAIL-CLOSED: if CRON_SECRET isn't configured, reject everything. The old
 *     `process.env.CRON_SECRET && auth !== …` guard was fail-OPEN — a missing or
 *     misconfigured env var silently let anyone trigger battle resolution, pot
 *     transfers, and mass push notifications.
 *   • TIMING-SAFE: constant-time compare so the secret can't be recovered by
 *     measuring response time against a `!==` short-circuit.
 */

import crypto from 'node:crypto';

/** True iff the request carries the correct `Authorization: Bearer <CRON_SECRET>`. */
export function isAuthorizedCron(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false; // fail closed — unconfigured means locked, not open

  const header   = req.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

  const a = Buffer.from(provided);
  const b = Buffer.from(`${expected}`);
  if (a.length !== b.length) return false; // timingSafeEqual requires equal lengths
  try { return crypto.timingSafeEqual(a, b); }
  catch { return false; }
}
