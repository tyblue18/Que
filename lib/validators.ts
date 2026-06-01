/**
 * lib/validators.ts
 *
 * Zod schemas for every API route that accepts a request body or query param.
 * Import the schema in the route, call .safeParse(), and return 400 on failure.
 */

import { z } from 'zod';

// ── Reusable primitives ───────────────────────────────────────────────────────

/** Cuid / nanoid IDs used as Prisma primary keys */
const id = z.string().min(1).max(128);

/** Arbitrary JSON object (top-level only — we don't deep-validate blobs) */
const jsonObject = z.record(z.string(), z.unknown());

// ── /api/sync POST ────────────────────────────────────────────────────────────

export const syncPostSchema = z.object({
  localDB:  jsonObject.optional(),
  profile:  jsonObject.optional(),
  settings: jsonObject.optional(),
});

// ── /api/friends POST ─────────────────────────────────────────────────────────

export const friendPostSchema = z.object({
  username: z.string().min(1).max(50),
});

// ── /api/friends DELETE ───────────────────────────────────────────────────────

export const friendDeleteSchema = z.object({
  friendshipId: id,
});

// ── /api/friends/respond POST ─────────────────────────────────────────────────

export const friendRespondSchema = z.object({
  friendshipId: id,
  accept:       z.boolean(),
});

// ── /api/challenges POST ──────────────────────────────────────────────────────

// YYYY-MM-DD — strict shape; deeper validity (real date, not in past, etc.)
// happens in the route handler where today's date is known.
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const challengePostSchema = z.object({
  friendId:   id,
  // 0 = a "bragging rights" battle (no coins on the line), matching team battles.
  wager:      z.number().int().min(0).max(100_000),
  // ── Typed-battle fields (optional for backward compat with the classic
  //    badge-count battles created without these set; new clients send them) ──
  bestOf:     z.union([z.literal(1), z.literal(3), z.literal(5)]).optional(),
  windowKind: z.enum(['day', '3day', 'week']).optional(),
  startDate:  dateString.optional(),
  // 1, 3, or 5 category slugs; must match bestOf length when both are present.
  categories: z.array(z.string().min(1).max(64)).min(1).max(5).optional(),
});

// ── /api/challenges/[id] POST ─────────────────────────────────────────────────

export const challengeActionSchema = z.object({
  action: z.enum(['accept', 'decline']),
});

// ── /api/user PATCH ───────────────────────────────────────────────────────────

export const userPatchSchema = z.object({
  username:         z.string().min(3).max(20).optional(),
  status:           z.string().max(60).nullable().optional(),
  statusDuration:   z.enum(['24h', 'forever', 'clear']).optional(),
  showcaseBadges:   z.array(z.string().max(100)).max(8).optional(),
  leaderboardOptIn: z.boolean().optional(),
});

// ── /api/invite/redeem POST ───────────────────────────────────────────────────

export const inviteRedeemSchema = z.object({
  // The inviter's username. Length-bounded here; full username-shape validation
  // (and the self/dedupe checks) happen in the route + lib/invite normaliser.
  code: z.string().min(1).max(40),
});

// ── /api/team-battles ─────────────────────────────────────────────────────────

const teamBattleCommon = {
  groupId:    id,
  wager:      z.number().int().min(0).max(100_000),
  bestOf:     z.union([z.literal(1), z.literal(3), z.literal(5)]),
  windowKind: z.enum(['day', '3day', 'week']),
  startDate:  dateString,
  categories: z.array(z.string().min(1).max(64)).min(1).max(5),
} as const;

export const teamBattleCreateSchema = z.discriminatedUnion('mode', [
  z.object({
    ...teamBattleCommon,
    mode:  z.literal('teams'),
    teamA: z.array(id).min(1).max(6),
    teamB: z.array(id).min(1).max(6),
  }),
  z.object({
    ...teamBattleCommon,
    mode:         z.literal('ffa'),
    participants: z.array(id).min(2).max(12),
  }),
]);

export const teamBattleActionSchema = z.object({
  action: z.enum(['accept', 'decline', 'cancel']),
});

// ── /api/posts (group feed) ─────────────────────────────────────────────────

export const postCreateSchema = z.object({
  groupIds: z.array(id).min(1).max(20),
  date:     dateString,
  payload:  jsonObject,          // workout snapshot, stored as-is
  note:     z.string().max(280).optional(),
});

export const commentCreateSchema = z.object({
  text: z.string().min(1).max(280),
});

// ── /api/groups ───────────────────────────────────────────────────────────────

export const groupCreateSchema = z.object({
  name:        z.string().min(1).max(40),
  description: z.string().max(200).optional(),
  memberIds:   z.array(id).max(20).optional(),
});

export const groupRenameSchema = z.object({
  name: z.string().min(1).max(40),
});

// PATCH /api/groups/[id] — rename and/or edit description (owner only).
export const groupUpdateSchema = z.object({
  name:        z.string().min(1).max(40).optional(),
  description: z.string().max(200).nullable().optional(),
}).refine(d => d.name !== undefined || d.description !== undefined, { message: 'Nothing to update' });

export const groupMemberSchema = z.object({
  userId: id,
});

// ── /api/wallet POST (coin import) ────────────────────────────────────────────

export const walletImportSchema = z.object({
  balance: z.number().int().min(0).max(100_000),
});

// ── /api/push/subscribe POST ──────────────────────────────────────────────────

export const pushSubscribeSchema = z.object({
  // Push endpoints are URLs that can run long on mobile (Apple Web Push, FCM).
  // 500 was too tight and silently 400'd valid mobile subscriptions; 2048 is a
  // safe URL ceiling.
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth:   z.string().min(1).max(100),
  }),
});

// ── /api/push/subscribe DELETE ────────────────────────────────────────────────

export const pushDeleteSchema = z.object({
  endpoint: z.string().min(1).max(2048),
});

// ── /api/food/search GET (?q=) ────────────────────────────────────────────────

export const foodSearchSchema = z.object({
  q: z.string().min(1).max(200),
});

// ── /api/feedback POST (user suggestions) ──────────────────────────────────────

export const feedbackSchema = z.object({
  message: z.string().trim().min(1).max(1000),
});

// ── /api/food/parse POST (natural-language meal → structured items) ─────────────
// Input is capped tight: this feeds an LLM, so the bound is a cost ceiling, not
// just hygiene. One short sentence is all the feature needs.
export const foodParseSchema = z.object({
  text: z.string().trim().min(1).max(300),
});
