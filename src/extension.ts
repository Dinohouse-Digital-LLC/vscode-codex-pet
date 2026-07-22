import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface PetManifest {
  id: string;
  displayName: string;
  description?: string;
  spritesheetPath: string;
  kind?: string;
}

interface Pet {
  folderName: string;
  manifest: PetManifest;
  folder: vscode.Uri;
}

const LAST_PET_KEY = 'codexPet.lastPetId';

interface TimingConfig {
  walkSpeed: number;
  moveChance: number;
  minActionDuration: number;
  maxActionDuration: number;
  jumpCooldown: number;
}

function getTimingConfig(): TimingConfig {
  const config = vscode.workspace.getConfiguration('codexPet');
  return {
    walkSpeed: config.get<number>('walkSpeed', 40),
    moveChance: config.get<number>('moveChance', 0.5),
    minActionDuration: config.get<number>('minActionDuration', 1500),
    maxActionDuration: config.get<number>('maxActionDuration', 3500),
    jumpCooldown: config.get<number>('jumpCooldown', 5000),
  };
}

const TIMING_SETTINGS = [
  'codexPet.walkSpeed',
  'codexPet.moveChance',
  'codexPet.minActionDuration',
  'codexPet.maxActionDuration',
  'codexPet.jumpCooldown',
];

function getPetScale(): number {
  return vscode.workspace.getConfiguration('codexPet').get<number>('petScale', 1);
}

function getIdleStateWeights(): Record<string, number> {
  return vscode.workspace
    .getConfiguration('codexPet')
    .get<Record<string, number>>('idleStateWeights', {});
}

function getUserPetsDir(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, 'pets');
}

async function readPetsFrom(petsDir: vscode.Uri): Promise<Pet[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(petsDir);
  } catch {
    return [];
  }

  const pets: Pet[] = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.Directory) continue;
    const folder = vscode.Uri.joinPath(petsDir, name);
    const manifestUri = vscode.Uri.joinPath(folder, 'pet.json');
    try {
      const bytes = await vscode.workspace.fs.readFile(manifestUri);
      const manifest = JSON.parse(Buffer.from(bytes).toString('utf8')) as PetManifest;
      pets.push({ folderName: name, manifest, folder });
    } catch {
      continue;
    }
  }
  return pets;
}

async function listPets(context: vscode.ExtensionContext): Promise<Pet[]> {
  const bundled = await readPetsFrom(vscode.Uri.joinPath(context.extensionUri, 'pets'));
  const user = await readPetsFrom(getUserPetsDir(context));

  // User-added pets take precedence over bundled ones with the same id.
  const byId = new Map<string, Pet>();
  for (const pet of bundled) byId.set(pet.manifest.id, pet);
  for (const pet of user) byId.set(pet.manifest.id, pet);
  return [...byId.values()];
}

function findPet(pets: Pet[], id: string): Pet | undefined {
  return pets.find((p) => p.manifest.id === id || p.folderName === id);
}

async function pickPet(context: vscode.ExtensionContext, pets: Pet[]): Promise<Pet | undefined> {
  const picked = await vscode.window.showQuickPick(
    pets.map((pet) => ({
      label: pet.manifest.displayName,
      description: pet.manifest.id,
      detail: pet.manifest.description,
      pet,
    })),
    { placeHolder: 'Choose a Codex pet' },
  );
  if (!picked) return undefined;
  await context.globalState.update(LAST_PET_KEY, picked.pet.manifest.id);
  return picked.pet;
}

async function resolvePet(
  context: vscode.ExtensionContext,
  forcePick: boolean,
): Promise<Pet | undefined> {
  const pets = await listPets(context);
  if (pets.length === 0) {
    vscode.window.showErrorMessage(
      'Codex Pet: no pet found. Add a pet.json + spritesheet.webp under pets/<pet-id>/ (use "Codex Pet: Open Pets Folder" for a location that survives updates).',
    );
    return undefined;
  }

  if (!forcePick) {
    const configured = vscode.workspace
      .getConfiguration('codexPet')
      .get<string>('selectedPet');
    if (configured) {
      const match = findPet(pets, configured);
      if (match) return match;
      vscode.window.showWarningMessage(
        `Codex Pet: configured pet "${configured}" was not found under pets/. Falling back.`,
      );
    }

    const lastId = context.globalState.get<string>(LAST_PET_KEY);
    if (lastId) {
      const match = findPet(pets, lastId);
      if (match) return match;
    }

    if (pets.length === 1) {
      return pets[0];
    }
  }

  return pickPet(context, pets);
}

// AI activity tracking: external tools (Claude Code hooks, etc.) report busy/idle
// state by writing "<source>.json" files into this directory. We watch it and
// treat the pet as "busy" whenever any source is busy and recently reported in.
const AI_STATUS_DIR = path.join(os.homedir(), '.codex-pet');
const AI_STATUS_SOURCES = ['claude-code', 'copilot'];
const AI_STATUS_STALE_MS = 30000;

function writeAiStatus(source: string, state: 'busy' | 'idle'): void {
  try {
    fs.mkdirSync(AI_STATUS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(AI_STATUS_DIR, `${source}.json`),
      JSON.stringify({ state, updatedAt: Date.now() }),
    );
  } catch {
    // Best-effort: if this fails, AI-activity reactions just won't be available.
  }
}
const HOOK_SCRIPT_PATH = path.join(AI_STATUS_DIR, 'report-status.sh');
const HOOK_SCRIPT_CONTENTS = `#!/usr/bin/env bash
# Installed by the Codex Pet VS Code extension. Reports AI tool activity so the
# pet can react. Usage: report-status.sh <source> <busy|idle>
dir="$(cd "$(dirname "$0")" && pwd)"
printf '{"state":"%s","updatedAt":%s}' "$2" "$(date +%s000)" > "$dir/$1.json"
`;

function ensureHookScript(): void {
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
  { event: 'UserPromptSubmit', command: '~/.codex-pet/report-status.sh claude-code busy' },
  { event: 'Stop', command: '~/.codex-pet/report-status.sh claude-code idle' },
  { event: 'SessionEnd', command: '~/.codex-pet/report-status.sh claude-code idle' },
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

async function maybePromptToInstallClaudeCodeHooks(context: vscode.ExtensionContext): Promise<void> {
  if (!isAiActivityEnabled()) return;
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

async function installClaudeCodeHooks(): Promise<void> {
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

function readAiSourceBusy(source: string): boolean {
  try {
    const bytes = fs.readFileSync(path.join(AI_STATUS_DIR, `${source}.json`), 'utf8');
    const data = JSON.parse(bytes) as { state?: string; updatedAt?: number };
    if (data.state !== 'busy') return false;
    if (typeof data.updatedAt !== 'number') return false;
    return Date.now() - data.updatedAt <= AI_STATUS_STALE_MS;
  } catch {
    return false;
  }
}

function computeAiBusy(): boolean {
  return AI_STATUS_SOURCES.some(readAiSourceBusy);
}

function isAiActivityEnabled(): boolean {
  return vscode.workspace.getConfiguration('codexPet').get<boolean>('reactToAiActivity', true);
}

// GitHub Copilot Chat has no hooks/lifecycle API to report activity like Claude
// Code does (see https://github.com/microsoft/vscode/issues/310951 - not shipped
// yet), so we guess instead: a burst of large/multi-part text-document edits looks
// more like an agent streaming changes than a human typing key-by-key. This is a
// heuristic and will misfire on things like paste, snippets, or format-on-save.
const COPILOT_HEURISTIC_IDLE_MS = 2000;

function isCopilotActivityEnabled(): boolean {
  return vscode.workspace.getConfiguration('codexPet').get<boolean>('reactToCopilotActivity', false);
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

function startCopilotActivityHeuristic(): vscode.Disposable {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const markBusy = () => {
    writeAiStatus('copilot', 'busy');
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => writeAiStatus('copilot', 'idle'), COPILOT_HEURISTIC_IDLE_MS);
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

function startAiActivityWatcher(providers: CodexPetViewProvider[]): vscode.Disposable {
  let lastBusy: boolean | undefined;
  let watcher: fs.FSWatcher | undefined;
  let disposed = false;

  const broadcast = () => {
    const busy = isAiActivityEnabled() && computeAiBusy();
    if (busy === lastBusy) return;
    lastBusy = busy;
    for (const provider of providers) provider.postAiState(busy);
  };

  const setupWatcher = () => {
    watcher?.close();
    try {
      fs.mkdirSync(AI_STATUS_DIR, { recursive: true });
      watcher = fs.watch(AI_STATUS_DIR, { persistent: false }, () => broadcast());
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

type Location = 'sidebar' | 'panel' | 'both';

function getLocation(): Location {
  return vscode.workspace.getConfiguration('codexPet').get<Location>('location', 'panel');
}

async function updateLocationContext(): Promise<void> {
  const location = getLocation();
  await vscode.commands.executeCommand(
    'setContext',
    'codexPet.showInSidebar',
    location === 'sidebar' || location === 'both',
  );
  await vscode.commands.executeCommand(
    'setContext',
    'codexPet.showInPanel',
    location === 'panel' || location === 'both',
  );
}

class CodexPetViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  currentPetId: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly containerCommand: string,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
    resolvePet(this.context, false).then((pet) => {
      if (pet) {
        this.showPet(pet);
        this.postAiState(isAiActivityEnabled() && computeAiBusy());
      }
    });
  }

  reveal(): void {
    vscode.commands.executeCommand(this.containerCommand);
  }

  showPet(pet: Pet): void {
    if (!this.view) return;
    this.currentPetId = pet.manifest.id;
    this.view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        pet.folder,
      ],
    };
    this.view.webview.html = getWebviewHtml(this.view.webview, this.context.extensionUri, pet);
  }

  postTimingUpdate(timing: TimingConfig): void {
    this.view?.webview.postMessage({ type: 'update-timing', timing });
  }

  postScaleUpdate(scale: number): void {
    this.view?.webview.postMessage({ type: 'update-scale', scale });
  }

  postIdleWeightsUpdate(weights: Record<string, number>): void {
    this.view?.webview.postMessage({ type: 'update-idle-weights', weights });
  }

  postAiState(busy: boolean): void {
    this.view?.webview.postMessage({ type: 'ai-state', busy });
  }
}

export function activate(context: vscode.ExtensionContext) {
  const sidebarProvider = new CodexPetViewProvider(
    context,
    'workbench.view.extension.codexPetContainer',
  );
  const panelProvider = new CodexPetViewProvider(
    context,
    'workbench.view.extension.codexPetPanelContainer',
  );
  const providers = [sidebarProvider, panelProvider];

  updateLocationContext();
  ensureHookScript();
  maybePromptToInstallClaudeCodeHooks(context);

  context.subscriptions.push(
    startAiActivityWatcher(providers),
    startCopilotActivityHeuristic(),
    vscode.window.registerWebviewViewProvider('codexPetView', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider('codexPetPanelView', panelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('codexPet.start', () => {
      const location = getLocation();
      (location === 'sidebar' ? sidebarProvider : panelProvider).reveal();
    }),
    vscode.commands.registerCommand('codexPet.choosePet', async () => {
      const pet = await resolvePet(context, true);
      if (pet) {
        const location = getLocation();
        (location === 'sidebar' ? sidebarProvider : panelProvider).reveal();
        for (const provider of providers) provider.showPet(pet);
      }
    }),
    vscode.commands.registerCommand('codexPet.installClaudeCodeHooks', installClaudeCodeHooks),
    vscode.commands.registerCommand('codexPet.openPetsFolder', async () => {
      const petsDir = getUserPetsDir(context);
      await vscode.workspace.fs.createDirectory(petsDir);
      await vscode.commands.executeCommand('revealFileInOS', petsDir);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codexPet.location')) {
        updateLocationContext();
      }

      if (e.affectsConfiguration('codexPet.selectedPet')) {
        resolvePet(context, false).then((pet) => {
          if (!pet) return;
          for (const provider of providers) {
            if (pet.manifest.id !== provider.currentPetId) provider.showPet(pet);
          }
        });
        return;
      }

      if (TIMING_SETTINGS.some((setting) => e.affectsConfiguration(setting))) {
        for (const provider of providers) provider.postTimingUpdate(getTimingConfig());
      }

      if (e.affectsConfiguration('codexPet.petScale')) {
        for (const provider of providers) provider.postScaleUpdate(getPetScale());
      }

      if (e.affectsConfiguration('codexPet.idleStateWeights')) {
        for (const provider of providers) provider.postIdleWeightsUpdate(getIdleStateWeights());
      }
    }),
  );
}

export function deactivate() {
  // Nothing to clean up: the webview view is disposed by VS Code automatically.
}

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, pet: Pet): string {
  const mediaUri = (file: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));

  const scriptUri = mediaUri('main.js');
  const styleUri = mediaUri('main.css');
  const spriteUri = webview.asWebviewUri(
    vscode.Uri.joinPath(pet.folder, pet.manifest.spritesheetPath),
  );
  const configUri = mediaUri('sprite-config.json');
  const timing = getTimingConfig();
  const petScale = getPetScale();
  const idleStateWeights = getIdleStateWeights();

  const nonce = getNonce();

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource};"
  />
  <link href="${styleUri}" rel="stylesheet" />
  <title>${pet.manifest.displayName}</title>
</head>
<body>
  <div id="pet-stage">
    <canvas id="pet-canvas"></canvas>
  </div>
  <script nonce="${nonce}">
    window.CODEX_PET = {
      spriteUri: "${spriteUri}",
      configUri: "${configUri}",
      timing: ${JSON.stringify(timing)},
      scale: ${JSON.stringify(petScale)},
      idleStateWeights: ${JSON.stringify(idleStateWeights)},
    };
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
