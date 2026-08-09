import { beforeEach, describe, expect, it } from 'vitest';
import { Uri, workspace, __reset } from './vscode-mock';
import {
  activityVarietyBonus,
  catchUpWeights,
  comboBonus,
  commitStreakBonus,
  countMissedWeekdaysBetween,
  crossProjectBonus,
  dailyStreakBonus,
  lateNightBonus,
  levelForXp,
  multiRepoCommitBonus,
  sessionStreakBonus,
  weekendBonus,
  xpForLevel,
  xpProgress,
  XpManager,
  loadStreakState,
  saveStreakState,
} from '../src/xp';

// context is only ever used for its globalStorageUri field, so a bare object
// is enough to drive the persistence helpers under test.
function fakeContext() {
  return { globalStorageUri: Uri.file('/fake-global-storage') } as any;
}

beforeEach(() => {
  __reset();
});

describe('xpForLevel / levelForXp / xpProgress', () => {
  it('levelForXp inverts xpForLevel at exact thresholds', () => {
    for (const level of [1, 2, 5, 10, 20, 30]) {
      expect(levelForXp(xpForLevel(level))).toBe(level);
    }
  });

  it('levelForXp never returns less than 1', () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(-100)).toBe(1);
  });

  it('xpProgress is 0 at a level floor and approaches 1 near the next level', () => {
    const level = 5;
    const floor = xpForLevel(level);
    const ceiling = xpForLevel(level + 1);
    expect(xpProgress(floor, level)).toBe(0);
    expect(xpProgress(ceiling - 1, level)).toBeCloseTo(1, 1);
    expect(xpProgress(ceiling, level)).toBeLessThanOrEqual(1);
  });

  it('xpProgress is clamped to [0, 1]', () => {
    expect(xpProgress(0, 10)).toBe(0);
    expect(xpProgress(Number.MAX_SAFE_INTEGER, 1)).toBe(1);
  });
});

describe('dailyStreakBonus', () => {
  it('is 0 with no streak and scales 10% per day', () => {
    expect(dailyStreakBonus(0)).toBe(0);
    expect(dailyStreakBonus(3)).toBeCloseTo(0.3);
  });

  it('caps at +100% (day 10+)', () => {
    expect(dailyStreakBonus(10)).toBe(1);
    expect(dailyStreakBonus(50)).toBe(1);
  });

  it('treats negative streak days as 0', () => {
    expect(dailyStreakBonus(-5)).toBe(0);
  });
});

describe('sessionStreakBonus', () => {
  const STEP_MS = 30 * 60 * 1000;

  it('is 0 under one full 30-minute tier', () => {
    expect(sessionStreakBonus(STEP_MS - 1)).toBe(0);
  });

  it('scales 10% per completed 30-minute tier', () => {
    expect(sessionStreakBonus(STEP_MS)).toBeCloseTo(0.1);
    expect(sessionStreakBonus(STEP_MS * 3)).toBeCloseTo(0.3);
  });

  it('caps at +100% (5 hours)', () => {
    expect(sessionStreakBonus(STEP_MS * 10)).toBe(1);
    expect(sessionStreakBonus(STEP_MS * 100)).toBe(1);
  });
});

describe('weekendBonus / lateNightBonus', () => {
  it('weekendBonus is +20% on Sat/Sun, 0 on weekdays', () => {
    expect(weekendBonus(new Date(2026, 7, 8))).toBe(0.2); // Saturday
    expect(weekendBonus(new Date(2026, 7, 9))).toBe(0.2); // Sunday
    expect(weekendBonus(new Date(2026, 7, 10))).toBe(0); // Monday
  });

  it('lateNightBonus ramps from 18:00, peaks at +34.3% (12/35) at midnight, and is 0 outside 18:00-6:00', () => {
    expect(lateNightBonus(new Date(2026, 7, 8, 18))).toBe(0);
    expect(lateNightBonus(new Date(2026, 7, 8, 0))).toBeCloseTo(12 / 35); // midnight peak
    expect(lateNightBonus(new Date(2026, 7, 8, 23))).toBeCloseTo(2 / 7, 5);
    expect(lateNightBonus(new Date(2026, 7, 8, 3))).toBeCloseTo(6 / 35, 5);
    expect(lateNightBonus(new Date(2026, 7, 8, 6))).toBe(0);
    expect(lateNightBonus(new Date(2026, 7, 8, 12))).toBe(0);
  });

  it("lateNightBonus's area over the old 22:00-6:00 window matches the old flat +20% cap's total (0.2 * 8h = 1.6 bonus-hours)", () => {
    // 1-minute-resolution Riemann sum across the old window - close enough to
    // the exact 14/3*peak integral to catch a wrong peak/shape by a wide margin.
    let sum = 0;
    for (let m = 0; m < 8 * 60; m++) {
      const t = 22 + m / 60; // hours since local midnight on Aug 8, may exceed 24
      const dayOffset = t >= 24 ? 1 : 0;
      sum += lateNightBonus(new Date(2026, 7, 8 + dayOffset, Math.floor(t % 24), m % 60));
    }
    expect(sum / 60).toBeCloseTo(1.6, 1);
  });
});

describe('commitStreakBonus', () => {
  it('is 0 with no streak, scales 5% per day, and caps at +50% (10 days)', () => {
    expect(commitStreakBonus(0)).toBe(0);
    expect(commitStreakBonus(3)).toBeCloseTo(0.15);
    expect(commitStreakBonus(10)).toBe(0.5);
    expect(commitStreakBonus(50)).toBe(0.5);
  });
});

describe('activityVarietyBonus', () => {
  it('rewards 2+ distinct activity kinds in the same minute', () => {
    expect(activityVarietyBonus(0)).toBe(0);
    expect(activityVarietyBonus(1)).toBe(0);
    expect(activityVarietyBonus(2)).toBe(0.05);
    expect(activityVarietyBonus(3)).toBe(0.15);
  });
});

describe('crossProjectBonus', () => {
  it('rewards touching 2+ distinct projects in a session', () => {
    expect(crossProjectBonus(1)).toBe(0);
    expect(crossProjectBonus(2)).toBe(0.1);
    expect(crossProjectBonus(3)).toBe(0.15);
  });
});

describe('multiRepoCommitBonus', () => {
  it('rewards committing to 2+ distinct repos on the same day', () => {
    expect(multiRepoCommitBonus(1)).toBe(0);
    expect(multiRepoCommitBonus(2)).toBe(0.1);
    expect(multiRepoCommitBonus(3)).toBe(0.15);
  });
});

describe('comboBonus', () => {
  it('is 0 for 2 or fewer active sources, scales 5% per source beyond that, capped at +25%', () => {
    expect(comboBonus(0)).toBe(0);
    expect(comboBonus(2)).toBe(0);
    expect(comboBonus(3)).toBeCloseTo(0.05);
    expect(comboBonus(7)).toBe(0.25);
    expect(comboBonus(100)).toBe(0.25);
  });
});

describe('countMissedWeekdaysBetween', () => {
  it('counts 0 for consecutive weekdays', () => {
    expect(countMissedWeekdaysBetween('2026-7-3', '2026-7-4')).toBe(0); // Mon -> Tue
  });

  it('counts 0 across a weekend (Fri -> Mon)', () => {
    expect(countMissedWeekdaysBetween('2026-7-7', '2026-7-10')).toBe(0); // Fri -> Mon
  });

  it('counts 2 for a 4-day weekend (Thu -> the following Tue)', () => {
    // Off Fri and the following Mon: two missed weekdays in a row.
    expect(countMissedWeekdaysBetween('2026-7-6', '2026-7-11')).toBe(2); // Thu -> Tue
  });
});

describe('catchUpWeights', () => {
  it('gives equal weight to pets at the same level', () => {
    expect(catchUpWeights([10, 10, 10])).toEqual([1, 1, 1]);
  });

  it('gives the group leader baseline weight and trailing pets more', () => {
    const [leader, laggard] = catchUpWeights([20, 15]);
    expect(leader).toBe(1);
    expect(laggard).toBeGreaterThan(1);
  });

  it('clamps the boost at 2x for gaps at or beyond the catch-up window', () => {
    const [leader, farBehind, wayBehind] = catchUpWeights([30, 20, 0]);
    expect(leader).toBe(1);
    expect(farBehind).toBe(2); // exactly at the 10-level window
    expect(wayBehind).toBe(2); // beyond the window, still clamped to 2
  });
});

describe('XpManager streak-reset regression (commit 6a3a3ac)', () => {
  // Before 6a3a3ac, flush() adopted disk.sessionActiveMs via an unconditional
  // Math.max, so a stale value left on disk by a long-dead window could
  // resurrect itself into a session that had already hard-reset elsewhere.
  it('does not resurrect a stale, long-dead session clock from disk', async () => {
    const context = fakeContext();
    const staleTimestamp = Date.now() - 999_999_999; // long past the hard-reset window
    const staleSessionMs = 999_999_999;
    await saveStreakState(context, {
      dailyStreakDays: 0,
      sessionActiveMs: staleSessionMs,
      lastActivityAt: staleTimestamp,
    });

    const mgr = new XpManager(context, []);
    await mgr.load();
    // This window has its own short-lived, currently-alive session.
    (mgr as any).sessionActiveMs = 500;
    (mgr as any).lastActivityAt = Date.now();
    (mgr as any).sessionDirty = true;

    await mgr.flush();

    const saved = await loadStreakState(context);
    expect(saved.sessionActiveMs).toBe(500);
    // The pre-fix formula would have produced this instead - assert we don't.
    expect(saved.sessionActiveMs).not.toBe(Math.max(500, staleSessionMs));
  });

  it('still adopts a genuinely longer session from a disk-alive window', async () => {
    const context = fakeContext();
    const aliveSessionMs = 5000;
    await saveStreakState(context, {
      dailyStreakDays: 0,
      sessionActiveMs: aliveSessionMs,
      lastActivityAt: Date.now(), // fresh - another window is still active
    });

    const mgr = new XpManager(context, []);
    await mgr.load();
    (mgr as any).sessionActiveMs = 500;
    (mgr as any).lastActivityAt = Date.now();
    (mgr as any).sessionDirty = true;

    await mgr.flush();

    const saved = await loadStreakState(context);
    expect(saved.sessionActiveMs).toBe(aliveSessionMs);
  });
});

describe('XpManager commit streak', () => {
  it('advances on consecutive weekdays, stays neutral on weekends, and resets after 2 missed weekdays', async () => {
    const context = fakeContext();
    const mgr = new XpManager(context, []);
    await mgr.load();

    (mgr as any).updateCommitStreak(new Date(2026, 7, 3).getTime()); // Monday
    expect((mgr as any).commitStreakDays).toBe(1);

    (mgr as any).updateCommitStreak(new Date(2026, 7, 4).getTime()); // Tuesday
    expect((mgr as any).commitStreakDays).toBe(2);

    (mgr as any).updateCommitStreak(new Date(2026, 7, 6).getTime()); // Thursday (1 missed weekday)
    expect((mgr as any).commitStreakDays).toBe(3);

    (mgr as any).updateCommitStreak(new Date(2026, 7, 8).getTime()); // Saturday - neutral, ignored
    expect((mgr as any).commitStreakDays).toBe(3);

    (mgr as any).updateCommitStreak(new Date(2026, 7, 11).getTime()); // Tuesday (2 missed weekdays: Fri + Mon) - hard reset
    expect((mgr as any).commitStreakDays).toBe(1);
  });
});

describe('XpManager committed repos today', () => {
  it('accumulates distinct repos committed today, ignores repeats, and resets on a stale day key', async () => {
    const context = fakeContext();
    const mgr = new XpManager(context, []);
    await mgr.load();

    mgr.awardCommit('/repo-a');
    expect((mgr as any).committedReposToday.size).toBe(1);

    mgr.awardCommit('/repo-a'); // same repo again - no growth
    expect((mgr as any).committedReposToday.size).toBe(1);

    mgr.awardCommit('/repo-b');
    expect((mgr as any).committedReposToday.size).toBe(2);

    // Simulate a leftover day key from a previous day (e.g. process asleep past midnight).
    (mgr as any).committedReposDayKey = 'stale-day-key';
    mgr.awardCommit('/repo-c');
    expect((mgr as any).committedReposToday.size).toBe(1); // reset, only today's commit counted
  });
});

describe('cleanupOrphanedTmpFiles', () => {
  it('removes orphaned streak.json.*.tmp files left by a failed rename', async () => {
    const context = fakeContext();
    const { cleanupOrphanedTmpFiles } = await import('../src/xp');
    const dir = context.globalStorageUri;
    await workspace.fs.createDirectory(dir);
    const orphan = Uri.joinPath(dir, `streak.json.${Date.now()}.tmp`);
    await workspace.fs.writeFile(orphan, Buffer.from('{}'));
    await workspace.fs.writeFile(Uri.joinPath(dir, 'streak.json'), Buffer.from('{}'));

    await cleanupOrphanedTmpFiles(context);

    const entries = await workspace.fs.readDirectory(dir);
    const names = entries.map(([name]) => name);
    expect(names).toContain('streak.json');
    expect(names.some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});
