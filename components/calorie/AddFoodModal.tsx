'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Plus, X, Search, Camera, ChevronRight, BookOpen, Trash2, ScanLine, Pencil,
  Clock, TrendingUp, Sparkles,
} from 'lucide-react';
import type { FoodEntry } from '@/lib/AppContext';
import { getRecent, getFrequent, forgetFood, type FoodUsageEntry } from '@/lib/foodUsage';
import { trackEvent } from '@/lib/telemetry';
import { reclaimBadgeCacheQuota } from '@/components/AutoCropImage';

// ── Custom / My Foods ─────────────────────────────────────────────────────────

export interface CustomFood {
  id:          string;
  name:        string;
  type:        'ingredient' | 'meal';
  kcal:        number;
  protein:     number;
  carbs:       number;
  fat:         number;
  servingDesc: string;
  createdAt:   number;
  barcode?:    string;   // set when saved from a barcode scan
}

const MY_FOODS_KEY = 'queMyFoods';

function loadMyFoods(): CustomFood[] {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem(MY_FOODS_KEY) ?? '[]'); }
  catch { return []; }
}
/** Persist custom foods. Returns false if the write ultimately failed (e.g.
 *  localStorage quota exhausted). On a first failure we reclaim the badge-crop
 *  cache — usually the biggest reclaimable consumer — and retry once, so a
 *  full disk self-heals instead of silently dropping the save. */
function saveMyFoods(foods: CustomFood[]): boolean {
  const write = () => localStorage.setItem(MY_FOODS_KEY, JSON.stringify(foods));
  try { write(); return true; }
  catch {
    try { reclaimBadgeCacheQuota(); write(); return true; }
    catch { return false; }
  }
}

// ── Meal section constants ────────────────────────────────────────────────────

export const FIXED_MEALS = ['breakfast', 'lunch', 'dinner'] as const;
export const MEAL_LABELS: Record<string, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };
export const DEFAULT_ORDER = ['breakfast', 'lunch', 'dinner'];

export function getMealLabel(id: string, order: string[]): string {
  if (FIXED_MEALS.includes(id as typeof FIXED_MEALS[number])) return MEAL_LABELS[id];
  const snacks = order.filter(m => !FIXED_MEALS.includes(m as typeof FIXED_MEALS[number]));
  return snacks.length === 1 ? 'Snack' : `Snack ${snacks.indexOf(id) + 1}`;
}

// ── SVG icons ─────────────────────────────────────────────────────────────────

function IngredientIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2a4 4 0 0 1 4 4c0 3-4 8-4 8S8 9 8 6a4 4 0 0 1 4-4z"/>
      <path d="M12 14v8M8 22h8"/>
    </svg>
  );
}
function MealIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 11l19-9-9 19-2-8-8-2z"/>
    </svg>
  );
}

// ── Open Food Facts types ─────────────────────────────────────────────────────

interface OFFNutriments {
  'energy-kcal_100g'?:    number;
  'energy-kcal_serving'?: number;
  proteins_100g?:         number;
  carbohydrates_100g?:    number;
  fat_100g?:              number;
}
export interface OFFProduct {
  code?: string;
  product_name: string;
  brands?: string;
  serving_size?: string;
  serving_quantity?: number | string;
  source?: string;       // 'usda' | 'off' | 'ai' — 'ai' = LLM-estimated macros
  nutriments: OFFNutriments;
}

export function perServing(p: OFFProduct, servings: number): Pick<FoodEntry, 'kcal'|'protein'|'carbs'|'fat'> {
  const n   = p.nutriments;
  const g   = parseFloat(String(p.serving_quantity ?? '100')) || 100;
  const f   = (g / 100) * servings;
  return {
    kcal:    Math.round((n['energy-kcal_100g'] ?? 0) * f),
    protein: Math.round((n.proteins_100g      ?? 0) * f * 10) / 10,
    carbs:   Math.round((n.carbohydrates_100g ?? 0) * f * 10) / 10,
    fat:     Math.round((n.fat_100g           ?? 0) * f * 10) / 10,
  };
}

// ── Food detail sheet ─────────────────────────────────────────────────────────

function FoodDetailSheet({ product, barcode, onAdd, onBack, initialServings }: {
  product: OFFProduct;
  barcode?: string;
  onAdd: (food: Omit<FoodEntry, 'id' | 'loggedAt' | 'meal'>, barcode?: string) => void;
  onBack: () => void;
  /** Pre-fill the servings stepper — e.g. NL parse of "2 eggs" opens at 2. */
  initialServings?: number;
}) {
  const [servings, setServings] = useState(initialServings && initialServings > 0 ? Math.round(initialServings * 2) / 2 : 1);
  // Outlier confirm: typos like 12000 kcal/100g (real OFF data has this!) are
  // the #1 source of garbage calorie data. Require a second tap when the
  // chosen serving exceeds a sane single-meal ceiling.
  const [pendingHighKcal, setPendingHighKcal] = useState(false);
  const macros = perServing(product, servings);
  const servingDesc = product.serving_size ?? `${product.serving_quantity ?? 100}g`;
  // Reset outlier confirm whenever the serving count changes (user is
  // reconsidering — don't keep showing the warning).
  useEffect(() => { setPendingHighKcal(false); }, [servings]);
  const HIGH_KCAL_THRESHOLD = 3000;
  const isHighKcal = macros.kcal > HIGH_KCAL_THRESHOLD;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 mb-4">
        <button type="button" onClick={onBack} className="text-[var(--ink-2)] hover:text-[var(--accent)] transition-colors">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <p className="font-mono text-[13px] font-bold text-[var(--ink-0)] truncate">{product.product_name}</p>
          {product.brands && <p className="font-mono text-[9px] text-[var(--ink-3)]">{product.brands}</p>}
        </div>
      </div>

      {/* AI-estimate disclosure — these macros are the model's estimate, not the DB's */}
      {product.source === 'ai' && (
        <p className="font-mono text-[9px] text-[#FFB547] bg-[#FFB547]/10 border border-[#FFB547]/25 rounded-md px-2.5 py-1.5 mb-3 leading-relaxed">
          AI estimate — not found in the food database. Double-check and adjust the servings if needed.
        </p>
      )}

      {/* Macro preview */}
      <div className="rounded border border-[var(--line-2)] bg-[var(--bg-2)] p-3 mb-4">
        <div className="grid grid-cols-4 gap-2 text-center">
          {[
            { label: 'Calories', value: macros.kcal, unit: 'kcal', accent: true },
            { label: 'Protein',  value: macros.protein, unit: 'g' },
            { label: 'Carbs',    value: macros.carbs,   unit: 'g' },
            { label: 'Fat',      value: macros.fat,     unit: 'g' },
          ].map(m => (
            <div key={m.label}>
              <p className="font-display text-[20px] leading-none" style={{ color: m.accent ? 'var(--accent)' : 'var(--ink-0)' }}>
                {m.value}
              </p>
              <p className="font-mono text-[8px] text-[var(--ink-3)] mt-0.5">{m.unit}</p>
              <p className="font-mono text-[7px] text-[var(--ink-3)] uppercase tracking-[0.5px]">{m.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Serving stepper */}
      <div className="mb-4">
        <p className="font-mono text-[9px] font-bold tracking-[1.5px] uppercase text-[var(--ink-3)] mb-2">
          Servings · {servingDesc} each
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setServings(s => Math.max(0.5, +(s - 0.5).toFixed(1)))}
            className="w-10 h-10 flex items-center justify-center rounded-sm border border-[var(--line-2)] bg-[var(--bg-2)] text-[var(--ink-0)] text-xl hover:border-[var(--accent)] hover:text-[var(--accent)] transition-all"
          >−</button>
          <span className="font-display tabular text-[26px] text-[var(--accent)] min-w-[48px] text-center leading-none">
            {servings}
          </span>
          <button
            type="button"
            onClick={() => setServings(s => +(s + 0.5).toFixed(1))}
            className="w-10 h-10 flex items-center justify-center rounded-sm border border-[var(--line-2)] bg-[var(--bg-2)] text-[var(--ink-0)] text-xl hover:border-[var(--accent)] hover:text-[var(--accent)] transition-all"
          >+</button>
        </div>
      </div>

      {isHighKcal && pendingHighKcal && (
        <div className="mb-3 rounded border border-[var(--warn)]/50 bg-[var(--warn)]/8 px-3 py-2">
          <p className="font-mono text-[10px] text-[var(--warn)] tracking-[0.3px] leading-relaxed">
            <strong>{macros.kcal} kcal</strong> in one entry is unusually high — most meals are 300–1,000 kcal.
            Tap <strong>Confirm</strong> if that&apos;s right, or adjust servings / go back.
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          if (isHighKcal && !pendingHighKcal) { setPendingHighKcal(true); return; }
          if (isHighKcal && pendingHighKcal) {
            trackEvent('food_outlier_confirmed', { kcal: macros.kcal });
          }
          onAdd({
            name: product.product_name,
            brand: product.brands,
            ...macros,
            servingDesc,
            servings,
          }, barcode);
        }}
        className={
          isHighKcal && pendingHighKcal
            ? 'que-btn-ghost w-full py-4 mt-auto !border-[var(--warn)] !text-[var(--warn)]'
            : 'que-btn-primary w-full py-4 mt-auto'
        }
      >
        {isHighKcal && pendingHighKcal ? 'Confirm Add' : 'Add to Log'}
      </button>
    </div>
  );
}

// ── My Foods tab ─────────────────────────────────────────────────────────────

const EMPTY_FORM = { name: '', type: 'ingredient' as 'ingredient'|'meal', servingDesc: '1 serving', kcal: '', protein: '', carbs: '', fat: '' };

// serving_quantity must be 100 so perServing's formula (g/100)*servings = 1*servings
function customToOFF(f: CustomFood): OFFProduct {
  return {
    product_name:     f.name,
    serving_size:     f.servingDesc,
    serving_quantity: 100,
    nutriments: {
      'energy-kcal_100g': f.kcal,
      proteins_100g:       f.protein,
      carbohydrates_100g:  f.carbs,
      fat_100g:            f.fat,
    },
  };
}

function MyFoodsTab({ onSelect }: { onSelect: (p: OFFProduct) => void }) {
  const [myFoods,    setMyFoods]    = useState<CustomFood[]>(() => loadMyFoods());
  const [editingId,  setEditingId]  = useState<string | null>(null);   // null = create mode
  const [showForm,   setShowForm]   = useState(false);
  const [form,       setForm]       = useState(EMPTY_FORM);
  const [formError,  setFormError]  = useState('');
  const [filter,     setFilter]     = useState('');

  const set = (k: keyof typeof EMPTY_FORM, v: string) => setForm(f => ({ ...f, [k]: v }));

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (f: CustomFood) => {
    setEditingId(f.id);
    setForm({
      name:        f.name,
      type:        f.type,
      servingDesc: f.servingDesc,
      kcal:        String(f.kcal),
      protein:     String(f.protein),
      carbs:       String(f.carbs),
      fat:         String(f.fat),
    });
    setFormError('');
    setShowForm(true);
  };

  const closeForm = () => { setShowForm(false); setFormError(''); };

  const save = () => {
    if (!form.name.trim())              { setFormError('Name is required.'); return; }
    if (!form.kcal || +form.kcal <= 0) { setFormError('Calories must be > 0.'); return; }

    let updated: CustomFood[];
    if (editingId) {
      updated = myFoods.map(f => f.id !== editingId ? f : {
        ...f,
        name:        form.name.trim(),
        type:        form.type,
        servingDesc: form.servingDesc.trim() || '1 serving',
        kcal:        +form.kcal,
        protein:     +form.protein || 0,
        carbs:       +form.carbs   || 0,
        fat:         +form.fat     || 0,
      });
    } else {
      const food: CustomFood = {
        id:          `${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
        name:        form.name.trim(),
        type:        form.type,
        servingDesc: form.servingDesc.trim() || '1 serving',
        kcal:        +form.kcal,
        protein:     +form.protein || 0,
        carbs:       +form.carbs   || 0,
        fat:         +form.fat     || 0,
        createdAt:   Date.now(),
      };
      updated = [...myFoods, food];
    }
    if (!saveMyFoods(updated)) {
      setFormError('Storage is full — could not save. Free up space and try again.');
      return;
    }
    setMyFoods(updated);
    closeForm();
  };

  const remove = (id: string) => {
    const updated = myFoods.filter(f => f.id !== id);
    saveMyFoods(updated);
    setMyFoods(updated);
  };

  if (showForm) return (
    <div className="space-y-3 pb-8">
      <div className="flex items-center gap-2 mb-1">
        <button type="button" onClick={closeForm}
          className="text-[var(--ink-2)] hover:text-[var(--accent)] transition-colors">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <p className="font-mono text-[11px] font-bold tracking-[1.5px] uppercase text-[var(--ink-1)]">
          {editingId ? 'Edit Food' : 'New Food'}
        </p>
      </div>

      <div className="flex bg-[var(--bg-2)] border border-[var(--line)] rounded-sm p-1 gap-0.5">
        {([['ingredient','Ingredient', IngredientIcon], ['meal','Meal / Recipe', MealIcon]] as const).map(([val, label, Icon]) => (
          <button key={val} type="button"
            onClick={() => set('type', val)}
            className={['flex-1 flex items-center justify-center gap-2 py-2 rounded-sm font-mono text-[10px] font-bold tracking-[1px] uppercase transition-all',
              form.type === val ? 'bg-[var(--accent)] text-[var(--accent-ink)]' : 'text-[var(--ink-2)] hover:text-[var(--ink-0)]'].join(' ')}
          >
            <Icon size={12} />{label}
          </button>
        ))}
      </div>

      <div>
        <label className="que-label">Name</label>
        <input type="text" className="que-input" placeholder={form.type === 'meal' ? 'e.g. Chicken & Rice Bowl' : 'e.g. Chicken Breast'}
          value={form.name} onChange={e => set('name', e.target.value)} />
      </div>
      <div>
        <label className="que-label">Serving description</label>
        <input type="text" className="que-input" placeholder="e.g. 1 serving, 100g, 1 cup"
          value={form.servingDesc} onChange={e => set('servingDesc', e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {([['kcal','Calories','numeric'],['protein','Protein / g','decimal'],['carbs','Carbs / g','decimal'],['fat','Fat / g','decimal']] as const).map(([k, label, mode]) => (
          <div key={k}>
            <label className="que-label">{label}{k !== 'kcal' && <span className="font-normal text-[var(--ink-3)] normal-case"> (opt)</span>}</label>
            <input type="text" inputMode={mode} className="que-input"
              value={(form as Record<string,string>)[k]} onChange={e => set(k, e.target.value)} />
          </div>
        ))}
      </div>

      {formError && <p className="font-mono text-[9px] text-[var(--danger)] tracking-[0.5px]">{formError}</p>}
      <button type="button" onClick={save} className="que-btn-primary w-full py-3">
        {editingId ? 'Update Food' : 'Save Food'}
      </button>
    </div>
  );

  const q = filter.toLowerCase().trim();
  const filtered = myFoods.filter(f => !q || f.name.toLowerCase().includes(q));
  const meals       = filtered.filter(f => f.type === 'meal').sort((a, b) => a.name.localeCompare(b.name));
  const ingredients = filtered.filter(f => f.type === 'ingredient').sort((a, b) => a.name.localeCompare(b.name));

  const FoodRow = ({ f }: { f: CustomFood }) => (
    <div className="flex items-center gap-2 px-3 py-2.5">
      <span className={['flex-shrink-0 w-7 h-7 rounded-sm flex items-center justify-center',
        f.type === 'meal' ? 'bg-[var(--positive)]/15 text-[var(--positive)]' : 'bg-[var(--accent)]/15 text-[var(--accent)]'].join(' ')}>
        {f.type === 'meal' ? <MealIcon size={14} /> : <IngredientIcon size={14} />}
      </span>
      <button type="button" onClick={() => onSelect(customToOFF(f))} className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-1.5 min-w-0">
          <p className="font-mono text-[11px] font-semibold text-[var(--ink-0)] truncate">{f.name}</p>
          {f.barcode && (
            <span className="flex-shrink-0 text-[var(--ink-3)]" title="Saved from barcode scan">
              <ScanLine size={10} />
            </span>
          )}
        </div>
        <p className="font-mono text-[9px] text-[var(--ink-3)]">
          {f.servingDesc} · <span className="text-[var(--accent)]">{f.kcal} kcal</span>
          {f.protein > 0 && <span className="text-[var(--ink-2)]"> · {f.protein}g protein</span>}
        </p>
      </button>
      <button type="button" onClick={() => openEdit(f)}
        className="text-[var(--ink-3)] hover:text-[var(--accent)] transition-colors flex-shrink-0 p-1.5">
        <Pencil size={12} />
      </button>
      <button type="button" onClick={() => remove(f.id)}
        className="text-[var(--ink-3)] hover:text-[var(--danger)] transition-colors flex-shrink-0 p-1.5">
        <Trash2 size={12} />
      </button>
    </div>
  );

  const SectionHeader = ({ label, count }: { label: string; count: number }) => (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-3)] border-b border-[var(--line)]">
      <p className="font-mono text-[8px] font-bold tracking-[2px] uppercase text-[var(--ink-3)]">{label}</p>
      <span className="font-mono text-[8px] text-[var(--ink-3)] opacity-60">{count}</span>
    </div>
  );

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--ink-3)] pointer-events-none" />
          <input
            type="text"
            className="que-input pl-7 text-[11px]"
            placeholder="Filter saved foods…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
        </div>
        <button type="button" onClick={openCreate}
          className="flex items-center gap-1.5 font-mono text-[9px] font-bold tracking-[1px] uppercase text-[var(--accent)] border border-[var(--accent)]/40 rounded-sm px-2.5 py-2 hover:bg-[var(--accent)]/10 transition-all flex-shrink-0">
          <Plus size={10} /> New
        </button>
      </div>

      {myFoods.length === 0 ? (
        <div className="text-center py-8 border border-dashed border-[var(--line-2)] rounded">
          <p className="font-mono text-[10px] text-[var(--ink-3)] tracking-[1px] uppercase">Save ingredients &amp; meals</p>
          <p className="font-mono text-[9px] text-[var(--ink-3)] mt-1 tracking-[0.5px]">Tap New · barcodes save automatically</p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="font-mono text-[9px] text-[var(--ink-3)] text-center py-6 tracking-[0.5px]">No matches for "{filter}"</p>
      ) : (
        <div className="rounded border border-[var(--line)] bg-[var(--bg-2)] overflow-hidden divide-y divide-[var(--line)]">
          {meals.length > 0 && (
            <>
              <SectionHeader label="Meals & Recipes" count={meals.length} />
              {meals.map(f => <FoodRow key={f.id} f={f} />)}
            </>
          )}
          {ingredients.length > 0 && (
            <>
              <SectionHeader label="Ingredients" count={ingredients.length} />
              {ingredients.map(f => <FoodRow key={f.id} f={f} />)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Quick Picks (recent + frequent shortcuts) ─────────────────────────────────

/** Turn a stored FoodUsageEntry back into an OFFProduct so the existing detail
 *  sheet (servings stepper, macro preview) works without any branching. */
function usageToOFF(u: FoodUsageEntry): OFFProduct {
  return {
    code:             u.barcode,
    product_name:     u.name,
    brands:           u.brand,
    serving_size:     u.servingDesc,
    serving_quantity: 100,
    nutriments: {
      'energy-kcal_100g': u.kcal,
      proteins_100g:       u.protein,
      carbohydrates_100g:  u.carbs,
      fat_100g:            u.fat,
    },
  };
}

function QuickPicksPanel({
  refreshKey,
  onSelect,
}: {
  /** Bumped after a forget action so the lists re-read localStorage. */
  refreshKey: number;
  onSelect:   (product: OFFProduct, barcode?: string) => void;
}) {
  const [tab,      setTab]      = useState<'recent' | 'frequent'>('recent');
  const [entries,  setEntries]  = useState<FoodUsageEntry[]>([]);
  const [refresh,  setRefresh]  = useState(0);

  useEffect(() => {
    setEntries(tab === 'recent' ? getRecent(20) : getFrequent(20));
  }, [tab, refresh, refreshKey]);

  if (entries.length === 0 && refresh === 0) {
    // Both tabs empty — only show on the recent tab to avoid a flash.
    if (tab === 'recent') {
      return (
        <div className="text-center py-8 border border-dashed border-[var(--line-2)] rounded">
          <p className="font-mono text-[10px] text-[var(--ink-3)] tracking-[1px] uppercase">No quick picks yet</p>
          <p className="font-mono text-[9px] text-[var(--ink-3)] mt-1 tracking-[0.5px]">Search or scan a food — it&apos;ll show up here next time</p>
        </div>
      );
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex bg-[var(--bg-2)] border border-[var(--line)] rounded-sm p-1 gap-0.5">
        {([['recent', 'Recent', Clock], ['frequent', 'Frequent', TrendingUp]] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={[
              'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-sm font-mono text-[9px] font-bold tracking-[1px] uppercase transition-all',
              tab === id ? 'bg-[var(--accent)] text-[var(--accent-ink)]' : 'text-[var(--ink-2)] hover:text-[var(--ink-0)]',
            ].join(' ')}
          >
            <Icon size={11} /> {label}
          </button>
        ))}
      </div>

      {entries.length === 0 ? (
        <p className="font-mono text-[9px] text-[var(--ink-3)] text-center py-6 tracking-[0.5px]">
          {tab === 'recent' ? 'No recent foods yet' : 'No frequent foods yet'}
        </p>
      ) : (
        <div className="rounded border border-[var(--line)] bg-[var(--bg-2)] divide-y divide-[var(--line)]">
          {entries.map(u => (
            <div key={u.key} className="flex items-center gap-2 px-3 py-2.5">
              <button
                type="button"
                onClick={() => onSelect(usageToOFF(u), u.barcode)}
                className="flex-1 min-w-0 text-left"
              >
                <p className="font-mono text-[11px] font-semibold text-[var(--ink-0)] truncate">{u.name}</p>
                <p className="font-mono text-[9px] text-[var(--ink-3)]">
                  {u.brand && <span>{u.brand} · </span>}
                  <span className="text-[var(--accent)]">{u.kcal} kcal</span>
                  {u.protein > 0 && <span> · {u.protein}g protein</span>}
                  {tab === 'frequent' && <span> · {u.count}×</span>}
                </p>
              </button>
              <button
                type="button"
                onClick={() => { forgetFood(u.key); setRefresh(r => r + 1); }}
                className="text-[var(--ink-3)] hover:text-[var(--danger)] transition-colors flex-shrink-0 p-1.5"
                title="Remove from list"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Add food modal ────────────────────────────────────────────────────────────

export function AddFoodModal({ open, onClose, onAdd }: {
  open: boolean;
  onClose: () => void;
  onAdd: (food: Omit<FoodEntry, 'id' | 'loggedAt' | 'meal'>, barcode?: string) => void;
}) {
  // Default to 'search' — landing on a list of the user's frequent/recent
  // foods is faster than camera priming for most daily use.
  const [mode,            setMode]           = useState<'scan' | 'search' | 'quicklog' | 'myfoods'>('search');
  const [searchQuery,     setSearchQuery]    = useState('');
  const [searchResults,   setSearchResults]  = useState<OFFProduct[]>([]);
  const [searching,       setSearching]      = useState(false);
  const [manualBarcode,   setManualBarcode]  = useState('');
  // `source` carries which entry point the user came from so telemetry can
  // attribute the add. 'recent' covers both Recents and Frequents (same panel).
  const [selectedProduct, setSelectedProduct] = useState<{
    p:         OFFProduct;
    barcode?:  string;
    source:    'search' | 'recent' | 'myfoods' | 'scan' | 'nl';
    servings?: number; // pre-fill (e.g. NL parse "2 eggs" → 2)
  } | null>(null);
  const [error,           setError]          = useState('');
  const [scanning,        setScanning]       = useState(false);
  const [detected,        setDetected]       = useState(false);
  // ── Natural-language meal parse ("2 eggs and a banana") ──────────────────
  // The LLM only extracts {name, qty}; macros are grounded against the food DB
  // server-side, so a parsed item carries a real OFFProduct + the parsed qty.
  const [nlText,    setNlText]    = useState('');
  const [nlParsing, setNlParsing] = useState(false);
  const [nlItems,   setNlItems]   = useState<Array<{ query: string; quantity: number; unit?: string; grams?: number; matched: boolean; source?: 'db' | 'ai'; product?: OFFProduct }> | null>(null);
  // Whether the Quick Log feature is available (server has an AI key). Probed
  // once on open via GET /api/food/parse so the tab's presence is correct from
  // the start — never shows a tab that would dead-end.
  const [nlEnabled, setNlEnabled] = useState(false);
  const videoRef      = useRef<HTMLVideoElement>(null);
  const controlsRef   = useRef<{ stop: () => void } | null>(null);
  const debounceRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pre-loaded ZXing module — avoids async import inside the click handler which
  // breaks the user-gesture chain iOS requires for getUserMedia
  const zxingRef      = useRef<typeof import('@zxing/browser') | null>(null);

  // Pre-warm ZXing when modal opens so the module is cached before startCamera
  // is called — avoids an async boundary between the user gesture and getUserMedia
  useEffect(() => {
    if (open && !zxingRef.current) {
      import('@zxing/browser').then(mod => { zxingRef.current = mod; }).catch(() => {});
    }
    if (open) {
      // Probe whether Quick Log is available so we only show its tab when the
      // server can actually parse (no key → tab never appears). Cheap GET.
      fetch('/api/food/parse')
        .then(r => r.ok ? r.json() : { configured: false })
        .then((d: { configured?: boolean }) => setNlEnabled(!!d.configured))
        .catch(() => setNlEnabled(false));
    }
    if (!open) {
      setMode('search'); setSearchQuery(''); setSearchResults([]);
      setManualBarcode(''); setSelectedProduct(null); setError('');
      setNlText(''); setNlItems(null); setNlParsing(false);
      stopCamera();
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopCamera = () => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setScanning(false);
  };

  const startCamera = useCallback(async () => {
    setError('');
    setScanning(true);
    try {
      // Use pre-warmed module if available, otherwise import (fallback)
      const { BrowserMultiFormatReader } = zxingRef.current ?? await import('@zxing/browser');
      if (!videoRef.current) { setScanning(false); return; }
      const reader = new BrowserMultiFormatReader();
      let handled = false;

      // ╔══════════════════════════════════════════════════════════════════════╗
      // ║  KNOWN-GOOD CAMERA SETUP — DO NOT "improve" without testing on a REAL  ║
      // ║  iOS Safari AND Android Chrome device first. This block has broken the ║
      // ║  scanner three separate times. Each of the following was tried and    ║
      // ║  BROKE detection on a real phone — do NOT reintroduce any of them:     ║
      // ║   1. Adding width/height to the getUserMedia constraints               ║
      // ║      (e.g. { width:{ideal:1920} }). Keep it { facingMode:'environment' }.║
      // ║   2. Calling track.applyConstraints({advanced:[{focusMode:...}]}) on   ║
      // ║      the live stream — it destabilises the feed ZXing/BD read from.    ║
      // ║   3. Requiring >1 matching frame before accepting. The BarcodeDetector ║
      // ║      loop self-stops after ONE detection, so anything stricter than    ║
      // ║      accept-on-first never completes on Android.                       ║
      // ║  Reliability improvements belong in lookupBarcode (AFTER detection),   ║
      // ║  never in this stream/detection setup.                                 ║
      // ╚══════════════════════════════════════════════════════════════════════╝
      // ZXing handles camera open, video setup, and play() retry on canplay.
      // Shared handler — flashes green, freezes the frame for 450 ms, then transitions.
      const onFound = (code: string, stopFn: () => void) => {
        if (handled) return;
        handled = true;
        setDetected(true);
        setTimeout(() => {
          stopFn();
          controlsRef.current = null;
          setDetected(false);
          setScanning(false);
          void lookupBarcode(code);
        }, 450);
      };

      const controls = await reader.decodeFromConstraints(
        { video: { facingMode: 'environment' } },
        videoRef.current,
        (result, _err, ctrl) => {
          if (result) onFound(result.getText(), () => ctrl.stop());
        },
      );
      controlsRef.current = controls;

      // If BarcodeDetector is available, run it alongside for better detection.
      // First to find a barcode wins; handled flag prevents double-lookup.
      if ('BarcodeDetector' in window && videoRef.current) {
        const video = videoRef.current;
        const origStop = controls.stop.bind(controls);
        let bdActive = true;
        controlsRef.current = {
          stop: () => { bdActive = false; origStop(); },
        };
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const detector = new (window as any).BarcodeDetector({
            formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'],
          });
          const tick = async () => {
            if (!bdActive || handled) return;
            if (video.readyState >= 2) {
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const codes: any[] = await detector.detect(video);
                if (codes.length > 0) {
                  bdActive = false;
                  onFound(codes[0].rawValue, origStop);
                  return;
                }
              } catch { /* no barcode this frame */ }
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        } catch { /* BarcodeDetector init failed — ZXing still detecting */ }
      }
    } catch {
      setScanning(false);
      setError('Camera access denied. Use the barcode field below.');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const lookupBarcode = async (code: string) => {
    setError('');
    setSearching(true);
    // Try the scanned code, then the UPC-A ↔ EAN-13 leading-zero variants —
    // OFF stores most US products under their 13-digit EAN, so a 12-digit UPC-A
    // scan often only matches once a leading zero is added (and vice versa).
    const candidates = [code];
    if (code.length === 12)                     candidates.push('0' + code);
    if (code.length === 13 && code[0] === '0')  candidates.push(code.slice(1));
    try {
      for (const c of candidates) {
        // Same-origin proxy (/api/food/barcode) — a direct browser fetch to
        // openfoodfacts.org is blocked by our CSP `connect-src 'self'`. The proxy
        // relays OFF's `{ status, product }` shape unchanged. A non-OK response
        // is a real lookup/network failure (surface it); status:0 with 200 means
        // "not found" (try the next candidate).
        const res = await fetch(`/api/food/barcode?code=${encodeURIComponent(c)}`);
        if (!res.ok) throw new Error('lookup_failed');
        const data = await res.json() as { status: number; product?: OFFProduct };
        if (data.status === 1 && data.product?.product_name) {
          setSelectedProduct({ p: data.product, barcode: c, source: 'scan' });
          return;
        }
      }
      setError(`No product found for barcode ${code}. Try searching by name.`);
    } catch {
      setError('Network error. Check your connection.');
    } finally {
      setSearching(false);
    }
  };

  const runSearch = useCallback(async (q: string) => {
    const query = q.trim();
    if (!query) return;
    setSearching(true); setError(''); setSearchResults([]);
    trackEvent('food_search_run', { length: query.length });
    try {
      const res  = await fetch(`/api/food/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error('fetch_failed');
      const data = await res.json() as { products?: OFFProduct[]; source?: string };
      const results = data.products ?? [];
      setSearchResults(results);
      if (results.length === 0) {
        trackEvent('food_search_empty');
        setError('No results — try a simpler term (e.g. "chicken breast" not "grilled lemon chicken").');
      }
    } catch {
      setError('Search unavailable. Use the barcode scanner or add via My Foods.');
    } finally {
      setSearching(false);
    }
  }, []);

  const handleSearchChange = useCallback((val: string) => {
    setSearchQuery(val);
    setSearchResults([]);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (val.trim().length >= 2) {
      debounceRef.current = setTimeout(() => runSearch(val), 500);
    }
  }, [runSearch]);

  // Natural-language parse: "2 eggs and a banana" → grounded, add-able items.
  const runParse = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t) return;
    setNlParsing(true); setError(''); setNlItems(null);
    try {
      const res = await fetch('/api/food/parse', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text: t }),
      });
      const data = await res.json() as {
        configured?: boolean;
        items?: Array<{ query: string; quantity: number; unit?: string; grams?: number; matched: boolean; source?: 'db' | 'ai'; product?: OFFProduct }>;
        error?: string;
      };
      if (data.configured === false) { setNlEnabled(false); setMode('search'); return; } // feature off → fall back to search
      if (!res.ok) { setError(data.error ?? 'Could not read that — try searching instead.'); return; }
      const items = data.items ?? [];
      setNlItems(items);
      if (items.length === 0) setError('Didn’t catch any foods — try rephrasing.');
      else trackEvent('food_added_search', { length: t.length }); // reuse: a parse is a search-style add intent
    } catch {
      setError('Parse unavailable. Use search or the scanner.');
    } finally {
      setNlParsing(false);
    }
  }, []);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[300] flex items-end md:items-center justify-center backdrop-blur-sm px-0 md:px-3"
          style={{ background: 'rgba(7,8,10,0.88)' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={e => { if (e.target === e.currentTarget) { stopCamera(); onClose(); } }}
        >
          <motion.div
            className="w-full md:max-w-[480px] h-[88dvh] flex flex-col rounded-t-lg md:rounded-lg border border-[var(--line-2)] bg-[var(--bg-1)] overflow-hidden"
            initial={{ opacity: 0, y: 48 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 48 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            style={{ boxShadow: '0 0 0 1px var(--line-2), 0 -2px 0 0 var(--accent), 0 40px 80px rgba(0,0,0,0.6)' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-[var(--line)] flex-shrink-0">
              <h3 className="font-display text-[20px] tracking-[2px] uppercase text-[var(--ink-0)]">Add Food</h3>
              <button onClick={() => { stopCamera(); onClose(); }} className="text-[var(--ink-2)] hover:text-[var(--accent)] transition-colors p-1">
                <X size={20} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto overscroll-contain p-4 md:p-5">
              <AnimatePresence mode="wait">
              {selectedProduct ? (
                <motion.div
                  key="detail"
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                >
                <FoodDetailSheet
                  product={selectedProduct.p}
                  barcode={selectedProduct.barcode}
                  initialServings={selectedProduct.servings}
                  onAdd={(food, barcode) => {
                    if (barcode) {
                      const existing = loadMyFoods();
                      if (!existing.some(f => f.barcode === barcode)) {
                        const p = selectedProduct.p;
                        const newFood: CustomFood = {
                          id: `${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                          name: p.product_name,
                          type: 'ingredient',
                          kcal: p.nutriments['energy-kcal_100g'] ?? 0,
                          protein: p.nutriments.proteins_100g ?? 0,
                          carbs: p.nutriments.carbohydrates_100g ?? 0,
                          fat: p.nutriments.fat_100g ?? 0,
                          servingDesc: p.serving_size ?? '100g',
                          createdAt: Date.now(),
                          barcode,
                        };
                        saveMyFoods([...existing, newFood]);
                      }
                    }
                    // Source attribution — tells us which entry point is
                    // doing the work (search vs recents vs scan vs custom).
                    const ev =
                      selectedProduct.source === 'scan'    ? 'food_added_scan'    :
                      selectedProduct.source === 'recent'  ? 'food_added_recent'  :
                      selectedProduct.source === 'myfoods' ? 'food_added_myfoods' :
                                                              'food_added_search';
                    trackEvent(ev);
                    onAdd(food, barcode);
                  }}
                  onBack={() => setSelectedProduct(null)}
                />
                </motion.div>
              ) : (
                <motion.div key="browse" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
                <>
                  {/* Mode tabs — Quick Log only appears when the server has an AI
                      key (nlEnabled), so there's never a dead tab. */}
                  <div className="flex bg-[var(--bg-2)] border border-[var(--line)] rounded-sm p-1 gap-0.5 mb-4">
                    {([
                    ['scan',    'Scan',     Camera],
                    ['search',  'Search',   Search],
                    ...(nlEnabled ? [['quicklog', 'Quick', Sparkles] as const] : []),
                    ['myfoods', 'Foods', BookOpen],
                  ] as const).map(([id, label, Icon]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => { setMode(id); stopCamera(); setError(''); setNlItems(null); }}
                        className={[
                          'flex-1 flex items-center justify-center gap-1.5 py-2 rounded-sm font-mono text-[9px] font-bold tracking-[0.5px] uppercase transition-all',
                          mode === id ? 'bg-[var(--accent)] text-[var(--accent-ink)]' : 'text-[var(--ink-2)] hover:text-[var(--ink-0)]',
                        ].join(' ')}
                      >
                        <Icon size={12} />
                        {label}
                      </button>
                    ))}
                  </div>

                  {/* ── SCAN MODE ── */}
                  {mode === 'scan' && (
                    <div className="space-y-4">
                      {/* Live camera view — works on iOS Safari, Android Chrome, Firefox */}
                      <div className="relative rounded border border-[var(--line-2)] bg-[var(--bg-2)] overflow-hidden aspect-[4/3]">
                        <video
                          ref={videoRef}
                          className={['block w-full h-full object-cover', scanning ? '' : 'hidden'].join(' ')}
                          playsInline autoPlay muted
                        />
                        {!scanning && (
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                            {searching ? (
                              <>
                                <div className="w-6 h-6 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
                                <p className="font-mono text-[9px] text-[var(--ink-2)] tracking-[1.5px] uppercase">Looking up…</p>
                              </>
                            ) : (
                              <>
                                <Camera size={40} className="text-[var(--ink-3)]" />
                                <p className="font-mono text-[10px] text-[var(--ink-3)] tracking-[1px] uppercase">
                                  Point camera at barcode
                                </p>
                              </>
                            )}
                          </div>
                        )}
                        {scanning && (
                          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <motion.div
                              className="w-52 h-24 border-2 rounded"
                              animate={{
                                borderColor: detected ? '#4ade80' : 'var(--accent)',
                                scale: detected ? 1.04 : 1,
                                opacity: detected ? 1 : 0.8,
                              }}
                              transition={{ duration: 0.15 }}
                            />
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={scanning ? stopCamera : startCamera}
                        className={scanning ? 'que-btn-ghost w-full py-3' : 'que-btn-primary w-full py-3'}
                      >
                        {scanning ? 'Stop Camera' : 'Start Camera'}
                      </button>

                      {/* Manual barcode entry */}
                      <div>
                        <label className="que-label">Barcode number</label>
                        <div className="flex gap-2">
                          <input
                            type="text" inputMode="numeric" className="que-input flex-1"
                            placeholder="e.g. 3017620422003"
                            value={manualBarcode}
                            onChange={e => setManualBarcode(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && manualBarcode && lookupBarcode(manualBarcode)}
                          />
                          <button
                            type="button"
                            onClick={() => manualBarcode && lookupBarcode(manualBarcode)}
                            disabled={!manualBarcode || searching}
                            className="que-btn-ghost px-4 flex-shrink-0 disabled:opacity-40"
                          >
                            {searching ? '…' : <ChevronRight size={16} />}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── QUICK LOG MODE (natural-language) ── */}
                  {mode === 'quicklog' && (
                    <div className="space-y-3">
                      {/* Explainer — so a first-time user immediately understands
                          what this is and that the numbers are trustworthy. */}
                      <div className="flex items-start gap-2">
                        <Sparkles size={14} className="text-[var(--accent)] flex-shrink-0 mt-0.5" />
                        <p className="font-mono text-[10px] text-[var(--ink-2)] leading-relaxed tracking-[0.2px]">
                          Describe your meal in plain words — like <span className="text-[var(--ink-0)]">“2 eggs and a banana”</span> — and we’ll find each food for you. Calories come from the food database, so you can trust them.
                        </p>
                      </div>

                      <div className="flex gap-2">
                        <input
                          type="text" className="que-input flex-1"
                          placeholder="What did you eat?"
                          value={nlText} maxLength={300}
                          onChange={e => setNlText(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && runParse(nlText)}
                          autoFocus
                        />
                        <button
                          type="button"
                          onClick={() => runParse(nlText)}
                          disabled={!nlText.trim() || nlParsing}
                          className="que-btn-primary px-4 flex-shrink-0 disabled:opacity-40"
                        >
                          {nlParsing ? '…' : <Sparkles size={16} />}
                        </button>
                      </div>

                      {nlItems && nlItems.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[var(--ink-3)]">
                            Tap to add ({nlItems.filter(i => i.matched).length})
                          </p>
                          {nlItems.map((it, i) => it.matched && it.product ? (
                            <button
                              key={i} type="button"
                              onClick={() => setSelectedProduct({ p: it.product!, source: 'nl', servings: it.quantity })}
                              className="w-full flex items-center justify-between gap-3 rounded-md border border-[var(--line-2)] bg-[var(--bg-2)] px-3 py-2.5 text-left hover:border-[var(--accent)] transition-colors"
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <p className="font-mono text-[11px] font-semibold text-[var(--ink-0)] truncate">
                                    {it.quantity > 1 ? `${it.quantity}× ` : ''}{it.product.product_name}
                                  </p>
                                  {it.source === 'ai'
                                    ? <span className="flex-shrink-0 font-mono text-[7px] font-bold uppercase tracking-[0.5px] rounded px-1 py-px text-[#FFB547] border border-[#FFB547]/40">AI est</span>
                                    : <span className="flex-shrink-0 font-mono text-[7px] font-bold uppercase tracking-[0.5px] rounded px-1 py-px text-[var(--accent)] border border-[var(--accent-24)]">DB</span>}
                                </div>
                                <p className="font-mono text-[8px] text-[var(--ink-3)]">
                                  {it.grams ? `~${it.grams} g · ` : ''}tap to review &amp; add
                                </p>
                              </div>
                              <Plus size={15} className="text-[var(--accent)] flex-shrink-0" />
                            </button>
                          ) : (
                            <div key={i} className="flex items-center justify-between gap-3 rounded-md border border-dashed border-[var(--line-2)] px-3 py-2.5">
                              <p className="font-mono text-[10px] text-[var(--ink-3)] truncate">
                                “{it.query}” — not found
                              </p>
                              <button
                                type="button"
                                onClick={() => { setNlItems(null); setNlText(''); setMode('search'); handleSearchChange(it.query); }}
                                className="font-mono text-[9px] font-bold uppercase tracking-[0.5px] text-[var(--accent)] flex-shrink-0"
                              >
                                Search
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      {!nlItems && !nlParsing && (
                        <p className="font-mono text-[9px] text-[var(--ink-3)] tracking-[0.3px] text-center pt-2">
                          You can list several foods at once.
                        </p>
                      )}
                    </div>
                  )}

                  {/* ── SEARCH MODE ── */}
                  {mode === 'search' && (
                    <div className="space-y-3">
                      <div className="flex gap-2">
                        <input
                          type="text" className="que-input flex-1"
                          placeholder="Search foods, brands…"
                          value={searchQuery}
                          onChange={e => handleSearchChange(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && runSearch(searchQuery)}
                          autoFocus
                        />
                        <button
                          type="button"
                          onClick={() => runSearch(searchQuery)}
                          disabled={!searchQuery.trim() || searching}
                          className="que-btn-primary px-4 flex-shrink-0 disabled:opacity-40"
                        >
                          {searching ? '…' : <Search size={16} />}
                        </button>
                      </div>

                      {searchResults.length > 0 && (
                        <div className="rounded border border-[var(--line)] bg-[var(--bg-2)] divide-y divide-[var(--line)]">
                          {searchResults.map((p, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => setSelectedProduct({ p, source: 'search' })}
                              className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-[var(--bg-3)] transition-colors"
                            >
                              <div className="min-w-0">
                                <p className="font-mono text-[11px] font-semibold text-[var(--ink-0)] truncate">{p.product_name}</p>
                                {p.brands && <p className="font-mono text-[9px] text-[var(--ink-3)] truncate">{p.brands}</p>}
                              </div>
                              <div className="text-right flex-shrink-0">
                                <p className="font-mono text-[11px] font-bold text-[var(--accent)]">
                                  {Math.round(p.nutriments['energy-kcal_100g'] ?? 0)}
                                </p>
                                <p className="font-mono text-[8px] text-[var(--ink-3)]">kcal/100g</p>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}

                      {/* When the search input is empty, show the user's recent
                          and frequent foods so they can re-add in one tap
                          without hitting USDA. Hidden the moment they start
                          typing so search results take the prime real estate. */}
                      {!searchQuery.trim() && !searching && (
                        <QuickPicksPanel
                          refreshKey={open ? 1 : 0}
                          onSelect={(p, barcode) => setSelectedProduct({ p, barcode, source: 'recent' })}
                        />
                      )}
                    </div>
                  )}

                  {/* Error */}
                  {error && (
                    <p className="font-mono text-[11px] text-[var(--warn)] mt-3 tracking-[0.3px] border border-[var(--warn)]/30 rounded px-3 py-2 bg-[var(--warn)]/10">{error}</p>
                  )}

                  {mode !== 'scan' && searching && !searchResults.length && (
                    <p className="font-mono text-[9px] text-[var(--ink-3)] mt-3 text-center tracking-[1px] uppercase animate-pulse">
                      Searching…
                    </p>
                  )}

                  {/* ── MY FOODS MODE ── */}
                  {mode === 'myfoods' && (
                    <MyFoodsTab onSelect={p => setSelectedProduct({ p, source: 'myfoods' })} />
                  )}
                </>
                </motion.div>
              )}
              </AnimatePresence>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
