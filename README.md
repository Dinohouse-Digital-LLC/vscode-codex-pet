# Codex Pet

A minimal VS Code extension, in the spirit of [vscode-pets](https://github.com/tonybaloney/vscode-pets),
that plays a [Codex pet](https://codexpets.org/) sprite sheet in its own
Activity Bar side panel.

## Status

Loads any pet that follows the Codex v2 pet spec (`pet.json` + `spritesheet.webp`)
from the bundled `pets/<pet-id>/` folder, plus any pet dropped into the
user pets folder (see **Codex Pet: Open Pets Folder** below) — that folder
lives outside the extension install directory, so pets you add there survive
extension updates/reinstalls. Multiple pets can be present at once — pick
which one loads via command or setting (see below). A user pet with the same
id as a bundled one takes precedence. If no pet is found, or its spritesheet
fails to load, the pet renders as a placeholder blob so the
movement/animation logic is still visible.

## Run it

```bash
npm install
npm run compile
```

Then press F5 in VS Code (or "Run Extension" in the debug panel) to launch an
Extension Development Host. A paw icon appears in the Activity Bar (the far
left icon strip) — click it to reveal the pet view. **Codex Pet: Reveal Pet
View** from the Command Palette does the same thing.

## Commands

- **Codex Pet: Reveal Pet View** (`codexPet.start`) — opens/focuses the
  Activity Bar view. The pet shown is resolved from the `codexPet.selectedPet`
  setting, or the last one picked via "Choose Pet...", or the only pet if
  there's just one. If none of those resolve and multiple pets exist, prompts
  with a picker.
- **Codex Pet: Choose Pet...** (`codexPet.choosePet`) — always shows the
  picker and switches the view to the chosen pet immediately, remembering the
  choice for next time.
- **Codex Pet: Open Pets Folder** (`codexPet.openPetsFolder`) — reveals your
  persistent user pets folder in Finder/Explorer (creating it if needed), so
  you can drop in a new pet folder that survives extension updates.
- **Codex Pet: Install Claude Code Hooks...** (`codexPet.installClaudeCodeHooks`)
  — adds the hooks described below to `~/.claude/settings.json` (with a
  confirmation dialog first). Safe to re-run: it only adds hooks that aren't
  already there, and never touches unrelated hooks you've configured.

## Reacting to Claude Code activity

If `claude-code` is listed in `codexPet.aiActivitySources` (it is by
default), the pet plays a "busy" animation (the `review` sprite state) with a
small speech bubble while Claude Code is actively working, and returns to
normal idle/walk behavior once it's done. The bubble shows what it's doing
when available — the current tool name (e.g. "Bash", "Edit") during tool use,
or "Thinking" while a prompt is being processed.

Separately, whenever one or more Claude Code sessions have finished
responding and are waiting on you for a prompt or action, a small red count
badge appears on the pet; hovering it shows which session(s) (by workspace
folder name) are waiting.

This works by watching per-session status files under
`~/.codex-pet/sessions/` (one JSON file per session, e.g.
`claude-code-<session-id>.json`, containing `{ "source", "state": "busy" |
"waiting", "updatedAt": <ms>, "label": <string | null>, "cwd": <string |
null> }`). A `busy` status older than 30s is treated as stale and ignored, so
a crashed session can't leave the pet stuck animating. A `waiting` status can
sit for much longer before being dropped (default 4 hours, via
`codexPet.waitingStaleMs`) since a session can legitimately wait on a human
for a long time — this timeout only exists to eventually clean up sessions
that crashed after finishing a response but before ending.

Claude Code reports into these files via its
[hooks](https://docs.claude.com/en/docs/claude-code/hooks) mechanism. The
first time the extension activates with hooks missing, it offers to install
them for you; you can also trigger this anytime via **Codex Pet: Install
Claude Code Hooks...**, or do it by hand by adding to
`~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "~/.codex-pet/report-status.sh claude-code busy" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "~/.codex-pet/report-status.sh claude-code busy Thinking" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "~/.codex-pet/report-status.sh claude-code waiting" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "~/.codex-pet/report-status.sh claude-code end" }] }]
  }
}
```

`report-status.sh` itself is (re)written to `~/.codex-pet/` by the extension
on every activation, so it's always present once the extension has run once
— the hooks above just need to call it. Claude Code pipes the hook's JSON
payload (which includes `session_id`, `cwd`, and for `PreToolUse`,
`tool_name`) on stdin; the script picks those up automatically to key each
session's file and label the bubble, unless an explicit label is passed as a
third argument (as `UserPromptSubmit` does with `Thinking`). `end`
(`SessionEnd`) deletes that session's file instead of writing a state.

If you installed hooks before this per-session tracking landed, re-run
**Codex Pet: Install Claude Code Hooks...** — the old `Stop`/`SessionEnd`
commands (which reported `idle`) will be recognized as missing and the
current ones added alongside them; remove the stale `idle` lines from
`~/.claude/settings.json` by hand afterward.

## Reacting to GitHub Copilot activity (experimental)

GitHub Copilot Chat has no hooks/lifecycle mechanism like Claude Code's, and
VS Code doesn't yet expose a public API for observing Copilot Chat request
status ([microsoft/vscode#310951](https://github.com/microsoft/vscode/issues/310951)
is open but unshipped). So instead of a real signal, adding `copilot` to
`codexPet.aiActivitySources` (off by default) uses a heuristic: bursts of
large or multi-part text-document edits look more like an agent streaming
changes than someone typing key-by-key, so the extension treats those as
"busy" and reports it into `~/.codex-pet/sessions/copilot-copilot.json` (same
status-file protocol as Claude Code above, with a fixed "Copilot" label).
Copilot has no equivalent of Claude Code's `Stop` hook, so it never reports
`waiting` — only `busy`, cleared back to nothing once the edit burst quiets
down.

This is a guess, not a real signal — it can also fire on pastes, snippet
expansion, formatters, find/replace, or other bulk edits from any source, not
just Copilot. Enable it if you want a rough "something is editing a lot"
indicator; leave it off if false positives bother you.

## Adding a pet

Drop a folder under either the bundled `pets/<pet-id>/` (repo-only, ships with
the extension) or, for pets that should stick around across updates, the
folder opened by **Codex Pet: Open Pets Folder**. Each pet folder needs:

- `pet.json` — `{ "id", "displayName", "description", "spritesheetPath", "kind" }`
- the spritesheet file it points to (typically `spritesheet.webp`)

Then run **Codex Pet: Choose Pet...** to pick it up — no reload or code
changes needed, the folders are scanned fresh each time a pet is resolved.

## Settings

| Setting                       | Default | Description                                                                 |
|--------------------------------|---------|------------------------------------------------------------------------------|
| `codexPet.location`             | `panel` | Where the pet view shows: `panel` (bottom, next to Terminal), `sidebar` (Activity Bar, next to Explorer/Git), or `both` (each location runs its own independent pet). |
| `codexPet.selectedPet`          | `""`    | Pet id or folder name under `pets/` to always load. Empty = last picked pet. |
| `codexPet.walkSpeed`            | `40`    | Pixels/second while running.                                                  |
| `codexPet.moveChance`           | `0.5`   | Probability (0-1) of starting a move vs. a stationary animation each cycle.   |
| `codexPet.minActionDuration`    | `1500`  | Minimum ms spent in one action before picking a new one.                     |
| `codexPet.maxActionDuration`    | `3500`  | Maximum ms spent in one action before picking a new one.                     |
| `codexPet.idleAnimationSpeed`   | `1`     | Speed multiplier for stationary idle animations (idle, wave, jump, waiting, review, failed). Doesn't affect walk/run. |
| `codexPet.aiActivitySources`    | `["claude-code"]` | Which AI tools trigger the busy animation + speech bubble: `claude-code`, `copilot` (experimental heuristic), both, or empty to disable. See below. |
| `codexPet.waitingStaleMs`       | `14400000` (4h) | How long a Claude Code session can sit in the "waiting for you" state before its badge entry is dropped as stale (crash cleanup only — doesn't affect normal waiting). |
| `codexPet.xpEnabled`            | `true`  | Whether the pet earns XP/levels from coding activity (AI tool activity, editor edits, terminal use, git commits, clicks). Progress (and level) is tracked separately per pet. |
| `codexPet.petGrowthEnabled`     | `false` | Whether the pet's sprite size grows with its level, from `petGrowthMinScale` at level 1 up to `petGrowthMaxScale` at `petGrowthMaxLevel`. Both are multipliers of `codexPet.petScale`. Requires `xpEnabled`. |
| `codexPet.petGrowthMinScale`    | `0.7`   | Size multiplier at level 1, when growth is enabled. |
| `codexPet.petGrowthMaxScale`    | `1.5`   | Size multiplier at `petGrowthMaxLevel`, when growth is enabled. |
| `codexPet.petGrowthMaxLevel`    | `20`    | Level at which the pet reaches `petGrowthMaxScale`. Growth is linear from level 1, then caps. |

Timing settings (`walkSpeed`, `moveChance`, `min/maxActionDuration`) apply live
to an already-open view — no reload needed. Changing `selectedPet` swaps the
pet in the open view immediately too.

## Sprite sheet layout (Codex v2 pet spec)

Every Codex pet spritesheet is a fixed **1536×1872px, 8-column × 9-row** grid
of **192×208px** cells, magenta (`#ff00ff`) color-keyed background, one row
per animation state:

| Row | State        |
|-----|--------------|
| 0   | idle         |
| 1   | running right|
| 2   | running left |
| 3   | waving       |
| 4   | jumping      |
| 5   | failed       |
| 6   | waiting      |
| 7   | running      |
| 8   | review       |

(Grid size and row order per [codexpets.org](https://codexpets.org/install).)
The official Codex app owns frame timing/sequencing itself — pet packages only
ship the manifest and image. Since this extension is its own renderer, that
same grid geometry plus our own per-row frame counts/fps/loop live in
[`media/sprite-config.json`](media/sprite-config.json) (shared across all pets,
not per-pet). Per-row **frame counts** aren't part of the published spec, so
those were eyeballed from the bundled sample sheets under `pets/` (e.g.
`pets/hoggie/spritesheet.webp`) — double check them against a pet's
spritesheet if an animation looks like it's looping into a blank/magenta
frame.

## Current behavior

- Every `minActionDuration`-`maxActionDuration` ms, randomly either starts
  moving (using the `runRight`/`runLeft` row for the chosen direction) or
  plays a stationary animation picked from `idleStates` (`idle`, `wave`,
  `jump`, `waiting`, `review`, `failed`).
- While moving, walks across the bottom of the view and reverses direction
  at the edges.
- Clicking the pet interrupts whatever it's doing and plays a random
  animation from `reactionStates` (`wave`, `jump` by default, configurable in
  [`media/sprite-config.json`](media/sprite-config.json)) for a fixed ~1.2s,
  with a small heart particle popping up as feedback, then resumes normal
  idle/walk behavior.
- While the cursor is anywhere over the view, the pet runs toward it
  horizontally instead of wandering randomly, and settles into idle once it's
  underneath. If the cursor stops roughly above the pet, it jumps to try to
  reach it (on a ~1.2s cooldown so it doesn't jump nonstop). Moving the
  cursor off the view resumes normal random idle/walk behavior.
- The pet earns XP (and levels shown as a small badge on its sprite) from
  active coding: a minute containing AI-tool activity, an editor edit, or
  terminal use counts once toward XP, a git commit is a flat one-off bonus,
  and clicking the pet gives a small rate-limited bonus too. Leveling up
  plays a jump + heart celebration. Progress persists per pet across restarts
  and updates; disable with `codexPet.xpEnabled`. Optionally
  (`codexPet.petGrowthEnabled`, off by default), the pet's sprite size grows
  with its level too, from a smaller starting size up to 1.5x the configured
  scale.

## Installing as a real (non-dev-host) extension

```bash
npm run install-extension
```

This packages a `.vsix` (via `npx @vscode/vsce package`) and installs it with
`code --install-extension`. To cut a new version first, use
`npm run release [patch|minor|major|x.y.z]` (see [scripts/release.js](scripts/release.js)).

Or in VS Code: Extensions view → `...` menu → **Install from VSIX...**.

## Not implemented (see vscode-pets for reference if you want these later)

- Multiple simultaneous pets shown at once (one at a time for now)
- Persisting pet position/state across window reloads
- Sound effects, click-to-interact, throw-ball
- Reacting to Codex CLI activity (Claude Code is wired up via real hooks, and
  Copilot has an experimental heuristic — see the sections above).
  `waiting`/`failed` are still just triggered randomly for variety.
