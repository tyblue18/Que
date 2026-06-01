/**
 * lib/dayMerge.ts
 *
 * Per-FIELD last-writer-wins merge for a single day's record — the fix for the
 * silent cross-field data loss in the old per-DAY merge:
 *
 *   10:00  Phone logs breakfast (foods)        → syncs
 *   10:30  Laptop (hasn't pulled) edits weight → syncs
 *          Old model: laptop's whole day (10:30) beats phone's (10:00) → breakfast lost.
 *          New model: foods stamped 10:00, weight 10:30 → BOTH survive.
 *
 * ── ONE pure function, BOTH sides ──────────────────────────────────────────
 * The most dangerous failure mode is the server POST and the client pull-merge
 * drifting apart — if they ever disagree on who wins a collision you get
 * nondeterministic data loss depending on which ran last. This module is the
 * single source both call, so divergence is structurally impossible.
 *
 * ── Granularity: TOP-LEVEL KEYS, not inside arrays ─────────────────────────
 * Each top-level DayRecord key (weight, steps, foods, exercises, measurements…)
 * merges independently. We deliberately do NOT merge *within* the serialized
 * `foods` / `exercises` arrays — that's the CRDT path, scoped out. Residual
 * known limitation: two devices editing the SAME collection in the same short
 * window still resolves last-writer-wins on that whole field.
 *
 * ── Deletion safety (the invariant this module depends on) ─────────────────
 * Clearing a field is done by writing an explicit empty value (`''`, `0`,
 * `'[]'`) — NEVER by removing the key (updateDayRecord is spread-only; see the
 * food-removal battle scar in CalorieTracker). So:
 *   • a PRESENT key (even empty) is a real, timestamped value → it can beat a
 *     stale non-empty value on the other side (no resurrection);
 *   • an ABSENT key means "this side never set it / has no opinion" → the other
 *     side's value is inherited.
 * `stampEditedFields` stamps by KEY PRESENCE (Object.keys), not truthiness, so a
 * cleared `weight: 0` still gets a fresh timestamp. Stamping by truthiness would
 * pass every happy-path test and silently reintroduce the resurrection bug — the
 * cleared-field test in the suite is the guard against exactly that.
 */

/** A day record as the merge sees it: arbitrary data keys + merge metadata. */
export interface MergeableDay {
  [key: string]: unknown;
  /** Whole-day edit time (legacy + ordering fallback). */
  _editedAt?: string;
  /** Per-field edit times: { weight: ISO, foods: ISO, … }. Absent on legacy days. */
  _fieldEditedAt?: Record<string, string>;
  /** Transport-only server sync time — never participates in the merge. */
  _syncedAt?: string;
}

export interface MergeResult {
  merged: MergeableDay;
  /** Data fields where `local` (the FIRST arg) was kept over `incoming`.
   *  Non-empty ⇒ the merge differs from what `incoming` sent, so the caller
   *  should surface/return the reconciled day (server: it's a "conflict";
   *  client: an unsynced local edit was preserved). */
  localWonFields: string[];
}

// Merge metadata — excluded from the data-field universe.
const META_KEYS = new Set(['_editedAt', '_fieldEditedAt', '_syncedAt']);

/** ISO string of when `field` was last edited on `day` — per-field map first,
 *  then the whole-day `_editedAt` (legacy days stamped every field at day-time),
 *  else undefined. */
function fieldIso(day: MergeableDay, field: string): string | undefined {
  return day._fieldEditedAt?.[field] ?? day._editedAt;
}

/** Numeric edit time for comparison. Unparseable / missing → 0 (loses to any
 *  real timestamp; ties resolve to `incoming` in mergeDays). */
function fieldTime(day: MergeableDay, field: string): number {
  const iso = fieldIso(day, field);
  const ms = iso ? Date.parse(iso) : 0;
  return Number.isFinite(ms) ? ms : 0;
}

function has(obj: MergeableDay, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Merge two versions of the same day, field by field. `incoming` wins ties
 * (preserving the existing "remote/pushed write wins on equal timestamps" rule
 * so server-side cron writes still propagate). A field present on only one side
 * is inherited (the other side has "no opinion" — see deletion-safety note).
 *
 * Pure + non-mutating. Used by BOTH the server POST and the client pull-merge.
 */
export function mergeDays(local: MergeableDay, incoming: MergeableDay): MergeResult {
  const keys = new Set<string>();
  for (const k of Object.keys(local))    if (!META_KEYS.has(k)) keys.add(k);
  for (const k of Object.keys(incoming)) if (!META_KEYS.has(k)) keys.add(k);

  const merged: MergeableDay = {};
  const mergedTimes: Record<string, string> = {};
  const localWonFields: string[] = [];

  const take = (from: MergeableDay, f: string) => {
    merged[f] = from[f];
    const iso = fieldIso(from, f);
    if (iso) mergedTimes[f] = iso;
  };

  for (const f of keys) {
    const inLocal    = has(local, f);
    const inIncoming = has(incoming, f);

    if (inLocal && !inIncoming) {
      // incoming has no opinion on this field → keep local's value.
      take(local, f);
      localWonFields.push(f);
    } else if (!inLocal && inIncoming) {
      take(incoming, f);
    } else {
      // Both present → newer field-edit-time wins; incoming wins ties.
      if (fieldTime(incoming, f) >= fieldTime(local, f)) {
        take(incoming, f);
      } else {
        take(local, f);
        localWonFields.push(f);
      }
    }
  }

  if (Object.keys(mergedTimes).length > 0) {
    merged._fieldEditedAt = mergedTimes;
    // Whole-day _editedAt = the most recent field edit (keeps ordering honest
    // for any legacy consumer that still reads the day-level timestamp).
    merged._editedAt = Object.values(mergedTimes).reduce(
      (max, iso) => (Date.parse(iso) > Date.parse(max) ? iso : max),
    );
  } else {
    // No timestamps anywhere — preserve whichever whole-day stamp exists.
    const e = incoming._editedAt ?? local._editedAt;
    if (e) merged._editedAt = e;
  }

  return { merged, localWonFields };
}

/**
 * Stamp `_fieldEditedAt` for the fields an edit just touched, with BACKFILL of a
 * legacy day's untouched fields FIRST. Pure + non-mutating.
 *
 * ── Why backfill-then-stamp (the legacy-transition correctness rule) ────────
 * A legacy day carries only a whole-day `_editedAt` (say Monday) — the honest
 * coarse claim "every field was last touched Monday". When a new client edits
 * ONE field on Wednesday, the other fields still have no per-field stamp. If we
 * let them fall through to the day's `_editedAt` at merge time, that's been
 * rolled up to Wednesday — fabricating "foods edited Wednesday" when foods was
 * really Monday, which would then wrongly beat a genuine Tuesday edit from
 * another device. So we BACKFILL every existing field's stamp from the day's
 * original `_editedAt` BEFORE applying the new edit, converting the coarse-but-
 * honest claim into a fine-grained-and-honest one. Order matters: backfill, then
 * stamp the touched keys.
 *
 * Stamps by KEY PRESENCE (every key in `updatedKeys`), NOT truthiness — so a
 * cleared field (`weight: 0`, `foods: '[]'`) gets a fresh timestamp and can beat
 * a stale value on another device (the resurrection guard).
 *
 * @param prevDay     the day's prior state (its fields + `_editedAt` + map)
 * @param updatedKeys the keys present in the partial update (Object.keys(updates))
 * @param nowIso      the edit timestamp to stamp the touched keys with
 */
export function stampEditedFields(
  prevDay: MergeableDay,
  updatedKeys: string[],
  nowIso: string,
): Record<string, string> {
  const next: Record<string, string> = { ...(prevDay._fieldEditedAt ?? {}) };

  // Backfill: existing DATA fields with no per-field stamp inherit the day's
  // honest whole-day `_editedAt` (their true coarse last-touch), so a later
  // rollup can't fabricate a newer time for fields this edit didn't touch.
  const dayEdited = prevDay._editedAt;
  if (dayEdited) {
    for (const k of Object.keys(prevDay)) {
      if (META_KEYS.has(k)) continue;
      if (!(k in next)) next[k] = dayEdited;
    }
  }

  // Stamp the fields this edit actually touched (by presence, not truthiness).
  for (const k of updatedKeys) {
    if (META_KEYS.has(k)) continue; // never stamp metadata as a data field
    next[k] = nowIso;
  }
  return next;
}

/**
 * Clamp any FUTURE per-field timestamp (beyond now + tolerance) down to now —
 * per field, not all-or-nothing. A skewed-fast device clock can't let one
 * fabricated-future field stamp poison the merge by claiming to be newer than
 * reality; clamping (vs dropping) preserves the real value while stripping its
 * false superiority. Applied at the call sites to keep `mergeDays` pure (no
 * concept of "now"). Pure + non-mutating; returns the same object if untouched.
 */
export function sanitizeFieldStamps(
  day: MergeableDay,
  nowMs: number,
  toleranceMs: number,
): MergeableDay {
  const ceiling = nowMs + toleranceMs;
  const nowIso = new Date(nowMs).toISOString();
  const clamp = (iso: string | undefined): string | undefined => {
    if (!iso) return iso;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) && ms > ceiling ? nowIso : iso;
  };

  let changed = false;
  let fieldMap = day._fieldEditedAt;
  if (fieldMap) {
    const out: Record<string, string> = {};
    for (const [k, iso] of Object.entries(fieldMap)) {
      const c = clamp(iso)!;
      if (c !== iso) changed = true;
      out[k] = c;
    }
    fieldMap = out;
  }
  const editedAt = clamp(day._editedAt);
  if (editedAt !== day._editedAt) changed = true;

  if (!changed) return day;
  return {
    ...day,
    ...(fieldMap ? { _fieldEditedAt: fieldMap } : {}),
    ...(editedAt ? { _editedAt: editedAt } : {}),
  };
}

/**
 * Server-side resolution of one incoming day against the stored row. Sanitizes
 * the incoming field stamps (future-clock guard), then merges with the STORED
 * row as `local` and the INCOMING push as `incoming` — so a tie goes to the
 * client push (preserving the existing "client dirty write wins" rule) and the
 * stored row remains authoritative for every field the push omitted.
 *
 * Returns the MERGED day to upsert (never the raw incoming — that would clobber
 * untouched stored fields, the server-side breakfast bug) plus `localWonFields`
 * = fields where the stored row beat the push (→ a conflict the client adopts).
 */
export function resolveIncomingDay(
  storedData: MergeableDay | undefined,
  incomingData: MergeableDay,
  nowMs: number,
  toleranceMs: number,
): MergeResult {
  const sanitized = sanitizeFieldStamps(incomingData, nowMs, toleranceMs);
  if (!storedData) return { merged: sanitized, localWonFields: [] };
  return mergeDays(storedData, sanitized);
}
