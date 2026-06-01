/**
 * lib/cronAuth.test.ts
 *
 * Locks the cron authorization contract — the property that matters is that it
 * FAILS CLOSED: a missing CRON_SECRET must reject everything (the old guard was
 * fail-open and silently exposed battle resolution + mass push to the public).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAuthorizedCron } from '@/lib/cronAuth';

const req = (authHeader?: string) =>
  new Request('http://x/api/cron/x', authHeader ? { headers: { authorization: authHeader } } : undefined);

const ORIGINAL = process.env.CRON_SECRET;
beforeEach(() => { process.env.CRON_SECRET = 'top-secret'; });
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe('isAuthorizedCron', () => {
  it('accepts the correct Bearer secret', () => {
    expect(isAuthorizedCron(req('Bearer top-secret'))).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(isAuthorizedCron(req('Bearer nope'))).toBe(false);
  });

  it('rejects a missing Authorization header', () => {
    expect(isAuthorizedCron(req())).toBe(false);
  });

  it('rejects a non-Bearer scheme even with the right value', () => {
    expect(isAuthorizedCron(req('top-secret'))).toBe(false);
  });

  it('FAILS CLOSED when CRON_SECRET is not configured', () => {
    delete process.env.CRON_SECRET;
    expect(isAuthorizedCron(req('Bearer top-secret'))).toBe(false);
    expect(isAuthorizedCron(req('Bearer '))).toBe(false);
    expect(isAuthorizedCron(req())).toBe(false);
  });

  it('rejects an empty configured secret (treated as unset)', () => {
    process.env.CRON_SECRET = '';
    expect(isAuthorizedCron(req('Bearer '))).toBe(false);
  });
});
