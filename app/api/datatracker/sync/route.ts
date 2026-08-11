/**
 * POST /api/datatracker/sync
 *
 * Manual "Sync now": calls the user's connected data_tracker `/api/sync` with the
 * shared secret. The tracker pulls the latest from Garmin and — because it's
 * configured with this user's Que health token — pushes the new run/bike/swim
 * back into Que's log via /api/health/activity. So one tap updates both.
 *
 * We only trigger and record the time here; the cardio arrives via the normal
 * health-activity path and shows up on the next pull.
 */

import { getServerSession }     from 'next-auth/next';
import { NextResponse }         from 'next/server';
import { authOptions }          from '@/lib/auth';
import { prisma }               from '@/lib/prisma';
import { dataTrackerSyncLimit } from '@/lib/ratelimit';
import { callTracker, TrackerError } from '@/lib/dataTracker';

export async function POST(req: Request): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { success } = await dataTrackerSyncLimit.limit(userId);
  if (!success) return NextResponse.json({ error: 'Too many syncs — wait a minute.' }, { status: 429 });

  const conn = await prisma.dataTrackerConnection.findUnique({ where: { userId } });
  if (!conn) return NextResponse.json({ error: 'No data_tracker connected.' }, { status: 400 });

  // `?full=1` re-sends already-imported activities so Que can backfill fields
  // added after they were first pushed (e.g. measured calories) over a wider
  // window. Normal sync just forwards new activities.
  const full = new URL(req.url).searchParams.get('full') === '1';
  const path = full ? '/api/sync?resend=true&days=120' : '/api/sync';

  let result: unknown;
  try {
    // A Garmin pull can take a while; give it a generous but bounded window.
    result = await callTracker(conn.baseUrl, conn.secret, path, { method: 'POST', timeoutMs: 90_000 });
  } catch (e) {
    if (e instanceof TrackerError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: 'Sync failed.' }, { status: 502 });
  }

  await prisma.dataTrackerConnection.update({
    where: { userId },
    data:  { lastSyncAt: new Date() },
  });

  return NextResponse.json({ ok: true, result });
}
