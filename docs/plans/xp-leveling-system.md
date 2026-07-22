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
- [ ] Add `getXpFilePath(context)` (mirrors `getUserPetsDir`) under
      `globalStorageUri`.
- [ ] Add `readXpState(petId)` / `writeXpState(petId, xp)` helpers.
- [ ] Add `xpForLevel(n)` / `levelForXp(xp)` pure functions.
- [ ] Hook XP accrual into `startAiActivityWatcher()`'s busy-tracking loop —
      award XP per minute of `aiBusy === true`, gated behind a new
      `codexPet.xpEnabled` setting.
- [ ] Add `onDidChangeTextDocument` and `onDidStartTerminalShellExecution`
      (fallback: `onDidOpenTerminal`/`onDidCloseTerminal`) listeners that
      feed the same "active minute" bucket as AI-busy, rather than awarding
      XP per event.
- [ ] Add a `.git/logs/HEAD` watcher (or `vscode.git` repository API) that
      awards a flat one-off XP bonus per commit, per workspace repo.
- [ ] Add a message handler / command path for click-driven XP (small flat
      award per click, rate-limited so spam-clicking doesn't dominate).

### Phase 2 — config
- [ ] `codexPet.xpEnabled` (boolean, default true).
- [ ] Decide whether XP rate constants need to be user-configurable or just
      hardcoded initially (lean hardcoded for v1, revisit if requested).

### Phase 3 — UI feedback (media/main.js + main.css)
- [ ] Render current level (small badge/number) on canvas or in the webview
      title area.
- [ ] On level-up, trigger a celebratory reaction — reuse the existing jump
      arc (`activateJump`) or heart-particle system
      (`spawnHeart`/`updateHearts`) rather than building a new effect.
- [ ] Wire the `'ai-state'` message-listener plumbing (already present but
      currently dead code per `aiBusy` variable) to also carry
      XP/level updates from extension → webview.

### Phase 4 — docs
- [ ] Update [README.md](../../README.md) "Current behavior" and Settings
      table with the new XP/leveling behavior and `codexPet.xpEnabled`.
- [ ] Remove "leveling system" from the README's "Not implemented" list once
      shipped.
