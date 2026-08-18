/**
 * lib/dataTracker.ts
 *
 * Server-side client for a user's self-hosted Garmin `data_tracker` instance.
 * Que never sees Garmin credentials — it holds only a capability to the user's
 * OWN service (its https origin + the tracker's CRON_SECRET) and calls it
 * server-to-server to trigger a sync or read the metrics snapshot.
 *
 * SSRF matters here: the base URL is user-supplied and we fetch it from our
 * server. `normalizeTrackerUrl` enforces https and blocks loopback / private /
 * link-local / metadata hosts, and `callTracker` refuses redirects and bounds
 * the request time. (Residual: a public hostname that later resolves to a
 * private IP — DNS rebinding — isn't caught here; acceptable for a
 * technical-user, self-hosted feature, and worth revisiting if it widens.)
 */

/** A user-facing failure talking to the tracker. `status` is the HTTP code to
 *  return to the browser. */
export class TrackerError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = 'TrackerError';
  }
}

/** True for IPv4 literals in a private / loopback / link-local / CGNAT range —
 *  or a malformed dotted-quad, which we treat as unsafe rather than guess. */
function isBlockedIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some(n => n > 255)) return true;
  const [a, b] = o;
  if (a === 0 || a === 127) return true;                 // this-host / loopback
  if (a === 10) return true;                             // private
  if (a === 172 && b >= 16 && b <= 31) return true;      // private
  if (a === 192 && b === 168) return true;               // private
  if (a === 169 && b === 254) return true;               // link-local + cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true;     // CGNAT
  return false;
}

/**
 * Validate + canonicalise a user-supplied tracker URL to its https origin
 * (scheme://host[:port], no path/query/credentials). Throws `TrackerError(400)`
 * on anything unsafe or malformed.
 */
export function normalizeTrackerUrl(input: string): string {
  let u: URL;
  try { u = new URL(input.trim()); }
  catch { throw new TrackerError('That is not a valid URL.', 400); }

  if (u.protocol !== 'https:') throw new TrackerError('The URL must start with https://', 400);
  if (u.username || u.password) throw new TrackerError('Remove the credentials from the URL.', 400);

  const host = u.hostname.toLowerCase();
  if (!host) throw new TrackerError('That is not a valid URL.', 400);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
    throw new TrackerError('Local addresses are not allowed — use your deployed URL.', 400);
  if (host.includes(':')) throw new TrackerError('IPv6 addresses are not allowed.', 400); // hostname keeps ':' for IPv6
  if (isBlockedIpv4(host)) throw new TrackerError('Private / loopback addresses are not allowed.', 400);

  return u.origin;
}

interface CallOpts {
  method?: 'GET' | 'POST';
  timeoutMs?: number;
  /** JSON body for POSTs. */
  body?: unknown;
}

/**
 * Call one endpoint on the user's tracker with the shared Bearer secret.
 * Returns the parsed JSON body, or throws `TrackerError`. Refuses redirects and
 * aborts on timeout (both SSRF/robustness guards).
 */
export async function callTracker(
  baseUrl: string,
  secret: string,
  path: string,
  { method = 'GET', timeoutMs = 20_000, body }: CallOpts = {},
): Promise<unknown> {
  const url = normalizeTrackerUrl(baseUrl) + path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: ctrl.signal,
      redirect: 'error',
      cache: 'no-store',
    });
  } catch (e) {
    throw new TrackerError(
      (e as Error)?.name === 'AbortError'
        ? 'Your data_tracker did not respond in time.'
        : 'Could not reach your data_tracker — check the URL and that it is deployed.',
      502,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) throw new TrackerError('That secret was rejected by your data_tracker.', 401);
  if (!res.ok) throw new TrackerError(`Your data_tracker returned an error (${res.status}).`, 502);
  try { return await res.json(); }
  catch { throw new TrackerError('Your data_tracker returned an unreadable response.', 502); }
}

/**
 * Hand the user's Que push credentials to their tracker so it can push cardio +
 * wellness WITHOUT the user copying tokens into Vercel env vars (the setup step
 * that has cost the most debugging). Best-effort: an older tracker without the
 * /api/que-config endpoint just 404s — the caller treats false as "configure
 * manually" (the panel's health warning covers it).
 */
export async function provisionQuePush(
  baseUrl: string,
  secret: string,
  activityUrl: string,
  token: string,
): Promise<boolean> {
  try {
    await callTracker(baseUrl, secret, '/api/que-config', {
      method: 'POST', timeoutMs: 10_000, body: { activityUrl, token },
    });
    return true;
  } catch { return false; }
}
