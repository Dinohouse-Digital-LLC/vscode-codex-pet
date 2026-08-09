#!/usr/bin/env node
// Bumps package.json's version, packages a new .vsix, and commits/tags the
// release in one step.
// Usage: node scripts/release.js <patch|minor|major|x.y.z> [--dry-run] [--no-commit] [--force]
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const RELEASE_BRANCH = 'main';

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: repoRoot, stdio: 'inherit' });
}

function capture(command, args) {
  return execFileSync(command, args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function resolveNextVersion(current, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const [major, minor, patch] = current.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const noCommit = args.includes('--no-commit');
  const force = args.includes('--force');
  const bump = args.find((a) => !a.startsWith('--')) || 'patch';

  const validKeywords = ['patch', 'minor', 'major'];
  const isSemver = /^\d+\.\d+\.\d+$/.test(bump);
  if (!validKeywords.includes(bump) && !isSemver) {
    console.error(
      `Invalid version argument "${bump}". Use "patch", "minor", "major", or an explicit x.y.z.`,
    );
    process.exit(1);
  }

  if (dryRun) {
    // `npm version --dry-run` is not actually a no-op on all npm versions (it
    // has been observed writing package.json anyway), so compute the bump
    // ourselves here instead of trusting it.
    const currentPkg = require(path.join(repoRoot, 'package.json'));
    console.log(`Current version: ${currentPkg.version}`);
    console.log(`Would become: ${resolveNextVersion(currentPkg.version, bump)} (dry run, not written)`);
    console.log('Dry run: skipping compile/package.');
    return;
  }

  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== RELEASE_BRANCH && !force) {
    console.error(
      `On branch "${branch}", not "${RELEASE_BRANCH}". Switch branches or pass --force to release anyway.`,
    );
    process.exit(1);
  }

  const gitStatus = capture('git', ['status', '--porcelain']);
  if (gitStatus && !force) {
    console.error(
      'Working tree has uncommitted changes. Commit or stash them first (or pass --force),' +
        ' so the version-bump commit only contains the version bump.',
    );
    process.exit(1);
  }

  run('npm', ['version', bump, '--no-git-tag-version']);

  const pkg = require(path.join(repoRoot, 'package.json'));
  console.log(`\nVersion is now ${pkg.version}.\n`);

  run('npm', ['run', 'compile']);
  run('npm', ['run', 'package']);

  const vsixName = `${pkg.name}-${pkg.version}.vsix`;
  const vsixPath = path.join(repoRoot, vsixName);
  if (!fs.existsSync(vsixPath)) {
    console.error(`Expected ${vsixName} to exist after packaging, but it doesn't.`);
    process.exit(1);
  }

  const staleVsixes = fs
    .readdirSync(repoRoot)
    .filter((f) => f.startsWith(`${pkg.name}-`) && f.endsWith('.vsix') && f !== vsixName);
  for (const stale of staleVsixes) {
    fs.unlinkSync(path.join(repoRoot, stale));
    console.log(`Removed stale package ${stale}`);
  }

  if (noCommit) {
    console.log(
      `\nPackaged ${vsixName}. Review the version bump (git diff package.json` +
        ' package-lock.json) and commit it, then upload the .vsix to the Marketplace when ready.',
    );
    return;
  }

  run('git', ['add', 'package.json', 'package-lock.json']);
  run('git', ['commit', '-m', `v${pkg.version}`]);
  run('git', ['tag', `v${pkg.version}`]);

  console.log(
    `\nPackaged ${vsixName} and committed/tagged v${pkg.version}.` +
      ' Push with `git push && git push --tags`, then upload the .vsix to the Marketplace when ready.',
  );
}

main();
