/**
 * lib/constants.ts
 *
 * App-wide constants — values that MUST agree across client and server, or
 * are referenced from many places where a typo would silently break sync.
 *
 * Don't put logic here. Functions live in lib/calorie-utils.ts, lib/storage.ts,
 * lib/syncEngine.ts, etc.
 */

// ── Calorie goal tolerance ───────────────────────────────────────────────────
// kcal window around the daily budget that counts as "hitting the goal".
// Used by the client streak UI, the server coin engine, the server badge
// engine, and the weekly recap cron — drifting any one of them silently
// awards (or fails to award) coins/badges. Single source of truth.
export const GOAL_TOLERANCE = 100;

// ── localStorage key namespace ───────────────────────────────────────────────
// These names are baked into users' browser storage; renaming any of them is
// a breaking change that requires a migration step. Centralized here so a
// typo can't silently create a separate key.

// Core workout / food / metrics log + BMR profile
// (legacy "ironman" prefix retained for backward compat with existing users)
export const DB_KEY            = 'ironmanCoreDB_v2';
export const PROFILE_KEY       = 'ironmanProfileSettings_v2';
export const TEMPLATES_KEY     = 'ironmanTemplatesPool';

// Coins / goals / streaks / PRs
export const COIN_KEY          = 'queCalorieCoins';
export const MACRO_GOALS_KEY   = 'queMacroGoals';
export const LAST_STREAK_KEY   = 'queLastStreak';
export const LIFT_PRS_KEY      = 'queLiftPRs';
export const MILLION_GROUPS_KEY = 'queMillionGroups';

// Plan / presets / usage
export const ATHLETE_PLAN_KEY   = 'queAthletePlan';
// Read-only archive of superseded plans — the user's cut/bulk journey over time.
export const PLAN_HISTORY_KEY   = 'queAthletePlanHistory';
export const WORKOUT_PRESETS_KEY = 'queWorkoutPresets';
export const EXERCISE_USAGE_KEY  = 'queExerciseUsage';
export const CUSTOM_EXERCISES_KEY = 'queCustomExercises'; // user-added exercises (name + secondary/tertiary muscles), per group

// UI preferences
export const UNITS_KEY         = 'queUnits';   // 'imperial' | 'metric' — display/input only; storage stays imperial
export const PROFILE_PHOTO_KEY = 'queProfilePhoto';
export const ACCENT_KEY        = 'queAccentColor';
export const BG_KEY            = 'queBgPreset';
export const LIGHT_BG_KEY      = 'queLightBgPreset';
export const THEME_KEY         = 'queTheme';

// Misc client state (single-use today, centralized so they're discoverable)
export const SHOWN_BADGES_KEY   = 'queShownBadgePopups';
// Durable queue of server-confirmed badges waiting to show their celebration
// popup. A sync drains pending badges from Redis ONCE (getdel), so the only
// resilient place to hold "still need to show this" is the client — this key
// survives a missed DOM event / frozen tab and is drained on the next app open.
export const PENDING_BADGE_POPUPS_KEY = 'quePendingBadgePopups';
export const WEIGHT_PROMPT_KEY  = 'queWeightPromptDate';   // legacy gate — cleaned up on load
export const WEIGHT_SKIP_KEY    = 'queWeightSkipDate';     // epoch-ms timestamp of the last morning-prompt skip (drives a 5-min snooze)
export const SOCIAL_ANIM_KEY    = 'queSocialAnimIdx';
export const COINS_MIGRATED_KEY = 'queCoinsMigrated';
// Floating rest-timer state (device-local, NOT synced). Persisted so the bar
// survives tab switches and app restarts mid-workout. Holds the active timer,
// whether it's visible, and when the user last committed an exercise (drives
// the "bring it back" button after a dismiss).
export const REST_TIMER_KEY     = 'queRestTimer';
// Week-one "Getting started" checklist state (device-local). { dismissed?, socialSeen? }.
export const GETTING_STARTED_KEY = 'queGettingStarted';
// Structured lifting program (split + prescribed sets/reps). Synced via SETTINGS_KEYS.
export const LIFTING_PROGRAM_KEY = 'queLiftingProgram';

// Multi-week periodized training block (hybrid lift + cardio scheduler).
// One active block at a time; synced via SETTINGS_KEYS. See lib/trainingBlock.ts.
export const TRAINING_BLOCK_KEY = 'queTrainingBlock';

// Last adaptive-TDEE estimate the user was shown in a weekly recap — used to
// detect a meaningful week-over-week change ("updated to X") vs. a stable
// estimate ("held steady"). Device-local; { weekId, estimate, confidence }.
export const ADAPTIVE_TDEE_LAST_KEY = 'queAdaptiveTdeeLast';

// App owner — the account that receives user-submitted suggestions
// (/api/feedback push). Same address used for the web-push VAPID contact.
export const OWNER_EMAIL = 'tanishqsomania21@gmail.com';
