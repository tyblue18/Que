/**
 * GET /api/cron/social-nudge — value-driven competitive notifications
 *
 * Scheduled daily by Vercel Cron. Sends AT MOST ONE push per user — the single
 * highest-priority social event — so it pulls people back to the differentiated
 * surfaces (battles, leaderboard) without becoming spam:
 *
 *   1. Battle final day  — you have an active battle whose window ends today
 *      (it resolves at the next 03:00 UTC sweep). Highest urgency.
 *   2. Season ending     — the weekly leaderboard resets in ≤1 day and you're
 *      opted in; tells you your current rank so you log to climb/defend.
 *
 * Only fires for users with a push subscription. Content is deadline-driven, not
 * time-of-day-driven, so unlike the food nudge it doesn't gate on local hour
 * (Vercel Hobby crons fire once/day at a fixed UTC time). Protected by CRON_SECRET.
 */

import { NextResponse }       from 'next/server';
import { prisma }             from '@/lib/prisma';
import { sendPushToUser }     from '@/lib/push';
import { mapWithConcurrency } from '@/lib/asyncBatch';
import {
  getSeasonRankings, DEFAULT_LEADERBOARD_CATEGORY, LEADERBOARD_CATEGORIES,
} from '@/lib/leaderboard';

type SubClient = { findMany: (a: unknown) => Promise<Array<{ userId: string }>> };
const ps = () => (prisma as unknown as { pushSubscription: SubClient }).pushSubscription;

function utcDateStr(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: Request): Promise<NextResponse> {
  const auth = req.headers.get('authorization');
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = utcDateStr(0);

  // ── 1. Who has a battle ending today? (1v1 typed + team/FFA) ────────────────
  const [challenges, teamBattles] = await Promise.all([
    prisma.challenge.findMany({
      where:  { status: 'active', endDate: today },
      select: { challengerId: true, challengeeId: true },
    }),
    prisma.teamBattle.findMany({
      where:   { status: 'active', endDate: today },
      include: { participants: { select: { userId: true } } },
    }),
  ]);
  const battleUsers = new Set<string>();
  for (const c of challenges) { battleUsers.add(c.challengerId); battleUsers.add(c.challengeeId); }
  for (const tb of teamBattles) for (const p of tb.participants) battleUsers.add(p.userId);

  // ── 2. Is the leaderboard season ending? If so, get everyone's rank. ────────
  const { season, ranked } = await getSeasonRankings(DEFAULT_LEADERBOARD_CATEGORY);
  const seasonEnding = season.daysLeft <= 1;
  const catLabel = LEADERBOARD_CATEGORIES.find(c => c.slug === DEFAULT_LEADERBOARD_CATEGORY)?.label ?? 'Steps';
  const rankByUsername = new Map(ranked.map(r => [r.username, r.rank]));

  const optedIn = seasonEnding
    ? await prisma.appUser.findMany({
        where:  { leaderboardOptIn: true, username: { not: null } },
        select: { id: true, username: true },
      })
    : [];
  const usernameById = new Map(optedIn.map(u => [u.id, u.username as string]));

  // ── 3. Restrict to push-subscribed users; build the candidate set. ──────────
  const subs = await ps().findMany({ distinct: ['userId'], select: { userId: true } });
  const subscribed = new Set(subs.map(s => s.userId));

  const candidates = new Set<string>();
  for (const id of battleUsers)        if (subscribed.has(id)) candidates.add(id);
  if (seasonEnding) for (const u of optedIn) if (subscribed.has(u.id)) candidates.add(u.id);

  if (candidates.size === 0) {
    return NextResponse.json({ ok: true, battle: 0, season: 0 });
  }

  const when = season.daysLeft === 0 ? 'today' : 'tomorrow';

  // ── 4. One prioritized push per user (battle > season). ─────────────────────
  const settled = await mapWithConcurrency([...candidates], 10, async (id) => {
    if (battleUsers.has(id)) {
      await sendPushToUser(id, {
        title: 'Final day ⚔️',
        body:  'Your battle ends tonight — log now to seal the win.',
        url:   '/app',
        tag:   'battle-deadline',
      });
      return 'battle' as const;
    }
    // Season-ending leaderboard nudge.
    const username = usernameById.get(id);
    const rank = username ? rankByUsername.get(username) : undefined;
    await sendPushToUser(id, {
      title: 'Season ending 🏆',
      body:  rank
        ? `${catLabel} season ends ${when} — you're #${rank} of ${ranked.length}. Log to climb.`
        : `${catLabel} season ends ${when} — log a workout to get on the board.`,
      url:   '/app',
      tag:   'season-end',
    });
    return 'season' as const;
  });

  let battle = 0, season_ = 0, failed = 0;
  for (const s of settled) {
    if (s.status === 'rejected')   failed++;
    else if (s.value === 'battle') battle++;
    else                           season_++;
  }

  console.log(`[cron/social-nudge] battle:${battle} season:${season_} failed:${failed}`);
  return NextResponse.json({ ok: true, battle, season: season_, failed });
}
