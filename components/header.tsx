'use client';

/**
 * AuthHeader — Athletic command bar
 * All visual rules live in .auth-* classes in app/globals.css.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSession, signOut } from 'next-auth/react';
import Image from 'next/image';
import Link from 'next/link';
import {
  applyAccent, applyBg, applyTheme,
  ACCENT_KEY, BG_KEY, LIGHT_BG_KEY, THEME_KEY,
  ACCENT_SWATCHES, BG_PRESETS, LIGHT_BG_PRESETS,
  type BgPreset, type Theme,
} from '@/lib/colorScheme';
import { pushNow }         from '@/lib/syncEngine';
import { PushPermission }  from '@/components/PushPermission';

import {
  PROFILE_PHOTO_KEY as PHOTO_KEY,
  ATHLETE_PLAN_KEY as PLAN_KEY,
  DB_KEY,
  PROFILE_KEY,
  WORKOUT_PRESETS_KEY,
  EXERCISE_USAGE_KEY,
  LIFT_PRS_KEY,
} from '@/lib/constants';

interface PlanData {
  type: string; intensity: string; dailyKcal: number;
  startDate: string; startWeight: number; goalWeight: number; weeksTarget: number;
}
function loadPlanData(): PlanData | null {
  try { const r = localStorage.getItem(PLAN_KEY); return r ? JSON.parse(r) as PlanData : null; }
  catch { return null; }
}

function compressPhoto(file: File): Promise<string> {
  return new Promise(resolve => {
    const img = document.createElement('img');
    img.onload = () => {
      const SIZE = 200;
      const canvas = document.createElement('canvas');
      canvas.width = SIZE; canvas.height = SIZE;
      const ctx = canvas.getContext('2d')!;
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  });
}

function GitHubMark({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function AuthSkeleton() {
  return (
    <div
      className="auth-skeleton"
      role="status"
      aria-label="Loading authentication state"
    />
  );
}

function SignInButton() {
  return (
    <button
      type="button"
      onClick={() => window.location.href = '/auth/signin'}
      className="auth-signin-btn"
      aria-label="Sign in to sync your data"
    >
      Sign in to sync
    </button>
  );
}

interface UserPillProps {
  image: string | null | undefined;
  name:  string | null | undefined;
  email: string | null | undefined;
}

function UserPill({ image, name, email }: UserPillProps) {
  const displayName = name ?? email ?? 'Athlete';
  const [localPhoto, setLocalPhoto]   = useState<string | null>(null);
  const [open, setOpen]               = useState(false);
  const [view, setView]               = useState<'menu' | 'settings' | 'scheme' | 'start' | 'feedback'>('menu');
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackState, setFeedbackState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [accentHex, setAccentHex]     = useState('#4FC3F7');
  const [bgLabel, setBgLabel]         = useState('Charcoal');
  const [theme, setTheme]             = useState<Theme>('dark');
  const [plan,      setPlan]          = useState<PlanData | null>(null);
  const [username,  setUsername]      = useState<string | null>(null);
  const [copied,    setCopied]        = useState(false);
  const [editWeight, setEditWeight]   = useState('');
  const [editDate,   setEditDate]     = useState('');
  const [startSaved, setStartSaved]   = useState(false);
  const [uploading,  setUploading]    = useState(false);
  const pillRef      = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLocalPhoto(localStorage.getItem(PHOTO_KEY));
    const refresh = () => setLocalPhoto(localStorage.getItem(PHOTO_KEY));
    window.addEventListener('queProfilePhotoChanged', refresh);
    window.addEventListener('storage', refresh);

    const storedAccent = localStorage.getItem(ACCENT_KEY);
    if (storedAccent) setAccentHex(storedAccent);
    const storedTheme = (localStorage.getItem(THEME_KEY) ?? 'dark') as Theme;
    setTheme(storedTheme);
    const storedBg = localStorage.getItem(
      storedTheme === 'light' ? LIGHT_BG_KEY : BG_KEY
    );
    if (storedBg) setBgLabel(storedBg);

    return () => {
      window.removeEventListener('queProfilePhotoChanged', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  useEffect(() => {
    if (!open) { setView('menu'); setStartSaved(false); setCopied(false); setFeedbackText(''); setFeedbackState('idle'); return; }
    const p = loadPlanData();
    setPlan(p);
    if (p) { setEditWeight(String(p.startWeight)); setEditDate(p.startDate); }
    if (!username) {
      fetch('/api/user').then(r => r.ok ? r.json() : null).then(d => {
        if (d?.username) setUsername(d.username as string);
      }).catch(() => {});
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (pillRef.current && !pillRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handlePhotoSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const compressed = await compressPhoto(file);
      let url = compressed;
      try {
        const res  = await fetch(compressed);
        const blob = await res.blob();
        const form = new FormData();
        form.append('photo', new File([blob], 'photo.jpg', { type: 'image/jpeg' }));
        const data = await fetch('/api/profile/photo', { method: 'POST', body: form })
          .then(r => r.ok ? r.json() : null) as { url?: string } | null;
        if (data?.url) url = data.url;
      } catch { /* blob upload failed — keep base64 fallback */ }
      localStorage.setItem(PHOTO_KEY, url);
      setLocalPhoto(url);
      window.dispatchEvent(new Event('queProfilePhotoChanged'));
      pushNow({});
    } finally {
      setUploading(false);
      e.target.value = '';
      setOpen(false);
    }
  }, []);

  const handleAccentChange = useCallback((hex: string) => {
    setAccentHex(hex);
    applyAccent(hex);
    localStorage.setItem(ACCENT_KEY, hex);
  }, []);

  const handleBgChange = useCallback((preset: BgPreset) => {
    setBgLabel(preset.label);
    applyBg(preset);
    localStorage.setItem(
      document.documentElement.getAttribute('data-theme') === 'light' ? LIGHT_BG_KEY : BG_KEY,
      preset.label,
    );
  }, []);

  const handleThemeChange = useCallback((newTheme: Theme) => {
    setTheme(newTheme);
    applyTheme(newTheme);
    localStorage.setItem(THEME_KEY, newTheme);
    // Restore the saved bg preset for this theme, or default to first option
    const bgKey   = newTheme === 'light' ? LIGHT_BG_KEY : BG_KEY;
    const presets = newTheme === 'light' ? LIGHT_BG_PRESETS : BG_PRESETS;
    const stored  = localStorage.getItem(bgKey);
    const preset  = presets.find(p => p.label === stored) ?? presets[0];
    applyBg(preset);
    setBgLabel(preset.label);
    // Re-apply accent so glow opacity recalculates for new theme
    applyAccent(accentHex);
  }, [accentHex]);

  const handleSavePlanStart = useCallback(() => {
    const current = loadPlanData();
    if (!current) return;
    const w = parseFloat(editWeight);
    if (!editWeight || isNaN(w) || !editDate) return;
    const updated = { ...current, startWeight: w, startDate: editDate };
    localStorage.setItem(PLAN_KEY, JSON.stringify(updated));
    window.dispatchEvent(new Event('storage'));
    setPlan(updated);
    setStartSaved(true);
    pushNow({});
  }, [editWeight, editDate]);

  const avatarSrc = localPhoto ?? image;

  return (
    <div className="auth-pill-wrapper" ref={pillRef}>
      <button
        type="button"
        className="auth-user-pill"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen(v => !v)}
      >
        {avatarSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarSrc} alt={`${displayName} profile picture`} className="auth-avatar" />
        ) : (
          <span className="auth-avatar-placeholder" aria-hidden="true">
            {displayName.charAt(0).toUpperCase()}
          </span>
        )}
        <span className="auth-user-name" title={email ?? undefined}>{displayName}</span>
        <svg className="auth-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      </button>

      {open && (
        <div className={`auth-dropdown${view === 'scheme' || view === 'start' || view === 'feedback' ? ' auth-dropdown--wide' : ''}`} role="menu">

          {view === 'menu' ? (
            <>
              <div className="px-3 py-2">
                <PushPermission />
              </div>

              <div className="auth-dropdown-divider" />

              <button type="button" role="menuitem" className="auth-dropdown-item"
                onClick={() => { setOpen(false); window.dispatchEvent(new Event('que-open-athlete-profile')); }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                </svg>
                Athlete Profile
              </button>

              <button type="button" role="menuitem" className="auth-dropdown-item"
                onClick={() => setView('settings')}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
                Settings
              </button>

              {username && (
                <button type="button" role="menuitem" className="auth-dropdown-item"
                  onClick={async () => {
                    const url = `${window.location.origin}/profile/${username}`;
                    if (navigator.share) {
                      try { await navigator.share({ title: 'My Que Profile', url }); }
                      catch { /* dismissed */ }
                    } else {
                      await navigator.clipboard.writeText(url);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }
                  }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                  </svg>
                  {copied ? 'Link copied!' : 'Share profile'}
                </button>
              )}

              <Link href="/about" role="menuitem" className="auth-dropdown-item"
                onClick={() => setOpen(false)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                </svg>
                About &amp; Support
              </Link>

              <button type="button" role="menuitem" className="auth-dropdown-item"
                onClick={() => setView('feedback')}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                Send Suggestions
              </button>

              <div className="auth-dropdown-divider" />

              <button type="button" role="menuitem" className="auth-dropdown-item auth-dropdown-item--danger"
                onClick={() => { setOpen(false); signOut({ callbackUrl: '/' }); }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                  <polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
                Sign out
              </button>
            </>
          ) : view === 'settings' ? (
            <>
              <button type="button" className="auth-scheme-back" onClick={() => setView('menu')}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
                Settings
              </button>

              <div className="auth-dropdown-divider" />

              <button type="button" role="menuitem" className="auth-dropdown-item"
                onClick={() => !uploading && fileInputRef.current?.click()}
                disabled={uploading} style={{ opacity: uploading ? 0.6 : undefined }}>
                {uploading ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="animate-spin">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                  </svg>
                )}
                {uploading ? 'Uploading…' : 'Change photo'}
              </button>

              <button type="button" role="menuitem" className="auth-dropdown-item"
                onClick={() => setView('scheme')}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
                  <path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>
                </svg>
                Color scheme
              </button>

              {plan && (
                <button type="button" role="menuitem" className="auth-dropdown-item"
                  onClick={() => setView('start')}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                  Fix plan start
                </button>
              )}

              <button type="button" role="menuitem" className="auth-dropdown-item"
                onClick={() => {
                  setOpen(false);
                  try {
                    const db       = JSON.parse(localStorage.getItem(DB_KEY) ?? '{}');
                    const profile  = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? '{}');
                    const settings: Record<string, unknown> = {};
                    [PLAN_KEY, WORKOUT_PRESETS_KEY, EXERCISE_USAGE_KEY, LIFT_PRS_KEY].forEach(k => {
                      const v = localStorage.getItem(k);
                      if (v) try { settings[k] = JSON.parse(v); } catch { settings[k] = v; }
                    });
                    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), profile, settings, localDB: db }, null, 2)], { type: 'application/json' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `que-data-${new Date().toISOString().slice(0,10)}.json`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                  } catch { /* silent */ }
                }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Export data
              </button>
            </>
          ) : view === 'start' ? (
            <>
              <button type="button" className="auth-scheme-back" onClick={() => { setView('settings'); setStartSaved(false); }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
                Fix plan start
              </button>

              <div className="auth-dropdown-divider" />

              <div className="px-3 py-2.5 space-y-3">
                {/* Warning */}
                <div className="rounded border border-[var(--warn)]/40 bg-[var(--warn)]/8 px-2.5 py-2">
                  <p className="font-mono text-[9px] text-[var(--warn)] leading-relaxed tracking-[0.3px]">
                    Only use if your original start date or weight was entered incorrectly. Overwrites the plan baseline and resets progress calculations.
                  </p>
                </div>

                {/* Start weight */}
                <div>
                  <label className="font-mono text-[9px] font-bold tracking-[1.5px] uppercase text-[var(--ink-3)] block mb-1">
                    Start weight / lbs
                  </label>
                  <input
                    type="number" inputMode="decimal"
                    value={editWeight}
                    onChange={e => setEditWeight(e.target.value)}
                    className="w-full bg-[var(--bg-3)] border border-[var(--line-2)] rounded-sm px-2.5 py-1.5 font-mono text-[11px] text-[var(--ink-0)] focus:outline-none focus:border-[var(--accent)] transition-colors"
                  />
                </div>

                {/* Start date */}
                <div>
                  <label className="font-mono text-[9px] font-bold tracking-[1.5px] uppercase text-[var(--ink-3)] block mb-1">
                    Start date
                  </label>
                  <input
                    type="date"
                    value={editDate}
                    onChange={e => setEditDate(e.target.value)}
                    className="w-full bg-[var(--bg-3)] border border-[var(--line-2)] rounded-sm px-2.5 py-1.5 font-mono text-[11px] text-[var(--ink-0)] focus:outline-none focus:border-[var(--accent)] transition-colors"
                  />
                </div>

                {startSaved ? (
                  <p className="font-mono text-[9px] text-[var(--positive)] tracking-[0.5px] text-center py-1">
                    ✓ Plan start updated
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={handleSavePlanStart}
                    disabled={!editWeight || !editDate}
                    className="w-full font-mono text-[10px] font-bold tracking-[1px] uppercase py-2 rounded-sm border border-[var(--warn)]/60 text-[var(--warn)] hover:bg-[var(--warn)]/10 transition-all disabled:opacity-40"
                  >
                    Update plan start
                  </button>
                )}
              </div>
            </>
          ) : view === 'feedback' ? (
            <>
              <button type="button" className="auth-scheme-back" onClick={() => setView('menu')}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
                Send Suggestions
              </button>

              <div className="auth-dropdown-divider" />

              <div className="px-3 py-2">
                <p className="font-mono text-[10px] text-[var(--ink-3)] leading-relaxed tracking-[0.3px] mb-2">
                  Got an idea or found a bug? Send it straight to the developer.
                </p>
                <textarea
                  value={feedbackText}
                  onChange={e => { setFeedbackText(e.target.value); if (feedbackState !== 'idle') setFeedbackState('idle'); }}
                  maxLength={1000}
                  rows={4}
                  placeholder="Your suggestion…"
                  className="w-full rounded-sm border border-[var(--line-2)] bg-[var(--bg-2)] p-2 font-mono text-[11px] text-[var(--ink-1)] placeholder:text-[var(--ink-3)] resize-none focus:outline-none focus:border-[var(--accent)] transition-colors"
                />
                <div className="flex items-center justify-between mt-1">
                  <span className="font-mono text-[8px] text-[var(--ink-3)]">{feedbackText.length}/1000</span>
                  {feedbackState === 'sent'  && <span className="font-mono text-[8px] text-[var(--accent)]">Thanks — sent! 🎉</span>}
                  {feedbackState === 'error' && <span className="font-mono text-[8px] text-[var(--danger)]">Couldn’t send — try again</span>}
                </div>
                <button
                  type="button"
                  disabled={!feedbackText.trim() || feedbackState === 'sending'}
                  onClick={async () => {
                    setFeedbackState('sending');
                    try {
                      const res = await fetch('/api/feedback', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({ message: feedbackText.trim() }),
                      });
                      if (!res.ok) throw new Error('failed');
                      setFeedbackState('sent');
                      setFeedbackText('');
                      setTimeout(() => { setOpen(false); }, 1200);
                    } catch {
                      setFeedbackState('error');
                    }
                  }}
                  className="w-full mt-2 font-mono text-[10px] font-bold tracking-[1px] uppercase py-2 rounded-sm bg-[var(--accent)] text-[var(--bg-0)] hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  {feedbackState === 'sending' ? 'Sending…' : feedbackState === 'sent' ? 'Sent ✓' : 'Send suggestion'}
                </button>
              </div>
            </>
          ) : (
            <>
              <button type="button" className="auth-scheme-back" onClick={() => setView('settings')}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
                Color scheme
              </button>

              <div className="auth-dropdown-divider" />

              {/* Light / dark toggle */}
              <div className="flex items-center justify-between px-[10px] py-2">
                <p className="font-mono text-[9px] font-bold tracking-[1.5px] uppercase text-[var(--ink-3)] m-0">Mode</p>
                <button
                  type="button"
                  onClick={() => handleThemeChange(theme === 'dark' ? 'light' : 'dark')}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-[var(--line-2)] bg-[var(--bg-3)] font-mono text-[10px] font-semibold text-[var(--ink-1)] hover:border-[var(--accent)] hover:text-[var(--ink-0)] transition-all"
                >
                  {theme === 'dark' ? (
                    <>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="5"/>
                        <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
                        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                        <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
                        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                      </svg>
                      Light
                    </>
                  ) : (
                    <>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                      </svg>
                      Dark
                    </>
                  )}
                </button>
              </div>

              <div className="auth-dropdown-divider" />

              <p className="auth-scheme-label">Accent</p>
              <div className="auth-swatch-grid">
                {ACCENT_SWATCHES.map(s => (
                  <button
                    key={s.hex}
                    type="button"
                    className={`auth-swatch${accentHex === s.hex ? ' auth-swatch--active' : ''}`}
                    style={{ background: s.hex }}
                    title={s.label}
                    onClick={() => handleAccentChange(s.hex)}
                  />
                ))}
                <label className="auth-swatch auth-swatch--rainbow" title="Custom color">
                  <input
                    type="color"
                    value={accentHex}
                    onChange={e => handleAccentChange(e.target.value)}
                  />
                </label>
              </div>

              <div className="auth-dropdown-divider" />

              <p className="auth-scheme-label">Background</p>
              <div className="auth-bg-grid">
                {(theme === 'light' ? LIGHT_BG_PRESETS : BG_PRESETS).map(p => (
                  <button
                    key={p.label}
                    type="button"
                    className={`auth-bg-swatch${bgLabel === p.label ? ' auth-bg-swatch--active' : ''}`}
                    style={{ background: p.bg2 }}
                    onClick={() => handleBgChange(p)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <input ref={fileInputRef} type="file" accept="image/*" className="auth-file-input" onChange={handlePhotoSelect} />
    </div>
  );
}

export function AuthHeader() {
  const { data: session, status } = useSession();

  return (
    <header className="auth-header" role="banner">
      <div className="auth-header-inner">
        <span className="auth-wordmark" aria-label="Que">
          <Image
            src="/Que_logo.png"
            alt=""
            width={32}
            height={32}
            className="auth-logo-img"
            priority
          />
          QUE
        </span>

        <div className="auth-controls" aria-live="polite" aria-atomic="true">
          {status === 'loading' && <AuthSkeleton />}
          {status === 'unauthenticated' && <SignInButton />}
          {status === 'authenticated' && session?.user && (
            <UserPill
              image={session.user.image}
              name={session.user.name}
              email={session.user.email}
            />
          )}
        </div>
      </div>
    </header>
  );
}
