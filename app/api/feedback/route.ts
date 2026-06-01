/**
 * POST /api/feedback — a signed-in user submits a product suggestion.
 *
 * Delivery: push-notifies the app OWNER (resolved by OWNER_EMAIL) using the
 * existing web-push infra, so suggestions land on the owner's devices like any
 * other Que notification. Also console.log'd as a durable fallback — if the
 * owner has no push subscription (or VAPID isn't configured) the suggestion is
 * still captured in the Vercel function logs and never lost.
 *
 * Auth-gated (so submissions carry a real account) and rate-limited (5/min/user)
 * so one user can't spam the owner.
 */

import { getServerSession } from 'next-auth/next';
import { after, NextResponse } from 'next/server';
import { authOptions }      from '@/lib/auth';
import { prisma }           from '@/lib/prisma';
import { sendPushToUser }   from '@/lib/push';
import { feedbackLimit }    from '@/lib/ratelimit';
import { feedbackSchema }   from '@/lib/validators';
import { OWNER_EMAIL }      from '@/lib/constants';

export async function POST(req: Request): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json(null, { status: 401 });

  const { success } = await feedbackLimit.limit(session.user.id);
  if (!success) return NextResponse.json({ error: 'Too many suggestions — try again shortly' }, { status: 429 });

  const parsed = feedbackSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Message required' }, { status: 400 });
  const { message } = parsed.data;

  const from = session.user.email ?? session.user.id;

  // Durable fallback — always captured even if push can't be delivered.
  console.log('[feedback]', JSON.stringify({ from, message }));

  // Notify the owner off the response path so submission stays snappy.
  after(async () => {
    try {
      const owner = await prisma.appUser.findUnique({ where: { email: OWNER_EMAIL }, select: { id: true } });
      if (!owner) return;
      await sendPushToUser(owner.id, {
        title: '💡 New Que suggestion',
        body:  message.length > 160 ? `${message.slice(0, 157)}…` : message,
        url:   '/app',
        tag:   'feedback',
      });
    } catch { /* best-effort — the console.log above already captured it */ }
  });

  return NextResponse.json({ ok: true });
}
