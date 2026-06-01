import { getServerSession } from 'next-auth/next';
import { NextResponse }     from 'next/server';
import { authOptions }      from '@/lib/auth';
import { sendPushToUser }   from '@/lib/push';
import { pushTestLimit }    from '@/lib/ratelimit';

export async function POST(req: Request): Promise<NextResponse> {
  void req;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json(null, { status: 401 });

  const { success } = await pushTestLimit.limit(session.user.id);
  if (!success) return NextResponse.json({ ok: false, reason: 'rate_limited' }, { status: 429 });

  const result = await sendPushToUser(session.user.id, {
    title: 'Que — notifications working ✓',
    body:  'You\'ll receive daily reminders and morning check-ins here.',
    url:   '/app',
  });

  // Report the real outcome so the UI can tell the user what's actually wrong
  // instead of always claiming success.
  if (!result.configured) {
    // VAPID env vars missing on the server — pushes can never be sent.
    return NextResponse.json({ ok: false, reason: 'not_configured' }, { status: 503 });
  }
  if (result.total === 0) {
    // Permission granted in the browser but no subscription reached the server.
    return NextResponse.json({ ok: false, reason: 'no_subscription' }, { status: 409 });
  }
  if (result.sent === 0) {
    // Subscriptions exist but the push service rejected every one.
    return NextResponse.json({ ok: false, reason: 'send_failed', failed: result.failed }, { status: 502 });
  }

  return NextResponse.json({ ok: true, sent: result.sent });
}
