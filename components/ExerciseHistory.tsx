'use client';

import { useEffect, useRef, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useApp } from '@/lib/AppContext';
import { useUnits } from '@/lib/units';
import { LIFT_PRS_KEY } from '@/lib/constants';

// ── Minimal parsers (duplicated to avoid cross-component imports) ─────────────
type RawEx = { k?: string; n?: string; sets?: Array<{ r: string; w: string }>; s?: string; r?: string; w?: string };

function parseRaw(raw: string): RawEx[] {
  if (!raw) return [];
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; }
  catch { return []; }
}
function maxWeight(ex: RawEx): number {
  const sets: Array<{ r: string; w: string }> = ex.sets && Array.isArray(ex.sets)
    ? ex.sets
    : Array.from({ length: parseInt(String(ex.s ?? '1')) || 1 }, () => ({ r: String(ex.r ?? '1'), w: String(ex.w ?? '') }));
  return Math.max(0, ...sets.map(s => parseFloat(s.w) || 0));
}

// ── Sparkline canvas ─────────────────────────────────────────────────────────
function drawSparkline(canvas: HTMLCanvasElement, pts: Array<{ date: string; maxW: number }>) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 400, H = 120;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);

  const weights = pts.map(p => p.maxW);
  const lo = Math.min(...weights), hi = Math.max(...weights), span = (hi - lo) || 5;
  const PAD = { t: 18, r: 14, b: 22, l: 46 };
  const cW = W - PAD.l - PAD.r, cH = H - PAD.t - PAD.b;
  const xOf = (i: number) => PAD.l + (pts.length > 1 ? i / (pts.length - 1) : 0.5) * cW;
  const yOf = (w: number) => PAD.t + (1 - (w - lo) / span) * cH;

  // Grid
  for (let i = 0; i <= 2; i++) {
    const y = PAD.t + (i / 2) * cH;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + cW, y); ctx.stroke();
  }

  // Y labels
  ctx.fillStyle = 'rgba(158,161,168,0.7)'; ctx.font = '9px JetBrains Mono, monospace'; ctx.textAlign = 'right';
  ctx.fillText(hi.toFixed(1), PAD.l - 4, PAD.t + 4);
  if (lo !== hi) ctx.fillText(lo.toFixed(1), PAD.l - 4, PAD.t + cH + 3);

  // Area fill
  const grad = ctx.createLinearGradient(0, PAD.t, 0, PAD.t + cH);
  grad.addColorStop(0, 'rgba(79,195,247,0.18)'); grad.addColorStop(1, 'rgba(79,195,247,0)');
  ctx.beginPath();
  pts.forEach((p, i) => i === 0 ? ctx.moveTo(xOf(i), yOf(p.maxW)) : ctx.lineTo(xOf(i), yOf(p.maxW)));
  ctx.lineTo(xOf(pts.length - 1), PAD.t + cH); ctx.lineTo(xOf(0), PAD.t + cH);
  ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

  // Line
  ctx.beginPath(); ctx.strokeStyle = 'rgba(79,195,247,0.75)'; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
  pts.forEach((p, i) => i === 0 ? ctx.moveTo(xOf(i), yOf(p.maxW)) : ctx.lineTo(xOf(i), yOf(p.maxW)));
  ctx.stroke();

  // Dots
  pts.forEach((p, i) => {
    const isPR = p.maxW === hi;
    const isLast = i === pts.length - 1;
    const col = isPR ? '#FFB547' : (isLast ? '#4FC3F7' : 'rgba(79,195,247,0.5)');
    const r = isPR || isLast ? 4.5 : 2.5;
    ctx.beginPath(); ctx.arc(xOf(i), yOf(p.maxW), r, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
    if (isPR || isLast) { ctx.beginPath(); ctx.arc(xOf(i), yOf(p.maxW), r - 2, 0, Math.PI * 2); ctx.fillStyle = '#07080A'; ctx.fill(); }
  });

  // Date labels
  const fmt = (ds: string) => { const d = new Date(ds + 'T00:00:00'); return `${d.getMonth()+1}/${d.getDate()}`; };
  ctx.fillStyle = 'rgba(158,161,168,0.6)'; ctx.font = '8px JetBrains Mono, monospace'; ctx.textAlign = 'center';
  ctx.fillText(fmt(pts[0].date), xOf(0), H - 3);
  if (pts.length > 1) ctx.fillText(fmt(pts[pts.length-1].date), xOf(pts.length-1), H - 3);
}

// ── Modal ────────────────────────────────────────────────────────────────────
export function ExerciseHistoryModal({ name, open, onClose }: {
  name: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const { localDB } = useApp();
  const u = useUnits();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const history = useMemo(() => {
    if (!name) return [];
    return Object.keys(localDB)
      .sort()
      .slice(-30)
      .flatMap(ds => {
        const raw = localDB[ds]?.exercises;
        if (!raw) return [];
        try {
          const match = parseRaw(String(raw)).find(e => e.k === 'lift' && e.n === name);
          if (!match) return [];
          const mw = maxWeight(match);
          return mw > 0 ? [{ date: ds, maxW: mw }] : [];
        } catch { return []; }
      });
  }, [localDB, name]);

  useEffect(() => {
    if (!canvasRef.current || !open || history.length === 0) return;
    drawSparkline(canvasRef.current, history);
  }, [history, open]);

  // All-time PR
  let prWeight = 0;
  try { prWeight = name ? ((JSON.parse(localStorage.getItem(LIFT_PRS_KEY) ?? '{}') as Record<string, number>)[name] ?? 0) : 0; }
  catch { /* noop */ }
  const latest = history[history.length - 1];

  return (
    <AnimatePresence>
      {open && name && (
        <motion.div
          className="fixed inset-0 z-[350] flex items-end md:items-center justify-center backdrop-blur-sm px-3 md:px-0"
          style={{ background: 'rgba(7,8,10,0.88)' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={e => { if (e.target === e.currentTarget) onClose(); }}
        >
          <motion.div
            className="w-full md:max-w-[480px] rounded-t-lg md:rounded-lg border border-[var(--line-2)] bg-[var(--bg-1)] overflow-hidden"
            initial={{ opacity: 0, y: 32 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 32 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            style={{ boxShadow: '0 0 0 1px var(--line-2), 0 40px 80px rgba(0,0,0,0.6)' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-[var(--line)]">
              <div>
                <h3 className="font-display text-[18px] tracking-[2px] uppercase text-[var(--ink-0)]">{name}</h3>
                <p className="font-mono text-[9px] text-[var(--ink-3)] tracking-[1px] mt-0.5">
                  Max weight per session · last 30 days
                </p>
              </div>
              <button onClick={onClose} className="text-[var(--ink-2)] hover:text-[var(--accent)] transition-colors p-1">
                <X size={18} />
              </button>
            </div>

            <div className="p-4 space-y-3">
              {/* Sparkline */}
              {history.length === 0 ? (
                <div className="h-[120px] flex items-center justify-center border border-dashed border-[var(--line-2)] rounded">
                  <p className="font-mono text-[10px] text-[var(--ink-3)] tracking-[1px] uppercase">No history in past 30 days</p>
                </div>
              ) : (
                <canvas ref={canvasRef} className="block w-full h-[120px]" />
              )}

              {/* Stats */}
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: 'Sessions',   value: String(history.length),                            color: 'var(--ink-0)'  },
                  { label: 'All-time PR', value: prWeight > 0 ? `${u.dispWeight(prWeight)} ${u.weightUnit}` : '—', color: '#FFB547'       },
                  { label: 'Last session', value: latest ? `${u.dispWeight(latest.maxW)} ${u.weightUnit}` : '—',  color: 'var(--accent)' },
                ].map(s => (
                  <div key={s.label} className="rounded border border-[var(--line)] bg-[var(--bg-2)] p-2.5 text-center">
                    <p className="font-mono text-[8px] text-[var(--ink-3)] uppercase tracking-[1px] mb-1">{s.label}</p>
                    <p className="font-mono text-[11px] font-bold" style={{ color: s.color }}>{s.value}</p>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
