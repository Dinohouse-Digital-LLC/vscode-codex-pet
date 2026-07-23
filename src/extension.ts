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

interface TimingConfig {
  walkSpeed: number;
  moveChance: number;
  minActionDuration: number;
  maxActionDuration: number;
  jumpCooldown: number;
  idleAnimationSpeed: number;
}

function getTimingConfig(): TimingConfig {
  const config = vscode.workspace.getConfiguration('codexPet');
  return {
    walkSpeed: config.get<number>('walkSpeed', 40),
    moveChance: config.get<number>('moveChance', 0.5),
    minActionDuration: config.get<number>('minActionDuration', 1500),
    maxActionDuration: config.get<number>('maxActionDuration', 3500),
    jumpCooldown: config.get<number>('jumpCooldown', 5000),
    idleAnimationSpeed: config.get<number>('idleAnimationSpeed', 1),
  };
}

const TIMING_SETTINGS = [
  'codexPet.walkSpeed',
  'codexPet.moveChance',
  'codexPet.minActionDuration',
  'codexPet.maxActionDuration',
  'codexPet.jumpCooldown',
  'codexPet.idleAnimationSpeed',
];

function getPetScale(): number {
  return vscode.workspace.getConfiguration('codexPet').get<number>('petScale', 1);
}

function getIdleStateWeights(): Record<string, number> {
  return vscode.workspace
    .getConfiguration('codexPet')
    .get<Record<string, number>>('idleStateWeights', {});
}

function isXpEnabled(): boolean {
  return vscode.workspace.getConfiguration('codexPet').get<boolean>('xpEnabled', true);
}

interface PetGrowthConfig {
  enabled: boolean;
  minScale: number;
  maxScale: number;
  maxLevel: number;
}

function getPetGrowthConfig(): PetGrowthConfig {
  const config = vscode.workspace.getConfiguration('codexPet');
  return {
    enabled: config.get<boolean>('petGrowthEnabled', false),
    minScale: config.get<number>('petGrowthMinScale', 0.7),
    maxScale: config.get<number>('petGrowthMaxScale', 1.5),
    maxLevel: config.get<number>('petGrowthMaxLevel', 20),
  };
}

const PET_GROWTH_SETTINGS = [
  'codexPet.petGrowthEnabled',
  'codexPet.petGrowthMinScale',
  'codexPet.petGrowthMaxScale',
  'codexPet.petGrowthMaxLevel',
];

function getUserPetsDir(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, 'pets');
}

// XP / leveling: per-pet-id progress persisted under globalStorageUri (survives
// extension updates, unlike anything under context.extensionUri). `xp` is the
// only authoritative field; `level` is a cached convenience value recomputed
// from xp on every award so it never drifts out of sync.
interface XpRecord {
  xp: number;
  level: number;
  lastUpdated: number;
}

function getXpFilePath(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, 'xp.json');
}

async function loadXpState(context: vscode.ExtensionContext): Promise<Record<string, XpRecord>> {
  try {
    const bytes = await vscode.workspace.fs.readFile(getXpFilePath(context));
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return {};
  }
}

async function saveXpState(
  context: vscode.ExtensionContext,
  state: Record<string, XpRecord>,
): Promise<void> {
  try {
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    await vscode.workspace.fs.writeFile(
      getXpFilePath(context),
      Buffer.from(JSON.stringify(state, null, 2)),
    );
  } catch {
    // Best-effort: if this fails, XP just won't persist across sessions.
  }
}

// Leveling curve: total XP required to reach level n. Tune once real XP rates
// are in place; only `xp` is authoritative, level is derived from it.
function xpForLevel(n: number): number {
  return 50 * Math.pow(n, 1.5);
}

function levelForXp(xp: number): number {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  return level;
}

// Fraction of the way from the current level to the next one. Level 1 has no
// real "floor" (xpForLevel(1) is never used as a threshold by levelForXp), so
// it's treated as starting at 0 XP; every other level floors at xpForLevel(level).
function xpProgress(xp: number, level: number): number {
  const floor = level <= 1 ? 0 : xpForLevel(level);
  const ceiling = xpForLevel(level + 1);
  if (ceiling <= floor) return 0;
  return Math.max(0, Math.min(1, (xp - floor) / (ceiling - floor)));
}

// Gamification polish: streak multipliers and off-hours bonuses applied to
// the active-minute pool (see multiple-pets.md's XP integration decision for
// the pool itself). Reflects the user's overall activity, not any one pet's,
// so it's tracked as its own small piece of global state rather than per pet.
interface StreakState {
  dailyStreakDays: number;
  lastActiveWeekdayKey?: string;
}

function getStreakFilePath(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, 'streak.json');
}

async function loadStreakState(context: vscode.ExtensionContext): Promise<StreakState> {
  try {
    const bytes = await vscode.workspace.fs.readFile(getStreakFilePath(context));
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return { dailyStreakDays: 0 };
  }
}

async function saveStreakState(context: vscode.ExtensionContext, state: StreakState): Promise<void> {
  try {
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    await vscode.workspace.fs.writeFile(
      getStreakFilePath(context),
      Buffer.from(JSON.stringify(state, null, 2)),
    );
  } catch {
    // Best-effort: if this fails, the daily streak just won't persist across sessions.
  }
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

// Weekdays strictly between two weekday date keys (exclusive of both), used
// to tell "the very next weekday" (0 missed) from "one weekday skipped" (1,
// forgiven by the grace window) from "two or more skipped" (hard reset).
function countMissedWeekdaysBetween(fromKey: string, toKey: string): number {
  const [fy, fm, fd] = fromKey.split('-').map(Number);
  const [ty, tm, td] = toKey.split('-').map(Number);
  const cursor = new Date(fy, fm, fd);
  const to = new Date(ty, tm, td);
  let missed = 0;
  cursor.setDate(cursor.getDate() + 1);
  while (cursor < to) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) missed++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return missed;
}

const SESSION_PAUSE_MS = 30 * 60 * 1000;
const SESSION_HARD_RESET_MS = 90 * 60 * 1000;
const SESSION_BONUS_STEP_MS = 30 * 60 * 1000;

// Pure so the combined multiplier is testable in isolation from the
// interval/timer plumbing that drives it.
function dailyStreakBonus(streakDays: number): number {
  return Math.min(1, Math.max(0, streakDays) * 0.1);
}

function sessionStreakBonus(sessionActiveMs: number): number {
  const tiers = Math.floor(Math.max(0, sessionActiveMs) / SESSION_BONUS_STEP_MS);
  return Math.min(1, tiers * 0.1);
}

function weekendBonus(now: Date): number {
  const day = now.getDay();
  return day === 0 || day === 6 ? 0.2 : 0;
}

function lateNightBonus(now: Date): number {
  const hour = now.getHours();
  return hour >= 22 || hour < 6 ? 0.2 : 0;
}

const XP_PER_ACTIVE_MINUTE = 2;
const XP_PER_COMMIT = 15;
const XP_PER_CLICK = 1;
const CLICK_XP_MIN_INTERVAL_MS = 4000;
const ACTIVE_WINDOW_MS = 60000;

// How far ahead of a shown pet's own level the catch-up split can boost its
// share of the active-minute pool: a pet this many (or more) levels behind
// the highest-level pet currently shown gets double weight; a pet level with
// the group leader gets baseline weight. Clamped so the split can't degenerate
// at large level gaps.
const CATCH_UP_LEVEL_WINDOW = 10;

interface XpUpdateEntry {
  petId: string;
  xp: number;
  level: number;
  progress: number;
  leveledUp: boolean;
}

// Awards XP for real coding activity: any minute containing AI-tool activity,
// an editor edit, or terminal use counts once as an "active minute" (rather
// than per-keystroke/per-command, which would be trivially gameable and noisy
// to listen for). Git commits are a discrete checkpoint instead, so they get a
// flat one-off bonus. Clicks are a small supplementary source, rate-limited so
// spam-clicking can't dominate.
//
// With multiple pets shown at once, active-minute XP is a shared pool that
// scales sublinearly with pet count (rewards showing more pets without
// letting it trivially multiply leveling speed), then split across the shown
// pets with catch-up weighting so a fresh pet next to a maxed one closes the
// gap. Commit XP stays flat per pet (a commit is a fixed, shared win); click
// XP is attributed to whichever specific pet was clicked.
class XpManager {
  private state: Record<string, XpRecord> = {};
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private lastActivityAt = 0;
  private lastClickXpAt = 0;
  // Continuous unbroken active duration, in ms — frozen (not reset) across a
  // pause, hard-reset to 0 across a longer gap. See markActive().
  private sessionActiveMs = 0;
  private dailyStreakDays = 0;
  private lastActiveWeekdayKey: string | undefined;
  currentPetIds: string[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly providers: CodexPetViewProvider[],
  ) {}

  async load(): Promise<void> {
    this.state = await loadXpState(this.context);
    const streak = await loadStreakState(this.context);
    this.dailyStreakDays = streak.dailyStreakDays;
    this.lastActiveWeekdayKey = streak.lastActiveWeekdayKey;
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      saveXpState(this.context, this.state);
      saveStreakState(this.context, {
        dailyStreakDays: this.dailyStreakDays,
        lastActiveWeekdayKey: this.lastActiveWeekdayKey,
      });
    }, 2000);
  }

  private getRecord(petId: string): XpRecord {
    let record = this.state[petId];
    if (!record) {
      record = { xp: 0, level: 1, lastUpdated: Date.now() };
      this.state[petId] = record;
    }
    return record;
  }

  getHighestLevel(): number {
    let max = 1;
    for (const record of Object.values(this.state)) {
      max = Math.max(max, record.level);
    }
    return max;
  }

  private broadcastXpUpdate(entries: XpUpdateEntry[]): void {
    for (const provider of this.providers) provider.postXpUpdate(entries);
  }

  private award(petId: string, amount: number): void {
    if (!isXpEnabled()) return;
    const record = this.getRecord(petId);
    const prevLevel = record.level;
    record.xp += amount;
    record.level = levelForXp(record.xp);
    record.lastUpdated = Date.now();
    this.scheduleSave();
    if (this.currentPetIds.includes(petId)) {
      this.broadcastXpUpdate([
        {
          petId,
          xp: record.xp,
          level: record.level,
          progress: xpProgress(record.xp, record.level),
          leveledUp: record.level > prevLevel,
        },
      ]);
    }
  }

  setCurrentPets(petIds: string[]): void {
    this.currentPetIds = petIds;
    this.broadcastXpUpdate(
      petIds.map((petId) => {
        const record = this.getRecord(petId);
        return {
          petId,
          xp: record.xp,
          level: record.level,
          progress: xpProgress(record.xp, record.level),
          leveledUp: false,
        };
      }),
    );
  }

  markActive(): void {
    const now = Date.now();
    this.updateSessionStreak(now);
    this.updateDailyStreak(now);
    this.lastActivityAt = now;
  }

  private updateSessionStreak(now: number): void {
    if (this.lastActivityAt === 0) return;
    const gap = now - this.lastActivityAt;
    if (gap > SESSION_HARD_RESET_MS) {
      this.sessionActiveMs = 0;
    } else if (gap > SESSION_PAUSE_MS) {
      // Paused within the grace window: clock stays frozen (the paused gap
      // itself isn't credited), and resumes accumulating from here.
    } else {
      this.sessionActiveMs += gap;
    }
  }

  private updateDailyStreak(now: number): void {
    const date = new Date(now);
    const day = date.getDay();
    if (day === 0 || day === 6) return; // weekends are neutral, not counted
    const todayKey = dateKey(date);
    if (todayKey === this.lastActiveWeekdayKey) return; // already counted today

    if (this.lastActiveWeekdayKey) {
      const missed = countMissedWeekdaysBetween(this.lastActiveWeekdayKey, todayKey);
      this.dailyStreakDays = missed >= 2 ? 1 : this.dailyStreakDays + 1;
    } else {
      this.dailyStreakDays = 1;
    }
    this.lastActiveWeekdayKey = todayKey;
    this.scheduleSave();
  }

  awardClick(petId: string): void {
    if (!this.currentPetIds.includes(petId)) return;
    const now = Date.now();
    if (now - this.lastClickXpAt < CLICK_XP_MIN_INTERVAL_MS) return;
    this.lastClickXpAt = now;
    this.award(petId, XP_PER_CLICK);
  }

  awardCommit(): void {
    for (const petId of this.currentPetIds) this.award(petId, XP_PER_COMMIT);
  }

  start(): vscode.Disposable {
    const interval = setInterval(() => {
      const petIds = this.currentPetIds;
      if (petIds.length === 0) return;
      if (Date.now() - this.lastActivityAt > ACTIVE_WINDOW_MS) return;

      // Sublinear pool: 1 pet = 2 XP/min (unchanged), 2 pets = 3, 3 pets = 4, ...
      const now = new Date();
      const multiplier =
        1 +
        dailyStreakBonus(this.dailyStreakDays) +
        sessionStreakBonus(this.sessionActiveMs) +
        weekendBonus(now) +
        lateNightBonus(now);
      const pool = XP_PER_ACTIVE_MINUTE * (1 + 0.5 * (petIds.length - 1)) * multiplier;

      const levels = petIds.map((id) => this.getRecord(id).level);
      const maxLevel = Math.max(...levels);
      // Weight ranges from 1 (level with the group leader) to 2 (10+ levels
      // behind), rather than an unbounded inverse-level formula that would
      // degenerate at large level gaps.
      const weights = levels.map((level) => 1 + Math.min(CATCH_UP_LEVEL_WINDOW, maxLevel - level) / CATCH_UP_LEVEL_WINDOW);
      const totalWeight = weights.reduce((a, b) => a + b, 0);

      petIds.forEach((petId, i) => {
        this.award(petId, (pool * weights[i]) / totalWeight);
      });
    }, ACTIVE_WINDOW_MS);

    return new vscode.Disposable(() => {
      clearInterval(interval);
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = undefined;
      }
      saveXpState(this.context, this.state);
      saveStreakState(this.context, {
        dailyStreakDays: this.dailyStreakDays,
        lastActiveWeekdayKey: this.lastActiveWeekdayKey,
      });
    });
  }
}

function startEditorAndTerminalActivityWatcher(xpManager: XpManager): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme !== 'file') return;
      if (event.contentChanges.length === 0) return;
      xpManager.markActive();
    }),
  );

  const onDidStartTerminalShellExecution = (
    vscode.window as unknown as {
      onDidStartTerminalShellExecution?: (listener: () => void) => vscode.Disposable;
    }
  ).onDidStartTerminalShellExecution;

  if (onDidStartTerminalShellExecution) {
    disposables.push(onDidStartTerminalShellExecution(() => xpManager.markActive()));
  } else {
    disposables.push(vscode.window.onDidOpenTerminal(() => xpManager.markActive()));
    disposables.push(vscode.window.onDidCloseTerminal(() => xpManager.markActive()));
  }

  return vscode.Disposable.from(...disposables);
}

function startGitCommitWatcher(xpManager: XpManager): vscode.Disposable {
  const watchers: fs.FSWatcher[] = [];

  const watchRepo = (repoRoot: string) => {
    const gitLogsHead = path.join(repoRoot, '.git', 'logs', 'HEAD');
    try {
      watchers.push(fs.watch(gitLogsHead, { persistent: false }, () => xpManager.awardCommit()));
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

interface PetPickItem extends vscode.QuickPickItem {
  pet?: Pet;
}

function buildPetPickItems(pets: Pet[], unlockedSlots: number): PetPickItem[] {
  const items: PetPickItem[] = pets.map((pet) => ({
    label: pet.manifest.displayName,
    description: pet.manifest.id,
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
): Promise<Pet[] | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<PetPickItem>();
    qp.canSelectMany = true;
    qp.placeholder = `Choose up to ${unlockedSlots} pet(s) to show at once`;
    qp.items = buildPetPickItems(pets, unlockedSlots);

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

async function resolvePets(
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

  const picked = await pickPets(context, pets, unlockedSlots);
  return picked ?? [];
}

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

async function maybePromptToInstallClaudeCodeHooks(context: vscode.ExtensionContext): Promise<void> {
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

const SOURCE_DEFAULT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  copilot: 'Copilot',
};

interface WaitingSession {
  id: string;
  label: string;
}

interface AiState {
  busy: boolean;
  label?: string;
  waiting: WaitingSession[];
}

function getWaitingStaleMs(): number {
  const minutes = vscode.workspace
    .getConfiguration('codexPet')
    .get<number>('waitingStaleMinutes', 240);
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

function computeAiState(): AiState {
  const sources = new Set(getAiActivitySources());
  const now = Date.now();
  const waitingStaleMs = getWaitingStaleMs();

  let busyLabel: string | undefined;
  const waiting: WaitingSession[] = [];

  for (const { file, data } of readSessionStatusFiles()) {
    if (!data.source || !sources.has(data.source)) continue;
    if (typeof data.updatedAt !== 'number') continue;
    const age = now - data.updatedAt;

    if (data.state === 'busy') {
      if (age > AI_STATUS_STALE_MS) continue;
      if (!busyLabel) busyLabel = data.label || SOURCE_DEFAULT_LABELS[data.source] || data.source;
    } else if (data.state === 'waiting') {
      if (age > waitingStaleMs) continue;
      const label =
        data.title || (data.cwd ? path.basename(data.cwd) : SOURCE_DEFAULT_LABELS[data.source] || data.source);
      waiting.push({ id: file, label });
    }
  }

  return { busy: Boolean(busyLabel), label: busyLabel, waiting };
}

function getAiActivitySources(): string[] {
  return vscode.workspace
    .getConfiguration('codexPet')
    .get<string[]>('aiActivitySources', ['claude-code']);
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

function startCopilotActivityHeuristic(): vscode.Disposable {
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

function startAiActivityWatcher(
  providers: CodexPetViewProvider[],
  xpManager: XpManager,
): vscode.Disposable {
  let lastKey: string | undefined;
  let watcher: fs.FSWatcher | undefined;
  let disposed = false;

  const broadcast = () => {
    const state = computeAiState();
    if (state.busy) xpManager.markActive();
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

  postPetGrowthUpdate(growth: PetGrowthConfig): void {
    this.view?.webview.postMessage({ type: 'update-pet-growth', growth });
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const providers: CodexPetViewProvider[] = [];
  const xpManager = new XpManager(context, providers);
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

  context.subscriptions.push(
    xpManager.start(),
    startAiActivityWatcher(providers, xpManager),
    startCopilotActivityHeuristic(),
    startEditorAndTerminalActivityWatcher(xpManager),
    startGitCommitWatcher(xpManager),
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
        for (const provider of providers) provider.showPets(pets);
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
        resolvePets(context, xpManager, false).then((pets) => {
          if (pets.length === 0) return;
          const newIds = pets.map((pet) => pet.manifest.id);
          for (const provider of providers) {
            const sameIds =
              provider.currentPetIds.length === newIds.length &&
              provider.currentPetIds.every((id, i) => id === newIds[i]);
            if (!sameIds) provider.showPets(pets);
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
    }),
  );
}

export function deactivate() {
  // Nothing to clean up: the webview view is disposed by VS Code automatically.
}

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, pets: Pet[]): string {
  const mediaUri = (file: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));

  const scriptUri = mediaUri('main.js');
  const styleUri = mediaUri('main.css');
  const configUri = mediaUri('sprite-config.json');
  const petDefs = pets.map((pet) => ({
    id: pet.manifest.id,
    spriteUri: webview
      .asWebviewUri(vscode.Uri.joinPath(pet.folder, pet.manifest.spritesheetPath))
      .toString(),
    configUri: configUri.toString(),
  }));
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
