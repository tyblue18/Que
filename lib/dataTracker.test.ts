/**
 * lib/dataTracker.test.ts
 *
 * Locks the SSRF guard on the user-supplied tracker URL: https only, public
 * hosts only (no loopback / private / link-local / metadata / CGNAT / IPv6),
 * no embedded credentials — and canonicalisation to a bare origin.
 */

import { describe, it, expect } from 'vitest';
import { normalizeTrackerUrl, TrackerError } from '@/lib/dataTracker';

const rejects = (u: string) => expect(() => normalizeTrackerUrl(u)).toThrow(TrackerError);

describe('normalizeTrackerUrl', () => {
  it('accepts a public https origin and strips path/query', () => {
    expect(normalizeTrackerUrl('https://my-tracker.vercel.app/dash?x=1')).toBe('https://my-tracker.vercel.app');
  });
  it('keeps a custom port', () => {
    expect(normalizeTrackerUrl('https://tracker.example.com:8443/')).toBe('https://tracker.example.com:8443');
  });
  it('allows a genuinely public IPv4 (172.15 is not private)', () => {
    expect(normalizeTrackerUrl('https://172.15.0.1')).toBe('https://172.15.0.1');
  });

  it('rejects http', () => rejects('http://my-tracker.vercel.app'));
  it('rejects localhost + .local', () => { rejects('https://localhost:3000'); rejects('https://box.local'); });
  it('rejects loopback 127.x', () => rejects('https://127.0.0.1'));
  it('rejects this-host 0.x', () => rejects('https://0.0.0.0'));
  it('rejects private 10.x', () => rejects('https://10.0.0.5'));
  it('rejects private 192.168.x', () => rejects('https://192.168.1.10'));
  it('rejects private 172.16–31.x', () => { rejects('https://172.16.0.1'); rejects('https://172.31.255.255'); });
  it('rejects link-local / cloud metadata 169.254.x', () => rejects('https://169.254.169.254'));
  it('rejects CGNAT 100.64–127.x', () => rejects('https://100.64.0.1'));
  it('rejects IPv6 literals', () => rejects('https://[::1]/'));
  it('rejects embedded credentials', () => rejects('https://user:pass@tracker.example.com'));
  it('rejects malformed input', () => { rejects('not a url'); rejects(''); });
});
