/**
 * /api/datatracker
 *
 *   GET    — connection status { connected, baseUrl, lastSyncAt } (never the secret)
 *   POST   — connect: { baseUrl, secret }. Validated + SSRF-guarded, then verified
 *            against the tracker (a snapshot fetch with the secret) BEFORE saving.
 *   DELETE — disconnect.
 *
 * We store only a capability to the user's OWN tracker (its origin + shared
 * secret). Garmin credentials never touch Que.
 */

import { getServerSession } from 'next-auth/next';
import { NextResponse }     from 'next/server';
import { authOptions }      from '@/lib/auth';
import { prisma }           from '@/lib/prisma';
import { dataTrackerLimit } from '@/lib/ratelimit';
import { dataTrackerConnectSchema } from '@/lib/validators';
import { normalizeTrackerUrl, callTracker, TrackerError } from '@/lib/dataTracker';

async function requireUserId(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  return session?.user?.id ?? null;
}

function fail(e: unknown): NextResponse {
  if (e instanceof TrackerError) return NextResponse.json({ error: e.message }, { status: e.status });
  return NextResponse.json({ error: 'Could not connect to your data_tracker.' }, { status: 502 });
}

export async function GET(): Promise<NextResponse> {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const conn = await prisma.dataTrackerConnection.findUnique({ where: { userId } });

  // Surface the tracker's own health so the panel can explain a dead sync
  // ("Garmin login expired") instead of failing opaquely. Best-effort: a
  // health probe failure must not break the status response.
  let health: { ok: boolean; garminTokens: number; lastActivity: string | null; quePushConfigured: boolean } | null = null;
  if (conn) {
    try {
      const h = await callTracker(conn.baseUrl, conn.secret, '/api/health', { timeoutMs: 8_000 }) as Record<string, unknown>;
      health = {
        ok:            h.ok === true && !h.error,
        garminTokens:  Number(h.garmin_tokens) || 0,
        lastActivity:  (h.counts as Record<string, unknown> | undefined)?.last_activity as string ?? null,
        quePushConfigured: h.que_push_configured !== false, // absent on older deploys → assume ok
      };
    } catch { health = null; /* unreachable — panel shows its own connectivity error on use */ }
  }

  return NextResponse.json({
    connected:  !!conn,
    baseUrl:    conn?.baseUrl ?? null,
    lastSyncAt: conn?.lastSyncAt ?? null,
    health,
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { success } = await dataTrackerLimit.limit(userId);
  if (!success) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  let raw: unknown;
  try { raw = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = dataTrackerConnectSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'A URL and secret are required.' }, { status: 400 });

  let baseUrl: string;
  try { baseUrl = normalizeTrackerUrl(parsed.data.baseUrl); }
  catch (e) { return fail(e); }

  // Verify reachability AND the secret before persisting: a snapshot fetch needs
  // the Bearer secret, so a 401 here means the secret is wrong, a network error
  // means the URL is wrong. Never save an unverified connection.
  try {
    await callTracker(baseUrl, parsed.data.secret, '/api/snapshot', { timeoutMs: 15_000 });
  } catch (e) { return fail(e); }

  await prisma.dataTrackerConnection.upsert({
    where:  { userId },
    create: { userId, baseUrl, secret: parsed.data.secret },
    update: { baseUrl, secret: parsed.data.secret },
  });
  return NextResponse.json({ ok: true, connected: true, baseUrl });
}

export async function DELETE(): Promise<NextResponse> {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  await prisma.dataTrackerConnection.deleteMany({ where: { userId } });
  return NextResponse.json({ ok: true, connected: false });
}
