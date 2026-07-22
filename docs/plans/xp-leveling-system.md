# XP / leveling system

Give the pet persistent XP and levels so it's not just a passive animation —
progress should reflect real usage over time, survive extension updates, and
produce visible feedback (level-up moment, on-screen level indicator).

## Background

The pet already reacts to two kinds of signal: direct interaction (click →
`triggerReaction()` in [media/main.js](../../media/main.js)) and, via the
externally-added AI activity watcher (`computeAiBusy()` /
`startAiActivityWatcher()` in [src/extension.ts](../../src/extension.ts)),
whether a connected AI tool (currently Claude Code, via hooks writing to
`~/.codex-pet/<source>.json`) is actively working. Neither currently
accumulates anything — they're purely momentary (a reaction plays and ends;
`aiBusy` just flips a boolean the pet isn't even rendering yet).

Open design question resolved below: XP source. Rejected pure-click-based XP
(farmable by just clicking repeatedly, doesn't reflect actual coding
activity) in favor of primarily activity-driven XP, with clicks as a small
supplementary source — this keeps leveling tied to real work sessions while
still rewarding direct interaction. Falls back gracefully (clicks still work)
for users who haven't installed the Claude Code hooks.

"Activity-driven" is broader than just the AI-busy signal: editor edits
(`vscode.workspace.onDidChangeTextDocument`) and terminal use
(`vscode.window.onDidStartTerminalShellExecution`, or
`onDidOpenTerminal`/`onDidCloseTerminal` as a fallback on older VS Code) are
both real signals of active coding, so they're folded into the same "active
minute" concept as AI-busy rather than tracked as separate momentary events —
per-keystroke/per-command XP would be trivially gameable (mash keys, spam
`ls`) and noisy to listen for. Git commits are the exception: a commit is a
discrete, meaningful checkpoint rather than a continuous signal, so it gets a
flat one-off bonus award instead of feeding the active-minute bucket —
watched via the same `fs.watch` pattern already used for the AI-status files
(on `.git/logs/HEAD`), or `vscode.git`'s repository API if simpler.

## Data model decision

Store `{ xp, level, lastUpdated }` per pet id in a JSON file under
`context.globalStorageUri` (same pattern as the persistent user-pets folder —
survives extension updates, unlike anything under `context.extensionUri`).
Rejected storing this in a VS Code `Memento`/global state key: a plain JSON
file is easier to inspect/hand-edit and consistent with how pets themselves
are already stored.

Level is derived from XP at read time via `xpForLevel(n)`, not stored
independently as a source of truth — only `xp` is authoritative, `level` in
the file is a cached convenience value recomputed on load.

Leveling curve: `xpForLevel(n) = 50 * n^1.5` (tune constants once real XP
rates are in place).

## Checklist

### Phase 1 — data + accrual (extension.ts)
- [x] Add `getXpFilePath(context)` (mirrors `getUserPetsDir`) under
      `globalStorageUri`.
- [x] Add `readXpState(petId)` / `writeXpState(petId, xp)` helpers. (Shipped
      as `loadXpState`/`saveXpState` over a single `xp.json` keyed by pet id,
      rather than one file per pet — simpler I/O, same on-disk contract.)
- [x] Add `xpForLevel(n)` / `levelForXp(xp)` pure functions.
- [x] Hook XP accrual into `startAiActivityWatcher()`'s busy-tracking loop —
      award XP per minute of `aiBusy === true`, gated behind a new
      `codexPet.xpEnabled` setting.
- [x] Add `onDidChangeTextDocument` and `onDidStartTerminalShellExecution`
      (fallback: `onDidOpenTerminal`/`onDidCloseTerminal`) listeners that
      feed the same "active minute" bucket as AI-busy, rather than awarding
      XP per event.
- [x] Add a `.git/logs/HEAD` watcher (or `vscode.git` repository API) that
      awards a flat one-off XP bonus per commit, per workspace repo.
- [x] Add a message handler / command path for click-driven XP (small flat
      award per click, rate-limited so spam-clicking doesn't dominate).

### Phase 2 — config
- [x] `codexPet.xpEnabled` (boolean, default true).
- [x] Decide whether XP rate constants need to be user-configurable or just
      hardcoded initially (lean hardcoded for v1, revisit if requested).
      Shipped hardcoded: 2 XP/active-minute, 15 XP/commit, 1 XP/click
      (4s rate limit).

### Phase 3 — UI feedback (media/main.js + main.css)
- [x] Render current level (small badge/number) on canvas or in the webview
      title area.
- [x] On level-up, trigger a celebratory reaction — reuse the existing jump
      arc (`activateJump`) or heart-particle system
      (`spawnHeart`/`updateHearts`) rather than building a new effect.
- [x] Wire the `'ai-state'` message-listener plumbing (already present but
      currently dead code per `aiBusy` variable) to also carry
      XP/level updates from extension → webview. (Shipped as its own
      `'xp-update'` message rather than piggybacking on `'ai-state'`, since
      XP updates aren't tied to AI busy/idle transitions.)

### Phase 4 — docs
- [x] Update [README.md](../../README.md) "Current behavior" and Settings
      table with the new XP/leveling behavior and `codexPet.xpEnabled`.
- [x] Remove "leveling system" from the README's "Not implemented" list once
      shipped. (Wasn't actually listed there, so nothing to remove.)

## Extension: per-pet leveling + optional size growth

Per-pet leveling was already a free consequence of the Phase 1 data model
(`XpRecord` keyed by pet id, `XpManager.setCurrentPet` swapping which record
broadcasts to the webview) — switching pets via `codexPet.selectedPet` or
"Choose Pet..." already tracks and shows separate XP/level per pet, no
additional work needed.

Size growth is new: pet sprite size optionally scales with level, from a
smaller starting size up to 1.5x the configured `codexPet.petScale`. Off by
default (`codexPet.petGrowthEnabled`) since it changes a visual default some
users won't want. Growth is linear between level 1 (`petGrowthMinScale`,
default 0.7x) and `petGrowthMaxLevel` (`petGrowthMaxScale`, default 1.5x,
default level 20), then caps — computed client-side in `media/main.js`'s
`getScale()` since it already combines `config.scale * userScale` and now
has `petLevel` from the `'xp-update'` message.

### Phase 5 — size growth (extension.ts + media/main.js)
- [x] Add `codexPet.petGrowthEnabled` / `petGrowthMinScale` /
      `petGrowthMaxScale` / `petGrowthMaxLevel` settings.
- [x] Pass growth config to the webview (initial HTML + a config-change
      message, mirroring `petScale`'s `update-scale` plumbing).
- [x] Compute the growth multiplier in `getScale()` from `petLevel` and fold
      it into the existing `config.scale * userScale` calculation.
- [x] Update README Settings table with the four new settings.
