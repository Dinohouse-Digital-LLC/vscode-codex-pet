import * as vscode from 'vscode';
import { Pet, NONSTANDARD_CONFIG_PATH, NONSTANDARD_SPRITESHEET_PATH, resolvePets } from './pets';
import { StreakInfo, XpManager, XpUpdateEntry } from './xp';
import { WaitingSession, computeAiState } from './ai-activity';

// `useSeamlessSprites` was the setting's original name; kept as a fallback
// so anyone with it already set in settings.json isn't silently switched
// back to standard sprites by the rename.
function useNonstandardSprites(): boolean {
  const config = vscode.workspace.getConfiguration('codexPet');
  const legacy = config.inspect<boolean>('useSeamlessSprites');
  const legacyIsSet =
    legacy?.globalValue !== undefined ||
    legacy?.workspaceValue !== undefined ||
    legacy?.workspaceFolderValue !== undefined;
  if (legacyIsSet) return config.get<boolean>('useSeamlessSprites', true);
  return config.get<boolean>('useNonstandardSprites', true);
}

export interface TimingConfig {
  walkSpeed: number;
  moveChance: number;
  minActionDuration: number;
  maxActionDuration: number;
  jumpCooldown: number;
  idleAnimationSpeed: number;
}

export function getTimingConfig(): TimingConfig {
  const config = vscode.workspace.getConfiguration('codexPet');
  return {
    walkSpeed: config.get<number>('walkSpeed', 40),
    moveChance: config.get<number>('moveChance', 0.5),
    // Settings are authored in seconds; the webview works in milliseconds.
    minActionDuration: config.get<number>('minActionSeconds', 3) * 1000,
    maxActionDuration: config.get<number>('maxActionSeconds', 10) * 1000,
    jumpCooldown: config.get<number>('jumpCooldown', 5000),
    idleAnimationSpeed: config.get<number>('idleAnimationSpeed', 0.5),
  };
}

export const TIMING_SETTINGS = [
  'codexPet.walkSpeed',
  'codexPet.moveChance',
  'codexPet.minActionSeconds',
  'codexPet.maxActionSeconds',
  'codexPet.jumpCooldown',
  'codexPet.idleAnimationSpeed',
];

export function getPetScale(): number {
  return vscode.workspace.getConfiguration('codexPet').get<number>('petScale', 2);
}

export function getIdleStateWeights(): Record<string, number> {
  return vscode.workspace
    .getConfiguration('codexPet')
    .get<Record<string, number>>('idleStateWeights', {});
}

export interface PetGrowthConfig {
  enabled: boolean;
  minScale: number;
  maxScale: number;
  maxLevel: number;
}

export function getPetGrowthConfig(): PetGrowthConfig {
  const config = vscode.workspace.getConfiguration('codexPet');
  return {
    enabled: config.get<boolean>('petGrowthEnabled', true),
    minScale: config.get<number>('petGrowthMinScale', 0.5),
    maxScale: config.get<number>('petGrowthMaxScale', 1.5),
    maxLevel: config.get<number>('petGrowthMaxLevel', 20),
  };
}

export const PET_GROWTH_SETTINGS = [
  'codexPet.petGrowthEnabled',
  'codexPet.petGrowthMinScale',
  'codexPet.petGrowthMaxScale',
  'codexPet.petGrowthMaxLevel',
];

export class CodexPetViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  currentPetIds: string[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly containerCommand: string,
    private readonly xpManager: XpManager,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
    webviewView.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'pet-click' && typeof message.petId === 'string') {
        this.xpManager.awardClick(message.petId);
      }
    });
    resolvePets(this.context, this.xpManager, false).then((pets) => {
      if (pets.length > 0) {
        this.showPets(pets);
        const state = computeAiState();
        this.postAiState(state.busy, state.label, state.waiting);
        this.postStreakUpdate(this.xpManager.getStreakInfo());
      }
    });
  }

  reveal(): void {
    vscode.commands.executeCommand(this.containerCommand);
  }

  showPets(pets: Pet[]): void {
    if (!this.view) return;
    this.currentPetIds = pets.map((pet) => pet.manifest.id);
    this.view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        ...pets.map((pet) => pet.folder),
      ],
    };
    this.view.webview.html = getWebviewHtml(this.view.webview, this.context.extensionUri, pets);
    this.xpManager.setCurrentPets(this.currentPetIds);
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

  postAiState(busy: boolean, label?: string, waiting?: WaitingSession[]): void {
    this.view?.webview.postMessage({ type: 'ai-state', busy, label, waiting: waiting ?? [] });
  }

  postXpUpdate(pets: XpUpdateEntry[]): void {
    this.view?.webview.postMessage({ type: 'xp-update', pets });
  }

  postStreakUpdate(streak: StreakInfo): void {
    this.view?.webview.postMessage({ type: 'streak-update', streak });
  }

  postPetGrowthUpdate(growth: PetGrowthConfig): void {
    this.view?.webview.postMessage({ type: 'update-pet-growth', growth });
  }
}

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, pets: Pet[]): string {
  const mediaUri = (file: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));

  const scriptUri = mediaUri('main.js');
  const styleUri = mediaUri('main.css');
  const defaultConfigUri = mediaUri('sprite-config.json');
  const wantNonstandard = useNonstandardSprites();
  const petDefs = pets.map((pet) => {
    const useNonstandard = wantNonstandard && pet.hasNonstandardVariant;
    const spritesheetPath = useNonstandard
      ? NONSTANDARD_SPRITESHEET_PATH
      : pet.manifest.spritesheetPath;
    return {
      id: pet.manifest.id,
      spriteUri: webview.asWebviewUri(vscode.Uri.joinPath(pet.folder, spritesheetPath)).toString(),
      configUri: useNonstandard
        ? webview.asWebviewUri(vscode.Uri.joinPath(pet.folder, NONSTANDARD_CONFIG_PATH)).toString()
        : defaultConfigUri.toString(),
      // Always the standard manifest, even when an alternate one is active,
      // so the renderer can scale an alternate sheet's own cell size to
      // match the on-screen footprint the standard manifest defines.
      standardConfigUri: defaultConfigUri.toString(),
    };
  });
  const timing = getTimingConfig();
  const petScale = getPetScale();
  const idleStateWeights = getIdleStateWeights();
  const petGrowth = getPetGrowthConfig();

  const nonce = getNonce();
  const title = pets.map((pet) => pet.manifest.displayName).join(' & ') || 'Codex Pet';

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource};"
  />
  <link href="${styleUri}" rel="stylesheet" />
  <title>${title}</title>
</head>
<body>
  <div id="pet-stage">
    <canvas id="pet-canvas"></canvas>
  </div>
  <script nonce="${nonce}">
    window.CODEX_PET = {
      pets: ${JSON.stringify(petDefs)},
      timing: ${JSON.stringify(timing)},
      scale: ${JSON.stringify(petScale)},
      idleStateWeights: ${JSON.stringify(idleStateWeights)},
      petGrowth: ${JSON.stringify(petGrowth)},
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
