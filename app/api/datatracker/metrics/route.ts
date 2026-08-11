/**
 * GET /api/datatracker/metrics
 *
 * Server-side proxy for the user's data_tracker `/api/snapshot` (the browser
 * can't fetch it directly — cross-origin is blocked by our CSP `connect-src
 * 'self'`, and the secret must stay server-side). Returns the tracker's rich
 * training snapshot (CTL/ATL/TSB, progression, intensity, HRV, …) for the
 * Metrics view to render.
 */

import { getServerSession } from 'next-auth/next';
import { NextResponse }     from 'next/server';
import { authOptions }      from '@/lib/auth';
import { prisma }           from '@/lib/prisma';
import { dataTrackerLimit } from '@/lib/ratelimit';
import { callTracker, TrackerError } from '@/lib/dataTracker';

export async function GET(): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { success } = await dataTrackerLimit.limit(userId);
  if (!success) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const conn = await prisma.dataTrackerConnection.findUnique({ where: { userId } });
  if (!conn) return NextResponse.json({ error: 'No data_tracker connected.' }, { status: 400 });

  try {
    const snapshot = await callTracker(conn.baseUrl, conn.secret, '/api/snapshot', { timeoutMs: 20_000 });
    return NextResponse.json({ ok: true, baseUrl: conn.baseUrl, snapshot });
  } catch (e) {
    if (e instanceof TrackerError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: 'Could not load metrics.' }, { status: 502 });
  }
}
