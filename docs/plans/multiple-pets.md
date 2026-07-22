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

## Checklist

### Phase 1 — extension host (src/extension.ts)
- [ ] Add `codexPet.selectedPets` setting (package.json) and a new
      `codexPet.lastPetIds` globalState key.
- [ ] Change `resolvePet`/`pickPet` into `resolvePets`/`pickPets` returning
      `Pet[]`, applying the `selectedPets` → `lastPetIds` → single-pet
      fallback precedence described above.
- [ ] Add `codexPet.choosePets` command using
      `showQuickPick(..., { canPickMany: true })`; keep `codexPet.choosePet`
      working for the single-pet case (or fold it into `choosePets` if a
      single-select affordance turns out unnecessary — decide once the
      multi-select QuickPick is in place).
- [ ] Update `CodexPetViewProvider.showPet` → `showPets(pets: Pet[])`;
      `currentPetId` → `currentPetIds: string[]`.
- [ ] Update `localResourceRoots` to include every selected pet's folder,
      not just one.
- [ ] Update the `codexPet.selectedPet`/`selectedPets` config-change listener
      to re-resolve and reload when either setting changes.

### Phase 2 — webview bootstrap (getWebviewHtml in extension.ts)
- [ ] Replace the single `spriteUri`/`configUri` injection with
      `window.CODEX_PET.pets = [{ id, spriteUri, configUri }, ...]`.
- [ ] Confirm CSP (`img-src`/`connect-src`) still covers all pet folders
      under the multi-root `localResourceRoots`.

### Phase 3 — media/main.js instance refactor
- [ ] Extract current module-level pet state into a `createPetInstance(petDef)`
      factory (state fields listed in Background).
- [ ] Load each instance's `config.json` + spritesheet independently
      (parallel `Promise.all`); spread initial `x` positions across the
      canvas width instead of all starting at `x = 40`.
- [ ] Rewrite `tick()` to loop over the instance array for update + draw;
      draw order = array order (later = on top).
- [ ] Keep `timing`, `userScale`, `idleStateWeights`, `aiBusy` as shared
      globals broadcast to every instance; keep `jumpCooldown` and all other
      per-pet state on the instance.

### Phase 4 — interaction (click/mousemove/cursor-chase)
- [ ] Update click/mousemove hit-testing to iterate instances top-to-bottom
      (reverse draw order) and act on the first `petBox` match only.
- [ ] Implement chase-with-separation: each instance targets
      `cursorX + (i - (n-1)/2) * spacing` (see Background for `spacing`
      derivation) instead of `cursorX` directly.
- [ ] Verify jump-over-cursor still triggers per-instance off each pet's own
      offset target and cooldown, not a shared one.

### Phase 5 — docs
- [ ] Update [README.md](../../README.md) settings table with
      `codexPet.selectedPets` and the `choosePets` command.
