#!/usr/bin/env node
// Bumps package.json's version and packages a new .vsix in one step.
// Usage: node scripts/release.js <patch|minor|major|x.y.z> [--dry-run]
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const repoRoot = path.join(__dirname, '..');

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: repoRoot, stdio: 'inherit' });
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

  run('npm', ['version', bump, '--no-git-tag-version']);

  const pkg = require(path.join(repoRoot, 'package.json'));
  console.log(`\nVersion is now ${pkg.version}.\n`);

  run('npm', ['run', 'compile']);
  run('npx', ['vsce', 'package', '--no-rewrite-relative-links']);

  console.log(
    `\nPackaged ${pkg.name}-${pkg.version}.vsix. Review the version bump (git diff package.json` +
      ' package-lock.json) and commit it, then upload the .vsix to the Marketplace when ready.',
  );
}

main();
