/**
 * GET /api/cron/resolve-battles
 *
 * Scheduled at 03:00 UTC daily.
 *
 * Sweeps every typed battle whose status='active' and endDate < today, scores
 * it via lib/battleEngine.resolveBattle(), transfers the pot, and pushes a
 * win/loss/tie notification to both users.
 *
 * Protected by CRON_SECRET. Safe to invoke manually for replays — resolveBattle
 * is idempotent (it guards with a status='active' updateMany check).
 */

import { NextResponse }       from 'next/server';
import { Redis }              from '@upstash/redis';
import { prisma }             from '@/lib/prisma';
import { isAuthorizedCron } from '@/lib/cronAuth';
import { sendPushToUser }     from '@/lib/push';
import { resolveBattle, resolveTeamBattle, todayUTC } from '@/lib/battleEngine';
import { awardBadgesForUser } from '@/lib/badgeEngine';
import type { AwardedBadge }  from '@/lib/badgeEngine';
import { mapWithConcurrency } from '@/lib/asyncBatch';

const redis = new Redis({
  url:   process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

/** Stash newly-awarded badges on Redis so the user's next sync (GET or POST)
 *  drains them and fires the que-badge-earned popup. This is the bridge that
 *  lets a cron-time award reach an in-app celebration without a session.
 *  7-day TTL gives infrequent users a comfortable window to see it; the badge
 *  itself stays in the DB regardless. */
async function queuePendingBadges(userId: string, awarded: AwardedBadge[]): Promise<void> {
  if (awarded.length === 0) return;
  const key      = `pending:badges:${userId}`;
  const existing = (await redis.get<AwardedBadge[]>(key)) ?? [];
  // Dedupe by slug — a user could earn the same threshold twice across cron
  // runs only if a badge was revoked in between (rare for battle badges, but
  // cheap to guard against).
  const seen     = new Set(existing.map(b => b.slug));
  const merged   = [...existing, ...awarded.filter(b => !seen.has(b.slug))];
  await redis.setex(key, 7 * 24 * 3600, JSON.stringify(merged));
}

interface Participant {
  id:       string;
  name:     string | null;
  username: string | null;
}

function displayName(p: Participant): string {
  return p.name ?? (p.username ? `@${p.username}` : 'your opponent');
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = todayUTC();

  // Find every typed battle whose window has ended. The composite
  // [status, endDate] index lets this stay cheap as the table grows.
  const due = await prisma.challenge.findMany({
    where: {
      status:  'active',
      type:    'typed',
      endDate: { lt: today },     // strict less-than: window must be fully past
    },
    select: {
      id:           true,
      challengerId: true,
      challengeeId: true,
      wager:        true,
      endDate:      true,
      challenger:   { select: { id: true, name: true, username: true } },
      challengee:   { select: { id: true, name: true, username: true } },
    },
    // Cap per-run work so a backlog after an outage doesn't time out the
    // serverless function. The next run picks up the rest 24h later.
    take: 200,
  });

  // Resolve battles with modest concurrency (5): each does a coin-transfer
  // transaction + winner badge eval (DB-bound, serialised by Prisma's pool) plus
  // fire-and-forget pushes. Kept lower than the push crons to avoid wallet
  // contention and thrashing the small connection pool. resolveBattle is
  // idempotent (status='active' guard), so concurrent runs are safe.
  const settled = await mapWithConcurrency(due, 5, async (c) => {
    const resolution = await resolveBattle(c.id);
    if (!resolution) return 'skipped' as const;   // already resolved, or invalid shape

    const challengerName = displayName(c.challenger);
    const challengeeName = displayName(c.challengee);
    const pot            = c.wager * 2;

    // Award any newly-earned badges to the winner (battle_first/5/10/20). Run
    // inline so we can name the badge in the push; errors are swallowed so a
    // badge failure doesn't fail the whole battle.
    const winnerId = resolution.winnerId;
    let battleBadgeNote = '';
    if (winnerId) {
      try {
        const awarded = await awardBadgesForUser(winnerId);
        if (awarded.length > 0) await queuePendingBadges(winnerId, awarded);
        const battleBadge = awarded.find(b => b.slug.startsWith('battle_'));
        if (battleBadge) battleBadgeNote = ` Earned “${battleBadge.label}”.`;
      } catch (e) {
        console.error(`[cron/resolve-battles] badge award failed for ${winnerId}:`, e);
      }
    }

    // Pushes are fire-and-forget — a push failure can't fail the battle.
    if (resolution.winnerId === c.challengerId) {
      sendPushToUser(c.challengerId, {
        title: `You won! 🏆`,
        body:  `Beat ${challengeeName} — ${pot} 🪙 added to your wallet.${battleBadgeNote}`,
        url:   '/',
      }).catch(() => {});
      sendPushToUser(c.challengeeId, {
        title: `Battle lost`,
        body:  `${challengerName} won the battle. Better luck next time.`,
        url:   '/',
      }).catch(() => {});
    } else if (resolution.winnerId === c.challengeeId) {
      sendPushToUser(c.challengeeId, {
        title: `You won! 🏆`,
        body:  `Beat ${challengerName} — ${pot} 🪙 added to your wallet.${battleBadgeNote}`,
        url:   '/',
      }).catch(() => {});
      sendPushToUser(c.challengerId, {
        title: `Battle lost`,
        body:  `${challengeeName} won the battle. Better luck next time.`,
        url:   '/',
      }).catch(() => {});
    } else {
      // Tie: both refunded their wager
      const tieBody = `Battle ended in a tie — ${c.wager} 🪙 refunded.`;
      sendPushToUser(c.challengerId, { title: 'Battle tied 🤝', body: tieBody, url: '/' }).catch(() => {});
      sendPushToUser(c.challengeeId, { title: 'Battle tied 🤝', body: tieBody, url: '/' }).catch(() => {});
    }
    return 'resolved' as const;
  });

  let resolved = 0;
  let failed   = 0;
  for (const s of settled) {
    if (s.status === 'rejected') { failed++; console.error('[cron/resolve-battles] failed:', s.reason); }
    else if (s.value === 'resolved') resolved++;
  }

  // ── Team battles ────────────────────────────────────────────────────────────
  // Resolve those whose window has fully passed; the [status,endDate] index keeps
  // this cheap. resolveTeamBattle is idempotent (status='active' guard).
  const dueTeam = await prisma.teamBattle.findMany({
    where:   { status: 'active', endDate: { lt: today } },
    include: { participants: { select: { userId: true, team: true } } },
    take:    200,
  });
  const teamSettled = await mapWithConcurrency(dueTeam, 5, async (tb) => {
    const res = await resolveTeamBattle(tb.id);
    if (!res) return 'skipped' as const;
    const pot = tb.wager * tb.participants.length;

    if (res.mode === 'teams') {
      const share = res.winningTeam !== null
        ? Math.floor(pot / tb.participants.filter(p => p.team === res.winningTeam).length)
        : 0;
      for (const p of tb.participants) {
        if (res.winningTeam === null) {
          sendPushToUser(p.userId, { title: 'Team battle tied 🤝', body: `Ended in a tie — ${tb.wager} 🪙 refunded.`, url: '/app' }).catch(() => {});
        } else if (p.team === res.winningTeam) {
          sendPushToUser(p.userId, { title: 'Your team won! 🏆', body: `Team battle won${tb.wager > 0 ? ` — ${share} 🪙 added to your wallet.` : '!'}`, url: '/app' }).catch(() => {});
        } else {
          sendPushToUser(p.userId, { title: 'Team battle lost', body: 'Your team came up short. Run it back!', url: '/app' }).catch(() => {});
        }
      }
    } else {
      // FFA — single winner takes the pot, or refund on tie.
      for (const p of tb.participants) {
        if (res.winnerId === null) {
          sendPushToUser(p.userId, { title: 'Battle tied 🤝', body: `FFA ended in a tie — ${tb.wager} 🪙 refunded.`, url: '/app' }).catch(() => {});
        } else if (p.userId === res.winnerId) {
          sendPushToUser(p.userId, { title: 'You won the FFA! 🏆', body: `Winner takes all${tb.wager > 0 ? ` — ${pot} 🪙 added to your wallet.` : '!'}`, url: '/app' }).catch(() => {});
        } else {
          sendPushToUser(p.userId, { title: 'FFA battle lost', body: 'Another player edged you out. Run it back!', url: '/app' }).catch(() => {});
        }
      }
    }
    return 'resolved' as const;
  });
  const teamResolved = teamSettled.filter(s => s.status === 'fulfilled' && s.value === 'resolved').length;

  // Cancel pending team battles whose window passed without everyone accepting →
  // refund anyone who already anted.
  const expiredTeam = await prisma.teamBattle.findMany({
    where:   { status: 'pending', endDate: { lt: today } },
    include: { participants: { select: { userId: true, accepted: true } } },
    take:    200,
  });
  let teamCancelled = 0;
  for (const tb of expiredTeam) {
    try {
      await prisma.$transaction(async tx => {
        const claimed = await tx.teamBattle.updateMany({ where: { id: tb.id, status: 'pending' }, data: { status: 'cancelled' } });
        if (claimed.count === 0) return;
        if (tb.wager > 0) {
          for (const p of tb.participants) {
            if (!p.accepted) continue;
            const w = await tx.coinWallet.upsert({ where: { userId: p.userId }, create: { userId: p.userId, balance: 0 }, update: {} });
            await tx.coinWallet.update({ where: { id: w.id }, data: { balance: { increment: tb.wager } } });
            await tx.coinTransaction.create({ data: { walletId: w.id, amount: tb.wager, reason: 'refund', refId: tb.id } });
          }
        }
      });
      teamCancelled++;
      for (const p of tb.participants) {
        if (p.accepted) sendPushToUser(p.userId, { title: 'Team battle expired', body: 'Not everyone joined in time — coins refunded.', url: '/app' }).catch(() => {});
      }
    } catch (e) {
      console.error(`[cron/resolve-battles] team expire failed for ${tb.id}:`, e);
    }
  }

  console.log(`[cron/resolve-battles] ${today} — resolved:${resolved} failed:${failed} scanned:${due.length} | team resolved:${teamResolved} cancelled:${teamCancelled}`);
  return NextResponse.json({ ok: true, date: today, resolved, failed, scanned: due.length, teamResolved, teamCancelled });
}
