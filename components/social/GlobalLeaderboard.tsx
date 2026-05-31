'use client';

import { useState, useEffect, useCallback } from 'react';
import { Trophy, Globe } from 'lucide-react';

interface Entry { rank: number; username: string; score: number; me: boolean }
interface Category { slug: string; label: string; unit: string }
interface Board {
  category: string;
  daysLeft: number;
  totalRanked: number;
  top: Entry[];
  me: Entry | null;
  optedIn: boolean;
  categories: Category[];
}

const DEFAULT_CATEGORY = 'cardio.steps';

function fmtScore(score: number, unit: string): string {
  if (unit === 'mi') return `${score.toLocaleString()} mi`;
  if (unit === 'lb') return score >= 1000 ? `${(score / 1000).toFixed(1)}k lb` : `${score} lb`;
  return score.toLocaleString(); // steps
}

const RANK_COLOR = (rank: number) =>
  rank === 1 ? '#FFD23F' : rank === 2 ? '#C7CDD6' : rank === 3 ? '#E08A4B' : 'var(--ink-3)';

function Row({ e, unit }: { e: Entry; unit: string }) {
  return (
    <div
      className="flex items-center gap-3 py-2 px-2 rounded-md"
      style={e.me ? { background: 'var(--accent-12)', border: '1px solid var(--accent)' } : undefined}
    >
      <span className="font-display text-[15px] tabular-nums w-7 text-center" style={{ color: RANK_COLOR(e.rank) }}>
        {e.rank}
      </span>
      <span className={`flex-1 font-mono text-[12px] truncate ${e.me ? 'text-[var(--accent)] font-bold' : 'text-[var(--ink-1)]'}`}>
        @{e.username}{e.me && ' · you'}
      </span>
      <span className="font-mono text-[12px] font-bold tabular-nums text-[var(--ink-0)]">{fmtScore(e.score, unit)}</span>
    </div>
  );
}

/**
 * Global, weekly-seasonal leaderboard — a competitive hook that works before a
 * user has friends. Opt-in gated (privacy); ranks reuse the battle-category
 * scorers so the metric matches a real battle.
 */
export function GlobalLeaderboard({ onOptInChange }: { onOptInChange?: () => void }) {
  const [category, setCategory] = useState(DEFAULT_CATEGORY);
  const [board, setBoard]       = useState<Board | null>(null);
  const [loading, setLoading]   = useState(true);
  const [joining, setJoining]   = useState(false);

  const load = useCallback(async (cat: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/leaderboard?category=${encodeURIComponent(cat)}`, { credentials: 'include' });
      if (res.ok) setBoard(await res.json());
    } catch { /* offline — leave prior board */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(category); }, [category, load]);

  const join = async () => {
    setJoining(true);
    try {
      await fetch('/api/user', {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leaderboardOptIn: true }),
      });
      await load(category);
      onOptInChange?.();
    } catch { /* ignore */ }
    finally { setJoining(false); }
  };

  const cats = board?.categories ?? [];
  const unit = cats.find(c => c.slug === category)?.unit ?? 'steps';
  const seasonLabel = board
    ? board.daysLeft <= 0 ? 'final day' : `resets in ${board.daysLeft}d`
    : '';

  return (
    <div className="que-card mb-4">
      <div className="px-5 pt-5 pb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="que-section-label">
            <span className="dot" style={{ background: '#FFD23F' }} />
            GLOBAL · THIS WEEK
          </h2>
          {board && (
            <span className="font-mono text-[9px] font-bold tracking-[1px] uppercase text-[var(--ink-3)] bg-[var(--bg-2)] border border-[var(--line)] rounded-full px-2.5 py-1">
              {seasonLabel}
            </span>
          )}
        </div>

        {/* Category tabs */}
        {cats.length > 0 && (
          <div className="flex gap-1.5 mb-3">
            {cats.map(c => (
              <button
                key={c.slug} type="button" onClick={() => setCategory(c.slug)}
                className={[
                  'flex-1 py-1.5 rounded-md font-mono text-[9px] font-bold uppercase tracking-[0.5px] transition-colors',
                  category === c.slug ? 'bg-[var(--accent-12)] text-[var(--accent)] border border-[var(--accent)]/40' : 'bg-[var(--bg-2)] text-[var(--ink-3)] border border-[var(--line)]',
                ].join(' ')}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}

        {loading && !board ? (
          <div className="flex justify-center py-8">
            <div className="w-5 h-5 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
          </div>
        ) : board ? (
          <>
            {board.top.length === 0 ? (
              <div className="flex items-start gap-2.5 rounded-md border border-dashed border-[var(--line-2)] bg-[var(--bg-2)] px-3 py-3">
                <Globe size={15} className="text-[var(--accent)] flex-shrink-0 mt-0.5" aria-hidden />
                <p className="font-mono text-[10px] text-[var(--ink-2)] leading-relaxed">
                  No one&apos;s on the board yet this week. Log a workout and claim the #1 spot.
                </p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {board.top.slice(0, 10).map(e => <Row key={e.username} e={e} unit={unit} />)}
              </div>
            )}

            {/* The user's own row, when they rank outside the visible top 10. */}
            {board.me && board.me.rank > 10 && (
              <>
                <p className="text-center font-mono text-[10px] text-[var(--ink-3)] my-1">···</p>
                <Row e={board.me} unit={unit} />
              </>
            )}

            {/* Opt-in / status footer */}
            {!board.optedIn ? (
              <div className="mt-3 rounded-md border border-[var(--accent)]/40 bg-[var(--accent-12)] px-3 py-3">
                <p className="font-mono text-[10px] text-[var(--ink-1)] leading-relaxed mb-2">
                  <Trophy size={12} className="inline mb-0.5 mr-1 text-[var(--accent)]" />
                  Join the global leaderboard to rank your week against everyone — your username + this stat become visible on the board.
                </p>
                <button
                  type="button" onClick={join} disabled={joining}
                  className="w-full py-2 rounded-md font-mono text-[10px] font-bold uppercase tracking-[1px] disabled:opacity-50"
                  style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
                >
                  {joining ? 'Joining…' : 'Join the leaderboard'}
                </button>
              </div>
            ) : board.me ? (
              <p className="mt-3 font-mono text-[9px] text-[var(--ink-3)] tracking-[0.5px] text-center">
                You&apos;re ranked #{board.me.rank} of {board.totalRanked} this week.
              </p>
            ) : (
              <p className="mt-3 font-mono text-[9px] text-[var(--ink-3)] tracking-[0.5px] text-center">
                You&apos;re in — log this category this week to claim your rank.
              </p>
            )}
          </>
        ) : (
          <p className="font-mono text-[10px] text-[var(--ink-3)] text-center py-6">Couldn&apos;t load the leaderboard.</p>
        )}
      </div>
    </div>
  );
}
