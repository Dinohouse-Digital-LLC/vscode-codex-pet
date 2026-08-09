import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { XpManager } from './xp';

// AI activity tracking: external tools (Claude Code hooks, etc.) report
// per-session busy/waiting state by writing "<source>-<sessionId>.json" files
// into AI_STATUS_SESSIONS_DIR. We watch that directory and aggregate across
// all sessions: the pet is "busy" whenever any session recently reported
// busy, and separately tracks which sessions are "waiting" (done responding,
// needs a prompt) so the UI can call those out individually.
const AI_STATUS_DIR = path.join(os.homedir(), '.codex-pet');
const AI_STATUS_SESSIONS_DIR = path.join(AI_STATUS_DIR, 'sessions');
const AI_STATUS_STALE_MS = 30000;

interface SessionStatusFile {
  source?: string;
  state?: string;
  updatedAt?: number;
  label?: string | null;
  cwd?: string | null;
  title?: string | null;
}

function writeSessionStatus(
  source: string,
  sessionId: string,
  state: 'busy' | 'waiting',
  label?: string,
  cwd?: string,
): void {
  try {
    fs.mkdirSync(AI_STATUS_SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(AI_STATUS_SESSIONS_DIR, `${source}-${sessionId}.json`),
      JSON.stringify({ source, state, updatedAt: Date.now(), label: label ?? null, cwd: cwd ?? null }),
    );
  } catch {
    // Best-effort: if this fails, AI-activity reactions just won't be available.
  }
}

function clearSessionStatus(source: string, sessionId: string): void {
  try {
    fs.unlinkSync(path.join(AI_STATUS_SESSIONS_DIR, `${source}-${sessionId}.json`));
  } catch {
    // Best-effort: file may already be gone.
  }
}

const HOOK_SCRIPT_PATH = path.join(AI_STATUS_DIR, 'report-status.sh');
const HOOK_SCRIPT_CONTENTS = `#!/usr/bin/env bash
# Installed by the Codex Pet VS Code extension. Reports AI tool activity so the
# pet can react. Usage: report-status.sh <source> <busy|waiting|end> [label]
# All JSON handling (parsing the hook payload piped on stdin, and reading/
# writing the session status file) is done by node rather than sed/grep:
# prompt text routinely contains quotes, backslashes, and other characters
# that break naive regex extraction and can silently corrupt the JSON we
# write back out. node ships alongside Claude Code, so it's always available.
dir="$(cd "$(dirname "$0")" && pwd)"
sessions_dir="$dir/sessions"
mkdir -p "$sessions_dir"

source="$1"
state="$2"
label="$3"

input=""
if [ ! -t 0 ]; then
  input="$(cat 2>/dev/null)"
fi

printf '%s' "$input" | node -e '
const fs = require("fs");
const [sessionsDir, source, state, explicitLabel] = process.argv.slice(1);

let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  let payload = {};
  try { payload = JSON.parse(data); } catch (e) {}

  const sessionId = payload.session_id || source;
  const file = sessionsDir + "/" + source + "-" + sessionId + ".json";

  if (state === "end") {
    try { fs.unlinkSync(file); } catch (e) {}
    return;
  }

  let label = explicitLabel || null;
  if (!label && state === "busy") label = payload.tool_name || null;

  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}

  // Keep the first prompt of a session as its one-time "title" (not
  // overwritten by later prompts), so the waiting badge has something more
  // identifying to show than the project folder name.
  let title = existing.title || null;
  if (!title && payload.prompt) {
    title = String(payload.prompt).trim().replace(/\\s+/g, " ");
    if (title.length > 20) title = title.slice(0, 17) + "...";
  }

  fs.writeFileSync(file, JSON.stringify({
    source: source,
    state: state,
    updatedAt: Date.now(),
    label: label,
    cwd: payload.cwd || null,
    title: title,
  }));
});
' "$sessions_dir" "$source" "$state" "$label"
`;

export function ensureHookScript(): void {
  try {
    fs.mkdirSync(AI_STATUS_DIR, { recursive: true });
    fs.writeFileSync(HOOK_SCRIPT_PATH, HOOK_SCRIPT_CONTENTS, { mode: 0o755 });
  } catch {
    // Best-effort: if this fails, AI-activity reactions just won't be available.
  }
}

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string }[];
}

const CLAUDE_HOOK_COMMANDS: { event: string; command: string }[] = [
  { event: 'PreToolUse', command: '~/.codex-pet/report-status.sh claude-code busy' },
  { event: 'UserPromptSubmit', command: '~/.codex-pet/report-status.sh claude-code busy Thinking' },
  // Notification fires for permission prompts and idle-waiting-for-input, not
  // just Stop — without it, a session blocked on a permission dialog never
  // reports "waiting" since it never reaches Stop.
  { event: 'Notification', command: '~/.codex-pet/report-status.sh claude-code waiting' },
  { event: 'Stop', command: '~/.codex-pet/report-status.sh claude-code waiting' },
  { event: 'SessionEnd', command: '~/.codex-pet/report-status.sh claude-code end' },
];

function hookArrayHasCommand(entries: HookEntry[] | undefined, command: string): boolean {
  return (entries ?? []).some((entry) => entry.hooks?.some((h) => h.command === command));
}

function readClaudeSettings(): { hooks?: Record<string, HookEntry[]>; [key: string]: unknown } {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

function missingClaudeHookCount(): number {
  const hooks = readClaudeSettings().hooks ?? {};
  return CLAUDE_HOOK_COMMANDS.filter(({ event, command }) => !hookArrayHasCommand(hooks[event], command))
    .length;
}

const CLAUDE_HOOKS_PROMPT_DISMISSED_KEY = 'codexPet.claudeHooksPromptDismissed';

export async function maybePromptToInstallClaudeCodeHooks(context: vscode.ExtensionContext): Promise<void> {
  if (!getAiActivitySources().includes('claude-code')) return;
  if (context.globalState.get<boolean>(CLAUDE_HOOKS_PROMPT_DISMISSED_KEY)) return;
  if (missingClaudeHookCount() === 0) return;

  const choice = await vscode.window.showInformationMessage(
    'Codex Pet can react to Claude Code activity (busy animation + speech bubble) once a few hooks are added to Claude Code\'s settings.',
    'Install Hooks',
    "Don't ask again",
  );
  if (choice === 'Install Hooks') {
    await installClaudeCodeHooks();
    await context.globalState.update(CLAUDE_HOOKS_PROMPT_DISMISSED_KEY, true);
  } else if (choice === "Don't ask again") {
    await context.globalState.update(CLAUDE_HOOKS_PROMPT_DISMISSED_KEY, true);
  }
}

export async function installClaudeCodeHooks(): Promise<void> {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

  let settings: { hooks?: Record<string, HookEntry[]>; [key: string]: unknown } = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      vscode.window.showErrorMessage(
        `Codex Pet: could not read ${settingsPath} (${(err as Error).message}). Fix or remove it, then retry.`,
      );
      return;
    }
  }

  const hooks = settings.hooks ?? {};
  const toAdd = CLAUDE_HOOK_COMMANDS.filter(
    ({ event, command }) => !hookArrayHasCommand(hooks[event], command),
  );

  if (toAdd.length === 0) {
    vscode.window.showInformationMessage('Codex Pet: Claude Code hooks are already installed.');
    return;
  }

  const preview = toAdd.map(({ event, command }) => `${event}: ${command}`).join('\n');
  const choice = await vscode.window.showWarningMessage(
    `Codex Pet will add ${toAdd.length} hook(s) to ${settingsPath} so Claude Code can report activity to the pet:\n\n${preview}`,
    { modal: true },
    'Add Hooks',
  );
  if (choice !== 'Add Hooks') return;

  for (const { event, command } of toAdd) {
    hooks[event] = hooks[event] ?? [];
    hooks[event].push({ hooks: [{ type: 'command', command }] });
  }
  settings.hooks = hooks;

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    ensureHookScript();
    vscode.window.showInformationMessage(
      'Codex Pet: Claude Code hooks installed. New Claude Code sessions will report activity to the pet.',
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Codex Pet: failed to write ${settingsPath}: ${(err as Error).message}`);
  }
}

const SOURCE_DEFAULT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  copilot: 'Copilot',
};

export interface WaitingSession {
  id: string;
  label: string;
}

export interface AiState {
  busy: boolean;
  label?: string;
  // Project root of the session that made us busy, if it reported one - fed
  // into XpManager.markActive for the cross-project bonus. Not part of
  // AiStateSink; UI consumers don't need it.
  cwd?: string;
  waiting: WaitingSession[];
}

// Structural sink so this module doesn't need to import the concrete webview
// provider class (which would create a circular import, since the provider
// itself holds an XpManager reference that flows back through here).
export interface AiStateSink {
  postAiState(busy: boolean, label?: string, waiting?: WaitingSession[]): void;
}

function getWaitingStaleMs(): number {
  const minutes = vscode.workspace
    .getConfiguration('codexPet')
    .get<number>('waitingStaleMinutes', 15);
  return minutes * 60 * 1000;
}

function readSessionStatusFiles(): { file: string; data: SessionStatusFile }[] {
  let names: string[];
  try {
    names = fs.readdirSync(AI_STATUS_SESSIONS_DIR);
  } catch {
    return [];
  }

  const results: { file: string; data: SessionStatusFile }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(AI_STATUS_SESSIONS_DIR, name), 'utf8');
      results.push({ file: name, data: JSON.parse(raw) as SessionStatusFile });
    } catch {
      continue;
    }
  }
  return results;
}

export function computeAiState(): AiState {
  const sources = new Set(getAiActivitySources());
  const now = Date.now();
  const waitingStaleMs = getWaitingStaleMs();

  let busyLabel: string | undefined;
  let busyCwd: string | undefined;
  const waiting: WaitingSession[] = [];

  for (const { file, data } of readSessionStatusFiles()) {
    if (!data.source || !sources.has(data.source)) continue;
    if (typeof data.updatedAt !== 'number') continue;
    const age = now - data.updatedAt;

    if (data.state === 'busy') {
      if (age > AI_STATUS_STALE_MS) continue;
      if (!busyLabel) {
        busyLabel = data.label || SOURCE_DEFAULT_LABELS[data.source] || data.source;
        busyCwd = data.cwd || undefined;
      }
    } else if (data.state === 'waiting') {
      if (age > waitingStaleMs) continue;
      const label =
        data.title || (data.cwd ? path.basename(data.cwd) : SOURCE_DEFAULT_LABELS[data.source] || data.source);
      waiting.push({ id: file, label });
    }
  }

  return { busy: Boolean(busyLabel), label: busyLabel, cwd: busyCwd, waiting };
}

function getAiActivitySources(): string[] {
  return vscode.workspace
    .getConfiguration('codexPet')
    .get<string[]>('aiActivitySources', ['claude-code', 'copilot']);
}

// GitHub Copilot Chat has no hooks/lifecycle API to report activity like Claude
// Code does (see https://github.com/microsoft/vscode/issues/310951 - not shipped
// yet), so we guess instead: a burst of large/multi-part text-document edits looks
// more like an agent streaming changes than a human typing key-by-key. This is a
// heuristic and will misfire on things like paste, snippets, or format-on-save.
const COPILOT_HEURISTIC_IDLE_MS = 2000;

function isCopilotActivityEnabled(): boolean {
  return getAiActivitySources().includes('copilot');
}

function looksLikeAgentEdit(event: vscode.TextDocumentChangeEvent): boolean {
  if (event.document.uri.scheme !== 'file') return false;
  if (event.contentChanges.length === 0) return false;
  if (event.contentChanges.length > 1) return true;

  const change = event.contentChanges[0];
  if (change.text.includes('\n') && change.text.length > 1) return true;
  if (change.text.length > 20) return true;
  if (change.text.length === 0 && change.rangeLength > 20) return true;
  return false;
}

export function startCopilotActivityHeuristic(): vscode.Disposable {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const markBusy = () => {
    writeSessionStatus('copilot', 'copilot', 'busy', SOURCE_DEFAULT_LABELS.copilot);
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => clearSessionStatus('copilot', 'copilot'), COPILOT_HEURISTIC_IDLE_MS);
  };

  const subscription = vscode.workspace.onDidChangeTextDocument((event) => {
    if (!isCopilotActivityEnabled()) return;
    if (looksLikeAgentEdit(event)) markBusy();
  });

  return new vscode.Disposable(() => {
    if (idleTimer) clearTimeout(idleTimer);
    subscription.dispose();
  });
}

export function startAiActivityWatcher(
  providers: AiStateSink[],
  xpManager: XpManager,
): vscode.Disposable {
  let lastKey: string | undefined;
  let watcher: fs.FSWatcher | undefined;
  let disposed = false;

  const broadcast = () => {
    const state = computeAiState();
    if (state.busy) xpManager.markActive('ai', state.cwd);
    const waitingKey = state.waiting
      .map((w) => `${w.id}:${w.label}`)
      .sort()
      .join(',');
    const key = `${state.busy}:${state.label ?? ''}:${waitingKey}`;
    if (key === lastKey) return;
    lastKey = key;
    for (const provider of providers) provider.postAiState(state.busy, state.label, state.waiting);
  };

  const setupWatcher = () => {
    watcher?.close();
    try {
      fs.mkdirSync(AI_STATUS_SESSIONS_DIR, { recursive: true });
      watcher = fs.watch(AI_STATUS_SESSIONS_DIR, { persistent: false }, () => broadcast());
    } catch {
      watcher = undefined;
    }
  };

  setupWatcher();
  broadcast();

  // Staleness fallback: catches the case where a hook never fires "idle"
  // (e.g. a crashed session) so the pet doesn't get stuck acting busy forever.
  const interval = setInterval(broadcast, 5000);

  return new vscode.Disposable(() => {
    if (disposed) return;
    disposed = true;
    clearInterval(interval);
    watcher?.close();
  });
}
