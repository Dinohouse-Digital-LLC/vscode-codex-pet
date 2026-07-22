# Publish to the VS Code Marketplace

Split `vscode-codex-pet` out of the multi-extension monorepo into its own
standalone repo (keeping the history that actually applies to this folder),
then make the extension itself publishable and push it live.

## Background

The extension currently lives at `vscode-codex-pet/` inside a larger git
repo (`Firefox_Extensions`) that also contains unrelated Firefox extensions.
`package.json`'s `repository.url` points at `git.andrewdeck.dev`, a private
git server — fine for local dev, but the Marketplace renders that link
publicly and it'll be dead/inaccessible to anyone who clicks it there.

Two options for extraction were considered: start the new repo with a fresh
initial commit (simplest, but throws away the commit history: `3506e0d`
activity bar pet → `d69c26a` jumping/Claude Code integration → `495d0c2` claude
status + XP plan → `f5b1d73` pet scale/jump-height/idle-timing settings →
`46a9b76` distributed pets), or rewrite history down to just the commits that
touched this subdirectory via `git filter-repo --subdirectory-filter` (or
`git subtree split`) and use that as the new repo's history. Rewriting wins
here — the commit log is small, readable, and worth keeping; there's no
churn from the other Firefox extensions muddying it since `filter-repo`
drops any commit that didn't touch `vscode-codex-pet/`.

Also currently blocking publish: `package.json` has `"private": true`
(`vsce` refuses to publish a private package), no Marketplace-suitable PNG
icon (only `media/icons/activitybar.svg`, which is used for the activity-bar
icon, not eligible as the listing icon), and no publisher account has been
created/verified yet.

Extraction has to happen before the `repository.url` fix, since that field
needs the new repo's real (public) URL.

## Checklist

### Phase 1 — extract subdirectory into a standalone repo
- [ ] Confirm `git-filter-repo` is installed (`brew install git-filter-repo`
      if not — the plain `git filter-branch` path is much slower and being
      phased out upstream).
- [ ] Clone (not move) the current repo to a scratch location, run
      `git filter-repo --subdirectory-filter vscode-codex-pet` there so the
      original `Firefox_Extensions` repo is untouched.
- [ ] Verify the filtered history: `git log --oneline` should show only
      commits that touched `vscode-codex-pet/`, with paths rewritten to be
      relative to the new repo root (e.g. `package.json` not
      `vscode-codex-pet/package.json`).
- [ ] Create the new standalone repo (GitHub, under andrewdeck) and push the
      filtered history to it.
- [ ] Decide what happens to `vscode-codex-pet/` in the original monorepo —
      remove it there (with a note pointing at the new repo) or leave it as
      a stale copy. Confirm with Andrew before deleting anything from the
      monorepo.
- [ ] Re-clone the new standalone repo as the working copy going forward;
      confirm `npm install` / `npm run compile` / F5 debug launch still work
      from the new location.

### Phase 2 — make the extension publishable
- [x] Remove `"private": true` from `package.json`.
- [x] Design or source a 128x128 PNG icon and add it as `package.json`'s
      top-level `icon` field (separate from the existing activity-bar SVG).
      Used `media/icons/marketplace-icon.png`, cropped from the cinder pet's
      idle frame.
- [x] Update `repository.url` in `package.json` to the new standalone repo's
      URL (`https://github.com/TempusShift/vscode-codex-pet.git`).
- [x] `*.vsix` already gitignored; removed the stray local `-0.0.1` through
      `-0.0.4` build artifacts from the repo root.
- [x] Bumped `version` to `0.1.0` for the first Marketplace release.

### Phase 3 — publisher account + credentials
- [ ] Create (or verify) an Azure DevOps organization for Andrew.
- [ ] Generate a Personal Access Token scoped to Marketplace (Manage).
- [ ] `vsce create-publisher andrewdeck` (skip if the publisher ID already
      exists on the Marketplace).
- [ ] `vsce login andrewdeck`, pasting the PAT when prompted.

### Phase 4 — publish
- [ ] `npm run compile` and sanity-check the extension still runs via F5
      from the new repo location.
- [ ] `vsce package` and manually install/test the produced `.vsix` once
      more before publishing.
- [ ] `vsce publish` (or upload the `.vsix` manually via the Marketplace
      Partner Center) to go live.
- [ ] Confirm the Marketplace listing renders correctly — icon, README,
      repository link all resolve.
