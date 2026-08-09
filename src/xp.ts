import * as vscode from 'vscode';

// A structural view of CodexPetViewProvider's XP/streak broadcast methods.
// XpManager only ever calls these two, so it depends on this narrow interface
// instead of importing the concrete provider class (which itself depends on
// XpManager), avoiding a circular import between extension.ts and this module.
export interface XpUpdateSink {
  postXpUpdate(pets: XpUpdateEntry[]): void;
  postStreakUpdate(streak: StreakInfo): void;
}

function isXpEnabled(): boolean {
  return vscode.workspace.getConfiguration('codexPet').get<boolean>('xpEnabled', true);
}

// XP / leveling: per-pet-id progress persisted under globalStorageUri (survives
// extension updates, unlike anything under context.extensionUri). `xp` is the
// only authoritative field; `level` is a cached convenience value recomputed
// from xp on every award so it never drifts out of sync.
export interface XpRecord {
  xp: number;
  level: number;
  lastUpdated: number;
}

function getXpFilePath(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, 'xp.json');
}

export async function loadXpState(context: vscode.ExtensionContext): Promise<Record<string, XpRecord>> {
  try {
    const bytes = await vscode.workspace.fs.readFile(getXpFilePath(context));
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return {};
  }
}

export async function saveXpState(
  context: vscode.ExtensionContext,
  state: Record<string, XpRecord>,
): Promise<void> {
  try {
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    await vscode.workspace.fs.writeFile(
      getXpFilePath(context),
      Buffer.from(JSON.stringify(state, null, 2)),
    );
  } catch (err) {
    // Best-effort: if this fails, XP just won't persist across sessions.
    console.error('codex-pet: failed to save xp.json', err);
  }
}

// Leveling curve: total XP required to reach level n. Tune once real XP rates
// are in place; only `xp` is authoritative, level is derived from it.
export function xpForLevel(n: number): number {
  return 50 * Math.pow(n, 1.5);
}

export function levelForXp(xp: number): number {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  return level;
}

// Fraction of the way from the current level to the next one. Level 1 has no
// real "floor" (xpForLevel(1) is never used as a threshold by levelForXp), so
// it's treated as starting at 0 XP; every other level floors at xpForLevel(level).
export function xpProgress(xp: number, level: number): number {
  const floor = level <= 1 ? 0 : xpForLevel(level);
  const ceiling = xpForLevel(level + 1);
  if (ceiling <= floor) return 0;
  return Math.max(0, Math.min(1, (xp - floor) / (ceiling - floor)));
}

// Gamification polish: streak multipliers and off-hours bonuses applied to
// the active-minute pool (see multiple-pets.md's XP integration decision for
// the pool itself). Reflects the user's overall activity, not any one pet's,
// so it's tracked as its own small piece of global state rather than per pet.
export interface StreakState {
  dailyStreakDays: number;
  lastActiveWeekdayKey?: string;
  // Same weekday-consecutive tracking as dailyStreakDays/lastActiveWeekdayKey,
  // but advanced only by commits (see XpManager.updateCommitStreak).
  commitStreakDays?: number;
  lastCommitWeekdayKey?: string;
  // Distinct repo roots committed to on committedReposDayKey (a dateKey()),
  // reset when the calendar date changes. Unlike the streak counters above,
  // concurrent windows union their sets rather than adopting one winner (see
  // XpManager.flush/reloadFromDisk), since two windows committing to
  // different repos on the same day are both correct, not conflicting.
  committedReposToday?: string[];
  committedReposDayKey?: string;
  // Continuous active-session clock (see XpManager.sessionActiveMs) plus the
  // wall-clock time of the last activity, persisted so the session streak
  // survives an extension/host restart instead of resetting to 0. On reload
  // the gap since lastActivityAt is treated as an activity gap.
  sessionActiveMs?: number;
  lastActivityAt?: number;
}

function getStreakFilePath(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, 'streak.json');
}

export async function loadStreakState(context: vscode.ExtensionContext): Promise<StreakState> {
  try {
    const bytes = await vscode.workspace.fs.readFile(getStreakFilePath(context));
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return { dailyStreakDays: 0 };
  }
}

export async function saveStreakState(context: vscode.ExtensionContext, state: StreakState): Promise<void> {
  try {
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    const target = getStreakFilePath(context);
    // Write to a temp file and rename over the target so a window/host reload
    // that kills the process mid-write can never leave a truncated/corrupt
    // streak.json behind (which loadStreakState would otherwise treat as "no streak").
    const tmp = vscode.Uri.joinPath(context.globalStorageUri, `streak.json.${Date.now()}.tmp`);
    await vscode.workspace.fs.writeFile(tmp, Buffer.from(JSON.stringify(state, null, 2)));
    try {
      await vscode.workspace.fs.rename(tmp, target, { overwrite: true });
    } catch (renameErr) {
      // Rename failed after the tmp file was written (e.g. cross-device or a
      // transient FS error) — clean up the orphan rather than leaving it
      // behind for cleanupOrphanedTmpFiles to find on the next activation.
      await vscode.workspace.fs.delete(tmp).then(undefined, () => {});
      throw renameErr;
    }
  } catch (err) {
    // Best-effort: if this fails, the daily streak just won't persist across sessions.
    console.error('codex-pet: failed to save streak.json', err);
  }
}

// Orphaned `streak.json.<timestamp>.tmp` files are left behind when a past
// save's rename-over-target step failed partway (see saveStreakState). They
// don't affect current state (the target file is only ever replaced by a
// successful rename) but accumulate silently over time, so sweep them on
// every activation.
export async function cleanupOrphanedTmpFiles(context: vscode.ExtensionContext): Promise<void> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(context.globalStorageUri);
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File) continue;
      if (!/^streak\.json\.\d+\.tmp$/.test(name)) continue;
      await vscode.workspace.fs
        .delete(vscode.Uri.joinPath(context.globalStorageUri, name))
        .then(undefined, () => {});
    }
  } catch {
    // globalStorageUri may not exist yet on first run; nothing to clean up.
  }
}

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

// Chronological comparison of dateKey() strings (which aren't lexicographically
// sortable since fields aren't zero-padded). Used to tell which of two
// independently-computed streak states (e.g. this window's vs. another
// window's, read back from disk) is further ahead.
export function compareDateKeys(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return new Date(ay, am, ad).getTime() - new Date(by, bm, bd).getTime();
}

// Weekdays strictly between two weekday date keys (exclusive of both), used
// to tell "the very next weekday" (0 missed) from "one weekday skipped" (1,
// forgiven by the grace window) from "two or more skipped" (hard reset).
export function countMissedWeekdaysBetween(fromKey: string, toKey: string): number {
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
export function dailyStreakBonus(streakDays: number): number {
  return Math.min(1, Math.max(0, streakDays) * 0.1);
}

export function sessionStreakBonus(sessionActiveMs: number): number {
  const tiers = Math.floor(Math.max(0, sessionActiveMs) / SESSION_BONUS_STEP_MS);
  return Math.min(1, tiers * 0.1);
}

export function weekendBonus(now: Date): number {
  const day = now.getDay();
  return day === 0 || day === 6 ? 0.2 : 0;
}

// Peak chosen so the triangle's area over just the *old* 22:00-6:00 window
// (the pre-ramp bonus's own timeframe) integrates to the same total
// bonus-hours as the old flat +20% cap did over that window - i.e. someone
// active throughout 22:00-6:00 nets the same total XP as before. The
// 18:00-22:00 evening extension is new territory on top of that, not
// counted against parity. Old: 0.2 * 8h = 1.6 bonus-hours. New, integrating
// only the 22:00-6:00 slice of the triangle: (14/3)*peak = 1.6, so
// peak = 1.6 * 3/14 = 12/35.
const LATE_NIGHT_BONUS_PEAK = 12 / 35;

// Continuous ramp instead of a hard cutoff: 0 during the workday, rising
// from 18:00, peaking at midnight, and back to 0 by 06:00 - so staying up
// progressively later is rewarded progressively more, with no arbitrary step.
export function lateNightBonus(now: Date): number {
  const hour = now.getHours() + now.getMinutes() / 60;
  const hoursIn = ((hour - 18) + 24) % 24;
  if (hoursIn >= 12) return 0;
  const t = hoursIn / 12;
  const shape = 1 - Math.abs(t - 0.5) * 2; // triangle, peaks at midnight
  return LATE_NIGHT_BONUS_PEAK * shape;
}

// Consecutive weekdays with at least one commit. Weighted lower than
// dailyStreakBonus (half the rate, half the cap) since committing on a day
// already implies being active that day - without this it'd just shadow the
// daily streak instead of rewarding a distinct habit.
export function commitStreakBonus(streakDays: number): number {
  return Math.min(0.5, Math.max(0, streakDays) * 0.05);
}

// Rewards using multiple kinds of activity (editor edits, terminal, AI tool)
// within the same active minute, not just any one of them repeatedly.
export function activityVarietyBonus(kindCount: number): number {
  if (kindCount >= 3) return 0.15;
  if (kindCount === 2) return 0.05;
  return 0;
}

// Rewards touching more than one project root within a continuous session.
export function crossProjectBonus(projectCount: number): number {
  if (projectCount >= 3) return 0.15;
  if (projectCount >= 2) return 0.1;
  return 0;
}

// Rewards committing to more than one repo on the same calendar day -
// distinct from crossProjectBonus (any activity, session-scoped): this is
// commit-only and day-scoped, so it reads as "today's commit streak spanned
// N repos" rather than "this sitting touched N projects."
export function multiRepoCommitBonus(repoCount: number): number {
  if (repoCount >= 3) return 0.15;
  if (repoCount >= 2) return 0.1;
  return 0;
}

// Rewards breadth of active bonus sources, on top of their sum - so
// "weekend + late night + on a streak" is worth more than the sum of its
// parts, distinct from raising any individual source's own cap.
export function comboBonus(activeSourceCount: number): number {
  return Math.min(0.25, Math.max(0, activeSourceCount - 2) * 0.05);
}

// Splits the active-minute pool across shown pets by level: a pet at the
// group leader's level gets weight 1, a pet CATCH_UP_LEVEL_WINDOW+ levels
// behind gets weight 2, linearly in between. Clamped so the split can't
// degenerate at large level gaps.
export function catchUpWeights(levels: number[]): number[] {
  const maxLevel = Math.max(...levels);
  return levels.map((level) => 1 + Math.min(CATCH_UP_LEVEL_WINDOW, maxLevel - level) / CATCH_UP_LEVEL_WINDOW);
}

const XP_PER_ACTIVE_MINUTE = 2;
// How much more each successive shown pet contributes to the active-minute
// pool than the one before it (pet 1 contributes the base rate, pet 2
// contributes base+step, pet 3 base+2*step, ...).
const XP_POOL_STEP_PER_PET = 0.2;
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

export interface XpUpdateEntry {
  petId: string;
  xp: number;
  level: number;
  progress: number;
  leveledUp: boolean;
}

export interface StreakInfo {
  dailyStreakDays: number;
  commitStreakDays: number;
  sessionActiveMs: number;
  multiplier: number;
  bonuses: {
    daily: number;
    session: number;
    weekend: number;
    lateNight: number;
    commitStreak: number;
    activityVariety: number;
    crossProject: number;
    multiRepoCommit: number;
    combo: number;
  };
}

// Awards XP for real coding activity: any minute containing AI-tool activity,
// an editor edit, or terminal use counts once as an "active minute" (rather
// than per-keystroke/per-command, which would be trivially gameable and noisy
// to listen for). Git commits are a discrete checkpoint instead, so they get a
// flat one-off bonus. Clicks are a small supplementary source, rate-limited so
// spam-clicking can't dominate.
//
// With multiple pets shown at once, active-minute XP is a shared pool where
// each additional pet contributes progressively more than the last (pet 1 at
// the base rate, pet 2 at base+step, pet 3 at base+2*step, ...), then the
// pool is split across the shown pets with catch-up weighting so a fresh pet
// next to a maxed one closes the gap. That escalating contribution means the
// average XP per pet actually rises with pet count instead of the pool just
// being divided more ways — going for levels is meant to reward showing more
// pets, not grinding one at a time. Commit XP stays flat per pet (a commit is
// a fixed, shared win); click XP is attributed to whichever specific pet was
// clicked.
export class XpManager {
  private state: Record<string, XpRecord> = {};
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  // XP awarded by this window since the last flush, per pet. Flushing applies
  // this delta on top of a fresh read of disk state (rather than overwriting
  // disk with this window's possibly-stale in-memory snapshot), so concurrent
  // windows' awards accumulate instead of racing to clobber each other.
  private pendingXpDelta: Record<string, number> = {};
  private streakDirty = false;
  private sessionDirty = false;
  private commitStreakDirty = false;
  private committedReposDirty = false;
  private lastActivityAt = 0;
  private lastClickXpAt = 0;
  // Continuous unbroken active duration, in ms — frozen (not reset) across a
  // pause, hard-reset to 0 across a longer gap. See markActive().
  private sessionActiveMs = 0;
  private dailyStreakDays = 0;
  private lastActiveWeekdayKey: string | undefined;
  private commitStreakDays = 0;
  private lastCommitWeekdayKey: string | undefined;
  // See StreakState.committedReposToday - distinct repos committed to today.
  private committedReposToday = new Set<string>();
  private committedReposDayKey: string | undefined;
  // Distinct activity kinds ('edit' | 'terminal' | 'ai') seen since the last
  // per-minute tick (see start()), and distinct project roots touched since
  // the last session hard-reset (see updateSessionStreak). Both feed bonus
  // sources in getStreakInfo and are populated by markActive().
  private activeKinds = new Set<string>();
  private projectsThisSession = new Set<string>();
  currentPetIds: string[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly providers: XpUpdateSink[],
  ) {}

  async load(): Promise<void> {
    this.state = await loadXpState(this.context);
    const streak = await loadStreakState(this.context);
    this.dailyStreakDays = streak.dailyStreakDays;
    this.lastActiveWeekdayKey = streak.lastActiveWeekdayKey;
    this.commitStreakDays = streak.commitStreakDays ?? 0;
    this.lastCommitWeekdayKey = streak.lastCommitWeekdayKey;
    // Only restore today's committed-repos set if it's actually still today -
    // a stale set from a previous day is meaningless and left empty instead.
    if (streak.committedReposDayKey === dateKey(new Date())) {
      this.committedReposDayKey = streak.committedReposDayKey;
      this.committedReposToday = new Set(streak.committedReposToday ?? []);
    }
    // Restore the session clock, treating the shut-down interval as an activity
    // gap: kept if we came back within the hard-reset window, dropped otherwise.
    // lastActivityAt stays 0 so the first markActive() after restart resumes the
    // clock (see updateSessionStreak) rather than crediting the offline gap.
    if (typeof streak.sessionActiveMs === 'number' && typeof streak.lastActivityAt === 'number') {
      const gap = Date.now() - streak.lastActivityAt;
      if (gap >= 0 && gap <= SESSION_HARD_RESET_MS) {
        this.sessionActiveMs = streak.sessionActiveMs;
      }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, 2000);
  }

  // Read-merge-write: re-reads the on-disk state and applies only what's
  // changed in this window (the XP delta since the last flush; the streak
  // transition if this window advanced it) rather than overwriting the file
  // with a stale in-memory snapshot. Makes concurrent windows converge instead
  // of last-writer-wins clobbering each other.
  async flush(): Promise<void> {
    const delta = this.pendingXpDelta;
    this.pendingXpDelta = {};
    if (Object.keys(delta).length > 0) {
      const disk = await loadXpState(this.context);
      for (const [petId, amount] of Object.entries(delta)) {
        const record = disk[petId] ?? { xp: 0, level: 1, lastUpdated: 0 };
        record.xp += amount;
        record.level = levelForXp(record.xp);
        record.lastUpdated = Date.now();
        disk[petId] = record;
      }
      this.state = disk;
      await saveXpState(this.context, this.state);
      this.broadcastXpUpdate(
        this.currentPetIds.map((petId) => {
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

    if (this.streakDirty || this.sessionDirty || this.commitStreakDirty || this.committedReposDirty) {
      const daily = this.streakDirty;
      const commit = this.commitStreakDirty;
      const repos = this.committedReposDirty;
      this.streakDirty = false;
      this.sessionDirty = false;
      this.commitStreakDirty = false;
      this.committedReposDirty = false;
      const disk = await loadStreakState(this.context);
      if (
        daily &&
        disk.lastActiveWeekdayKey &&
        (!this.lastActiveWeekdayKey || compareDateKeys(disk.lastActiveWeekdayKey, this.lastActiveWeekdayKey) >= 0)
      ) {
        // Another window already recorded today's (or a later) transition on
        // disk - adopt it instead of overwriting with our own copy.
        this.dailyStreakDays = disk.dailyStreakDays;
        this.lastActiveWeekdayKey = disk.lastActiveWeekdayKey;
      }
      if (
        commit &&
        disk.lastCommitWeekdayKey &&
        (!this.lastCommitWeekdayKey || compareDateKeys(disk.lastCommitWeekdayKey, this.lastCommitWeekdayKey) >= 0)
      ) {
        this.commitStreakDays = disk.commitStreakDays ?? 0;
        this.lastCommitWeekdayKey = disk.lastCommitWeekdayKey;
      }
      if (repos) {
        // Unlike the streak counters, two windows' committed-repos-today sets
        // both hold real commits - union them instead of picking one.
        const todayKey = dateKey(new Date());
        if (disk.committedReposDayKey === todayKey) {
          for (const repo of disk.committedReposToday ?? []) this.committedReposToday.add(repo);
        }
        this.committedReposDayKey = todayKey;
      }
      // Keep whichever window's session clock is furthest along (the true
      // longest current session) rather than last-writer-wins clobbering it -
      // but only if disk's session is still alive (another window active
      // within the hard-reset window). Otherwise disk just holds a stale
      // pre-reset value, and adopting it via Math.max would undo a hard reset
      // this window just made in updateSessionStreak().
      const diskSessionAlive =
        typeof disk.lastActivityAt === 'number' && Date.now() - disk.lastActivityAt <= SESSION_HARD_RESET_MS;
      this.sessionActiveMs = Math.max(this.sessionActiveMs, diskSessionAlive ? disk.sessionActiveMs ?? 0 : 0);
      await saveStreakState(this.context, {
        dailyStreakDays: this.dailyStreakDays,
        lastActiveWeekdayKey: this.lastActiveWeekdayKey,
        commitStreakDays: this.commitStreakDays,
        lastCommitWeekdayKey: this.lastCommitWeekdayKey,
        committedReposToday: Array.from(this.committedReposToday),
        committedReposDayKey: this.committedReposDayKey,
        sessionActiveMs: this.sessionActiveMs,
        lastActivityAt: Math.max(this.lastActivityAt, disk.lastActivityAt ?? 0),
      });
    }
  }

  // Picks up XP/streak changes written by other windows, without clobbering
  // this window's own not-yet-flushed awards. Called on a file-change
  // notification so idle windows stay in sync even between this window's own
  // saves.
  async reloadFromDisk(): Promise<void> {
    const disk = await loadXpState(this.context);
    let changed = false;
    for (const [petId, record] of Object.entries(disk)) {
      if (petId in this.pendingXpDelta) continue; // an unflushed local award will merge with this on next flush
      const existing = this.state[petId];
      if (!existing || record.lastUpdated > existing.lastUpdated) {
        this.state[petId] = record;
        changed = true;
      }
    }

    const streakDisk = await loadStreakState(this.context);
    if (
      !this.streakDirty &&
      streakDisk.lastActiveWeekdayKey &&
      (!this.lastActiveWeekdayKey || compareDateKeys(streakDisk.lastActiveWeekdayKey, this.lastActiveWeekdayKey) > 0)
    ) {
      this.dailyStreakDays = streakDisk.dailyStreakDays;
      this.lastActiveWeekdayKey = streakDisk.lastActiveWeekdayKey;
    }

    if (
      !this.commitStreakDirty &&
      streakDisk.lastCommitWeekdayKey &&
      (!this.lastCommitWeekdayKey || compareDateKeys(streakDisk.lastCommitWeekdayKey, this.lastCommitWeekdayKey) > 0)
    ) {
      this.commitStreakDays = streakDisk.commitStreakDays ?? 0;
      this.lastCommitWeekdayKey = streakDisk.lastCommitWeekdayKey;
    }

    if (!this.committedReposDirty && streakDisk.committedReposDayKey === dateKey(new Date())) {
      // Union, not adopt: another window's commits today are additional
      // repos, not a replacement for ones this window already knows about.
      for (const repo of streakDisk.committedReposToday ?? []) this.committedReposToday.add(repo);
      this.committedReposDayKey = streakDisk.committedReposDayKey;
    }

    if (changed) {
      this.broadcastXpUpdate(
        this.currentPetIds.map((petId) => {
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
  }

  private getRecord(petId: string): XpRecord {
    let record = this.state[petId];
    if (!record) {
      record = { xp: 0, level: 1, lastUpdated: Date.now() };
      this.state[petId] = record;
    }
    return record;
  }

  getLevel(petId: string): number {
    return this.state[petId]?.level ?? 1;
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

  getStreakInfo(now: Date = new Date()): StreakInfo {
    const sourceBonuses = {
      daily: dailyStreakBonus(this.dailyStreakDays),
      session: sessionStreakBonus(this.sessionActiveMs),
      weekend: weekendBonus(now),
      lateNight: lateNightBonus(now),
      commitStreak: commitStreakBonus(this.commitStreakDays),
      activityVariety: activityVarietyBonus(this.activeKinds.size),
      crossProject: crossProjectBonus(this.projectsThisSession.size),
      multiRepoCommit: multiRepoCommitBonus(this.committedReposToday.size),
    };
    const activeSourceCount = Object.values(sourceBonuses).filter((v) => v > 0).length;
    const bonuses = { ...sourceBonuses, combo: comboBonus(activeSourceCount) };
    const multiplier = 1 + Object.values(bonuses).reduce((sum, v) => sum + v, 0);
    return {
      dailyStreakDays: this.dailyStreakDays,
      commitStreakDays: this.commitStreakDays,
      sessionActiveMs: this.sessionActiveMs,
      multiplier,
      bonuses,
    };
  }

  broadcastStreakUpdate(): void {
    const info = this.getStreakInfo();
    for (const provider of this.providers) provider.postStreakUpdate(info);
  }

  private award(petId: string, amount: number): void {
    if (!isXpEnabled()) return;
    const record = this.getRecord(petId);
    const prevLevel = record.level;
    record.xp += amount;
    record.level = levelForXp(record.xp);
    record.lastUpdated = Date.now();
    this.pendingXpDelta[petId] = (this.pendingXpDelta[petId] ?? 0) + amount;
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

  // source/projectKey tag which activity kind fired and which project root it
  // came from, feeding activityVarietyBonus and crossProjectBonus - both
  // optional since not every caller (e.g. terminal events) has a reliable
  // project root to report.
  markActive(source?: 'edit' | 'terminal' | 'ai', projectKey?: string): void {
    const now = Date.now();
    this.updateSessionStreak(now);
    this.updateDailyStreak(now);
    this.lastActivityAt = now;
    if (source) this.activeKinds.add(source);
    if (projectKey) this.projectsThisSession.add(projectKey);
    this.broadcastStreakUpdate();
  }

  private updateSessionStreak(now: number): void {
    if (this.lastActivityAt === 0) return;
    const gap = now - this.lastActivityAt;
    if (gap > SESSION_HARD_RESET_MS) {
      this.sessionActiveMs = 0;
      this.projectsThisSession.clear();
    } else if (gap > SESSION_PAUSE_MS) {
      // Paused within the grace window: clock stays frozen (the paused gap
      // itself isn't credited), and resumes accumulating from here.
    } else {
      this.sessionActiveMs += gap;
    }
    // Persist the advanced clock so it survives a restart (debounced via flush).
    this.sessionDirty = true;
    this.scheduleSave();
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
    this.streakDirty = true;
    this.scheduleSave();
  }

  // Same weekday-consecutive logic as updateDailyStreak, but advanced only by
  // commits (see awardCommit) so it tracks a distinct habit rather than
  // shadowing the general activity streak.
  private updateCommitStreak(now: number): void {
    const date = new Date(now);
    const day = date.getDay();
    if (day === 0 || day === 6) return; // weekends are neutral, not counted
    const todayKey = dateKey(date);
    if (todayKey === this.lastCommitWeekdayKey) return; // already counted today

    if (this.lastCommitWeekdayKey) {
      const missed = countMissedWeekdaysBetween(this.lastCommitWeekdayKey, todayKey);
      this.commitStreakDays = missed >= 2 ? 1 : this.commitStreakDays + 1;
    } else {
      this.commitStreakDays = 1;
    }
    this.lastCommitWeekdayKey = todayKey;
    this.commitStreakDirty = true;
    this.scheduleSave();
  }

  awardClick(petId: string): void {
    if (!this.currentPetIds.includes(petId)) return;
    const now = Date.now();
    if (now - this.lastClickXpAt < CLICK_XP_MIN_INTERVAL_MS) return;
    this.lastClickXpAt = now;
    this.award(petId, XP_PER_CLICK);
  }

  awardCommit(repoRoot: string): void {
    this.updateCommitStreak(Date.now());
    this.projectsThisSession.add(repoRoot);
    this.trackCommitRepoToday(repoRoot);
    for (const petId of this.currentPetIds) this.award(petId, XP_PER_COMMIT);
  }

  private trackCommitRepoToday(repoRoot: string): void {
    const todayKey = dateKey(new Date());
    if (this.committedReposDayKey !== todayKey) {
      this.committedReposToday = new Set();
      this.committedReposDayKey = todayKey;
    }
    if (!this.committedReposToday.has(repoRoot)) {
      this.committedReposToday.add(repoRoot);
      this.committedReposDirty = true;
      this.scheduleSave();
    }
  }

  start(): vscode.Disposable {
    const interval = setInterval(() => {
      const petIds = this.currentPetIds;
      if (petIds.length === 0) return;
      if (Date.now() - this.lastActivityAt > ACTIVE_WINDOW_MS) return;

      // Escalating pool: pet 1 contributes 2 XP/min, pet 2 contributes 2.2,
      // pet 3 contributes 2.4, pet 4 contributes 2.6, etc. — sum of that
      // arithmetic series is n*base + step*n*(n-1)/2.
      const streakInfo = this.getStreakInfo();
      for (const provider of this.providers) provider.postStreakUpdate(streakInfo);
      const petCount = petIds.length;
      const pool =
        (petCount * XP_PER_ACTIVE_MINUTE + (XP_POOL_STEP_PER_PET * petCount * (petCount - 1)) / 2) *
        streakInfo.multiplier;

      const levels = petIds.map((id) => this.getRecord(id).level);
      const weights = catchUpWeights(levels);
      const totalWeight = weights.reduce((a, b) => a + b, 0);

      petIds.forEach((petId, i) => {
        this.award(petId, (pool * weights[i]) / totalWeight);
      });
      // Activity kinds are scoped to "this active minute" - reset after
      // each tick so activityVarietyBonus reflects the current minute, not
      // the union of every kind ever seen this session.
      this.activeKinds.clear();
    }, ACTIVE_WINDOW_MS);

    return new vscode.Disposable(() => {
      clearInterval(interval);
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = undefined;
      }
      void this.flush();
    });
  }
}
