# Multiple pets at once

Allow more than one pet to be shown and animated simultaneously in a single
Codex Pet webview (sidebar and/or panel), instead of the current one-pet-per-view
limitation, so users can mix pets (or run several instances) side by side.

## Background

Both the extension host and the webview are built around a single active pet.
`resolvePet`/`pickPet` in [src/extension.ts](../../src/extension.ts) resolve
and return exactly one `Pet`, and `getWebviewHtml` injects a single
`spriteUri`/`configUri` pair into `window.CODEX_PET`. On the render side,
[media/main.js](../../media/main.js) tracks the pet's entire runtime state
(`x`, `facing`, `moving`, `currentState`, `frameIndex`/`frameTimer`,
`stateTimer`/`stateDuration`, `petBox`, `hearts`, `reacting`,
`jumpCooldown`/`jumpHeight`/`jumpFrameDuration`, `wasAiBusy`) as flat
module-level variables, and `tick()` operates on that single set of globals.

Rejected: keeping one pet per webview and telling users to set `location:
"both"` plus running duplicate views — that only ever yields two views tied
to fixed containers (sidebar + panel), not an arbitrary N pets in one place,
and it's already how "both" works today for a single pet.

Cursor-chase behavior needed a decision since `chaseCursor()` currently drives
one pet straight at the cursor. Rejected "only nearest pet chases" (simple,
but the others visibly ignore the cursor) and "no chase with >1 pet" (loses
the interactive feel entirely). Decision: **all pets chase, with side-by-side
separation** — pet `i` of `n` targets `cursorX + (i - (n-1)/2) * spacing`
instead of `cursorX` directly, so the group visibly follows the cursor but
queues up beside it rather than stacking. `spacing` is derived from each
pet's own scaled sprite width (`frameWidth * getScale()`) plus a small gap,
so it holds up across different `petScale` values. Per-instance
`jumpCooldown` stays independent so pets don't jump over the cursor in sync.

## Data model decision

Add `codexPet.selectedPets: string[]` (default `[]`) alongside the existing
`codexPet.selectedPet: string`. Rejected changing `selectedPet`'s type to
`string | string[]` — keeping them as two separate settings avoids a messy
union type in the JSON schema and lets existing single-pet configs keep
working untouched. Precedence: if `selectedPets` is non-empty, use it;
otherwise fall back to the current single-pet resolution
(`selectedPet` → last-picked id → the only pet, if just one exists).

Last-used multi-selection is stored in `context.globalState` under a new key
(e.g. `codexPet.lastPetIds`), mirroring the existing `LAST_PET_KEY` pattern,
rather than overloading `LAST_PET_KEY` with a differently-shaped value.

## XP integration decision

The XP/leveling system ([xp-leveling-system.md](xp-leveling-system.md)) was
built around a single `currentPetId` — `XpManager.award`/`awardClick`/
`awardCommit`/`start`'s active-minute interval in
[src/extension.ts](../../src/extension.ts) all key off that one field, and
`postXpUpdate` sends a single flat `'xp-update'` message. None of that holds
once N pets can be shown at once, so multi-pet work needs to fold in XP
changes rather than bolt them on after:

- **`currentPetId` → `currentPetIds: string[]`**, set from `resolvePets`'
  result via a renamed `setCurrentPets`. `postXpUpdate` becomes a batch
  message (`{ type: 'xp-update', pets: [{ petId, xp, level, progress,
  leveledUp }, ...] }`) instead of one flat payload, and the webview renders
  one level badge per instance instead of a single one.
- **Click XP is now directly attributable**: once Phase 4's per-instance hit
  testing lands, the `pet-click` message carries the clicked instance's
  `petId`, so `awardClick` awards that specific pet — no ambiguity, no
  change to the flat per-click amount.
- **Commit XP stays flat per pet, awarded to every currently-shown pet**
  (`XP_PER_COMMIT` each) — a commit is a fixed, shared win regardless of how
  many pets are out.
- **Active-minute XP becomes a shared pool that scales with pet count**,
  rather than N independent full-rate awards (which would let anyone
  max out totally leveling by just displaying more pets) or an even split
  (which would make total XP independent of N and remove any upside to
  having more than one pet out). Sublinear growth balances both concerns:
  `pool = XP_PER_ACTIVE_MINUTE * (1 + 0.5 * (petCount - 1))` — 1 pet = 2
  XP/min (unchanged), 2 pets = 3, 3 pets = 4, 4 pets = 5.
- **Pool is split across shown pets with catch-up weighting**, not evenly:
  weight each pet by its level-gap to the highest-level pet in the
  currently-shown group, clamped to a 10-level window, so a fresh pet
  alongside a maxed one gets a real boost without needing an unbounded
  inverse-level formula that degenerates at large level gaps.
- **Pet slots are gated behind level, and enforced, not just suggested.**
  Gate on the level of the single highest-level pet you own (not a sum
  across pets, which would reward spreading XP thin instead of the
  catch-up mechanic's intent): level 5 unlocks a 2nd slot, level 15 a 3rd,
  level 30 a 4th — thresholds echo the existing `50 * n^1.5` XP curve so
  later slots feel earned rather than just further apart. `resolvePets`
  truncates `selectedPets` to the unlocked count server-side (a user
  hand-editing `settings.json` past their unlocked count is truncated, not
  honored — this is a real gate, not a UI nicety). The `choosePets`
  QuickPick shows locked slots as disabled entries ("🔒 unlocks at level
  5") rather than hiding them, so the goal is visible before it's reachable.

See [gamification-polish.md](gamification-polish.md) for the streak
multipliers, off-hours bonuses, and prestige cosmetic that build on top of
this pool once it exists — those are additive polish and don't block
multi-pet rendering from working, so they're tracked separately.

## Checklist

### Phase 1 — extension host (src/extension.ts)
- [x] Add `codexPet.selectedPets` setting (package.json) and a new
      `codexPet.lastPetIds` globalState key.
- [x] Change `resolvePet`/`pickPet` into `resolvePets`/`pickPets` returning
      `Pet[]`, applying the `selectedPets` → `lastPetIds` → single-pet
      fallback precedence described above.
- [x] Add `codexPet.choosePets` command using
      `createQuickPick` with `canSelectMany`; kept `codexPet.choosePet` as an
      alias delegating to `choosePets` (a single-select affordance turned out
      unnecessary — picking one item is just checking one box).
- [x] Update `CodexPetViewProvider.showPet` → `showPets(pets: Pet[])`;
      `currentPetId` → `currentPetIds: string[]`.
- [x] Update `localResourceRoots` to include every selected pet's folder,
      not just one.
- [x] Update the `codexPet.selectedPet`/`selectedPets` config-change listener
      to re-resolve and reload when either setting changes.

### Phase 2 — webview bootstrap (getWebviewHtml in extension.ts)
- [x] Replace the single `spriteUri`/`configUri` injection with
      `window.CODEX_PET.pets = [{ id, spriteUri, configUri }, ...]`.
- [x] Confirm CSP (`img-src`/`connect-src`) still covers all pet folders
      under the multi-root `localResourceRoots`.

### Phase 3 — media/main.js instance refactor
- [x] Extract current module-level pet state into a `createPetInstance(petDef)`
      factory (state fields listed in Background).
- [x] Load each instance's `config.json` + spritesheet independently
      (parallel `Promise.all`); spread initial `x` positions across the
      canvas width instead of all starting at `x = 40`.
- [x] Rewrite `tick()` to loop over the instance array for update + draw;
      draw order = array order (later = on top).
- [x] Keep `timing`, `userScale`, `idleStateWeights`, `aiBusy` as shared
      globals broadcast to every instance; keep `jumpCooldown` and all other
      per-pet state on the instance.

### Phase 4 — interaction (click/mousemove/cursor-chase)
- [x] Update click/mousemove hit-testing to iterate instances top-to-bottom
      (reverse draw order) and act on the first `petBox` match only.
- [x] Implement chase-with-separation: each instance targets
      `cursorX + (i - (n-1)/2) * spacing` (see Background for `spacing`
      derivation) instead of `cursorX` directly.
- [x] Verify jump-over-cursor still triggers per-instance off each pet's own
      offset target and cooldown, not a shared one.

### Phase 5 — XP integration (see decision above)
- [x] Rename `currentPetId` → `currentPetIds: string[]` on `XpManager`;
      `setCurrentPet` → `setCurrentPets(petIds: string[])`.
- [x] Change `postXpUpdate` to send a batch `'xp-update'` message
      (`pets: [{ petId, xp, level, progress, leveledUp }, ...]`); update
      `media/main.js` to render one level badge per pet instance.
- [x] Add `petId` to the `pet-click` webview message (from Phase 4's
      per-instance hit testing) and have `awardClick` use it instead of a
      single implicit current pet.
- [x] Change `awardCommit` to award `XP_PER_COMMIT` to every pet in
      `currentPetIds`.
- [x] Replace the flat `XP_PER_ACTIVE_MINUTE` award in `start()`'s interval
      with the sublinear pool formula, split across `currentPetIds` via
      level-gap catch-up weighting (clamped to a 10-level window).
- [x] Add slot-unlock thresholds (level 5 / 15 / 30 → 2/3/4 slots) and
      enforce them by truncating `selectedPets` in `resolvePets`.
- [x] Show locked slots as disabled "🔒 unlocks at level N" entries in the
      `choosePets` QuickPick.

### Phase 6 — docs
- [x] Update [README.md](../../README.md) settings table with
      `codexPet.selectedPets` and the `choosePets` command, and document the
      slot-unlock thresholds and shared active-minute pool.
