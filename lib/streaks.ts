/**
 * lib/streaks.ts
 *
 * Rest-aware workout-streak math, shared by the badge engine (server) and the
 * calendar/metrics UI (client) so the streak a user SEES and the streak that
 * AWARDS a badge can never drift. A day the user marks as a rest day BRIDGES
 * the streak — it keeps the chain alive without itself being a workout — so a
 * planned recovery day doesn't read as a missed day.
 *
 * Day classification (a workout WINS if both a workout is logged AND restDay is
 * set — you trained, so it's a workout day):
 *   workout : a session is logged   (isWorkout(rec) === true)
 *   rest    : explicitly marked rest (rec.restDay === true) and not a workout
 *   none    : neither               → breaks the streak
 *
 * Two measures, each correct for its surface:
 *   • streakEndingAt(db, date) — the *current* streak ending on `date` (the
 *       calendar chip). Counts from the earliest workout in the consecutive
 *       on-plan span up to `date`, so a rest day TODAY keeps the streak alive
 *       and growing monotonically. Leading rest (before the first workout) is
 *       trimmed; trailing rest up to `date` is kept (it's "now").
 *   • maxWorkoutStreak(db) — the longest streak anywhere in history (the
 *       badges). Each maximal calendar-consecutive on-plan run contributes
 *       (last workout − first workout + 1): BOTH leading and trailing rest are
 *       trimmed, so a run that trails off into rest and then stops ("rested,
 *       then quit") isn't credited for the abandonment.
 *
 * Streak badges are nutrition-category (never revoked), so widening a streak by
 * bridging rest can only ADD a badge, never strip one.
 */

export interface StreakDay {
  exercises?: unknown;
  restDay?: unknown;
}

export type DayStatus = 'workout' | 'rest' | 'none';

const DAY_MS = 86_400_000;

/** Default "is this a workout day" — a non-trivial serialised exercises blob.
 *  Matches the badge engine's hasWorkout (`length > 2` rejects '' and '[]'). */
export const defaultIsWorkout = (rec: StreakDay | undefined | null): boolean =>
  String(rec?.exercises ?? '').length > 2;

export function dayStatus(
  rec: StreakDay | undefined | null,
  isWorkout: (r: StreakDay | undefined | null) => boolean = defaultIsWorkout,
): DayStatus {
  if (isWorkout(rec)) return 'workout';
  if (rec?.restDay === true) return 'rest';
  return 'none';
}

/** Pure date-string arithmetic (UTC midnight), so it's timezone-stable. */
function shiftDate(dateStr: string, deltaDays: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Current rest-aware streak ending on (and including) `dateStr`. Returns 0 if
 * that day is neither a workout nor a marked rest day, or if the unbroken
 * on-plan span walking back from it contains no workout at all (a lone rest day
 * — or a run of pure rest — is not a streak).
 */
export function streakEndingAt(
  localDB: Record<string, StreakDay>,
  dateStr: string,
  isWorkout: (r: StreakDay | undefined | null) => boolean = defaultIsWorkout,
): number {
  const st = (d: string) => dayStatus(localDB[d], isWorkout);
  if (st(dateStr) === 'none') return 0;

  // How many days back is the EARLIEST workout in the unbroken on-plan span?
  let earliestWorkoutBack = st(dateStr) === 'workout' ? 0 : -1;
  let back = 0;
  let cursor = dateStr;
  for (;;) {
    cursor = shiftDate(cursor, -1);
    back++;
    const s = st(cursor);
    if (s === 'none') break;
    if (s === 'workout') earliestWorkoutBack = back;
  }
  if (earliestWorkoutBack === -1) return 0; // span is all rest → not a streak
  return earliestWorkoutBack + 1;
}

/** Longest rest-aware streak in all of localDB (used for badge thresholds). */
export function maxWorkoutStreak(
  localDB: Record<string, StreakDay>,
  isWorkout: (r: StreakDay | undefined | null) => boolean = defaultIsWorkout,
): number {
  const dates = Object.keys(localDB)
    .filter(d => dayStatus(localDB[d], isWorkout) !== 'none')
    .sort();

  let best = 0;
  let i = 0;
  while (i < dates.length) {
    // Extend a maximal calendar-consecutive run dates[i..j].
    let j = i;
    while (
      j + 1 < dates.length &&
      Math.round(
        (Date.parse(dates[j + 1] + 'T00:00:00Z') - Date.parse(dates[j] + 'T00:00:00Z')) / DAY_MS,
      ) === 1
    ) {
      j++;
    }
    // First & last workout within the run (rest-only runs contribute nothing).
    let firstW = -1;
    let lastW = -1;
    for (let k = i; k <= j; k++) {
      if (dayStatus(localDB[dates[k]], isWorkout) === 'workout') {
        if (firstW === -1) firstW = k;
        lastW = k;
      }
    }
    // The run is calendar-consecutive, so index diff === calendar-day diff.
    if (firstW !== -1) best = Math.max(best, lastW - firstW + 1);
    i = j + 1;
  }
  return best;
}
