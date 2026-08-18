/**
 * lib/healthToken.ts
 *
 * The personal health-sync bearer token (settings.stepApiToken) — shared by the
 * token route (issue/rotate) and the data_tracker connect flow (auto-provision).
 */

import { prisma } from '@/lib/prisma';

export function generateHealthToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Return the user's token, generating + persisting one if it doesn't exist.
 *  Pass `rotate: true` to force a fresh token (invalidates the old one). */
export async function ensureHealthToken(userId: string, rotate = false): Promise<string> {
  const wd = await prisma.workoutData.findUnique({ where: { userId } });
  const settings = (wd?.settings ?? {}) as Record<string, unknown>;
  let token = settings.stepApiToken as string | undefined;

  if (!token || rotate) {
    token = generateHealthToken();
    await prisma.workoutData.upsert({
      where:  { userId },
      create: { userId, settings: { ...settings, stepApiToken: token } },
      update: { settings: { ...settings, stepApiToken: token } },
    });
  }
  return token;
}
