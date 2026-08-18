/**
 * /api/health/token
 *
 *   GET  — return the authenticated user's personal health-sync API token,
 *          generating one on first call. The same token authenticates the step,
 *          activity, wellness, and batch pushes.
 *   POST — ROTATE the token (invalidates the old one immediately), and
 *          best-effort re-provision a connected data_tracker with the new value
 *          so its pushes keep working without manual reconfiguration.
 *
 * Response (both): { token, endpoint (steps), activityEndpoint (cardio),
 *                    trackerReprovisioned? (POST only) }
 */

import { getServerSession } from 'next-auth/next';
import { NextResponse }     from 'next/server';
import { authOptions }      from '@/lib/auth';
import { prisma }           from '@/lib/prisma';
import { ensureHealthToken } from '@/lib/healthToken';
import { provisionQuePush }  from '@/lib/dataTracker';

function endpoints() {
  const base = process.env.NEXTAUTH_URL ?? '';
  return { endpoint: `${base}/api/health/steps`, activityEndpoint: `${base}/api/health/activity` };
}

export async function GET(): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const token = await ensureHealthToken(session.user.id);
  return NextResponse.json({ token, ...endpoints() });
}

export async function POST(): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const userId = session.user.id;
  const token = await ensureHealthToken(userId, true);

  // Keep a connected tracker working across the rotation — otherwise its next
  // push 401s until the user re-copies the token by hand.
  let trackerReprovisioned = false;
  const conn = await prisma.dataTrackerConnection.findUnique({ where: { userId } });
  if (conn) {
    trackerReprovisioned = await provisionQuePush(
      conn.baseUrl, conn.secret, endpoints().activityEndpoint, token,
    );
  }

  return NextResponse.json({ token, ...endpoints(), trackerReprovisioned });
}
