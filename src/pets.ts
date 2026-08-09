import * as vscode from 'vscode';
import { XpManager } from './xp';

export interface PetManifest {
  id: string;
  displayName: string;
  description?: string;
  spritesheetPath: string;
  kind?: string;
}

export interface Pet {
  folderName: string;
  manifest: PetManifest;
  folder: vscode.Uri;
  hasNonstandardVariant: boolean;
}

export const NONSTANDARD_SPRITESHEET_PATH = 'nonstandard-seamless/spritesheet-seamless.webp';
export const NONSTANDARD_CONFIG_PATH = 'nonstandard-seamless/spritesheet-seamless.json';

const LAST_PET_KEY = 'codexPet.lastPetId';
const LAST_PET_IDS_KEY = 'codexPet.lastPetIds';

// Pet slots are gated on the level of the single highest-level owned pet
// (not a sum across pets, which would reward spreading XP thin instead of
// rewarding the catch-up mechanic's intent). Thresholds echo the existing
// XP curve so later slots feel earned rather than just further apart.
const SLOT_UNLOCK_LEVELS = [5, 15, 30];
const SLOT_ORDINALS = ['1st', '2nd', '3rd', '4th'];

function getUnlockedSlotCount(highestLevel: number): number {
  return 1 + SLOT_UNLOCK_LEVELS.filter((level) => highestLevel >= level).length;
}

export function getUserPetsDir(context: vscode.ExtensionContext): vscode.Uri {
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
      let hasNonstandardVariant = false;
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, NONSTANDARD_SPRITESHEET_PATH));
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, NONSTANDARD_CONFIG_PATH));
        hasNonstandardVariant = true;
      } catch {
        hasNonstandardVariant = false;
      }
      pets.push({ folderName: name, manifest, folder, hasNonstandardVariant });
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

interface PetPickItem extends vscode.QuickPickItem {
  pet?: Pet;
}

function buildPetPickItems(
  pets: Pet[],
  unlockedSlots: number,
  xpManager: XpManager,
): PetPickItem[] {
  const items: PetPickItem[] = pets.map((pet) => ({
    label: pet.manifest.displayName,
    description: `Lvl ${xpManager.getLevel(pet.manifest.id)} · ${pet.manifest.id}`,
    detail: pet.manifest.description,
    pet,
  }));

  // Locked slots are shown (not hidden) so the goal is visible before it's
  // reachable, but they carry no `pet` so selecting one is a no-op.
  SLOT_UNLOCK_LEVELS.forEach((level, i) => {
    const slotNumber = i + 2;
    if (slotNumber > unlockedSlots) {
      items.push({
        label: `🔒 ${SLOT_ORDINALS[slotNumber - 1]} pet slot unlocks at level ${level}`,
      });
    }
  });

  return items;
}

async function pickPets(
  context: vscode.ExtensionContext,
  pets: Pet[],
  unlockedSlots: number,
  xpManager: XpManager,
): Promise<Pet[] | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<PetPickItem>();
    qp.canSelectMany = true;
    qp.placeholder = `Choose up to ${unlockedSlots} pet(s) to show at once`;
    qp.items = buildPetPickItems(pets, unlockedSlots, xpManager);

    qp.onDidChangeSelection((selected) => {
      const pickable = selected.filter((item) => item.pet);
      if (pickable.length > unlockedSlots) {
        qp.selectedItems = pickable.slice(0, unlockedSlots);
      }
    });

    let resolved = false;
    qp.onDidAccept(async () => {
      const chosen = qp.selectedItems.filter((item) => item.pet).map((item) => item.pet as Pet);
      if (chosen.length > 0) {
        await context.globalState.update(
          LAST_PET_IDS_KEY,
          chosen.map((pet) => pet.manifest.id),
        );
      }
      resolved = true;
      qp.hide();
      resolve(chosen.length > 0 ? chosen : undefined);
    });
    qp.onDidHide(() => {
      qp.dispose();
      if (!resolved) resolve(undefined);
    });
    qp.show();
  });
}

export async function resolvePets(
  context: vscode.ExtensionContext,
  xpManager: XpManager,
  forcePick: boolean,
): Promise<Pet[]> {
  const pets = await listPets(context);
  if (pets.length === 0) {
    vscode.window.showErrorMessage(
      'Codex Pet: no pet found. Add a pet.json + spritesheet.webp under pets/<pet-id>/ (use "Codex Pet: Open Pets Folder" for a location that survives updates).',
    );
    return [];
  }

  const unlockedSlots = getUnlockedSlotCount(xpManager.getHighestLevel());

  if (!forcePick) {
    const configuredPets = vscode.workspace
      .getConfiguration('codexPet')
      .get<string[]>('selectedPets', []);
    if (configuredPets.length > 0) {
      const matches = configuredPets
        .map((id) => findPet(pets, id))
        .filter((pet): pet is Pet => Boolean(pet));
      if (matches.length > 0) return matches.slice(0, unlockedSlots);
    }

    const lastIds = context.globalState.get<string[]>(LAST_PET_IDS_KEY);
    if (lastIds && lastIds.length > 0) {
      const matches = lastIds
        .map((id) => findPet(pets, id))
        .filter((pet): pet is Pet => Boolean(pet));
      if (matches.length > 0) return matches.slice(0, unlockedSlots);
    }

    const configured = vscode.workspace
      .getConfiguration('codexPet')
      .get<string>('selectedPet');
    if (configured) {
      const match = findPet(pets, configured);
      if (match) return [match];
      vscode.window.showWarningMessage(
        `Codex Pet: configured pet "${configured}" was not found under pets/. Falling back.`,
      );
    }

    const lastId = context.globalState.get<string>(LAST_PET_KEY);
    if (lastId) {
      const match = findPet(pets, lastId);
      if (match) return [match];
    }

    if (pets.length === 1) {
      return [pets[0]];
    }
  }

  const picked = await pickPets(context, pets, unlockedSlots, xpManager);
  return picked ?? [];
}
