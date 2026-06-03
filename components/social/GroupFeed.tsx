'use client';

import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { MessageCircle, Trash2, X, Bookmark, Plus, Send, Swords, Settings, UserPlus, LogOut, BarChart3 } from 'lucide-react';
import { useApp } from '@/lib/AppContext';
import type { DayRecord } from '@/lib/AppContext';
import { summarizeDay, type CardioSeg, type WorkoutItem } from '@/lib/shareWorkout';
import { getWorkoutPresets, saveWorkoutPresets } from '@/lib/storage';
import { BATTLE_CATEGORIES } from '@/lib/battle-categories';
import { CreateTeamBattle } from '@/components/social/TeamBattles';
import { GroupLeaderboard } from '@/components/social/GroupLeaderboard';

interface MemberLite { id: string; name: string | null; username: string | null; photo: string | null }
interface GroupLite  { id: string; name: string; ownerId: string; isOwner: boolean; members: MemberLite[]; description?: string | null; createdAt?: string }

interface PostPayload { title?: string; lines?: string[]; items?: WorkoutItem[]; exercises?: string; liftCount?: number; setCount?: number; volume?: number; cardio?: CardioSeg[] }
interface Post {
  id: string; date: string; note: string | null; payload: PostPayload; createdAt: string;
  author: { id: string; name: string | null; username: string | null; photo: string | null };
  likeCount: number; commentCount: number; liked: boolean; mine: boolean;
}
interface Comment { id: string; text: string; createdAt: string; author: { id: string; name: string | null; username: string | null } }

const mdy = (iso: string) => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };
const NM  = (p: { name: string | null; username: string | null }) => p.name ?? (p.username ? `@${p.username}` : 'Athlete');

function Avatar({ p, size = 30 }: { p: { name: string | null; username: string | null; photo?: string | null }; size?: number }) {
  if (p.photo) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={p.photo} alt="" style={{ width: size, height: size }} className="rounded-full object-cover border border-[var(--line-2)]" />;
  }
  return (
    <span className="rounded-full inline-flex items-center justify-center font-mono font-bold text-[var(--accent)] bg-[var(--accent-12)] border border-[var(--accent-24)]"
      style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">
      {NM(p).replace('@', '').charAt(0).toUpperCase()}
    </span>
  );
}


const KIND_ICON: Record<string, string> = { lift: '🏋️', run: '🏃', bike: '🚴', swim: '🏊' };

/** Pretty muscle-group label (stored lowercase: "chest" → "Chest"). */
function groupLabel(g: string): string {
  return g.charAt(0).toUpperCase() + g.slice(1);
}

interface LiftEntry { name: string; group: string; sets: { r: string; w: string }[]; topWeight: number; volume: number }

/** Parse the raw exercises JSON in a post payload into structured lifts (sets,
 *  top weight, volume) — the source for the per-set bars + muscle filter. */
function parseLifts(json?: string): LiftEntry[] {
  if (!json) return [];
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Record<string, unknown>>)
    .filter(e => e.k === 'lift')
    .map(ex => {
      const rawSets = Array.isArray(ex.sets) ? ex.sets as Array<{ r?: unknown; w?: unknown }> : [];
      const sets = rawSets.length
        ? rawSets.map(s => ({ r: String(s.r ?? ''), w: String(s.w ?? '') }))
        : (ex.s ? Array.from({ length: parseInt(String(ex.s)) || 1 }, () => ({ r: String(ex.r ?? ''), w: String(ex.w ?? '') })) : []);
      const weights = sets.map(s => parseFloat(s.w) || 0);
      const topWeight = weights.length ? Math.max(...weights) : 0;
      const volume = sets.reduce((sum, s) => sum + (parseFloat(s.r) || 0) * (parseFloat(s.w) || 0), 0);
      return { name: String(ex.n ?? 'Exercise'), group: String(ex.g || 'Other'), sets, topWeight, volume };
    });
}

/** minutes → "m:ss" (handles fractional minutes from pace math). */
function fmtClock(minutes: number): string {
  const total = Math.round(minutes * 60);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
const fmtPace = (distMi: number, timeMin: number) => (distMi > 0 ? fmtClock(timeMin / distMi) : '');

/** ISO timestamp → "7:14a" (the post time, used as the activity time stamp). */
function fmtTimeOfDay(iso: string): string {
  const d = new Date(iso);
  let h = d.getHours();
  const ap = h < 12 ? 'a' : 'p';
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}${ap}`;
}

/** Cardio for a post: prefer the structured payload, else recover dist/time
 *  from the legacy item detail strings ("3.1 mi · 31 min") on older posts. */
function postCardio(payload: PostPayload): CardioSeg[] {
  if (payload.cardio?.length) return payload.cardio;
  const out: CardioSeg[] = [];
  for (const it of payload.items ?? []) {
    if (it.kind === 'lift') continue;
    const dist = it.detail.match(/([\d.]+)\s*mi/);
    const time = it.detail.match(/([\d.]+)\s*min/);
    out.push({ kind: it.kind as CardioSeg['kind'], dist: dist ? parseFloat(dist[1]) : 0, time: time ? parseFloat(time[1]) : 0 });
  }
  return out;
}

/** Small decorative cardio motif — no axes/values, purely a visual accent. */
function Sparkline() {
  return (
    <svg width="56" height="20" viewBox="0 0 56 20" fill="none" aria-hidden="true" className="flex-shrink-0">
      <polyline points="0,15 8,11 16,13 24,6 32,9 40,4 48,8 56,3"
        stroke="var(--ink-3)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Local YYYY-MM-DD, offset days from today (negative = past). */
function localDay(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const WK  = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Feed date divider label: "TODAY · THU 5/28", "YESTERDAY · …", else "MON 5/26". */
function dayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = WK[new Date(y, m - 1, d).getDay()];
  const md = `${m}/${d}`;
  if (dateStr === localDay(0))  return `TODAY · ${wd} ${md}`;
  if (dateStr === localDay(-1)) return `YESTERDAY · ${wd} ${md}`;
  return `${wd} ${md}`;
}

/** Group "established" label from createdAt: "Apr '26". */
function estLabel(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${MON[d.getMonth()]} '${String(d.getFullYear()).slice(2)}`;
}

// ── Active/pending battles strip ──────────────────────────────────────────────

interface StripStandingsTeams { mode: 'teams'; started: boolean; team0Wins: number; team1Wins: number; perCategory: { slug: string; label: string; team0Score: number | null; team1Score: number | null; leader: 0 | 1 | null }[] }
interface StripStandingsFFA   { mode: 'ffa'; started: boolean; leaderboard: { userId: string; categoryWins: number }[]; perCategory: { slug: string; label: string; scores: Record<string, number | null>; leaderId: string | null }[] }
type StripStandings = StripStandingsTeams | StripStandingsFFA;
interface StripParticipant { id: string; team: number; accepted: boolean; name: string | null; username: string | null; photo: string | null }
interface StripBattle {
  id: string; mode: 'teams' | 'ffa'; wager: number; bestOf: number; windowKind: string;
  startDate: string; endDate: string; categories: string[]; status: string;
  participants: StripParticipant[]; standings: StripStandings | null;
}

/** 38400 → "38.4k". */
function compact(n: number): string {
  if (Math.abs(n) >= 1000) { const k = n / 1000; return `${k.toFixed(k >= 100 ? 0 : 1).replace(/\.0$/, '')}k`; }
  return String(Math.round(n));
}
function daysLeftLabel(endDate: string): string {
  const [ey, em, ed] = endDate.split('-').map(Number);
  const [ty, tm, td] = localDay(0).split('-').map(Number);
  const diff = Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(ty, tm - 1, td)) / 86400000);
  return diff <= 0 ? 'ends today' : `${diff} day${diff === 1 ? '' : 's'} left`;
}
const initials = (ps: StripParticipant[]) => ps.map(p => NM(p).replace('@', '').charAt(0).toUpperCase()).join('·') || '—';
const catLabel = (slug?: string) => BATTLE_CATEGORIES.find(c => c.slug === slug)?.label ?? slug ?? '';

const GROUP_ICON: Record<string, string> = { cardio: '🏃', lift: '🏋️', diet: '🍽️' };
function catMeta(slug: string): { group: string; direction: 'higher' | 'lower'; unit: string } {
  const c = BATTLE_CATEGORIES.find(x => x.slug === slug);
  return { group: c?.group ?? 'lift', direction: (c?.direction as 'higher' | 'lower') ?? 'higher', unit: c?.unit ?? '' };
}
function fmtNum(v: number | null): string {
  if (v == null) return '—';
  if (Math.abs(v) >= 1000) return compact(v);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
function rangeLabel(s: string, e: string): string {
  const [, sm, sd] = s.split('-').map(Number);
  const [, em, ed] = e.split('-').map(Number);
  return s === e ? `${MON[sm - 1]} ${sd}` : `${MON[sm - 1]} ${sd} – ${MON[em - 1]} ${ed}`;
}

interface Entrant { key: string; name: string; value: number | null; leader: boolean }

/** One category block: a sorted set of bars (leader highlighted). Bar length is
 *  relative standing (leader always longest, respecting direction); the number
 *  is the real value. */
function CategoryBlock({ slug, label, entrants }: { slug: string; label: string; entrants: Entrant[] }) {
  const meta = catMeta(slug);
  const vals = entrants.map(e => e.value).filter((v): v is number => v != null);
  const max = vals.length ? Math.max(...vals) : 0;
  const min = vals.length ? Math.min(...vals) : 0;
  const frac = (v: number | null): number => {
    if (v == null) return 0;
    if (meta.direction === 'higher') return max > 0 ? v / max : 0;
    return max === min ? 1 : (max - v) / (max - min);   // lower wins → smaller value = longer bar
  };
  const sorted = [...entrants].sort((x, y) => {
    if (x.value == null) return 1;
    if (y.value == null) return -1;
    return meta.direction === 'higher' ? y.value - x.value : x.value - y.value;
  });

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-[12px]">{GROUP_ICON[meta.group] ?? '🏅'}</span>
        <span className="font-mono text-[9px] font-bold tracking-[1.5px] uppercase text-[var(--ink-2)]">{label}</span>
        {meta.unit && <span className="font-mono text-[8px] text-[var(--ink-3)]">· {meta.unit}</span>}
        {meta.direction === 'lower' && <span className="font-mono text-[8px] text-[var(--ink-3)]">· lower wins</span>}
      </div>
      <div className="space-y-1.5">
        {sorted.map(e => (
          <div key={e.key} className="flex items-center gap-2">
            <span className={`font-mono text-[10px] w-12 truncate flex-shrink-0 ${e.leader ? 'font-bold text-[var(--ink-0)]' : 'text-[var(--ink-2)]'}`}>{e.name}</span>
            <div className="flex-1 h-3 rounded-full overflow-hidden" style={{ background: 'var(--bg-3)' }}>
              <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(3, frac(e.value) * 100)}%`, background: e.leader ? 'var(--accent)' : 'var(--ink-3)' }} />
            </div>
            <span className={`font-mono text-[10px] tabular-nums text-right flex-shrink-0 w-12 ${e.leader ? 'font-bold text-[var(--ink-0)]' : 'text-[var(--ink-2)]'}`}>{fmtNum(e.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Full battle detail — Stats (per-category bars) + Leaderboard tabs. */
function BattleDetail({ battle, onClose }: { battle: StripBattle; onClose: () => void }) {
  const [tab, setTab] = useState<'stats' | 'board'>('stats');
  const st = battle.standings;
  const teamsMode = battle.mode === 'teams';
  const teamA = battle.participants.filter(p => p.team === 0);
  const teamB = battle.participants.filter(p => p.team === 1);
  const pById = new Map(battle.participants.map(p => [p.id, p]));
  const started = !!st?.started;
  const totalCats = battle.categories.length;
  const title = teamsMode ? `${teamA.length}v${teamB.length} battle` : `${battle.participants.length}-way FFA`;

  return (
    <div className="fixed inset-0 z-[490] flex items-end sm:items-center justify-center bg-black/70 px-0 sm:px-4" onClick={onClose}>
      <div className="w-full sm:max-w-[440px] h-[90dvh] sm:h-auto sm:max-h-[88vh] flex flex-col rounded-t-2xl sm:rounded-2xl bg-[var(--bg-1)] overflow-hidden"
        style={{ boxShadow: '0 0 0 1px var(--line-2), 0 -2px 0 0 var(--accent), 0 40px 80px rgba(0,0,0,0.6)' }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 flex-shrink-0">
          <div className="min-w-0">
            <h3 className="font-display text-[18px] tracking-[1px] uppercase text-[var(--ink-0)] truncate">{title}</h3>
            <p className="font-mono text-[9px] text-[var(--ink-3)] mt-0.5">
              {rangeLabel(battle.startDate, battle.endDate)} · Bo{battle.bestOf}{battle.wager > 0 ? ` · ${battle.wager} 🪙 ante` : ''}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="w-9 h-9 -mr-1 flex items-center justify-center text-[var(--ink-2)] hover:text-[var(--accent)] flex-shrink-0"><X size={18} /></button>
        </div>

        {/* Tabs */}
        <div className="px-5 pb-3 flex-shrink-0">
          <div className="flex gap-1 p-0.5 rounded-md bg-[var(--bg-3)]">
            {(['stats', 'board'] as const).map(t => (
              <button key={t} type="button" onClick={() => setTab(t)}
                className="flex-1 py-1.5 font-mono text-[9px] font-bold tracking-[1px] uppercase rounded-sm transition-all"
                style={tab === t ? { background: 'var(--accent)', color: 'var(--accent-ink)' } : { color: 'var(--ink-3)' }}>
                {t === 'stats' ? 'Stats' : 'Leaderboard'}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 pb-6" style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}>
          {!started || !st ? (
            <div className="text-center py-12">
              <p className="font-mono text-[11px] text-[var(--ink-2)] font-bold tracking-[1px] uppercase">Not started yet</p>
              <p className="font-mono text-[9px] text-[var(--ink-3)] mt-1">Stats appear once the window opens on {rangeLabel(battle.startDate, battle.startDate)}.</p>
            </div>
          ) : tab === 'stats' ? (
            <div className="space-y-5">
              {battle.categories.map(slug => {
                if (st.mode === 'teams') {
                  const pc = st.perCategory.find(c => c.slug === slug);
                  const entrants: Entrant[] = [
                    { key: 'A', name: 'Team A', value: pc?.team0Score ?? null, leader: pc?.leader === 0 },
                    { key: 'B', name: 'Team B', value: pc?.team1Score ?? null, leader: pc?.leader === 1 },
                  ];
                  return <CategoryBlock key={slug} slug={slug} label={pc?.label ?? slug} entrants={entrants} />;
                }
                const pc = st.perCategory.find(c => c.slug === slug);
                const entrants: Entrant[] = battle.participants.map(p => ({
                  key: p.id, name: NM(p).replace('@', ''), value: pc?.scores[p.id] ?? null, leader: pc?.leaderId === p.id,
                }));
                return <CategoryBlock key={slug} slug={slug} label={pc?.label ?? slug} entrants={entrants} />;
              })}
            </div>
          ) : (
            /* Leaderboard */
            <div className="space-y-2">
              {st.mode === 'ffa'
                ? [...st.leaderboard].sort((a, b) => b.categoryWins - a.categoryWins).map((row, i) => {
                    const p = pById.get(row.userId);
                    const lead = i === 0 && row.categoryWins > 0;
                    return (
                      <div key={row.userId} className="flex items-center gap-3 rounded-lg p-3 border"
                        style={{ borderColor: lead ? 'var(--accent-24)' : 'var(--line)', background: lead ? 'var(--accent-12)' : 'var(--bg-2)' }}>
                        <span className="font-display text-[18px] w-5 text-center flex-shrink-0" style={{ color: lead ? 'var(--accent)' : 'var(--ink-3)' }}>{i + 1}</span>
                        {p && <Avatar p={p} size={28} />}
                        <span className="font-mono text-[11px] font-bold text-[var(--ink-0)] flex-1 min-w-0 truncate">{p ? NM(p) : 'Athlete'}{lead && ' 👑'}</span>
                        <span className="font-mono text-[11px] font-bold tabular-nums flex-shrink-0" style={{ color: lead ? 'var(--accent)' : 'var(--ink-2)' }}>{row.categoryWins}<span className="text-[var(--ink-3)] font-normal">/{totalCats}</span></span>
                      </div>
                    );
                  })
                : ([{ team: 0, wins: st.team0Wins, members: teamA }, { team: 1, wins: st.team1Wins, members: teamB }] as { team: 0 | 1; wins: number; members: StripParticipant[] }[])
                    .sort((a, b) => b.wins - a.wins).map(t => {
                      const lead = t.wins > (t.team === 0 ? st.team1Wins : st.team0Wins);
                      return (
                        <div key={t.team} className="rounded-lg p-3 border"
                          style={{ borderColor: lead ? 'var(--accent-24)' : 'var(--line)', background: lead ? 'var(--accent-12)' : 'var(--bg-2)' }}>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[11px] font-bold text-[var(--ink-0)] flex-1">Team {t.team === 0 ? 'A' : 'B'}{lead && ' 👑'}</span>
                            <span className="font-mono text-[12px] font-bold tabular-nums" style={{ color: lead ? 'var(--accent)' : 'var(--ink-2)' }}>{t.wins}<span className="text-[var(--ink-3)] font-normal">/{totalCats}</span></span>
                          </div>
                          <div className="flex -space-x-2 mt-2">
                            {t.members.map(m => <span key={m.id} className="rounded-full inline-flex ring-2 ring-[var(--bg-1)]"><Avatar p={m} size={22} /></span>)}
                          </div>
                        </div>
                      );
                    })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Horizontally-scrollable strip of the group's active + pending battles. */
function GroupBattles({ groupId, version = 0 }: { groupId: string; version?: number }) {
  const [open, setOpen] = useState<StripBattle | null>(null);
  const [battles, setBattles] = useState<StripBattle[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/groups/${groupId}/battles`, { credentials: 'include' });
        if (!r.ok) return;
        const d = await r.json() as { battles: StripBattle[] };
        if (!cancelled) setBattles(d.battles ?? []);
      } catch { /* noop */ }
    })();
    return () => { cancelled = true; };
  }, [groupId, version]);

  if (battles.length === 0) return null;

  return (
    <div className="mb-4">
      <p className="font-mono text-[8px] font-bold tracking-[2px] uppercase text-[var(--ink-3)] mb-2 px-0.5">Active · {battles.length}</p>
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4" style={{ scrollbarWidth: 'none' }}>
        {battles.map(b => {
          const teamsMode = b.mode === 'teams';
          const a  = b.participants.filter(p => p.team === 0);
          const bb = b.participants.filter(p => p.team === 1);
          const sizeLabel = teamsMode ? `${a.length}v${bb.length}` : `FFA · ${b.participants.length}`;
          const active = b.status === 'active';
          const future = b.startDate > localDay(0);
          const statusLabel = future
            ? (() => { const [, m, d] = b.startDate.split('-').map(Number); return `starts ${MON[m - 1]} ${d}`; })()
            : active ? daysLeftLabel(b.endDate) : 'join';
          const cat = catLabel(b.categories[0]);

          let bar: ReactNode = null;
          if (active && b.standings?.started && b.standings.mode === 'teams') {
            const pc = b.standings.perCategory[0];
            const s0 = pc?.team0Score ?? 0, s1 = pc?.team1Score ?? 0;
            const tot = (s0 || 0) + (s1 || 0);
            const p0 = tot > 0 ? ((s0 || 0) / tot) * 100 : 50;
            bar = (
              <div className="mt-2">
                <div className="h-1.5 rounded-full overflow-hidden flex" style={{ background: 'var(--bg-3)' }}>
                  <span style={{ width: `${p0}%`, background: 'var(--accent)' }} />
                </div>
                <div className="flex justify-between mt-1 font-mono text-[9px] tabular-nums">
                  <span className="text-[var(--ink-1)]"><span className="font-bold">{initials(a)}</span> {compact(s0 || 0)}</span>
                  <span className="text-[var(--ink-2)]">{compact(s1 || 0)} <span className="font-bold">{initials(bb)}</span></span>
                </div>
              </div>
            );
          } else if (active && b.standings?.started && b.standings.mode === 'ffa') {
            const top  = b.standings.leaderboard[0];
            const topP = b.participants.find(p => p.id === top?.userId);
            bar = <p className="mt-2 font-mono text-[9px] text-[var(--ink-2)]">leader: <span className="font-bold text-[var(--ink-0)]">{topP ? NM(topP) : '—'}</span></p>;
          }

          return (
            <button key={b.id} type="button" onClick={() => setOpen(b)}
              className="flex-shrink-0 w-[180px] rounded-lg p-3 text-left transition-colors hover:border-[var(--accent)]"
              style={{ border: active ? '1px solid var(--line-2)' : '1px dashed var(--line-2)', background: active ? 'var(--bg-2)' : 'transparent' }}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[9px] font-bold uppercase tracking-[1px]" style={{ color: 'var(--accent)' }}>{sizeLabel}</span>
                <span className="font-mono text-[8px] text-[var(--ink-3)] whitespace-nowrap">{statusLabel}</span>
              </div>
              <p className="font-mono text-[11px] font-bold text-[var(--ink-0)] mt-1 truncate">
                {teamsMode ? `${initials(a)} vs ${initials(bb)}` : `${b.participants.length} players`}
                {cat && <span className="text-[var(--ink-3)] font-normal"> · {cat.toLowerCase()}</span>}
              </p>
              {bar}
            </button>
          );
        })}
      </div>

      {open && <BattleDetail battle={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function GroupFeed({ group, meId, friends, onChanged, onClose }: {
  group: GroupLite; meId: string; friends: MemberLite[]; onChanged: () => void; onClose: () => void;
}) {
  const { localDB } = useApp();
  const [posts, setPosts]     = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [busy, setBusy]       = useState(false);
  const [manageError, setManageError] = useState('');
  const [descDraft, setDescDraft] = useState(group.description ?? '');
  const [creatingBattle, setCreatingBattle] = useState(false);
  const [battleBusy, setBattleBusy] = useState(false);
  const [battleVersion, setBattleVersion] = useState(0);
  const [showLeaderboard, setShowLeaderboard] = useState(false);

  // Member CRUD — hits the API, then asks the parent to refresh the groups list
  // (the updated `group` prop flows back down). closeAfter is for delete/leave,
  // where this group ceases to exist for the user.
  const manage = async (url: string, method: string, body?: object, closeAfter = false) => {
    setBusy(true); setManageError('');
    try {
      const res = await fetch(url, {
        method, credentials: 'include',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) { setManageError((await res.json().catch(() => null))?.error ?? 'Something went wrong'); return; }
      onChanged();
      if (closeAfter) { setShowManage(false); onClose(); }
    } finally { setBusy(false); }
  };

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/groups/${group.id}/posts`, { credentials: 'include' });
      const d = r.ok ? await r.json() as { posts: Post[] } : null;
      setPosts(d?.posts ?? []);
    } catch { /* keep */ } finally { setLoading(false); }
  }, [group.id]);
  useEffect(() => { void refresh(); }, [refresh]);

  const toggleLike = async (p: Post) => {
    setPosts(prev => prev.map(x => x.id === p.id ? { ...x, liked: !x.liked, likeCount: x.likeCount + (x.liked ? -1 : 1) } : x));
    try {
      const r = await fetch(`/api/posts/${p.id}/like`, { method: 'POST', credentials: 'include' });
      if (r.ok) { const d = await r.json() as { liked: boolean; count: number }; setPosts(prev => prev.map(x => x.id === p.id ? { ...x, liked: d.liked, likeCount: d.count } : x)); }
    } catch { /* revert handled on next refresh */ }
  };

  const del = async (p: Post) => {
    setPosts(prev => prev.filter(x => x.id !== p.id));
    try { await fetch(`/api/posts/${p.id}`, { method: 'DELETE', credentials: 'include' }); } catch { /* noop */ }
  };

  // Open the team-battle creator scoped to THIS group, in place. (Previously it
  // dispatched an event the Social tab listened for + closed the feed; that
  // listener was removed when the Social tab moved to the group leaderboard, so
  // the group hub now owns team-battle creation directly.)
  const startBattle = () => setCreatingBattle(true);

  // Current group streak — consecutive days with ≥1 post, counting back from
  // today (or yesterday, so a not-yet-posted-today streak still reads as live).
  const streak = useMemo(() => {
    const dates = new Set(posts.map(p => p.date));
    if (!dates.size) return 0;
    let start: number;
    if (dates.has(localDay(0)))       start = 0;
    else if (dates.has(localDay(-1))) start = -1;
    else return 0;
    let n = 0;
    while (dates.has(localDay(start - n))) n++;
    return n;
  }, [posts]);

  // Posts split into date sections (newest first), each with a divider label.
  const sections = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, Post[]>();
    for (const p of posts) {
      if (!map.has(p.date)) { map.set(p.date, []); order.push(p.date); }
      map.get(p.date)!.push(p);
    }
    return order.map(date => ({ date, posts: map.get(date)! }));
  }, [posts]);

  const total = group.members.length;

  return (
    <div className="fixed inset-0 z-[470] flex flex-col bg-[var(--bg-0)]">
      {/* Slim top bar — back + settings */}
      <div className="flex items-center justify-between px-3 py-2 flex-shrink-0"
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}>
        <button onClick={onClose} aria-label="Back" className="w-10 h-10 flex items-center justify-center text-[var(--ink-2)] hover:text-[var(--accent)]"><X size={20} /></button>
        <button onClick={() => { setManageError(''); setDescDraft(group.description ?? ''); setShowManage(true); }} aria-label="Group settings"
          className="w-10 h-10 flex items-center justify-center text-[var(--ink-2)] hover:text-[var(--accent)]"><Settings size={18} /></button>
      </div>

      {/* Scrollable: group home card → actions → date-grouped feed */}
      <div className="flex-1 overflow-y-auto px-4" style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}>

        {/* Group home card — avatars + name, date + description underneath */}
        <div className="que-card p-4 mb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex -space-x-2 flex-shrink-0">
                {group.members.slice(0, 4).map(m => (
                  <span key={m.id} className="rounded-full inline-flex ring-2 ring-[var(--bg-1)]"><Avatar p={m} size={30} /></span>
                ))}
                {total > 4 && (
                  <span className="w-[30px] h-[30px] rounded-full inline-flex items-center justify-center font-mono text-[9px] font-bold text-[var(--ink-2)] bg-[var(--bg-3)] ring-2 ring-[var(--bg-1)]">+{total - 4}</span>
                )}
              </div>
              <h2 className="font-display text-[24px] tracking-[1px] text-[var(--ink-0)] leading-tight truncate min-w-0">{group.name}</h2>
            </div>
            {streak > 0 && (
              <span className="flex items-center gap-1 font-mono text-[10px] font-bold rounded-full px-2.5 py-1 flex-shrink-0 whitespace-nowrap"
                style={{ background: 'var(--accent-12)', color: 'var(--accent)', border: '1px solid var(--accent-24)' }}>
                🔥 {streak} day streak
              </span>
            )}
          </div>
          <p className="font-mono text-[10px] text-[var(--ink-3)] mt-2">
            {total} member{total === 1 ? '' : 's'}{group.createdAt ? ` · est. ${estLabel(group.createdAt)}` : ''}
          </p>
          {group.description && <p className="font-mono text-[10px] text-[var(--ink-2)] mt-2 leading-relaxed">{group.description}</p>}
        </div>

        {/* Actions */}
        <div className="space-y-2 mb-4">
          <button type="button" onClick={() => setSharing(true)} className="que-btn-primary w-full py-3 text-[12px] flex items-center justify-center gap-1.5">
            <Plus size={15} /> Share today
          </button>
          {total >= 2 && (
            <div className="flex gap-2">
              <button type="button" onClick={startBattle}
                className="flex-1 py-3 text-[12px] font-mono font-bold tracking-[0.5px] uppercase rounded-md border flex items-center justify-center gap-1.5 transition-all"
                style={{ borderColor: '#FFB547', color: '#FFB547' }}>
                <Swords size={14} /> Battle
              </button>
              <button type="button" onClick={() => setShowLeaderboard(true)}
                className="flex-1 py-3 text-[12px] font-mono font-bold tracking-[0.5px] uppercase rounded-md border flex items-center justify-center gap-1.5 transition-all"
                style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>
                <BarChart3 size={14} /> Leaderboard
              </button>
            </div>
          )}
        </div>

        {/* Active / pending battles */}
        <GroupBattles groupId={group.id} version={battleVersion} />

        {/* Feed */}
        {loading ? (
          <p className="font-mono text-[10px] text-[var(--ink-3)] text-center py-6">Loading feed…</p>
        ) : posts.length === 0 ? (
          <div className="text-center py-10">
            <p className="font-mono text-[11px] text-[var(--ink-2)] font-bold tracking-[1px] uppercase">No posts yet</p>
            <p className="font-mono text-[9px] text-[var(--ink-3)] mt-1">Be the first — tap “Share today”.</p>
          </div>
        ) : (
          sections.map(sec => (
            <div key={sec.date} className="mb-3">
              <p className="font-mono text-[8px] font-bold tracking-[2px] uppercase text-[var(--ink-3)] mb-2 px-0.5">{dayLabel(sec.date)}</p>
              <div className="space-y-3">
                {sec.posts.map(p => <PostCard key={p.id} post={p} onLike={() => toggleLike(p)} onDelete={() => del(p)} />)}
              </div>
            </div>
          ))
        )}
      </div>

      {sharing && (
        <ShareSheet
          localDB={localDB}
          groupName={group.name}
          onClose={() => setSharing(false)}
          onShared={() => { setSharing(false); void refresh(); }}
          groupId={group.id}
        />
      )}

      {/* Team-battle creator — scoped to this group, opened by the Battle button */}
      {creatingBattle && (
        <CreateTeamBattle
          meId={meId}
          groups={[group]}
          initialGroupId={group.id}
          busy={battleBusy}
          setBusy={setBattleBusy}
          onClose={() => setCreatingBattle(false)}
          onCreated={() => { setCreatingBattle(false); setBattleVersion(v => v + 1); }}
        />
      )}

      {/* Group leaderboard — read-only ranking of this group's members */}
      {showLeaderboard && (
        <div className="fixed inset-0 z-[480] flex items-end sm:items-center justify-center bg-black/60 px-4" onClick={() => setShowLeaderboard(false)}>
          <div className="w-full max-w-[440px] max-h-[88vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-[var(--bg-1)] border border-[var(--line-2)] p-5"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display text-[18px] tracking-[1.5px] uppercase text-[var(--ink-0)]">Leaderboard</h3>
              <button type="button" onClick={() => setShowLeaderboard(false)} className="text-[var(--ink-3)] hover:text-[var(--ink-0)]"><X size={18} /></button>
            </div>
            <GroupLeaderboard groupId={group.id} />
          </div>
        </div>
      )}

      {/* Manage group — members, add friends, delete/leave */}
      {showManage && (
        <div className="fixed inset-0 z-[480] flex items-end sm:items-center justify-center bg-black/60 px-4" onClick={() => setShowManage(false)}>
          <div className="w-full max-w-[400px] max-h-[88vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-[var(--bg-1)] border border-[var(--line-2)] p-5"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-[18px] tracking-[1.5px] uppercase text-[var(--ink-0)]">Manage Group</h3>
              <button type="button" onClick={() => setShowManage(false)} className="text-[var(--ink-3)] hover:text-[var(--ink-0)]"><X size={18} /></button>
            </div>

            {/* Description (owner) */}
            {group.isOwner && (
              <div className="mb-4">
                <label className="que-label">Description</label>
                <textarea className="que-input resize-none" rows={2} maxLength={200} placeholder="What's this group about?"
                  value={descDraft} onChange={e => setDescDraft(e.target.value)} />
                <div className="flex justify-end mt-1.5">
                  <button type="button"
                    disabled={busy || descDraft.trim() === (group.description ?? '').trim()}
                    onClick={() => manage(`/api/groups/${group.id}`, 'PATCH', { description: descDraft.trim() })}
                    className="font-mono text-[9px] font-bold tracking-[1px] uppercase text-[var(--accent)] border border-[var(--accent)]/50 rounded-sm px-2.5 py-1.5 hover:bg-[var(--accent)] hover:text-[var(--accent-ink)] transition-all disabled:opacity-40">
                    Save description
                  </button>
                </div>
              </div>
            )}

            {/* Member list */}
            <div className="space-y-1.5 mb-4">
              {group.members.map(m => (
                <div key={m.id} className="flex items-center gap-2">
                  <Avatar p={m} size={22} />
                  <span className="font-mono text-[10px] text-[var(--ink-1)] flex-1 min-w-0 truncate">
                    {NM(m)}{m.id === group.ownerId && <span className="text-[var(--ink-3)]"> · owner</span>}
                  </span>
                  {group.isOwner && m.id !== group.ownerId && (
                    <button type="button" disabled={busy}
                      onClick={() => manage(`/api/groups/${group.id}/members`, 'DELETE', { userId: m.id })}
                      aria-label="Remove member"
                      className="text-[var(--ink-3)] hover:text-[var(--danger)] transition-colors disabled:opacity-40">
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Owner: add friends not already in the group */}
            {group.isOwner && (() => {
              const inGroup = new Set(group.members.map(m => m.id));
              const addable = friends.filter(f => !inGroup.has(f.id));
              return addable.length > 0 ? (
                <div className="mb-4">
                  <p className="font-mono text-[9px] font-bold tracking-[1.5px] uppercase text-[var(--ink-3)] mb-1.5">Add friends</p>
                  <div className="flex flex-wrap gap-1.5">
                    {addable.map(f => (
                      <button key={f.id} type="button" disabled={busy}
                        onClick={() => manage(`/api/groups/${group.id}/members`, 'POST', { userId: f.id })}
                        className="flex items-center gap-1 font-mono text-[9px] text-[var(--ink-1)] border border-[var(--line-2)] rounded-full pl-1 pr-2 py-0.5 hover:border-[var(--accent)] hover:text-[var(--accent)] transition-all disabled:opacity-40">
                        <Avatar p={f} size={16} /> <UserPlus size={10} /> {f.name ?? f.username}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null;
            })()}

            {manageError && <p className="font-mono text-[9px] text-[var(--danger)] mb-2">{manageError}</p>}

            {/* Owner deletes, member leaves */}
            <div className="flex justify-end pt-1">
              {group.isOwner ? (
                <button type="button" disabled={busy}
                  onClick={() => manage(`/api/groups/${group.id}`, 'DELETE', undefined, true)}
                  className="font-mono text-[9px] font-bold tracking-[1px] uppercase text-[var(--danger)] border border-[var(--danger)]/40 rounded-sm px-2.5 py-1.5 hover:bg-[var(--danger)]/10 transition-all flex items-center gap-1 disabled:opacity-40">
                  <Trash2 size={12} /> Delete group
                </button>
              ) : (
                <button type="button" disabled={busy}
                  onClick={() => manage(`/api/groups/${group.id}/members`, 'DELETE', { userId: meId }, true)}
                  className="font-mono text-[9px] font-bold tracking-[1px] uppercase text-[var(--ink-2)] border border-[var(--line-2)] rounded-sm px-2.5 py-1.5 hover:border-[var(--danger)] hover:text-[var(--danger)] transition-all flex items-center gap-1 disabled:opacity-40">
                  <LogOut size={12} /> Leave
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Single post ──────────────────────────────────────────────────────────────

function PostCard({ post, onLike, onDelete }: { post: Post; onLike: () => void; onDelete: () => void }) {
  const [showComments, setShowComments] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loadingC, setLoadingC] = useState(false);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);   // muscle-pill filter

  const loadComments = useCallback(async () => {
    setLoadingC(true);
    try {
      const r = await fetch(`/api/posts/${post.id}/comments`, { credentials: 'include' });
      const d = r.ok ? await r.json() as { comments: Comment[] } : null;
      setComments(d?.comments ?? []);
    } catch { /* noop */ } finally { setLoadingC(false); }
  }, [post.id]);

  const openComments = () => { const next = !showComments; setShowComments(next); if (next && comments.length === 0) void loadComments(); };

  const addComment = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    try {
      const r = await fetch(`/api/posts/${post.id}/comments`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t }),
      });
      if (r.ok) { const d = await r.json() as { comment: Comment }; setComments(prev => [...prev, d.comment]); }
    } catch { /* noop */ }
  };

  const saveAsPreset = () => {
    try {
      const ps = getWorkoutPresets();
      const name = post.payload.title ? `${post.payload.title}` : 'Shared workout';
      saveWorkoutPresets([...ps, {
        id: `preset_${Date.now()}`, name, exercises: post.payload.exercises ?? '[]',
        isRecurring: false, daysOfWeek: [], everyNWeeks: 1, createdAt: new Date().toISOString().slice(0, 10),
      }]);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* noop */ }
  };

  const lifts = useMemo(() => parseLifts(post.payload.exercises), [post.payload.exercises]);
  const groups = useMemo(() => {
    const seen: string[] = [];
    for (const l of lifts) if (!seen.includes(l.group)) seen.push(l.group);
    return seen;
  }, [lifts]);
  const shownLifts = activeGroup ? lifts.filter(l => l.group === activeGroup) : lifts;
  const maxWeight  = Math.max(1, ...lifts.map(l => l.topWeight));

  const lines  = post.payload.lines ?? [];
  const cardio = postCardio(post.payload);
  const volume = post.payload.volume ?? lifts.reduce((s, l) => s + l.volume, 0);
  const hasExercises = !!post.payload.exercises && post.payload.exercises !== '[]';
  const stamp  = `${mdy(post.date)} · ${fmtTimeOfDay(post.createdAt)}`;

  return (
    <div className="rounded-xl border border-black bg-[var(--bg-1)] overflow-hidden">
      {/* Header — avatar, name/time, volume */}
      <div className="flex items-start gap-3 px-4 pt-4 pb-3">
        <Avatar p={post.author} size={38} />
        <div className="flex-1 min-w-0">
          <p className="font-mono text-[12px] font-bold text-[var(--ink-0)] truncate">{NM(post.author)}</p>
          <p className="font-mono text-[9px] text-[var(--ink-3)] mt-0.5">{stamp}</p>
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          {post.mine && (
            confirmDel ? (
              <div className="flex items-center gap-1">
                <button onClick={() => setConfirmDel(false)} className="font-mono text-[9px] text-[var(--ink-3)] px-1">Keep</button>
                <button onClick={onDelete} className="font-mono text-[9px] font-bold text-[var(--danger)] px-1">Delete</button>
              </div>
            ) : (
              <button onClick={() => setConfirmDel(true)} aria-label="Delete post" className="text-[var(--ink-3)] hover:text-[var(--danger)]"><Trash2 size={13} /></button>
            )
          )}
          {volume > 0 && (
            <div className="text-right">
              <p className="font-display text-[26px] leading-none" style={{ color: 'var(--accent)' }}>{volume.toLocaleString()}</p>
              <p className="font-mono text-[8px] text-[var(--ink-3)] tracking-[0.5px] mt-0.5">lbs · volume</p>
            </div>
          )}
        </div>
      </div>

      {/* Muscle-group filter pills */}
      {groups.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-3">
          {groups.map(g => {
            const active = activeGroup === g;
            return (
              <button key={g} type="button" onClick={() => setActiveGroup(active ? null : g)}
                className="font-mono text-[10px] font-bold rounded-full px-2.5 py-1 border transition-all"
                style={active
                  ? { background: 'var(--accent)', color: 'var(--accent-ink)', borderColor: 'var(--accent)' }
                  : { background: 'transparent', color: 'var(--ink-2)', borderColor: 'var(--line-2)' }}>
                {groupLabel(g).toLowerCase()}
              </button>
            );
          })}
        </div>
      )}

      {/* Lifting — one bar per exercise, segmented by set, length ∝ top weight */}
      {lifts.length > 0 ? (
        <div className="px-4 pb-3">
          <div className="flex items-center gap-1.5 mb-2">
            <span className="text-[12px]">🏋️</span>
            <span className="font-mono text-[8px] font-bold tracking-[2px] uppercase text-[var(--ink-3)]">
              Lifting · {shownLifts.length} exercise{shownLifts.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="space-y-2">
            {shownLifts.map((l, i) => {
              const widthPct = Math.max(10, (l.topWeight / maxWeight) * 100);
              const segs = Math.max(1, l.sets.length);
              return (
                <div key={i} className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-[var(--ink-1)] w-[38%] truncate flex-shrink-0">{l.name}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex gap-0.5 h-2.5" style={{ width: `${widthPct}%` }}>
                      {Array.from({ length: segs }).map((_, s) => (
                        <span key={s} className="flex-1 rounded-[2px]"
                          style={{ background: 'var(--accent)', opacity: 0.45 + 0.55 * ((parseFloat(l.sets[s]?.w ?? '') || l.topWeight) / maxWeight) }} />
                      ))}
                    </div>
                  </div>
                  <span className="font-mono text-[10px] font-bold text-[var(--ink-1)] tabular-nums text-right flex-shrink-0 w-[42px]">{l.topWeight || ''}</span>
                </div>
              );
            })}
            {shownLifts.length === 0 && (
              <p className="font-mono text-[9px] text-[var(--ink-3)]">No {activeGroup ? groupLabel(activeGroup).toLowerCase() : ''} exercises.</p>
            )}
          </div>
        </div>
      ) : lines.length > 0 && cardio.length === 0 ? (
        <div className="px-4 pb-3 space-y-0.5">
          {lines.map((l, i) => <p key={i} className="font-mono text-[10px] text-[var(--ink-1)]">{l}</p>)}
        </div>
      ) : null}

      {/* Cardio */}
      {cardio.length > 0 && (
        <div className="px-4 pb-3 pt-3 border-t border-[var(--line)]">
          <div className="flex items-center gap-1.5 mb-2">
            <span className="text-[12px]">🏃</span>
            <span className="font-mono text-[8px] font-bold tracking-[2px] uppercase text-[var(--ink-3)]">Cardio</span>
          </div>
          {cardio.map((c, i) => (
            <div key={i} className="flex items-center justify-between gap-3">
              <p className="font-mono text-[11px] text-[var(--ink-1)] tabular-nums">
                <span className="mr-1">{KIND_ICON[c.kind]}</span>
                {c.dist > 0 && <><span className="font-bold">{c.dist}</span> mi</>}
                {c.time > 0 && <> · <span className="font-bold">{fmtClock(c.time)}</span></>}
                {c.kind === 'run' && c.dist > 0 && c.time > 0 && <span className="text-[var(--ink-3)]"> · {fmtPace(c.dist, c.time)}/mi</span>}
              </p>
              <Sparkline />
            </div>
          ))}
        </div>
      )}

      {post.note && <p className="font-mono text-[10px] text-[var(--ink-2)] italic px-4 pb-3">“{post.note}”</p>}

      {/* Reactions + actions */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-[var(--line)]">
        <button onClick={onLike} aria-label="React"
          className="flex items-center gap-1 font-mono text-[10px] font-bold rounded-full px-2.5 py-1 border transition-all"
          style={post.liked
            ? { background: 'var(--accent-12)', color: 'var(--accent)', borderColor: 'var(--accent-24)' }
            : { background: 'var(--bg-3)', color: 'var(--ink-2)', borderColor: 'var(--line-2)' }}>
          <span className="text-[11px]" style={{ filter: post.liked ? 'none' : 'grayscale(0.5)' }}>🔥</span>
          {post.likeCount > 0 && <span className="tabular-nums">{post.likeCount}</span>}
        </button>
        <button onClick={openComments} aria-label="Comments"
          className="flex items-center gap-1 font-mono text-[10px] font-bold rounded-full px-2.5 py-1 border border-[var(--line-2)] bg-[var(--bg-3)] text-[var(--ink-2)] hover:text-[var(--ink-0)] transition-all">
          <MessageCircle size={12} /> {post.commentCount > 0 && <span className="tabular-nums">{post.commentCount}</span>}
        </button>
        {hasExercises && (
          <button onClick={saveAsPreset} aria-label="Save to presets"
            className="flex items-center gap-1 font-mono text-[10px] font-bold rounded-full px-2.5 py-1 border transition-all"
            style={saved
              ? { background: 'var(--positive)', color: '#06140b', borderColor: 'var(--positive)' }
              : { background: 'var(--bg-3)', color: 'var(--ink-2)', borderColor: 'var(--line-2)' }}>
            <Bookmark size={12} fill={saved ? '#06140b' : 'none'} /> {saved ? 'Saved' : 'Save'}
          </button>
        )}
        <button onClick={openComments}
          className="ml-auto flex items-center gap-1 font-mono text-[10px] text-[var(--ink-3)] hover:text-[var(--ink-1)] transition-colors">
          ↩ comment
        </button>
      </div>

      {/* Comments */}
      {showComments && (
        <div className="px-4 pb-4 pt-3 border-t border-[var(--line)] space-y-2">
          {loadingC ? (
            <p className="font-mono text-[9px] text-[var(--ink-3)]">Loading…</p>
          ) : comments.length === 0 ? (
            <p className="font-mono text-[9px] text-[var(--ink-3)]">No comments yet.</p>
          ) : (
            comments.map(c => (
              <div key={c.id} className="font-mono text-[10px]">
                <span className="font-bold text-[var(--ink-1)]">{NM(c.author)}</span>{' '}
                <span className="text-[var(--ink-2)]">{c.text}</span>
              </div>
            ))
          )}
          <div className="flex gap-2 pt-1">
            <input type="text" className="que-input flex-1 text-[10px] py-2" placeholder="Add a comment…" value={text} maxLength={280}
              onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addComment(); }} />
            <button onClick={addComment} disabled={!text.trim()} aria-label="Send"
              className="px-3 rounded border border-[var(--line-2)] text-[var(--accent)] disabled:opacity-30 flex items-center"><Send size={14} /></button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Share sheet ────────────────────────────────────────────────────────────

function ShareSheet({ localDB, groupId, groupName, onClose, onShared }: {
  localDB: Record<string, DayRecord>; groupId: string; groupName: string;
  onClose: () => void; onShared: () => void;
}) {
  const [date, setDate] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Recent days (last 21) that actually have a workout/cardio to share.
  const days = Object.keys(localDB).sort().reverse()
    .map(d => ({ date: d, ...summarizeDay(localDB[d]) }))
    .filter(d => d.hasContent)
    .slice(0, 21);

  const selected = date ? summarizeDay(localDB[date]) : null;

  const share = async () => {
    if (!date || !selected) { setError('Pick a workout'); return; }
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/posts', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groupIds: [groupId], date,
          payload: {
            title: selected.title, items: selected.items, lines: selected.lines,
            exercises: selected.exercises, liftCount: selected.liftCount, setCount: selected.setCount,
            volume: selected.volume, cardio: selected.cardio,
          },
          note: note.trim() || undefined,
        }),
      });
      if (!res.ok) { setError((await res.json().catch(() => null))?.error ?? 'Could not share'); return; }
      onShared();
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[480] flex items-end sm:items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div className="w-full max-w-[420px] max-h-[86vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-[var(--bg-1)] border border-[var(--line-2)] p-5"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-display text-[18px] tracking-[1.5px] uppercase text-[var(--ink-0)]">Share to {groupName}</h3>
          <button onClick={onClose} className="text-[var(--ink-3)] hover:text-[var(--ink-0)]"><X size={18} /></button>
        </div>
        <p className="font-mono text-[10px] text-[var(--ink-2)] mb-4">Pick a recent workout to post to the group.</p>

        {days.length === 0 ? (
          <p className="font-mono text-[10px] text-[var(--ink-3)] mb-4">No logged workouts yet — log a lift or cardio first.</p>
        ) : (
          <div className="space-y-1.5 max-h-[34vh] overflow-y-auto mb-4">
            {days.map(d => {
              const on = date === d.date;
              return (
                <button key={d.date} type="button" onClick={() => setDate(d.date)}
                  className="w-full text-left px-3 py-2 rounded-md border transition-all"
                  style={{ borderColor: on ? 'var(--accent)' : 'var(--line)', background: on ? 'var(--accent-12)' : 'var(--bg-2)' }}>
                  <p className="font-mono text-[10px] font-bold" style={{ color: on ? 'var(--accent)' : 'var(--ink-0)' }}>{mdy(d.date)} · {d.title || 'Workout'}</p>
                  <p className="font-mono text-[8px] text-[var(--ink-3)] truncate">{d.lines.slice(0, 2).join(' · ')}</p>
                </button>
              );
            })}
          </div>
        )}

        {selected && (
          <div className="rounded-md border border-[var(--line)] bg-[var(--bg-2)] p-3 mb-3 space-y-0.5">
            {selected.lines.map((l, i) => <p key={i} className="font-mono text-[9px] text-[var(--ink-1)]">{l}</p>)}
          </div>
        )}

        <label className="que-label">Caption (optional)</label>
        <input type="text" className="que-input mb-4" placeholder="How'd it go?" value={note} maxLength={280} onChange={e => setNote(e.target.value)} />

        {error && <p className="font-mono text-[9px] text-[var(--danger)] mb-2">{error}</p>}

        <button type="button" onClick={share} disabled={busy || !date} className="que-btn-primary w-full py-3 disabled:opacity-40">
          {busy ? 'Sharing…' : 'Share'}
        </button>
      </div>
    </div>
  );
}
