# Gamification polish

Additive layer on top of the shared active-minute XP pool introduced by
multi-pet support (see [multiple-pets.md](multiple-pets.md)'s "XP
integration decision"): streak multipliers, off-hours bonuses, and a
cosmetic flourish for pets past the growth cap. None of this blocks
multi-pet rendering from working, so it's tracked as its own follow-on
rather than bloating that checklist.

## Background

The active-minute pool already scales with pet count and splits via
catch-up weighting (multiple-pets.md). This doc adds multipliers on top of
that pool — the pool is computed first, then multiplied, then split across
pets. Commit XP and click XP are unaffected by anything here (see
multiple-pets.md — commits are a flat per-pet award, clicks are
attributed to whichever pet was clicked).

## Design decisions

**Two streak multipliers, additive (not compounding), each independently
capped at +100%:**

- **Daily streak** — counts *weekdays only* (Mon–Fri). Weekend activity
  still earns normal XP (pool + session streak + off-hours bonus below),
  it just doesn't advance or break the daily-streak counter — weekends are
  neutral for streak-keeping, not required and not penalized. +10% per
  consecutive weekday, capping at day 10 (+100%). Grace: the streak only
  hard-resets after **2 consecutive missed weekdays**, not the first miss
  — a single day off survives (e.g. active Thu, off Fri, weekend passes
  untouched, active Mon → streak intact, since only one weekday was
  missed). Off both Fri and the following Mon (a 4-day weekend) → two
  missed weekdays in a row → resets.

- **Session streak** — rewards a continuous unbroken sitting, tracked via
  `sessionStartedAt` reset logic layered on the existing `lastActivityAt`
  used by `XpManager.markActive()`. Pause threshold (time since last
  active signal before the session clock stops advancing, without
  resetting) is **30 minutes**; hard reset to zero happens at **90
  minutes** (3x the pause threshold) of continuous inactivity. +10% per 30
  continuous active minutes, capping at 5 hours (+100%) — the bonus step
  size deliberately matches the pause threshold, so every 30-minute window
  you don't get paused on is exactly one bonus tier.

**Off-hours bonus, flat and stackable, same additive-stack pattern:**

- **Weekend bonus**: +20% during any active minute on Sat/Sun. Gives
  weekend activity a positive reason to happen even though it's neutral
  for the daily streak.
- **Late-night bonus**: +20% during a fixed window (10pm–6am local system
  time), any day. Both are hardcoded wall-clock checks, not a personalized
  "typical hours" baseline — keep this a tunable constant like the rest of
  the XP rates (`XP_PER_ACTIVE_MINUTE`, etc.) rather than a new profiling
  feature.

**Combined multiplier**: `1 + dailyStreakBonus + sessionStreakBonus +
weekendBonus + lateNightBonus`, applied to the N-scaled pool from
multiple-pets.md *before* the per-pet catch-up split. No additional
combined ceiling — the two streak caps plus both flat bonuses can stack
freely (theoretical max ~3.4x); reaching that requires a maxed daily streak
*and* a 5-hour unbroken session *and* it being a weekend night, which is
self-limiting enough not to need an artificial cap.

**Prestige cosmetic past the growth cap**: `petGrowthMaxLevel` (default
20) currently just plateaus sprite size (`petGrowthMaxScale`) with nothing
marking a pet as "done growing." Add a cosmetic flourish — particle aura or
badge border color change — once a pet reaches `petGrowthMaxLevel`, so
leveling past the cap still has a visible payoff.

## Checklist

### Phase 1 — streak tracking (extension.ts)
- [x] Track `lastActiveWeekday` / consecutive-weekday-miss count for the
      daily streak (persisted alongside `XpRecord`, or as its own small
      piece of global state — decide once XP persistence shape is
      revisited; doesn't need to be per-pet since it reflects the user's
      overall activity, not any one pet's). Landed as its own `streak.json`
      (`StreakState { dailyStreakDays, lastActiveWeekdayKey }`) alongside
      `xp.json`, saved on the same debounce timer.
- [x] Track `sessionStartedAt` / `lastActivityAt`-derived pause/reset logic
      for the session streak, reusing the existing `markActive()` call
      sites. Landed as an accumulated `sessionActiveMs` (frozen across a
      30-min pause, hard-reset past 90 min) rather than a wall-clock
      `sessionStartedAt`, so paused time is never credited.
- [x] Add pure functions for each bonus (`dailyStreakBonus(state)`,
      `sessionStreakBonus(state)`, `weekendBonus(now)`,
      `lateNightBonus(now)`) so the combined multiplier is testable in
      isolation from the interval/timer plumbing.

### Phase 2 — apply multiplier to the pool
- [x] Fold the combined multiplier into the active-minute pool calculation
      from multiple-pets.md, before the catch-up split.
- [x] Confirm commit XP and click XP remain unaffected (flat, as decided).

### Phase 3 — prestige cosmetic (media/main.js + main.css)
- [x] Add a visual flourish (particle aura or badge border treatment) for
      pets at `petGrowthMaxLevel`, gated behind `petGrowthEnabled` as it's
      an extension of that same growth system. Landed as a golden badge
      outline plus a slow 4-point sparkle aura, both canvas-drawn — no
      `main.css` changes were needed since the pet view has no per-pet DOM
      elements to style.

### Phase 4 — docs
- [x] Update [README.md](../../README.md) with the streak mechanics and
      off-hours bonuses.
