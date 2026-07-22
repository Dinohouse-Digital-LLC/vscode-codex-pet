# Session attention tracking

Track multiple concurrent AI chat sessions (starting with Claude Code) instead
of a single global busy/idle flag, and let the pet surface which session(s)
are waiting on the user — i.e. the AI has finished responding and needs a
prompt or action — not just whether *something* is currently busy.

## Background

Today `~/.codex-pet/` holds one status file per **source**
(`claude-code.json`, `copilot.json`), written by `writeAiStatus` in
[src/extension.ts](../../src/extension.ts) and read back by
`readAiSourceStatus`/`computeAiState`. The Claude Code hook script
(`HOOK_SCRIPT_CONTENTS`) maps `PreToolUse`/`UserPromptSubmit` → `busy` and
`Stop`/`SessionEnd` → `idle`. Two problems fall out of this model:

1. **One file per source, not per session.** Two concurrent Claude Code
   sessions (two terminals, two repos) stomp on the same `claude-code.json`.
   There's no way to know *which* session is busy or waiting, only that
   *some* Claude Code process last reported one of those states.
2. **No "waiting" state.** `Stop` fires exactly when Claude finishes
   responding and is idle-but-waiting-for-you — that's the "needs attention"
   moment — but it's currently folded into the same `idle` bucket as
   `SessionEnd` (session gone entirely). The pet has no way to distinguish
   "nothing running" from "something's waiting on you."

Rejected: keeping the source-level file and adding a `sessionCount` field.
That still can't say *which* session needs attention, only how many might.
The pet needs at least a label (cwd/workspace folder) per waiting session to
be useful, which means per-session files.

Rejected: trying to give every session a friendly name. Claude Code's hook
payload gives us `session_id` (opaque) and `cwd`, nothing a human named. We
use the basename of `cwd` as the label and accept that two sessions in the
same repo will show the same label — calling this out rather than building
naming machinery for it.

## Data model decision

Replace the flat `~/.codex-pet/<source>.json` files with per-session files
under `~/.codex-pet/sessions/<source>-<session_id>.json`, each shaped as:

```json
{ "state": "busy" | "waiting", "updatedAt": <ms epoch>, "label": "tool name or null", "cwd": "/path/to/repo" }
```

Sources without a native session concept (the Copilot heuristic, which has
no `session_id`) get a synthetic session id equal to the source name
(`copilot-copilot.json`), so `computeAiState` only ever deals with one shape.

State transitions for Claude Code hooks:
- `PreToolUse` → `busy` (label = tool name, as today).
- `UserPromptSubmit` → `busy` (label = "Thinking", as today).
- `Stop` → **`waiting`** (new — this is the "needs attention" signal).
- `SessionEnd` → **delete the session's file** rather than writing `idle`.
  A finished session shouldn't linger and be recomputed every broadcast;
  deleting is the unambiguous "this session no longer exists."

Rejected: keeping `idle` as a third state alongside `waiting`. Nothing ever
needs to read "idle" once `SessionEnd` deletes the file — a session is either
busy, waiting, or its file doesn't exist. Keeping `idle` around would just be
dead code paths.

Staleness needs two different timeouts, because "busy" and "waiting" decay at
different rates:
- `busy` keeps today's `AI_STATUS_STALE_MS` (30s) — a crashed session
  mid-tool-call should stop animating quickly.
- `waiting` needs a much longer timeout (proposed default: 4 hours, via a new
  `codexPet.waitingStaleMinutes` setting) since a session can legitimately sit
  waiting for a human for a long time. This only exists to eventually
  self-clean sessions that crashed *after* `Stop` but never got a
  `SessionEnd` (e.g. terminal closed).

Aggregation in `computeAiState`: busy state (for the existing animation +
speech bubble) is unchanged in spirit — first non-stale `busy` session wins,
same priority order as today. Separately, compute the full list of non-stale
`waiting` sessions (`{ id, label }[]`, label = `path.basename(cwd)`) and
broadcast that alongside busy state so the webview can render a count/list
independent of the busy animation.

## Checklist

### Phase 1 — hook script + status file format
- [x] Update `HOOK_SCRIPT_CONTENTS` to parse `session_id` and `cwd` out of the
      stdin JSON (same `sed`-based extraction already used for `tool_name`)
      and pass them through to the written file.
- [x] Change `report-status.sh` to write to
      `~/.codex-pet/sessions/<source>-<session_id>.json` instead of
      `~/.codex-pet/<source>.json`; add a `delete` mode for `SessionEnd`
      (implemented as an `end` state rather than a separate flag, since the
      shell script already branches on `$state`).
- [x] Update `CLAUDE_HOOK_COMMANDS` so `Stop` reports `waiting` instead of
      `idle`, and `SessionEnd` triggers file deletion instead of an `idle`
      write.
- [x] `missingClaudeHookCount`/`installClaudeCodeHooks` needed no logic
      changes — they already compare exact command strings, so the new
      `waiting`/`end` commands are just treated as "missing" for anyone with
      hooks installed from before this change (documented in the README as a
      manual re-run + cleanup step, since there's no reliable way to
      distinguish "old-style hook to remove" from "unrelated custom hook" by
      command string alone).

### Phase 2 — extension host aggregation (src/extension.ts)
- [x] Replaced `writeAiStatus`/`readAiSourceStatus` with `writeSessionStatus`/
      `clearSessionStatus`/`readSessionStatusFiles`, which read every file
      under `~/.codex-pet/sessions/` and rely on a `source` field written
      into the JSON itself (not filename parsing — avoids ambiguity since
      `claude-code` itself contains a hyphen).
- [x] Added `codexPet.waitingStaleMinutes` setting (default 4h); kept
      `AI_STATUS_STALE_MS` (30s) for `busy` only.
- [x] Rewrote `computeAiState` to return
      `{ busy: boolean, label?: string, waiting: { id: string, label: string }[] }`.
- [x] Updated `startAiActivityWatcher`'s change-detection key and
      `provider.postAiState` call to include the waiting list, and to
      re-broadcast when the *set* of waiting sessions changes (not just
      busy/label).
- [x] Updated `startCopilotActivityHeuristic` to write/clear its synthetic
      `copilot-copilot.json` session file instead of the old flat file (no
      `waiting` state for Copilot — it only ever reports `busy`, since there's
      no hook to detect "finished and waiting").

### Phase 3 — webview (media/main.js + getWebviewHtml)
- [x] Extended the `ai-state` message handler to store the `waiting` list
      alongside `aiBusy`/`aiLabel`.
- [x] Added a small red count badge on the pet (top-left of the sprite, mirroring
      the level badge's top-right position) when `waiting.length > 0`.
- [x] Hovering the badge shows a tooltip bubble listing the waiting sessions'
      labels (comma-separated) above it, reusing the existing speech-bubble
      styling. No change needed to `getWebviewHtml` — the message channel
      already carried everything needed.

### Phase 4 — docs
- [x] Updated [README.md](../../README.md): waiting-badge behavior, the new
      per-session status file shape/location, `codexPet.waitingStaleMinutes` in
      the settings table, the Copilot section's file path, and a note for
      existing users to re-run **Install Claude Code Hooks...** and manually
      remove stale `idle`-reporting hook entries.
