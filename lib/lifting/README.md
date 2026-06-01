# Lifting Program — design & science

How Que builds and runs structured lifting plans, and *why* each decision is
made the way it is. Everything here maps to code in this directory. Claims are
flagged as **[evidence]** (literature-backed), **[estimate]** (population
averages / starting values that should refine from a user's own data), or
**[heuristic]** (tuned judgment, not from a paper) so a future reader knows
which is which before changing it.

> Companion to the running VDOT engine (`lib/running/`). Same philosophy:
> a closed loop that reads the user's logged response and adapts, rather than a
> static template.

---

## The four layers

```
1. GENERATOR      program.ts        builds the week-1 plan from your inputs
2. LOAD COACH     progression.ts    reads your logs → what weight to use today
3. VOLUME ENGINE  volume.ts         ramps sets across a mesocycle + deload
4. SWAP LAYER     alternatives.ts   muscle-mapped exercise substitution
5. READINESS      progression.ts    sessFeel nudges today's load suggestion
```

They compose: the generator sets the baseline, the volume engine ramps it week
to week, the load coach progresses weight within each exercise, readiness tilts
that suggestion by how the last session felt, and the swap layer lets you change
movements without breaking any of the above.

Storage: the plan lives in `localStorage` under `queLiftingProgram`, synced
across devices via `SETTINGS_KEYS`. All weights are stored **canonical (lb)** and
converted only at the display/input edge (`lib/units.ts`), so kg/lb is a pure
display preference — no data migration, formulas untouched.

---

## Layer 1 — Generator (`program.ts`)

**Input:** days/week (2–6, the only required choice), goal (strength /
hypertrophy / general), experience (beginner / intermediate / advanced).

### Split selection
Frequency is a **volume-distribution** tool, so more days just spreads the same
weekly volume into smaller sessions. **[evidence]** (frequency's effect on
hypertrophy is ~negligible when volume is equated; it does help strength, hence
the goal fork below.)

| Days | Split |
|---|---|
| 2 | Full Body |
| 3 | PPL (Full Body for beginners — more practice per lift) |
| 4 | Upper / Lower |
| 5 | PPL + Upper/Lower |
| 6 | PPL ×2 |

### The variable hierarchy
**Tier 1 — primary drivers**
- **Volume** (sets/muscle/week) is the strongest dose-response lever. We count
  **fractional sets**: a set credits its primary mover **1.0** and each
  secondary mover **0.5** (bench = 1.0 chest + 0.5 triceps + 0.5 front delts).
  This is the substrate every other layer reads. **[evidence]** (Pelland 2024
  meta-regression: hypertrophy probability rises with volume; ~4 sets/muscle
  minimum, 5–10 banks most gains, diminishing returns after, no clear ceiling.)
- **Proximity to failure** — every set carries an **RIR** (reps-in-reserve)
  target: hypertrophy compounds 1–3, isolation 0–2 (low systemic fatigue lets
  them go closer), strength 2–3. **[evidence]** (Robinson 2024: hypertrophy
  improves closer to failure but failure itself isn't required; 1–3 RIR captures
  the stimulus without failure's fatigue cost.)

**Tier 2 — supported but flexible**
- **Rep ranges chosen for practicality, not as a growth lever** — pressing 5–10
  (joint-friendly, technique holds), most else 8–15; strength forks to 3–6 on
  compounds. **[evidence]** (No "hypertrophy zone": growth is similar across
  loads ≥~30% 1RM taken near failure; moderate loads are simply most
  time-efficient. Strength *does* favor heavy loads >~60% 1RM — the goal fork.)

**Tier 3 — fixed defaults (not user-facing)**
- Full ROM; rest prescribed per exercise (≈3 min heavy compounds → 90 s
  isolation). **[evidence]** (ROM and rest-interval effects on hypertrophy are
  real but trivial-to-small; ~2 min rest preserves per-set performance without
  costing growth.)

### Volume target & exercise cap
Target sets/muscle scale with experience (hypertrophy 10/15/20 for
beg/int/adv; lower for strength/general). Beginners cap at 5 exercises/session
for recovery + technique focus.

### Nutrition
Protein band **1.6–2.2 g/kg/day**, **0.25–0.40 g/kg per meal** across 3–6 meals.
**[evidence]** (Morton's ~1.6 g/kg breakpoint as the conservative anchor — note
it's contested; a reanalysis questions a hard plateau — with 2.2 as the generous
ceiling and per-meal dosing to maximize the MPS response.)

---

## Layer 2 — Load coach (`progression.ts`)

Reads your **most recent logged session** of each prescribed lift and applies
**double progression** (push reps to the top of the range, then add load and
reset reps):

| Last session | Action | Today |
|---|---|---|
| Every set hit the **top** of the range | **Add load** | +5 lb upper / +10 lb lower, reset reps to bottom |
| In range, **below the top** | Push reps | Keep weight, chase the top |
| **Missed the bottom** of the range | Hold | Stay, rebuild reps before adding weight |
| Never logged | Start | Seed from all-time PR, or "log your first set" |

- Uses the **heaviest worked weight** as the reference, so warm-up/ramp sets
  don't fool it.
- Cold-start seed = PR × goal factor (strength 0.85, hypertrophy 0.72, general
  0.75), rounded to 5 lb.

**[evidence]** (A 2024 trial found load- and rep-progression produce equivalent
hypertrophy, so double progression is a fully defensible default engine.) The
+5 lb upper / +10 lb lower jump sizes are **[heuristic]** — conventional gym
practice, not a measured optimum.

---

## Layer 3 — Volume engine (`volume.ts`) — the most important layer

Makes volume *progress* instead of sitting static, via **MEV → MAV → MRV**:

- **5-week block: 4 ramp weeks + 1 deload.** Week 1 = generated baseline, then
  **+1 set per exercise each week** (wk2 +1, wk3 +2, wk4 +3), then **week 5
  halves volume** (deload).
- Current week is **derived from `mesoStartDate`** — no per-week bookkeeping;
  reading the program on any date yields the right prescription.
- Each muscle is shown against its **MEV / MAV / MRV** landmarks: a tick marks
  where growth begins (MEV), the bar scales to the recoverable ceiling (MRV),
  amber past MRV.

**[evidence]** (Ramping volume across a block beats parking at high volume;
starting at MRV leaves nowhere to go but down; consensus deload every 4–6 weeks
to maintenance volume.)

**Block length is fixed at 5 weeks regardless of experience.** The evidence
supports *varying* it (beginners recover faster and could ramp longer; advanced
lifters fatigue sooner) — we chose a single block for simplicity and because the
autoregulated deload trigger (below) catches early fatigue anyway. Revisit if
user data shows advanced users stalling before week 5. **[heuristic]**

### Autoregulated deload signal
Reuses the load coach's existing "missed the bottom of the range" flag across
*all* program lifts. A single bad day is noise; **2+ lifts regressing within the
last week** surfaces "you may be due for a deload."

⚠️ **The "2 lifts / 7 days" threshold is a tuned [heuristic], not a literature
value.** It came from judgment about what separates a pattern from a bad day,
not a paper. The *concept* is **[evidence]** — you've hit MRV when 2+ fatigue
markers decline together, and performance regression is the cleanest marker —
but the specific numbers are the first thing to tune if it fires too often or
too rarely. (As of the readiness layer, this is a *two-signal* inference: see
Layer 5.)

---

## Layer 4 — Swap layer (`alternatives.ts`)

Each exercise belongs to a **family** of variations sharing the same primary
muscle, secondary muscles, and role (compound/isolation). Swap Bench Press →
Dumbbell Bench Press and:

- **Volume counting stays correct** — the new movement carries the same muscle
  mapping, so chest still gets 1.0 and triceps/shoulders still get 0.5.
- **The prescription is preserved** — same sets/reps/RIR/rest; only identity +
  muscle mapping change.
- **Progression intentionally resets** for the new movement (dumbbell bench uses
  different absolute loads than barbell — you *should* re-find the weight; volume
  tracking stays seamless because the muscle mapping is identical).

**[evidence, softened]** Exercise variation is double-edged: systematic
same-muscle rotation can enhance regional hypertrophy, while *excessive or
redundant* variation **may blunt** gains and should be approached systematically.
(The review was tentative and the sample small + all young men — it does **not**
establish that random rotation definitively hinders gains.) Role-consistent,
same-muscle families are the safe design that captures the upside without the
risk.

---

## Layer 5 — Readiness (`progression.ts`, reads `sessFeel`)

The user already logs a session **feel** (`sessFeel`, 1–10) in the WorkoutLogger
check-in. The load coach reads the *most recent* feel and tilts today's
suggestion:

- **Felt brutal (low feel)** → hold back: don't add load even if reps qualified;
  defer the increase one session.
- **Felt easy (high feel)** → green-light the planned progression (and it's
  permitted to nudge slightly sooner).
- **Neutral / unlogged** → pure double progression, unchanged.

This attacks the documented churn driver (apps that feel *static* lose users;
apps that feel responsive to *today's* person retain better) **[evidence]**, and
it reuses a signal already in the data — no new capture UI.

**Synergy with the deload trigger:** subjective "felt brutal" is a *second*
fatigue marker. Combined with performance regression, the deload signal moves
from a one-signal to a two-signal inference — closer to the MRV literature's
"2+ markers decline together." **[evidence]** for the principle; the exact
combination rule is **[heuristic]**.

---

## A session, end to end

```
Open program → volume engine sets THIS WEEK's set counts
            → load coach reads your last session + sessFeel → "go up to 140"
                                                              (or "hold, last felt brutal")
Tap "Start this workout"
            → today's day drops into the logger, pre-filled with the coached
              weight × this-week's set count, reps as placeholders
Log your sets (the rest timer fills reps as you go) + a session feel
            → next visit, the coach reads what you did → next step
```

---

## Honest limitations (kept visible in the UI)

1. **MEV/MAV/MRV landmarks are [estimate]s** — population averages, largely from
   young men, and truly individual. The UI frames them as starting estimates
   that refine as you log. Real landmarks only emerge from 2–3 of a user's own
   mesocycles.
2. **Progression matches by exact exercise name.** The swap layer handles
   substitutions *within the program*; a one-off lift logged outside the program
   won't link.
3. **Readiness uses a single self-reported number (`sessFeel`).** It's a coarse
   proxy for recovery, not HRV/sleep data — deliberately, to stay zero-friction.

---

## What's deliberately *not* here (and why)

- **Per-set RIR/RPE autoregulated load model** — the meta-analytic answer is no
  significant difference vs. standardized progression, so double progression
  stays the engine; readiness (Layer 5) is the lightweight hybrid instead.
- **Velocity-based training** — needs hardware most users don't have.
- **Experience-varied block length** — see Layer 3; chose simplicity.

---

## File map

| File | Responsibility |
|---|---|
| `program.ts` | Generator: split, prescription, fractional-set volume, protein. Pure. |
| `progression.ts` | Load coach (double progression) + readiness tilt. Pure. |
| `volume.ts` | Mesocycle ramp, MEV/MAV/MRV landmarks, autoregulated deload. Pure. |
| `alternatives.ts` | Movement families for muscle-mapped swaps. Pure. |
| `*.test.ts` | Vitest coverage for each engine. |
| `components/lifting/LiftingPlanBuilder.tsx` | The UI that consumes all of the above. |

All engine files are pure (no React, no storage) so they're unit-tested in
isolation; the builder is the only stateful consumer.
