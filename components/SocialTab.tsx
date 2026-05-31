'use client';

import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { AnimatePresence, motion }                   from 'framer-motion';
import {
  Users, UserPlus, X, Check, Swords, Clock,
  Bike, Dumbbell, Utensils, AlertTriangle,
} from 'lucide-react';
import dynamic                                       from 'next/dynamic';
import ProfileCard, { type PublicProfile }           from '@/components/ProfileCard';
import { InviteFriends }                              from '@/components/social/InviteFriends';
import { BeatLastWeek }                                from '@/components/social/BeatLastWeek';
import { Groups }                                     from '@/components/social/Groups';
import { TeamBattles }                               from '@/components/social/TeamBattles';
import {
  COIN_KEY, PROFILE_PHOTO_KEY, SOCIAL_ANIM_KEY, COINS_MIGRATED_KEY,
} from '@/lib/constants';
import {
  BATTLE_CATEGORIES, type BattleCategory, type CategoryGroup,
} from '@/lib/battle-categories';
import type { BattleResolution, CategoryResult } from '@/lib/battleEngine';
import { trackEvent } from '@/lib/telemetry';
import { useApp } from '@/lib/AppContext';

// Lottie + its JSON payloads are only used by the loading spinner that
// briefly shows on first mount. Defer the library + JSON until they're
// actually needed so the rest of the tab can hydrate sooner.
const Lottie = dynamic(() => import('lottie-react'), { ssr: false });

const LOADING_ANIM_LOADERS: Array<() => Promise<{ default: unknown }>> = [
  () => import('@/public/loading1_animation.json'),
  () => import('@/public/loading2_animation.json'),
  () => import('@/public/loading3_animation.json'),
];

// ── Types ──────────────────────────────────────────────────────────────────────

interface FriendData {
  id:           string;
  friendshipId: string;
  name:         string | null;
  username:     string | null;
  badgeCount:   number;
  photo:        string | null;
  status:       string | null;
}

interface PendingData {
  id:           string;
  friendshipId: string;
  name:         string | null;
  username:     string | null;
}

interface ChallengeData {
  id:         string;
  wager:      number;
  status:     string;
  winnerId:   string | null;
  resolvedAt: string | null;
  createdAt:  string;
  challenger: { id: string; name: string | null; username: string | null };
  challengee: { id: string; name: string | null; username: string | null };
  // Typed-battle fields — present when a typed battle was created (null on
  // legacy badge-count battles, which still resolve instantly on accept).
  type?:        'typed' | 'classic' | null;
  bestOf?:      number | null;
  windowKind?:  'day' | '3day' | 'week' | null;
  startDate?:   string | null;
  endDate?:     string | null;
  categories?:  string[] | null;
  resolution?:  BattleResolution | null;
}

// ── Date helpers (client local time, matching how DayRecord.date is built) ────

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDaysISO(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function daysBetween(aStr: string, bStr: string): number {
  const [ya, ma, da] = aStr.split('-').map(Number);
  const [yb, mb, db] = bStr.split('-').map(Number);
  const a = new Date(ya, ma - 1, da).getTime();
  const b = new Date(yb, mb - 1, db).getTime();
  return Math.round((b - a) / 86_400_000);
}

function fmtMonthDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtRange(startDate: string, endDate: string): string {
  if (startDate === endDate) return fmtMonthDay(startDate);
  return `${fmtMonthDay(startDate)} – ${fmtMonthDay(endDate)}`;
}

/** Wager chip text: "5 🪙" for a real stake, "Free" for a bragging-rights battle. */
function wagerChip(w: number): string {
  return w > 0 ? `${w} 🪙` : 'Free';
}

/** Human-readable status for an active battle ("Day 3 of 7", "Starts tomorrow", "Resolving…"). */
function battleProgressLabel(startDate: string, endDate: string): string {
  const today = localToday();
  if (today < startDate) {
    const n = daysBetween(today, startDate);
    if (n === 1) return 'Starts tomorrow';
    return `Starts in ${n} days`;
  }
  if (today > endDate) return 'Resolving…';
  const total = daysBetween(startDate, endDate) + 1;
  const dayN  = daysBetween(startDate, today) + 1;
  if (total === 1) return 'Ends tonight';
  return `Day ${dayN} of ${total}`;
}

// ── Profile stat-rail computations (own profile, from localDB) ────────────────

function dStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Current consecutive-day workout streak ending today (today may be unlogged — grace). */
function currentWorkoutStreak(localDB: Record<string, { exercises?: string }>): number {
  const has = (ds: string) => String(localDB[ds]?.exercises ?? '').length > 2;
  const cursor = new Date();
  if (!has(dStr(cursor))) cursor.setDate(cursor.getDate() - 1); // today not logged yet → start at yesterday
  let count = 0;
  for (let i = 0; i < 400; i++) {
    if (!has(dStr(cursor))) break;
    count++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

/** Total lift volume (reps × weight) over the last 7 days incl. today. */
function weekLiftVolume(localDB: Record<string, { exercises?: string }>): number {
  const num = (v: unknown) => { const n = parseFloat(String(v ?? '0')); return Number.isFinite(n) ? n : 0; };
  let total = 0;
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const raw = localDB[dStr(d)]?.exercises;
    if (!raw) continue;
    try {
      const exs = JSON.parse(String(raw));
      if (!Array.isArray(exs)) continue;
      for (const ex of exs) {
        if ((ex as { k?: string }).k !== 'lift') continue;
        const e = ex as { sets?: Array<{ r?: unknown; w?: unknown }>; s?: unknown; r?: unknown; w?: unknown };
        const sets = Array.isArray(e.sets)
          ? e.sets
          : Array.from({ length: parseInt(String(e.s ?? '1')) || 1 }, () => ({ r: e.r, w: e.w }));
        for (const s of sets) total += num(s.r) * num(s.w);
      }
    } catch { /* skip corrupt day */ }
  }
  return total;
}

// ── Challenge modal ────────────────────────────────────────────────────────────

type WindowPreset = 'today' | 'tomorrow' | 'past_week' | 'next_week' | 'custom';

interface WindowPresetEntry {
  id:    WindowPreset;
  label: string;
  sub:   string;
}

const WINDOW_PRESETS: WindowPresetEntry[] = [
  { id: 'next_week', label: 'Next 7 days', sub: 'starts today' },
  { id: 'today',     label: 'Today',       sub: 'ends tonight' },
  { id: 'tomorrow',  label: 'Tomorrow',    sub: 'one day' },
  { id: 'past_week', label: 'Past 7 days', sub: 'retrospective' },
  { id: 'custom',    label: 'Custom',      sub: 'pick a start date' },
];

const GROUP_META: Record<CategoryGroup, { label: string; Icon: typeof Bike; color: string }> = {
  cardio: { label: 'Cardio', Icon: Bike,     color: '#60A5FA' },
  lift:   { label: 'Lift',   Icon: Dumbbell, color: '#F59E0B' },
  diet:   { label: 'Diet',   Icon: Utensils, color: '#A78BFA' },
};

/** Small uppercase section label used throughout the ChallengeModal. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-[9px] font-bold tracking-[2px] uppercase text-[var(--ink-3)]">
      {children}
    </p>
  );
}

function presetToWindow(
  preset:      WindowPreset,
  customStart: string,
  customKind:  'day' | '3day' | 'week',
): { startDate: string; windowKind: 'day' | '3day' | 'week' } {
  const today = localToday();
  switch (preset) {
    case 'today':     return { startDate: today,                 windowKind: 'day' };
    case 'tomorrow':  return { startDate: addDaysISO(today,  1), windowKind: 'day' };
    case 'past_week': return { startDate: addDaysISO(today, -6), windowKind: 'week' };
    case 'next_week': return { startDate: today,                 windowKind: 'week' };
    case 'custom':    return { startDate: customStart,           windowKind: customKind };
  }
}

const BEST_OF_OPTIONS = [1, 3, 5] as const;
const GROUP_ORDER: CategoryGroup[] = ['cardio', 'lift', 'diet'];
const GROUP_LABELS: Record<CategoryGroup, string> = {
  cardio: 'Cardio',
  lift:   'Lift',
  diet:   'Diet',
};

function ChallengeModal({ friend, myBalance, onClose, onSent }: {
  friend:    FriendData;
  myBalance: number;
  onClose:   () => void;
  onSent:    () => void;
}) {
  // ── Form state ──────────────────────────────────────────────────────────
  // Default to a forward window so two fresh users compete going forward rather
  // than on empty history (a past-week battle fails the "must have logged" check
  // for brand-new accounts).
  const [preset,        setPreset]        = useState<WindowPreset>('next_week');
  const [customStart,   setCustomStart]   = useState(localToday());
  const [customKind,    setCustomKind]    = useState<'day' | '3day' | 'week'>('day');
  const [bestOf,        setBestOf]        = useState<1 | 3 | 5>(1);
  const [selectedCats,  setSelectedCats]  = useState<string[]>([]);
  // Default to a small wager when the user has coins, else 0 (bragging rights) so
  // a broke user can still send a challenge with one tap.
  const [wager,         setWager]         = useState(Math.max(0, Math.min(3, myBalance)));
  const [sending,       setSending]       = useState(false);
  const [error,         setError]         = useState('');

  // When bestOf shrinks, drop categories beyond the new limit.
  useEffect(() => {
    setSelectedCats(cur => (cur.length > bestOf ? cur.slice(0, bestOf) : cur));
  }, [bestOf]);

  const max     = Math.max(0, myBalance);
  const win     = presetToWindow(preset, customStart, customKind);
  const canSend =
    wager >= 0 && wager <= max &&
    selectedCats.length === bestOf;

  // Surface any safety notes for currently-selected categories.
  const safetyNotes = useMemo(() => {
    const seen = new Set<string>();
    const notes: string[] = [];
    for (const slug of selectedCats) {
      const cat = BATTLE_CATEGORIES.find(c => c.slug === slug);
      if (cat?.safetyNote && !seen.has(cat.safetyNote)) {
        seen.add(cat.safetyNote);
        notes.push(cat.safetyNote);
      }
    }
    return notes;
  }, [selectedCats]);

  const toggleCat = (slug: string) => {
    setSelectedCats(cur => {
      if (cur.includes(slug)) return cur.filter(s => s !== slug);
      if (cur.length >= bestOf) return cur;     // at limit — ignore
      return [...cur, slug];
    });
  };

  const send = async () => {
    setSending(true); setError('');
    const res = await fetch('/api/challenges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        friendId:   friend.id,
        wager,
        bestOf,
        windowKind: win.windowKind,
        startDate:  win.startDate,
        categories: selectedCats,
      }),
    });
    const data = await res.json();
    setSending(false);
    if (res.ok) { onSent(); onClose(); }
    else        { setError(data.error ?? 'Failed to send challenge'); }
  };

  return (
    <motion.div
      className="fixed inset-0 z-[400] flex items-end md:items-center justify-center backdrop-blur-sm px-0 md:px-3"
      style={{ background: 'rgba(7,8,10,0.92)' }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        className="w-full md:max-w-[460px] max-h-[92dvh] flex flex-col rounded-t-2xl md:rounded-2xl bg-[var(--bg-1)] overflow-hidden"
        initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 60, opacity: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        style={{ boxShadow: '0 0 0 1px rgba(255,181,71,0.4), 0 -2px 0 0 #FFB547, 0 40px 80px rgba(0,0,0,0.7)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-[var(--line)] flex-shrink-0">
          <div className="flex items-center gap-2">
            <Swords size={18} style={{ color: '#FFB547' }} />
            <h3 className="font-display text-[18px] tracking-[2px] uppercase text-[var(--ink-0)]">Challenge</h3>
          </div>
          <button onClick={onClose} className="w-11 h-11 flex items-center justify-center text-[var(--ink-2)] hover:text-[var(--accent)] transition-colors"><X size={20} /></button>
        </div>

        {/* Scrollable body — gives the form room to breathe on mobile. */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">

          {/* ── Opponent ──────────────────────────────────────────────────── */}
          <div className="flex items-center gap-3 rounded border border-[var(--line)] bg-[var(--bg-2)] px-4 py-3">
            <div className="w-9 h-9 rounded-full bg-[var(--bg-3)] border border-[var(--line-2)] flex items-center justify-center flex-shrink-0 overflow-hidden">
              {friend.photo ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={friend.photo} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="font-display text-[14px] text-[var(--ink-2)]">
                  {(friend.name ?? friend.username ?? '?')[0].toUpperCase()}
                </span>
              )}
            </div>
            <div>
              <p className="font-mono text-[12px] font-bold text-[var(--ink-0)]">{friend.name ?? friend.username}</p>
              {friend.username && <p className="font-mono text-[9px] text-[var(--ink-3)]">@{friend.username} · {friend.badgeCount} badges</p>}
            </div>
          </div>

          {/* ── When ───────────────────────────────────────────────────── */}
          <SectionLabel>When</SectionLabel>
          <div className="grid grid-cols-2 gap-1.5">
            {WINDOW_PRESETS.map(p => {
              const active   = preset === p.id;
              const win      = presetToWindow(p.id, customStart, customKind);
              const endDate  = addDaysISO(win.startDate, win.windowKind === 'week' ? 6 : win.windowKind === '3day' ? 2 : 0);
              const rangeStr = p.id === 'custom' ? p.sub : fmtRange(win.startDate, endDate);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPreset(p.id)}
                  className="text-left px-3 py-2.5 rounded-md border transition-all"
                  style={{
                    borderColor: active ? '#FFB547'             : 'var(--line)',
                    background:  active ? 'rgba(255,181,71,0.10)' : 'var(--bg-2)',
                  }}
                >
                  <p className="font-mono text-[10px] font-bold tracking-[0.5px]"
                    style={{ color: active ? '#FFB547' : 'var(--ink-0)' }}>
                    {p.label}
                  </p>
                  <p className="font-mono text-[9px] text-[var(--ink-3)] mt-0.5 tabular-nums">{rangeStr}</p>
                </button>
              );
            })}
          </div>
          {preset === 'custom' && (
            <div className="flex gap-2 -mt-1">
              <input
                type="date"
                className="que-input flex-1 text-[10px] py-2"
                value={customStart}
                onChange={e => setCustomStart(e.target.value)}
              />
              <div className="flex rounded-md border border-[var(--line)] overflow-hidden flex-shrink-0">
                {(['day', '3day', 'week'] as const).map(k => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setCustomKind(k)}
                    className="px-2.5 font-mono text-[9px] font-bold tracking-[0.5px] uppercase transition-colors"
                    style={{
                      background: customKind === k ? 'rgba(255,181,71,0.16)' : 'transparent',
                      color:      customKind === k ? '#FFB547'               : 'var(--ink-2)',
                    }}
                  >
                    {k === 'day' ? '1d' : k === '3day' ? '3d' : '7d'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Format (best of) ───────────────────────────────────────── */}
          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <SectionLabel>Format</SectionLabel>
              <span className="font-mono text-[9px] text-[var(--ink-3)]">
                {bestOf === 1 ? 'one category' : `winner takes ${Math.ceil(bestOf / 2)}+`}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {BEST_OF_OPTIONS.map(n => {
                const active = bestOf === n;
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setBestOf(n)}
                    className="py-2.5 rounded-md border transition-all"
                    style={{
                      borderColor: active ? '#FFB547'             : 'var(--line)',
                      background:  active ? 'rgba(255,181,71,0.10)' : 'var(--bg-2)',
                    }}
                  >
                    <span className="font-display text-[20px] leading-none block"
                      style={{ color: active ? '#FFB547' : 'var(--ink-1)' }}>
                      Bo{n}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Categories ─────────────────────────────────────────────── */}
          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <SectionLabel>
                Categories
              </SectionLabel>
              <span className="font-mono text-[9px] tabular-nums font-bold"
                style={{ color: selectedCats.length === bestOf ? 'var(--positive)' : 'var(--ink-3)' }}>
                {selectedCats.length} / {bestOf}
              </span>
            </div>
            <div className="space-y-3">
              {GROUP_ORDER.map(group => {
                const items = BATTLE_CATEGORIES.filter(c => c.group === group);
                const meta  = GROUP_META[group];
                const GroupIcon = meta.Icon;
                return (
                  <div key={group}>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <GroupIcon size={11} style={{ color: meta.color }} />
                      <p className="font-mono text-[9px] font-bold tracking-[1px] uppercase"
                        style={{ color: meta.color }}>
                        {meta.label}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {items.map(cat => {
                        const sel   = selectedCats.includes(cat.slug);
                        const atCap = !sel && selectedCats.length >= bestOf;
                        return (
                          <button
                            key={cat.slug}
                            type="button"
                            onClick={() => toggleCat(cat.slug)}
                            disabled={atCap}
                            // min-h-9 (36px) keeps each chip comfortably tappable
                            // on mobile without forcing them onto separate rows.
                            className="inline-flex items-center gap-1 px-3 py-2 rounded-full border font-mono text-[10px] font-bold transition-all min-h-9 active:scale-95"
                            style={{
                              borderColor: sel ? meta.color                                              : 'var(--line)',
                              background:  sel ? `${meta.color}22`                                        : 'var(--bg-2)',
                              color:       sel ? meta.color : atCap ? 'var(--ink-3)' : 'var(--ink-1)',
                              opacity:     atCap ? 0.4 : 1,
                            }}
                          >
                            {sel && <Check size={11} strokeWidth={3} />}
                            {cat.label}
                            {cat.safetyNote && (
                              <AlertTriangle size={10} style={{ color: sel ? meta.color : 'var(--warn, #FBBF24)' }} />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── How each picked category is scored ─────────────────────── */}
          {selectedCats.length > 0 && (
            <div className="rounded-md border border-[var(--line)] bg-[var(--bg-2)] divide-y divide-[var(--line)]">
              {selectedCats.map(slug => {
                const cat = BATTLE_CATEGORIES.find(c => c.slug === slug);
                if (!cat) return null;
                const meta = GROUP_META[cat.group];
                return (
                  <div key={slug} className="flex items-start gap-2 p-2.5">
                    <span className="block w-1.5 h-1.5 rounded-full flex-shrink-0 mt-[5px]"
                      style={{ background: meta.color }} />
                    <div className="flex-1 min-w-0">
                      <p className="font-mono text-[10px] font-bold text-[var(--ink-1)]">{cat.label}</p>
                      <p className="font-mono text-[9px] text-[var(--ink-3)] leading-relaxed mt-0.5">
                        {cat.description}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Safety notes ───────────────────────────────────────────── */}
          {safetyNotes.length > 0 && (
            <div className="rounded-md border border-[rgba(251,191,36,0.3)] bg-[rgba(251,191,36,0.06)] p-3 space-y-1">
              {safetyNotes.map((n, i) => (
                <div key={i} className="flex items-start gap-2">
                  <AlertTriangle size={11} className="flex-shrink-0 mt-[1px]" style={{ color: '#FBBF24' }} />
                  <p className="font-mono text-[9px] text-[var(--ink-1)] leading-relaxed">{n}</p>
                </div>
              ))}
            </div>
          )}

          {/* ── Wager ──────────────────────────────────────────────────── */}
          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <SectionLabel>Wager</SectionLabel>
              <span className="font-mono text-[9px] text-[var(--ink-3)]">
                Balance: <span className="text-[var(--ink-1)] tabular-nums">{myBalance}</span> 🪙
              </span>
            </div>
            <div className="flex items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--bg-2)] p-1">
              <button type="button" onClick={() => setWager(w => Math.max(0, w - 1))}
                className="w-11 h-11 flex items-center justify-center rounded text-[var(--ink-1)] text-2xl hover:bg-[var(--bg-3)] transition-colors disabled:opacity-30"
                disabled={wager <= 0}>−</button>
              <div className="flex-1 flex items-baseline justify-center gap-1.5">
                {wager === 0 ? (
                  <span className="font-display tracking-[1px] text-[22px] leading-none" style={{ color: 'var(--ink-1)' }}>FREE</span>
                ) : (
                  <>
                    <span className="font-display tabular-nums text-[32px] leading-none" style={{ color: '#FFB547' }}>{wager}</span>
                    <span className="font-mono text-[11px] text-[var(--ink-3)]">🪙</span>
                  </>
                )}
              </div>
              <button type="button" onClick={() => setWager(w => Math.min(max, w + 1))}
                className="w-11 h-11 flex items-center justify-center rounded text-[var(--ink-1)] text-2xl hover:bg-[var(--bg-3)] transition-colors disabled:opacity-30"
                disabled={wager >= max}>+</button>
            </div>
            <p className="font-mono text-[9px] text-[var(--ink-3)] text-center mt-1.5">
              {wager === 0
                ? 'Bragging rights — no coins on the line'
                : <>Pot: <span className="text-[var(--ink-1)] font-bold tabular-nums">{wager * 2}</span> 🪙 · Winner takes all</>}
            </p>
            {myBalance === 0 && (
              <p className="font-mono text-[9px] text-[var(--ink-3)] mt-2 text-center">
                No coins yet — battle for bragging rights, or hit your calorie goal to earn some.
              </p>
            )}
          </div>

          {error && (
            <div className="rounded-md border border-[rgba(248,113,113,0.3)] bg-[rgba(248,113,113,0.06)] px-3 py-2">
              <p className="font-mono text-[10px] text-[var(--danger)]">{error}</p>
            </div>
          )}
        </div>

        {/* Sticky footer with the send button — safe-area padding so the
            iOS home indicator doesn't sit on top of the action button. */}
        <div className="flex gap-2 p-4 border-t border-[var(--line)] flex-shrink-0"
          style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
          <button type="button" onClick={onClose} className="flex-1 que-btn-ghost py-3.5">Cancel</button>
          <button type="button" onClick={send} disabled={!canSend || sending}
            className="flex-1 py-3.5 rounded-md font-mono text-[10px] font-bold tracking-[1px] uppercase transition-all disabled:opacity-40 active:scale-[0.98]"
            style={{ background: '#FFB547', color: '#07080A', boxShadow: canSend ? '0 0 0 1px #FFB547, 0 0 20px rgba(255,181,71,0.3)' : 'none' }}>
            {sending
              ? '…'
              : selectedCats.length === bestOf
                ? (wager === 0 ? 'Send · Bragging rights' : `Challenge · ${wager} 🪙`)
                : selectedCats.length === 0
                  ? `Pick ${bestOf} categor${bestOf === 1 ? 'y' : 'ies'}`
                  : `Pick ${bestOf - selectedCats.length} more`}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Battle detail sheet ──────────────────────────────────────────────────────
// Renders the per-category scoreboard for a single battle. For 'active' battles
// the resolution doesn't exist yet (it's computed on resolve), so we just show
// the categories, window, and progress. For 'resolved' battles we render the
// full breakdown stored in challenge.resolution.

function formatScore(score: number | null, unit: string): string {
  if (score === null) return '—';
  // Step counts and large kcal totals look weird with decimals.
  const rounded = unit === 'steps' || unit === 'kcal' || unit === 'reps'
    ? Math.round(score)
    : Math.round(score * 10) / 10;
  return `${rounded.toLocaleString()} ${unit}`;
}

function Avatar({ name, photo, size = 36, color }: {
  name:  string;
  photo: string | null;
  size?: number;
  color?: string;
}) {
  if (photo) {
    return (
      /* eslint-disable-next-line @next/next/no-img-element */
      <img src={photo} alt="" className="rounded-full object-cover flex-shrink-0"
        style={{ width: size, height: size, border: '1px solid var(--line-2)' }} />
    );
  }
  return (
    <div className="rounded-full flex items-center justify-center flex-shrink-0 font-display"
      style={{
        width: size, height: size,
        background: 'var(--bg-3)',
        color: color ?? 'var(--ink-2)',
        border: '1px solid var(--line-2)',
        fontSize: size * 0.42,
      }}>
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function BattleDetailSheet({ challenge, myId, myName, myPhoto, opponentPhoto, onClose }: {
  challenge:     ChallengeData;
  myId:          string;
  myName:        string;
  myPhoto:       string | null;
  opponentPhoto: string | null;
  onClose:       () => void;
}) {
  const isResolved    = challenge.status === 'resolved';
  const iAmChallenger = challenge.challenger.id === myId;
  const opponent      = iAmChallenger ? challenge.challengee : challenge.challenger;
  const opponentName  = opponent.name ?? (opponent.username ? `@${opponent.username}` : 'Opponent');

  const progress = challenge.startDate && challenge.endDate
    ? battleProgressLabel(challenge.startDate, challenge.endDate)
    : null;

  const overallOutcome: 'win' | 'loss' | 'tie' | null = !isResolved ? null
    : challenge.winnerId === myId      ? 'win'
    : challenge.winnerId === null      ? 'tie'
    : 'loss';

  const outcomeColor =
    overallOutcome === 'win'  ? 'var(--positive)' :
    overallOutcome === 'loss' ? 'var(--danger)'   :
    overallOutcome === 'tie'  ? 'var(--ink-1)'    :
    'var(--ink-2)';

  // Per-category rows — from the server's resolution snapshot if resolved,
  // otherwise built from the challenge.categories list for display only.
  const rows: CategoryResult[] = useMemo(() => {
    if (challenge.resolution?.perCategory?.length) return challenge.resolution.perCategory;
    if (!challenge.categories?.length) return [];
    return challenge.categories.map(slug => {
      const cat = BATTLE_CATEGORIES.find(c => c.slug === slug);
      return {
        slug,
        label:           cat?.label ?? slug,
        group:           (cat?.group ?? 'cardio') as BattleCategory['group'],
        direction:       (cat?.direction ?? 'higher') as BattleCategory['direction'],
        unit:            cat?.unit ?? '',
        challengerScore: null,
        challengeeScore: null,
        outcome:         'nodata',
      };
    });
  }, [challenge.resolution, challenge.categories]);

  // Group the rows so the sheet renders Cardio → Lift → Diet sections.
  const groupedRows = useMemo(() => {
    const out: Record<CategoryGroup, CategoryResult[]> = { cardio: [], lift: [], diet: [] };
    for (const r of rows) out[r.group as CategoryGroup].push(r);
    return out;
  }, [rows]);

  return (
    <motion.div
      className="fixed inset-0 z-[350] flex items-end md:items-center justify-center backdrop-blur-sm px-0 md:px-3"
      style={{ background: 'rgba(7,8,10,0.9)' }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        className="w-full md:max-w-[480px] max-h-[92dvh] flex flex-col rounded-t-2xl md:rounded-2xl bg-[var(--bg-1)] overflow-hidden"
        initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 60, opacity: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        style={{ boxShadow: '0 0 0 1px var(--line-2), 0 -2px 0 0 #FFB547, 0 40px 80px rgba(0,0,0,0.6)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[var(--line)] flex-shrink-0">
          <div className="flex items-center gap-2">
            <Swords size={16} style={{ color: '#FFB547' }} />
            <p className="font-mono text-[9px] font-bold tracking-[2px] uppercase text-[var(--ink-3)]">
              {isResolved ? 'Battle Result' : 'Active Battle'}
            </p>
          </div>
          <button onClick={onClose} className="w-11 h-11 flex items-center justify-center text-[var(--ink-2)] hover:text-[var(--accent)] transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">

          {/* ── Versus header (gradient backdrop) ──────────────────────────────── */}
          <div className="relative px-5 pt-5 pb-4 border-b border-[var(--line)]"
            style={{
              background:
                overallOutcome === 'win'  ? 'linear-gradient(180deg, rgba(74,222,128,0.10), transparent)' :
                overallOutcome === 'loss' ? 'linear-gradient(180deg, rgba(248,113,113,0.10), transparent)' :
                overallOutcome === 'tie'  ? 'linear-gradient(180deg, rgba(148,163,184,0.10), transparent)' :
                'linear-gradient(180deg, rgba(255,181,71,0.08), transparent)',
            }}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col items-center gap-2 flex-1 min-w-0">
                <Avatar name={myName || 'Y'} photo={myPhoto} size={48}
                  color={overallOutcome === 'win' ? 'var(--positive)' : undefined} />
                <p className="font-mono text-[10px] font-bold text-[var(--ink-0)] truncate max-w-full">You</p>
              </div>
              <div className="flex flex-col items-center justify-center px-2 flex-shrink-0">
                <p className="font-display text-[14px] tracking-[3px] text-[var(--ink-3)]">VS</p>
                {challenge.bestOf && (
                  <p className="font-mono text-[8px] tracking-[1px] uppercase text-[var(--ink-3)] mt-0.5">
                    Best of {challenge.bestOf}
                  </p>
                )}
              </div>
              <div className="flex flex-col items-center gap-2 flex-1 min-w-0">
                <Avatar name={opponentName} photo={opponentPhoto} size={48}
                  color={overallOutcome === 'loss' ? 'var(--danger)' : undefined} />
                <p className="font-mono text-[10px] font-bold text-[var(--ink-0)] truncate max-w-full">
                  {opponent.name ?? opponent.username ?? 'Opponent'}
                </p>
              </div>
            </div>

            {/* Outcome / status line */}
            {overallOutcome ? (
              <div className="mt-4 text-center">
                <p className="font-display text-[22px] tracking-[2.5px] uppercase leading-tight" style={{ color: outcomeColor }}>
                  {overallOutcome === 'win'  ? 'Victory'  :
                   overallOutcome === 'loss' ? 'Defeat'   :
                                               'Tied'}
                </p>
                <p className="font-mono text-[10px] text-[var(--ink-2)] mt-1 tabular-nums">
                  {challenge.wager === 0
                    ? 'Bragging rights'
                    : overallOutcome === 'win'  ? <>+{challenge.wager * 2} 🪙 to your wallet</> :
                      overallOutcome === 'loss' ? <>−{challenge.wager} 🪙 to {opponentName}</> :
                                                  <>{challenge.wager} 🪙 refunded</>}
                </p>
                {challenge.resolution && (
                  <p className="font-mono text-[9px] text-[var(--ink-3)] mt-1 tabular-nums">
                    {iAmChallenger
                      ? `${challenge.resolution.summary.challengerWins}–${challenge.resolution.summary.challengeeWins}`
                      : `${challenge.resolution.summary.challengeeWins}–${challenge.resolution.summary.challengerWins}`}
                    {challenge.resolution.summary.ties > 0 && ` · ${challenge.resolution.summary.ties} tied`}
                  </p>
                )}
              </div>
            ) : (
              progress && (
                <div className="mt-4 flex items-center justify-center gap-1.5">
                  <Clock size={12} className="text-[var(--accent)]" />
                  <p className="font-mono text-[11px] font-bold tracking-[0.5px] text-[var(--ink-1)]">{progress}</p>
                </div>
              )
            )}
          </div>

          {/* ── Meta strip ──────────────────────────────────────────────────── */}
          <div className="flex items-center justify-between gap-4 px-5 py-3 border-b border-[var(--line)] font-mono text-[10px] text-[var(--ink-2)]">
            {challenge.startDate && challenge.endDate && (
              <div className="flex items-center gap-1.5">
                <span className="text-[var(--ink-3)]">📅</span>
                <span className="tabular-nums">{fmtRange(challenge.startDate, challenge.endDate)}</span>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              {challenge.wager === 0 ? (
                <span className="text-[var(--ink-2)] font-bold">Bragging rights</span>
              ) : (
                <>
                  <span className="text-[var(--ink-3)]">🪙</span>
                  <span style={{ color: '#FFB547' }} className="font-bold tabular-nums">{challenge.wager}</span>
                  <span className="text-[var(--ink-3)]">wager</span>
                </>
              )}
            </div>
          </div>

          {/* ── Categories — grouped ────────────────────────────────────────── */}
          <div className="p-5 space-y-4"
            style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}>
            {GROUP_ORDER.map(group => {
              const items = groupedRows[group];
              if (items.length === 0) return null;
              const meta = GROUP_META[group];
              const GroupIcon = meta.Icon;
              return (
                <div key={group}>
                  <div className="flex items-center gap-1.5 mb-2">
                    <GroupIcon size={12} style={{ color: meta.color }} />
                    <p className="font-mono text-[9px] font-bold tracking-[1.5px] uppercase" style={{ color: meta.color }}>
                      {meta.label}
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    {items.map(row => (
                      <CategoryRow
                        key={row.slug}
                        row={row}
                        iAmChallenger={iAmChallenger}
                        isResolved={isResolved}
                        groupColor={meta.color}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** One per-category row inside BattleDetailSheet. Shows both scores side-by-side
 *  with the winner highlighted; "no data" cells show the category-specific
 *  noDataLabel instead of "0". */
function CategoryRow({ row, iAmChallenger, isResolved, groupColor }: {
  row:            CategoryResult;
  iAmChallenger:  boolean;
  isResolved:     boolean;
  groupColor:     string;
}) {
  const myScore  = iAmChallenger ? row.challengerScore : row.challengeeScore;
  const oppScore = iAmChallenger ? row.challengeeScore : row.challengerScore;
  const myWon    = isResolved && (
    (iAmChallenger && row.outcome === 'challenger') ||
    (!iAmChallenger && row.outcome === 'challengee')
  );
  const oppWon   = isResolved && (
    (iAmChallenger && row.outcome === 'challengee') ||
    (!iAmChallenger && row.outcome === 'challenger')
  );
  const tied     = isResolved && row.outcome === 'tie';
  const nodata   = row.outcome === 'nodata';
  const noDataLabel = BATTLE_CATEGORIES.find(c => c.slug === row.slug)?.noDataLabel ?? 'no data';

  return (
    <div className="rounded-md border border-[var(--line)] bg-[var(--bg-2)] overflow-hidden">
      {/* Title row */}
      <div className="flex items-center justify-between px-3 pt-2 pb-1.5">
        <p className="font-mono text-[10px] font-bold text-[var(--ink-0)] truncate">{row.label}</p>
        {isResolved && (
          nodata ? (
            <span className="font-mono text-[8px] tracking-[1px] uppercase text-[var(--ink-3)]">No data</span>
          ) : (
            <span className="font-mono text-[8px] font-bold tracking-[1px] uppercase px-1.5 py-0.5 rounded-sm"
              style={{
                color: myWon ? 'var(--positive)' : oppWon ? 'var(--danger)' : 'var(--ink-2)',
                background:
                  myWon  ? 'rgba(74,222,128,0.12)' :
                  oppWon ? 'rgba(248,113,113,0.12)' :
                           'var(--bg-3)',
              }}>
              {myWon ? 'Won' : oppWon ? 'Lost' : 'Tied'}
            </span>
          )
        )}
      </div>

      {isResolved ? (
        // Two-column score split. Winner side gets group-colored background.
        <div className="grid grid-cols-[1fr_auto_1fr] items-stretch">
          <ScoreSide
            score={myScore}
            unit={row.unit}
            noDataLabel={noDataLabel}
            won={myWon}
            tied={tied}
            align="right"
            color={groupColor}
          />
          <div className="flex items-center px-2 text-[var(--ink-3)]">
            <span className="font-display text-[11px] tracking-[1.5px]">vs</span>
          </div>
          <ScoreSide
            score={oppScore}
            unit={row.unit}
            noDataLabel={noDataLabel}
            won={oppWon}
            tied={tied}
            align="left"
            color={groupColor}
          />
        </div>
      ) : (
        <p className="px-3 pb-2 font-mono text-[9px] text-[var(--ink-3)] italic">
          Scores reveal when the battle resolves
        </p>
      )}
    </div>
  );
}

/** Small colored dots indicating which category groups are used in a battle.
 *  Helps the user scan the BATTLES list and know at a glance what kind of
 *  competition each row is. */
function CategoryGroupDots({ slugs, size = 6 }: { slugs: string[] | null | undefined; size?: number }) {
  if (!slugs?.length) return null;
  const groups = new Set<CategoryGroup>();
  for (const slug of slugs) {
    const cat = BATTLE_CATEGORIES.find(c => c.slug === slug);
    if (cat) groups.add(cat.group);
  }
  if (groups.size === 0) return null;
  return (
    <span className="inline-flex items-center gap-[3px]">
      {GROUP_ORDER.filter(g => groups.has(g)).map(g => (
        <span key={g} aria-label={GROUP_META[g].label} className="rounded-full" style={{
          width: size, height: size, background: GROUP_META[g].color,
        }} />
      ))}
    </span>
  );
}

/** "Friend" chip marking a 1v1 friend battle in the merged BATTLES list.
 *  Mirrors the Team/FFA ModeChip in TeamBattles so the row types read consistently. */
function FriendChip() {
  const color = '#FFB547';
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-[2px] rounded-sm font-mono text-[8px] font-bold tracking-[0.5px] uppercase flex-shrink-0"
      style={{ color, background: `${color}1A`, border: `1px solid ${color}40` }}>
      <Swords size={9} aria-hidden="true" /> Friend
    </span>
  );
}

function ScoreSide({ score, unit, noDataLabel, won, tied, align, color }: {
  score:       number | null;
  unit:        string;
  noDataLabel: string;
  won:         boolean;
  tied:        boolean;
  align:       'left' | 'right';
  color:       string;
}) {
  const isNoData = score === null;
  return (
    <div
      className="px-3 py-2 flex flex-col justify-center"
      style={{
        background: won ? `${color}15` : 'transparent',
        textAlign:  align,
      }}
    >
      <p className="font-display text-[18px] leading-none tabular-nums truncate"
        style={{ color: isNoData ? 'var(--ink-3)' : won ? color : tied ? 'var(--ink-1)' : 'var(--ink-2)' }}>
        {isNoData ? '—' : formatScore(score, unit).replace(` ${unit}`, '')}
      </p>
      <p className="font-mono text-[8px] tracking-[0.5px] mt-0.5"
        style={{ color: isNoData ? 'var(--ink-3)' : 'var(--ink-3)' }}>
        {isNoData ? noDataLabel : unit}
      </p>
    </div>
  );
}

// ── Username setup ────────────────────────────────────────────────────────────

function UsernameSetup({ onSaved }: { onSaved: () => void }) {
  const [val,    setVal]    = useState('');
  const [error,  setError]  = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const username = val.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) { setError('3–20 chars · letters, numbers, underscores only'); return; }
    setSaving(true); setError('');
    const res  = await fetch('/api/user', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    const data = await res.json();
    setSaving(false);
    if (res.ok) { onSaved(); }
    else        { setError(data.error ?? 'Username taken'); }
  };

  return (
    <div className="que-card p-5 mb-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="block w-2 h-2 rounded-full bg-[var(--accent)]" />
        <p className="font-mono text-[10px] font-bold tracking-[2px] uppercase text-[var(--ink-1)]">Set Your Username</p>
      </div>
      <p className="font-mono text-[10px] text-[var(--ink-3)] mb-3">Choose a unique handle so friends can find and challenge you.</p>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[12px] text-[var(--ink-3)]">@</span>
          <input type="text" className="que-input pl-7" placeholder="your_username" value={val} maxLength={20}
            onChange={e => { setVal(e.target.value); setError(''); }}
            onKeyDown={e => e.key === 'Enter' && save()} />
        </div>
        <button type="button" onClick={save} disabled={saving || !val.trim()}
          className="que-btn-primary px-5 disabled:opacity-40 flex-shrink-0">
          {saving ? '…' : 'Save'}
        </button>
      </div>
      {error && <p className="font-mono text-[9px] text-[var(--danger)] mt-2">{error}</p>}
    </div>
  );
}

// ── Challenge result ──────────────────────────────────────────────────────────

function ChallengeResult({ challenge, myId }: { challenge: ChallengeData; myId: string }) {
  if (challenge.status === 'cancelled') return <span className="font-mono text-[9px] text-[var(--ink-3)]">Declined</span>;
  const free = challenge.wager === 0;
  if (!challenge.winnerId) return <span className="font-mono text-[9px] text-[var(--ink-3)]">{free ? 'Tie' : 'Tie · refunded'}</span>;
  const won = challenge.winnerId === myId;
  return (
    <span className="font-mono text-[9px] font-bold" style={{ color: won ? 'var(--positive)' : 'var(--danger)' }}>
      {won ? (free ? 'Won' : `+${challenge.wager} 🪙 Won`) : (free ? 'Lost' : `-${challenge.wager} 🪙 Lost`)}
    </span>
  );
}

// ── Friend profile sheet ──────────────────────────────────────────────────────

function FriendProfileSheet({ userId, onClose, onChallenge }: {
  userId:      string;
  onClose:     () => void;
  onChallenge: () => void;
}) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);

  useEffect(() => {
    fetch(`/api/user/${userId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setProfile(d));
  }, [userId]);

  return (
    <motion.div
      className="fixed inset-0 z-[300] flex items-end md:items-center justify-center backdrop-blur-sm px-0 md:px-3"
      style={{ background: 'rgba(7,8,10,0.88)' }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        className="w-full md:max-w-[480px] max-h-[88dvh] flex flex-col rounded-t-2xl md:rounded-2xl bg-[var(--bg-1)] overflow-hidden"
        initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 60, opacity: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        style={{ boxShadow: '0 0 0 1px var(--line-2), 0 -2px 0 0 var(--accent), 0 40px 80px rgba(0,0,0,0.6)' }}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[var(--line)] flex-shrink-0">
          <p className="font-mono text-[9px] font-bold tracking-[2px] uppercase text-[var(--ink-3)]">Profile</p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onChallenge}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm border font-mono text-[9px] font-bold uppercase transition-all"
              style={{ borderColor: 'rgba(255,181,71,0.4)', color: '#FFB547' }}>
              <Swords size={11} /> Battle
            </button>
            <button onClick={onClose} className="w-11 h-11 flex items-center justify-center text-[var(--ink-2)] hover:text-[var(--accent)] transition-colors">
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {profile ? (
            <ProfileCard profile={profile} isOwn={false} />
          ) : (
            <div className="py-10 text-center">
              <p className="font-mono text-[10px] text-[var(--ink-3)] animate-pulse tracking-[1px] uppercase">Loading…</p>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Main SocialTab ────────────────────────────────────────────────────────────

export default function SocialTab() {
  const [ownProfile,    setOwnProfile]    = useState<PublicProfile | null>(null);
  const [friends,       setFriends]       = useState<FriendData[]>([]);
  const [incoming,      setIncoming]      = useState<PendingData[]>([]);
  const [outgoing,      setOutgoing]      = useState<PendingData[]>([]);
  const [inChallenge,   setInChallenge]   = useState<ChallengeData[]>([]);
  const [sentChallenge, setSentChallenge] = useState<ChallengeData[]>([]);
  const [activeBattles, setActiveBattles] = useState<ChallengeData[]>([]);
  const [resolved,      setResolved]      = useState<ChallengeData[]>([]);
  const [viewBattleId,  setViewBattleId]  = useState<string | null>(null);
  const [balance,       setBalance]       = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    try { return (JSON.parse(localStorage.getItem(COIN_KEY) ?? 'null') as { total?: number } | null)?.total ?? 0; }
    catch { return 0; }
  });
  const [addQuery,      setAddQuery]      = useState('');
  const [addStatus,     setAddStatus]     = useState<{ ok: boolean; msg: string } | null>(null);
  const [loading,       setLoading]       = useState(true);
  const [loadingAnim,   setLoadingAnim]   = useState<unknown>(null);
  const [viewFriendId,  setViewFriendId]  = useState<string | null>(null);
  const [challenging,   setChallenging]   = useState<FriendData | null>(null);
  const [responding,    setResponding]    = useState<string | null>(null);
  const [resolving,     setResolving]     = useState<string | null>(null);
  const [pendingRemove,  setPendingRemove]  = useState<string | null>(null);
  const [pendingDecline, setPendingDecline] = useState<string | null>(null);
  const [removeError,    setRemoveError]    = useState<string | null>(null);
  const [challengeError, setChallengeError] = useState<string | null>(null);

  // Profile stat-rail stats — computed client-side from the local workout log.
  const { localDB } = useApp();
  const profileStreak = useMemo(() => currentWorkoutStreak(localDB), [localDB]);
  const weekVolume    = useMemo(() => weekLiftVolume(localDB), [localDB]);

  const refresh = useCallback(async () => {
    const [userRes, friendRes, challengeRes] = await Promise.all([
      fetch('/api/user'),
      fetch('/api/friends'),
      fetch('/api/challenges'),
    ]);

    if (userRes.ok) {
      const data = await userRes.json() as PublicProfile;
      // Supplement profilePhoto from localStorage if the DB hasn't received the
      // sync yet (e.g. photo was set while offline or before first successful push).
      if (!data.profilePhoto) {
        const localPhoto = localStorage.getItem(PROFILE_PHOTO_KEY);
        if (localPhoto) data.profilePhoto = localPhoto;
      }
      // Client coin ledger may be ahead of the DB (coins are awarded locally
      // on each calorie goal hit; the DB only syncs via the one-time migration).
      // Show whichever balance is higher so the card matches the header counter.
      try {
        const localCoins = JSON.parse(localStorage.getItem(COIN_KEY) ?? 'null') as { total?: number } | null;
        const localTotal = localCoins?.total ?? 0;
        const dbTotal    = data.coinBalance ?? 0;
        setOwnProfile({ ...data, coinBalance: Math.max(dbTotal, localTotal) });
      } catch {
        setOwnProfile(data);
      }
    }
    try { setBalance((JSON.parse(localStorage.getItem(COIN_KEY) ?? 'null') as { total?: number } | null)?.total ?? 0); } catch { /* ignore */ }
    if (friendRes.ok) {
      const d = await friendRes.json();
      setFriends(d.friends   ?? []);
      setIncoming(d.incoming ?? []);
      setOutgoing(d.outgoing ?? []);
    }
    if (challengeRes.ok) {
      const d = await challengeRes.json();
      setInChallenge(d.incoming    ?? []);
      setSentChallenge(d.sent      ?? []);
      setActiveBattles(d.active    ?? []);
      setResolved(d.resolved       ?? []);
    }
    setLoading(false);
  }, []);

  // Lazy-load one of the loading-animation JSON files (rotates per visit).
  useEffect(() => {
    let cancelled = false;
    let idx = 0;
    try {
      idx = parseInt(localStorage.getItem(SOCIAL_ANIM_KEY) ?? '0', 10) % LOADING_ANIM_LOADERS.length;
      localStorage.setItem(SOCIAL_ANIM_KEY, String((idx + 1) % LOADING_ANIM_LOADERS.length));
    } catch { /* default to 0 */ }
    LOADING_ANIM_LOADERS[idx]()
      .then(mod => { if (!cancelled) setLoadingAnim(mod.default); })
      .catch(() => { /* offline / chunk fail — loader just stays empty */ });
    return () => { cancelled = true; };
  }, []);

  // Re-fetch when user updates their profile photo while Social tab is mounted.
  useEffect(() => {
    const onPhoto = () => void refresh();
    window.addEventListener('queProfilePhotoChanged', onPhoto);
    return () => window.removeEventListener('queProfilePhotoChanged', onPhoto);
  }, [refresh]);

  // Refresh badge collection whenever the sync engine reports a revocation.
  useEffect(() => {
    const onRevoked = () => void refresh();
    window.addEventListener('que-badges-revoked', onRevoked);
    return () => window.removeEventListener('que-badges-revoked', onRevoked);
  }, [refresh]);

  // Also refresh when new badges are earned so the collection shows them immediately.
  useEffect(() => {
    const onEarned = () => void refresh();
    window.addEventListener('que-badge-earned', onEarned);
    return () => window.removeEventListener('que-badge-earned', onEarned);
  }, [refresh]);

  useEffect(() => {
    const importCoins = async () => {
      if (typeof window === 'undefined' || localStorage.getItem(COINS_MIGRATED_KEY)) return;
      try {
        const stored = JSON.parse(localStorage.getItem(COIN_KEY) ?? 'null');
        const total  = (stored?.total ?? 0) as number;
        if (total === 0) { localStorage.setItem(COINS_MIGRATED_KEY, '1'); return; }
        const res = await fetch('/api/wallet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ balance: total }),
        });
        if (res.ok) localStorage.setItem(COINS_MIGRATED_KEY, '1');
      } catch { /* retry next visit */ }
    };
    // Run coin migration and data fetch in parallel — migration doesn't affect fetch results
    void importCoins();
    void refresh();
  }, [refresh]);

  const sendRequest = async () => {
    const q = addQuery.trim().toLowerCase();
    if (!q) return;
    setAddStatus(null);
    const res  = await fetch('/api/friends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: q }),
    });
    const data = await res.json();
    setAddStatus({ ok: res.ok, msg: res.ok ? 'Request sent!' : (data.error ?? 'Error') });
    if (res.ok) { setAddQuery(''); void refresh(); }
  };

  const respondFriend = async (friendshipId: string, accept: boolean) => {
    // Snapshot for rollback
    const prevIncoming = incoming;
    const prevFriends  = friends;
    const target = incoming.find(r => r.friendshipId === friendshipId);

    // Optimistic update: remove from incoming, add to friends if accepting
    setIncoming(prev => prev.filter(r => r.friendshipId !== friendshipId));
    if (accept && target) {
      setFriends(prev => [...prev, {
        id:           target.id,
        friendshipId,
        name:         target.name,
        username:     target.username,
        badgeCount:   0,
        photo:        null,
        status:       null,
      }]);
    }

    setResponding(friendshipId);
    const res = await fetch('/api/friends/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendshipId, accept }),
    });
    setResponding(null);

    if (!res.ok) {
      // Rollback
      setIncoming(prevIncoming);
      setFriends(prevFriends);
      return;
    }
    // Refresh in the background to get authoritative data (badge counts, photo, status)
    void refresh();
  };

  const removeFriend = async (friendshipId: string) => {
    if (pendingRemove !== friendshipId) { setPendingRemove(friendshipId); setRemoveError(null); return; }
    setPendingRemove(null); setRemoveError(null);

    // Snapshot + optimistic removal from whichever list it lives in
    const prevFriends  = friends;
    const prevOutgoing = outgoing;
    setFriends(prev  => prev.filter(f => f.friendshipId !== friendshipId));
    setOutgoing(prev => prev.filter(r => r.friendshipId !== friendshipId));

    const res = await fetch('/api/friends', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendshipId }),
    });
    if (!res.ok) {
      setFriends(prevFriends);
      setOutgoing(prevOutgoing);
      setRemoveError('Failed to remove');
      return;
    }
    // No refresh needed — the optimistic state already matches the server
  };

  const respondChallenge = async (challengeId: string, action: 'accept' | 'decline') => {
    if (action === 'decline' && pendingDecline !== challengeId) { setPendingDecline(challengeId); setChallengeError(null); return; }
    setPendingDecline(null); setChallengeError(null);

    // Snapshot + optimistic removal from inChallenge (we'll learn the real outcome on refresh)
    const prevInChallenge = inChallenge;
    setInChallenge(prev => prev.filter(c => c.id !== challengeId));

    setResolving(challengeId);
    const res = await fetch(`/api/challenges/${challengeId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    setResolving(null);

    if (!res.ok) {
      setInChallenge(prevInChallenge);
      setChallengeError('Failed — please try again');
      return;
    }
    // If the server awarded any battle-count badges on this resolve, fire
    // the same que-badge-earned event the sync engine uses so the popup +
    // badge-collection refresh trigger immediately. Safe-parse: older servers
    // won't return the field.
    try {
      const body = await res.clone().json();
      const awarded = Array.isArray(body?.awardedBadges) ? body.awardedBadges : [];
      if (awarded.length > 0) {
        window.dispatchEvent(new CustomEvent('que-badge-earned', { detail: awarded }));
      }
      // Attribute the outcome — most useful battle metric. result is one of
      // 'win' | 'tie' | 'loss' | 'declined' from the server.
      if (action === 'decline') {
        trackEvent('battle_declined');
      } else if (body?.result === 'win') {
        trackEvent('battle_resolved_win');
      } else if (body?.result === 'loss') {
        trackEvent('battle_resolved_loss');
      } else if (body?.result === 'tie') {
        trackEvent('battle_resolved_tie');
      } else {
        trackEvent('battle_accepted');
      }
    } catch { /* response wasn't json — ignore */ }
    // Refresh in the background — accepts may resolve into the resolved list,
    // declines into cancellation, and balance may change.
    void refresh();
  };

  const today   = new Date();
  const dateTag = `${today.getMonth() + 1}/${today.getDate()}`;
  const totalNotifs = incoming.length + inChallenge.length;
  const hasUsername = !!ownProfile?.username;

  return (
    <div className="max-w-2xl mx-auto px-4 py-5 pb-28 lg:py-8">

      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <span className="block w-2 h-2 rounded-full bg-[var(--accent)]" style={{ boxShadow: '0 0 8px var(--accent-40)' }} />
        <span className="font-mono text-[11px] font-bold tabular tracking-[2px] uppercase text-[var(--ink-1)]">
          Social · {dateTag}
        </span>
        <div className="ml-auto flex items-center gap-3">
          {totalNotifs > 0 && (
            <span className="w-5 h-5 rounded-full text-[9px] font-bold font-mono flex items-center justify-center"
              style={{ background: 'var(--danger)', color: '#fff' }}>{totalNotifs}</span>
          )}
          {hasUsername && <span className="font-mono text-[10px] text-[var(--ink-3)]">@{ownProfile?.username}</span>}
        </div>
      </div>

      {/* Username setup */}
      {!loading && !hasUsername && <UsernameSetup onSaved={refresh} />}

      {/* ── Loading animation ── */}
      <AnimatePresence>
        {loading && (
          <motion.div
            className="flex items-center justify-center py-8"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: 'easeInOut' }}
          >
            {loadingAnim ? (
              <Lottie animationData={loadingAnim} loop autoplay className="w-44 h-44" />
            ) : (
              <div className="w-44 h-44" aria-hidden="true" />
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Content — fades up as loader fades out (overlapping crossfade) ── */}
      <AnimatePresence>
        {!loading && (
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          >

      {/* ── YOUR PROFILE CARD ─────────────────────────────────────────────── */}
      {ownProfile && (
        <div className="mb-4">
          <ProfileCard profile={ownProfile} isOwn stats={{ streak: profileStreak, weekVolume }} onRefresh={refresh} />
        </div>
      )}

      {/* ── BEAT LAST WEEK (solo competitive on-ramp — no friends required) ──── */}
      <BeatLastWeek />

      {/* ── GROUPS (community hub — feeds + team battles entry) ──────────────── */}
      {hasUsername && ownProfile?.id && (
        <Groups meId={ownProfile.id} friends={friends} />
      )}

      {/* ── BATTLES (1v1 friend + team, merged) ──────────────────────────── */}
      <div className="que-card mb-4">
        <div className="px-5 pt-5 pb-3">
          <h2 className="que-section-label">
            <span className="dot" style={{ background: '#FFB547' }} />
            BATTLES
          </h2>

          {challengeError && (
            <p className="font-mono text-[9px] text-[var(--danger)] mb-2">{challengeError}</p>
          )}

          {/* ── Friend (1v1) ── */}
          <p className="font-mono text-[9px] font-bold tracking-[1.5px] uppercase text-[var(--ink-3)] mt-1 mb-2">Friend (1v1)</p>

          {inChallenge.length === 0 && sentChallenge.length === 0 && activeBattles.length === 0 && resolved.length === 0 ? (
            <p className="font-mono text-[9px] text-[var(--ink-3)] py-1 mb-1">
              No 1v1 battles yet — tap “Battle” on a friend below to start one.
            </p>
          ) : (
            <>
            {/* Incoming requests — you need to accept/decline */}
            {inChallenge.map(c => (
              <div key={c.id} className="mb-2">
                <div className="flex items-center gap-3 rounded-md border border-[rgba(255,181,71,0.35)] bg-[rgba(255,181,71,0.06)] px-3 py-3">
                  <Swords size={16} style={{ color: '#FFB547', flexShrink: 0 }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <FriendChip />
                      <p className="font-mono text-[11px] font-bold text-[var(--ink-0)] truncate">
                        {c.challenger.name ?? c.challenger.username ?? 'Unknown'}
                      </p>
                      <CategoryGroupDots slugs={c.categories} />
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="font-mono text-[9px] text-[var(--ink-3)]">{wagerChip(c.wager)}</span>
                      {c.bestOf && (
                        <span className="font-mono text-[8px] font-bold tracking-[0.5px] uppercase px-1.5 py-[1px] rounded-sm bg-[var(--bg-3)] text-[var(--ink-2)]">
                          Bo{c.bestOf}
                        </span>
                      )}
                      {c.startDate && c.endDate && (
                        <span className="font-mono text-[9px] text-[var(--ink-3)] tabular-nums">
                          {fmtRange(c.startDate, c.endDate)}
                        </span>
                      )}
                    </div>
                  </div>
                  <button type="button" onClick={() => respondChallenge(c.id, 'accept')} disabled={resolving === c.id}
                    aria-label="Accept challenge"
                    className="w-11 h-11 flex items-center justify-center rounded-md border border-[var(--positive)]/50 text-[var(--positive)] hover:bg-[var(--positive)]/15 active:bg-[var(--positive)]/25 transition-all disabled:opacity-40 flex-shrink-0">
                    {resolving === c.id ? '…' : <Check size={18} />}
                  </button>
                  {pendingDecline === c.id ? (
                    <>
                      <button type="button" onClick={() => setPendingDecline(null)}
                        className="px-3 h-11 flex items-center font-mono text-[10px] text-[var(--ink-3)] hover:text-[var(--ink-1)] active:text-[var(--ink-1)] transition-colors">
                        Keep
                      </button>
                      <button type="button" onClick={() => respondChallenge(c.id, 'decline')} disabled={resolving === c.id}
                        className="px-3 h-11 flex items-center font-mono text-[10px] font-bold text-[var(--danger)] hover:opacity-80 active:opacity-60 transition-all disabled:opacity-40">
                        Decline
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={() => respondChallenge(c.id, 'decline')} disabled={resolving === c.id}
                      aria-label="Decline challenge"
                      className="w-11 h-11 flex items-center justify-center rounded-md border border-[var(--line-2)] text-[var(--ink-3)] hover:text-[var(--danger)] active:text-[var(--danger)] transition-all disabled:opacity-40 flex-shrink-0">
                      <X size={18} />
                    </button>
                  )}
                </div>
              </div>
            ))}

            {/* Active battles — accepted, waiting for window to close */}
            {activeBattles.length > 0 && (
              <div className="mb-3">
                <p className="font-mono text-[9px] font-bold tracking-[1.5px] uppercase text-[var(--ink-3)] mb-2">
                  In Progress ({activeBattles.length})
                </p>
                <div className="space-y-1.5">
                  {activeBattles.map(c => {
                    const myId     = ownProfile?.id ?? '';
                    const isSender = c.challenger.id === myId;
                    const opponent = isSender ? c.challengee : c.challenger;
                    const label    = c.startDate && c.endDate
                      ? battleProgressLabel(c.startDate, c.endDate)
                      : 'In progress';
                    return (
                      <button
                        type="button"
                        key={c.id}
                        onClick={() => setViewBattleId(c.id)}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md border border-[var(--line)] bg-[var(--bg-2)] hover:border-[var(--accent)]/40 transition-colors text-left"
                      >
                        <Clock size={14} className="text-[var(--accent)] flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <FriendChip />
                            <p className="font-mono text-[10px] font-bold text-[var(--ink-1)] truncate">
                              vs @{opponent.username ?? opponent.name ?? 'unknown'}
                            </p>
                            <CategoryGroupDots slugs={c.categories} />
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="font-mono text-[8px] text-[var(--accent)] font-bold tracking-[0.5px]">{label}</span>
                            <span className="font-mono text-[8px] text-[var(--ink-3)]">·</span>
                            <span className="font-mono text-[8px] text-[var(--ink-3)]">{wagerChip(c.wager)}</span>
                            {c.bestOf && (
                              <span className="font-mono text-[8px] font-bold tracking-[0.5px] uppercase px-1 py-[1px] rounded-sm bg-[var(--bg-3)] text-[var(--ink-2)]">
                                Bo{c.bestOf}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Sent — pending challenges waiting on the friend */}
            {sentChallenge.map(c => (
              <div key={c.id} className="flex items-center gap-3 px-3 py-2.5 rounded-md border border-[var(--line)] bg-[var(--bg-2)] mb-2">
                <Swords size={14} className="text-[var(--ink-3)] flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <FriendChip />
                    <p className="font-mono text-[10px] font-bold text-[var(--ink-2)] truncate">
                      vs @{c.challengee.username ?? 'unknown'}
                    </p>
                    <CategoryGroupDots slugs={c.categories} />
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="font-mono text-[8px] text-[var(--ink-3)]">{wagerChip(c.wager)}</span>
                    {c.bestOf && (
                      <span className="font-mono text-[8px] font-bold tracking-[0.5px] uppercase px-1 py-[1px] rounded-sm bg-[var(--bg-3)] text-[var(--ink-2)]">
                        Bo{c.bestOf}
                      </span>
                    )}
                    <span className="font-mono text-[8px] italic text-[var(--ink-3)]">waiting…</span>
                  </div>
                </div>
              </div>
            ))}

            {/* Recent results — tap to see the per-category breakdown */}
            {resolved.length > 0 && (
              <div className="mt-2 space-y-1.5">
                <p className="font-mono text-[9px] font-bold tracking-[1.5px] uppercase text-[var(--ink-3)] mb-2">Recent Results</p>
                {resolved.map(c => {
                  const myId     = ownProfile?.id ?? '';
                  const isSender = c.challenger.id === myId;
                  const opponent = isSender ? c.challengee : c.challenger;
                  const clickable = c.type === 'typed' && c.status === 'resolved';
                  const inner = (
                    <>
                      <FriendChip />
                      <span className="font-mono text-[12px]">
                        {!c.winnerId ? '🤝' : c.winnerId === myId ? '🏆' : '💀'}
                      </span>
                      <p className="flex-1 font-mono text-[10px] text-[var(--ink-2)] truncate">
                        vs @{opponent.username ?? opponent.name ?? 'unknown'}
                      </p>
                      <ChallengeResult challenge={c} myId={myId} />
                    </>
                  );
                  return clickable ? (
                    <button
                      type="button"
                      key={c.id}
                      onClick={() => setViewBattleId(c.id)}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded border border-[var(--line)] bg-[var(--bg-2)] hover:border-[var(--accent)]/40 transition-colors text-left"
                    >
                      {inner}
                    </button>
                  ) : (
                    <div key={c.id} className="flex items-center gap-3 px-3 py-2 rounded border border-[var(--line)] bg-[var(--bg-2)]">
                      {inner}
                    </div>
                  );
                })}
              </div>
            )}
            </>
          )}

          {/* ── Group battles (team + FFA) — accept invites, view active ── */}
          {ownProfile?.id && <TeamBattles meId={ownProfile.id} embedded />}
        </div>
      </div>

      {/* ── FRIENDS ──────────────────────────────────────────────────────── */}
      <div className="que-card">
        <div className="px-5 pt-5 pb-2">
          <h2 className="que-section-label">
            <span className="dot" />
            FRIENDS
          </h2>

          <div className="mb-4">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[12px] text-[var(--ink-3)]">@</span>
                <input type="text" className="que-input pl-7" placeholder="username" value={addQuery} disabled={!hasUsername}
                  onChange={e => { setAddQuery(e.target.value); setAddStatus(null); }}
                  onKeyDown={e => e.key === 'Enter' && sendRequest()} />
              </div>
              <button type="button" onClick={sendRequest} disabled={!addQuery.trim() || !hasUsername}
                className="que-btn-primary px-4 flex-shrink-0 disabled:opacity-40 flex items-center gap-1.5">
                <UserPlus size={14} /> Add
              </button>
            </div>
            {addStatus && (
              <p className={['font-mono text-[9px] mt-1.5', addStatus.ok ? 'text-[var(--positive)]' : 'text-[var(--danger)]'].join(' ')}>
                {addStatus.msg}
              </p>
            )}
            {!hasUsername && <p className="font-mono text-[9px] text-[var(--ink-3)] mt-1.5">Set your username above to add friends.</p>}
          </div>

          {/* Incoming friend requests */}
          {incoming.length > 0 && (
            <div className="mb-4">
              <p className="font-mono text-[9px] font-bold tracking-[1.5px] uppercase text-[var(--ink-3)] mb-2">Requests ({incoming.length})</p>
              <div className="space-y-2">
                {incoming.map(req => (
                  <div key={req.friendshipId} className="flex items-center gap-3 rounded border border-[var(--line)] bg-[var(--bg-2)] px-3 py-2.5">
                    <div className="flex-1 min-w-0">
                      <p className="font-mono text-[11px] font-bold text-[var(--ink-0)] truncate">{req.name ?? req.username ?? 'Unknown'}</p>
                      {req.username && <p className="font-mono text-[9px] text-[var(--ink-3)]">@{req.username}</p>}
                    </div>
                    <button type="button" onClick={() => respondFriend(req.friendshipId, true)} disabled={responding === req.friendshipId}
                      aria-label="Accept friend request"
                      className="w-11 h-11 flex items-center justify-center rounded-md border border-[var(--positive)]/50 text-[var(--positive)] hover:bg-[var(--positive)]/15 active:bg-[var(--positive)]/25 transition-all disabled:opacity-40 flex-shrink-0">
                      {responding === req.friendshipId ? '…' : <Check size={18} />}
                    </button>
                    <button type="button" onClick={() => respondFriend(req.friendshipId, false)} disabled={responding === req.friendshipId}
                      aria-label="Reject friend request"
                      className="w-11 h-11 flex items-center justify-center rounded-md border border-[var(--line-2)] text-[var(--ink-3)] hover:text-[var(--danger)] active:text-[var(--danger)] transition-all disabled:opacity-40 flex-shrink-0">
                      <X size={18} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Outgoing */}
          {outgoing.length > 0 && (
            <div className="mb-4">
              <p className="font-mono text-[9px] font-bold tracking-[1.5px] uppercase text-[var(--ink-3)] mb-2">Sent ({outgoing.length})</p>
              {outgoing.map(req => (
                <div key={req.friendshipId} className="flex items-center gap-2 px-3 rounded-md border border-[var(--line)] bg-[var(--bg-2)] mb-1.5 min-h-[44px]">
                  <p className="flex-1 font-mono text-[10px] text-[var(--ink-2)] truncate">
                    @{req.username ?? 'unknown'} <span className="text-[var(--ink-3)]">· pending</span>
                  </p>
                  {pendingRemove === req.friendshipId ? (
                    <>
                      <button type="button" onClick={() => setPendingRemove(null)}
                        className="px-3 h-10 flex items-center font-mono text-[10px] text-[var(--ink-3)] hover:text-[var(--ink-1)] active:text-[var(--ink-1)] transition-colors">
                        Keep
                      </button>
                      <button type="button" onClick={() => removeFriend(req.friendshipId)}
                        className="px-3 h-10 flex items-center font-mono text-[10px] font-bold text-[var(--danger)] hover:opacity-80 active:opacity-60 transition-opacity">
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={() => removeFriend(req.friendshipId)}
                      aria-label="Cancel friend request"
                      className="w-10 h-10 flex items-center justify-center text-[var(--ink-3)] hover:text-[var(--danger)] active:text-[var(--danger)] transition-colors">
                      <X size={15} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {removeError && (
          <p className="font-mono text-[9px] text-[var(--danger)] px-5 pb-2">{removeError}</p>
        )}
        {friends.length === 0 && !loading ? (
          <div className="px-5 pb-5">
            <div className="text-center py-8 border border-dashed border-[var(--line-2)] rounded">
              <Users size={24} className="text-[var(--ink-3)] mx-auto mb-2" />
              <p className="font-mono text-[10px] text-[var(--ink-2)] font-bold tracking-[1px] uppercase">No friends yet</p>
              <p className="font-mono text-[9px] text-[var(--ink-3)] mt-1">Add a friend by username above</p>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-[var(--line)] border-t border-[var(--line)]">
            {friends.map(friend => (
              <div key={friend.friendshipId} className="flex items-center gap-3 px-5 py-3.5">
                <button type="button" onClick={() => setViewFriendId(friend.id)}
                  className="w-10 h-10 rounded-full bg-[var(--bg-3)] border border-[var(--line-2)] flex items-center justify-center flex-shrink-0 overflow-hidden">
                  {friend.photo ? (
                    <img src={friend.photo} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <span className="font-display text-[15px] text-[var(--ink-2)]">
                      {(friend.name ?? friend.username ?? '?')[0].toUpperCase()}
                    </span>
                  )}
                </button>
                <button type="button" onClick={() => setViewFriendId(friend.id)} className="flex-1 min-w-0 text-left">
                  <p className="font-mono text-[12px] font-bold text-[var(--ink-0)] truncate">{friend.name ?? friend.username ?? 'Unknown'}</p>
                  {friend.status ? (
                    <p className="font-mono text-[9px] text-[var(--accent)] truncate">{friend.status}</p>
                  ) : (
                    <p className="font-mono text-[9px] text-[var(--ink-3)]">
                      {friend.username ? `@${friend.username} · ` : ''}{friend.badgeCount} badge{friend.badgeCount !== 1 ? 's' : ''}
                    </p>
                  )}
                  {friend.status && friend.username && (
                    <p className="font-mono text-[8px] text-[var(--ink-3)]">
                      @{friend.username} · {friend.badgeCount} badge{friend.badgeCount !== 1 ? 's' : ''}
                    </p>
                  )}
                </button>
                {pendingRemove === friend.friendshipId ? (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button type="button" onClick={() => setPendingRemove(null)}
                      className="px-3 h-11 flex items-center font-mono text-[10px] text-[var(--ink-3)] hover:text-[var(--ink-1)] active:text-[var(--ink-1)] transition-colors">
                      Cancel
                    </button>
                    <button type="button" onClick={() => removeFriend(friend.friendshipId)}
                      className="px-3 h-11 flex items-center font-mono text-[10px] font-bold text-[var(--danger)] hover:opacity-80 active:opacity-60 transition-opacity">
                      Remove
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button type="button" onClick={() => setChallenging(friend)}
                      className="flex items-center gap-1.5 px-3 h-10 rounded-md border font-mono text-[10px] font-bold tracking-[0.5px] uppercase transition-all active:scale-95"
                      style={{ borderColor: 'rgba(255,181,71,0.4)', color: '#FFB547' }}>
                      <Swords size={13} /> Battle
                    </button>
                    <button type="button" onClick={() => { setPendingRemove(friend.friendshipId); setRemoveError(null); }}
                      aria-label="Remove friend"
                      className="w-10 h-10 flex items-center justify-center text-[var(--ink-3)] hover:text-[var(--danger)] active:text-[var(--danger)] transition-colors">
                      <X size={15} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── INVITE FRIENDS (growth CTA — footer) ──────────────────────────── */}
      {hasUsername && ownProfile?.username && (
        <InviteFriends username={ownProfile.username} referralCount={ownProfile.referralCount ?? 0} />
      )}

          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Modals ── */}
      <AnimatePresence>
        {viewFriendId && (() => {
          const friend = friends.find(f => f.id === viewFriendId);
          return (
            <FriendProfileSheet
              key={viewFriendId}
              userId={viewFriendId}
              onClose={() => setViewFriendId(null)}
              onChallenge={() => {
                setViewFriendId(null);
                if (friend) setChallenging(friend);
              }}
            />
          );
        })()}
        {challenging && (
          <ChallengeModal
            friend={challenging}
            myBalance={balance}
            onClose={() => setChallenging(null)}
            onSent={refresh}
          />
        )}
        {viewBattleId && (() => {
          const battle =
            activeBattles.find(c => c.id === viewBattleId) ??
            resolved.find(c => c.id === viewBattleId);
          if (!battle) return null;
          // The opponent's photo lives on the friend record (the challenge
          // payload itself only carries id/name/username for privacy).
          const opponentId = battle.challenger.id === ownProfile?.id
            ? battle.challengee.id
            : battle.challenger.id;
          const friendRec = friends.find(f => f.id === opponentId);
          return (
            <BattleDetailSheet
              key={viewBattleId}
              challenge={battle}
              myId={ownProfile?.id ?? ''}
              myName={ownProfile?.name ?? ownProfile?.username ?? 'You'}
              myPhoto={ownProfile?.profilePhoto ?? null}
              opponentPhoto={friendRec?.photo ?? null}
              onClose={() => setViewBattleId(null)}
            />
          );
        })()}
      </AnimatePresence>
    </div>
  );
}
