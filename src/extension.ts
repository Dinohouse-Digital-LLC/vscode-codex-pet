import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { cleanupOrphanedTmpFiles, XpManager } from './xp';
import { Pet, getUserPetsDir, resolvePets } from './pets';
import {
  ensureHookScript,
  installClaudeCodeHooks,
  maybePromptToInstallClaudeCodeHooks,
  startAiActivityWatcher,
  startCopilotActivityHeuristic,
} from './ai-activity';
import {
  CodexPetViewProvider,
  PET_GROWTH_SETTINGS,
  TIMING_SETTINGS,
  getIdleStateWeights,
  getPetGrowthConfig,
  getPetScale,
  getTimingConfig,
} from './webview';

function startEditorAndTerminalActivityWatcher(xpManager: XpManager): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme !== 'file') return;
      if (event.contentChanges.length === 0) return;
      const projectKey = vscode.workspace.getWorkspaceFolder(event.document.uri)?.uri.fsPath;
      xpManager.markActive('edit', projectKey);
    }),
  );

  const onDidStartTerminalShellExecution = (
    vscode.window as unknown as {
      onDidStartTerminalShellExecution?: (listener: () => void) => vscode.Disposable;
    }
  ).onDidStartTerminalShellExecution;

  if (onDidStartTerminalShellExecution) {
    disposables.push(onDidStartTerminalShellExecution(() => xpManager.markActive('terminal')));
  } else {
    disposables.push(vscode.window.onDidOpenTerminal(() => xpManager.markActive('terminal')));
    disposables.push(vscode.window.onDidCloseTerminal(() => xpManager.markActive('terminal')));
  }

  return vscode.Disposable.from(...disposables);
}

function startGitCommitWatcher(xpManager: XpManager): vscode.Disposable {
  const watchers: fs.FSWatcher[] = [];

  const watchRepo = (repoRoot: string) => {
    const gitLogsHead = path.join(repoRoot, '.git', 'logs', 'HEAD');
    try {
      watchers.push(fs.watch(gitLogsHead, { persistent: false }, () => xpManager.awardCommit(repoRoot)));
    } catch {
      // No .git/logs/HEAD (not a repo, or shallow clone without reflog) - skip.
    }
  };

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme === 'file') watchRepo(folder.uri.fsPath);
  }

  return new vscode.Disposable(() => {
    for (const watcher of watchers) watcher.close();
  });
}

// Keeps XP/streak in sync across multiple VS Code windows: each window only
// flushes its own state to xp.json/streak.json on its own save cycle, so an
// idle window would otherwise show stale progress until it next awards XP
// itself. Watching the storage directory lets it pick up other windows'
// writes as they happen.
function startXpFileWatcher(context: vscode.ExtensionContext, xpManager: XpManager): vscode.Disposable {
  let watcher: fs.FSWatcher | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const onChange = (_event: string, filename: string | null) => {
    if (filename && filename !== 'xp.json' && filename !== 'streak.json') return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void xpManager.reloadFromDisk();
    }, 300);
  };

  try {
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    watcher = fs.watch(context.globalStorageUri.fsPath, { persistent: false }, onChange);
  } catch {
    watcher = undefined;
  }

  return new vscode.Disposable(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
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

// Held so deactivate() can await a final flush instead of racing extension
// host teardown against the fire-and-forget flush in XpManager.start()'s
// Disposable, which could otherwise leave a truncated streak.json behind.
let activeXpManager: XpManager | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const providers: CodexPetViewProvider[] = [];
  const xpManager = new XpManager(context, providers);
  activeXpManager = xpManager;
  const sidebarProvider = new CodexPetViewProvider(
    context,
    'workbench.view.extension.codexPetContainer',
    xpManager,
  );
  const panelProvider = new CodexPetViewProvider(
    context,
    'workbench.view.extension.codexPetPanelContainer',
    xpManager,
  );
  providers.push(sidebarProvider, panelProvider);

  updateLocationContext();
  ensureHookScript();
  maybePromptToInstallClaudeCodeHooks(context);
  await xpManager.load();
  void cleanupOrphanedTmpFiles(context);

  context.subscriptions.push(
    xpManager.start(),
    startAiActivityWatcher(providers, xpManager),
    startCopilotActivityHeuristic(),
    startEditorAndTerminalActivityWatcher(xpManager),
    startGitCommitWatcher(xpManager),
    startXpFileWatcher(context, xpManager),
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
    vscode.commands.registerCommand('codexPet.choosePets', async () => {
      const pets = await resolvePets(context, xpManager, true);
      if (pets.length > 0) {
        const location = getLocation();
        (location === 'sidebar' ? sidebarProvider : panelProvider).reveal();
        const streakInfo = xpManager.getStreakInfo();
        for (const provider of providers) {
          provider.showPets(pets);
          provider.postStreakUpdate(streakInfo);
        }
      }
    }),
    // Kept as an alias so existing keybindings/muscle memory still work; the
    // multi-select QuickPick subsumes the single-pick case (picking one item
    // is just checking one box).
    vscode.commands.registerCommand('codexPet.choosePet', () =>
      vscode.commands.executeCommand('codexPet.choosePets'),
    ),
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

      if (
        e.affectsConfiguration('codexPet.selectedPet') ||
        e.affectsConfiguration('codexPet.selectedPets')
      ) {
        resolvePets(context, xpManager, false).then((pets: Pet[]) => {
          if (pets.length === 0) return;
          const newIds = pets.map((pet) => pet.manifest.id);
          const streakInfo = xpManager.getStreakInfo();
          for (const provider of providers) {
            const sameIds =
              provider.currentPetIds.length === newIds.length &&
              provider.currentPetIds.every((id, i) => id === newIds[i]);
            if (!sameIds) {
              provider.showPets(pets);
              provider.postStreakUpdate(streakInfo);
            }
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

      if (PET_GROWTH_SETTINGS.some((setting) => e.affectsConfiguration(setting))) {
        for (const provider of providers) provider.postPetGrowthUpdate(getPetGrowthConfig());
      }

      if (
        e.affectsConfiguration('codexPet.useNonstandardSprites') ||
        e.affectsConfiguration('codexPet.useSeamlessSprites')
      ) {
        resolvePets(context, xpManager, false).then((pets: Pet[]) => {
          if (pets.length === 0) return;
          for (const provider of providers) provider.showPets(pets);
        });
      }
    }),
  );
}

export async function deactivate() {
  // The webview view itself is disposed by VS Code automatically; this just
  // makes sure the pending streak/XP write actually lands before the host
  // tears down, instead of racing it (see XpManager.start()'s Disposable).
  await activeXpManager?.flush();
}
