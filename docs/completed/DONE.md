# Completed work

## Archived 2026-07-22

### XP / leveling system

Gave the pet persistent XP and levels, tied primarily to activity rather than
clicks. Plan doc: [docs/plans/xp-leveling-system.md](../plans/xp-leveling-system.md)
(kept in place with its checklist fully checked).

- XP accrues from "active minutes" (AI-busy via the Claude Code hooks,
  editor edits, terminal use) rather than per-event, so it can't be gamed by
  spamming keystrokes or commands; git commits get a flat one-off bonus via a
  `.git/logs/HEAD` watcher since a commit is a discrete checkpoint, not a
  continuous signal. Clicks award a small flat XP amount with a 4s rate limit
  as a fallback for users without the Claude Code hooks installed.
  Hardcoded v1 rates: 2 XP/active-minute, 15 XP/commit, 1 XP/click.
- Data model: `{ xp, level, lastUpdated }` per pet id in a JSON file under
  `context.globalStorageUri` (`loadXpState`/`saveXpState` over a single
  `xp.json` keyed by pet id, rather than one file per pet). Level is always
  derived from XP at read time via `xpForLevel(n) = 50 * n^1.5`, never stored
  as an independent source of truth.
  Gated behind `codexPet.xpEnabled` (default true).
- Per-pet leveling fell out of the data model for free — switching pets via
  `codexPet.selectedPet` already tracks/shows separate XP/level per pet.
- Added optional size growth: pet sprite scales linearly with level (from
  `petGrowthMinScale` at level 1 to `petGrowthMaxScale` at
  `petGrowthMaxLevel`, computed client-side in `getScale()`), off by default
  via `codexPet.petGrowthEnabled` since it changes a visual default.
- UI: a "Lvl N" pill badge with a progress bar underneath (replaced an
  earlier bare-number-in-a-circle design, then a ring-around-the-badge
  design that didn't wrap a rectangle well), plus a hover tooltip showing the
  exact percent to next level. Level-ups reuse the existing jump-arc/heart-
  particle reactions rather than a new effect. Progress fraction is computed
  extension-side via `xpProgress(xp, level)` and threaded through as its own
  `'xp-update'` message (not piggybacked on `'ai-state'`).

### Track which AI session(s) need attention

Replaced the single global busy/idle flag with per-session tracking so the
pet can show *which* concurrent AI session(s) are waiting on the user, not
just whether something is busy. Plan doc:
[docs/plans/session-attention-tracking.md](../plans/session-attention-tracking.md)
(kept in place with its checklist fully checked).

- Root problem: the old model wrote one status file per **source**
  (`claude-code.json`), so two concurrent Claude Code sessions stomped on
  the same file and there was no "waiting" state distinct from "idle" —
  `Stop` (finished responding, waiting on you) and `SessionEnd` (session
  gone) were both folded into `idle`.
- New model: per-session files under `~/.codex-pet/sessions/<source>-<session_id>.json`,
  each carrying `state` (`busy`/`waiting`), `updatedAt`, `label` (tool name,
  or `path.basename(cwd)` for the waiting list), and `cwd`. `Stop` now writes
  `waiting`; `SessionEnd` deletes the file outright instead of writing
  `idle`, so a session is only ever busy, waiting, or nonexistent. Sources
  without a native session concept (the Copilot heuristic) get a synthetic
  session id equal to the source name.
- Two staleness timeouts since busy and waiting decay at different rates:
  `busy` keeps the existing 30s `AI_STATUS_STALE_MS`; `waiting` uses a new
  `codexPet.waitingStaleMinutes` setting (default 4h) to eventually clean up
  sessions that crashed after `Stop` but never got a `SessionEnd` (e.g.
  terminal closed).
- `computeAiState` now returns
  `{ busy, label?, waiting: { id, label }[] }`; the webview shows a red count
  badge (top-left, mirroring the level badge's top-right position) when any
  sessions are waiting, with a hover tooltip listing their labels.
- Migration note: existing users need to re-run **Install Claude Code
  Hooks...** and manually remove stale old-style hook entries, since the
  hook-presence check compares exact command strings and can't reliably
  distinguish "old hook to remove" from an unrelated custom hook.

### Publish to the VS Code Marketplace

Shipped the first public release of Codex Pet. Plan doc:
[docs/plans/marketplace-publish.md](../plans/marketplace-publish.md)
(kept in place with its checklist fully checked — has the detailed
per-phase notes this entry summarizes).

- Stood up `vscode-codex-pet` as a standalone GitHub repo under the
  `TempusShift` account (`https://github.com/TempusShift/vscode-codex-pet`,
  private). The originally-planned `git filter-repo --subdirectory-filter`
  extraction from a `Firefox_Extensions` monorepo turned out to be
  unnecessary — this working copy had no prior git history, so it was a
  plain `git init` instead.
- Made `package.json` publishable: dropped `"private": true`, added a
  128×128 PNG Marketplace icon (`media/icons/marketplace-icon.png`, cropped
  from the cinder pet's idle sprite frame), pointed `repository.url` at the
  new GitHub repo, and bumped `version` to `0.1.0` for the first release.
- Created Marketplace publisher `dinohousedigitalllc` via the web management
  portal — not `andrewdeck` as the original plan assumed.
- `vsce login` was blocked by a persistent Azure AD tenant error ("Selected
  user account does not exist in tenant 'Microsoft Services'") that
  resisted account/tenant-switching fixes, so publishing went through the
  Marketplace's manual drag-and-drop `.vsix` upload flow instead of
  `vsce publish`. Revisit CLI publishing later if this becomes a recurring
  friction point.
- Local install/test of the packaged `.vsix` (via `code --install-extension`)
  surfaced and fixed two real bugs before anything went live:
  - **Pet view never appeared on a fresh install.** `activationEvents` was
    `[]`, and the panel/sidebar views are gated behind context keys
    (`codexPet.showInSidebar`/`showInPanel`) that are only set inside
    `activate()`. Nothing implicit triggered activation on startup, so the
    context stayed unset and the view never showed — it only ever worked
    during dev because manually running "Codex Pet: Reveal Pet View" from
    the Command Palette activated the extension as a side effect. Fixed by
    adding `"onStartupFinished"` to `activationEvents`.
  - **Stale local installs collided with the packaged one.** Leftover dev
    installs (`andrewdeck.vscode-codex-pet@0.0.1`,
    `undefined_publisher.vscode-codex-pet-0.0.1`) contributed the same view
    container IDs as the new package and shadowed it. Fixed by uninstalling
    the old copies.
- Also excluded internal planning docs (`docs/plans/`, `TODO.md`) from the
  packaged `.vsix` via `.vscodeignore` — they were being bundled into the
  public artifact.
- Follow-on (same session, small enough not to need its own plan doc):
  replaced the `reactToAiActivity`/`reactToCopilotActivity` booleans with a
  single `codexPet.aiActivitySources` array setting, and made the busy
  speech bubble show *what* Claude Code is doing (tool name via
  `PreToolUse`'s hook JSON payload, or "Thinking" during
  `UserPromptSubmit`) instead of a generic "...". Required rewriting
  `~/.codex-pet/report-status.sh`'s generation logic and updating the
  already-installed Claude Code hooks in `~/.claude/settings.json` to match.
