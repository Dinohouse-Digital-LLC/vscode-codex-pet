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
- [x] Turned out this working copy had no prior git history to extract from
      (not actually inside the `Firefox_Extensions` monorepo at the time),
      so the `git filter-repo` path described below wasn't needed — did a
      plain `git init` + initial commit instead.
- [x] Created the new standalone repo on GitHub under the `TempusShift`
      account (confirmed as the correct account) and pushed:
      `https://github.com/TempusShift/vscode-codex-pet`.
- [x] Confirmed `npm run compile` and packaging work from this location.

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
- [x] Publisher `dinohousedigitalllc` created via the Marketplace management
      portal (`marketplace.visualstudio.com/manage`) — not `andrewdeck` as
      originally assumed; `package.json`'s `publisher` field updated to
      match.
- [x] `vsce login` was blocked by an Azure AD error ("Selected user account
      does not exist in tenant 'Microsoft Services'") that couldn't be
      resolved via account/tenant switching in the time available — abandoned
      the CLI login path in favor of Phase 4's manual upload.

### Phase 4 — publish
- [x] `npm run compile`, `vsce package --no-rewrite-relative-links`, then
      `code --install-extension` to sanity-test the `.vsix` locally. Caught
      and fixed two real bugs this way (see below) before uploading.
- [x] Published via manual drag-and-drop upload of the `.vsix` at
      `marketplace.visualstudio.com/manage/publishers/dinohousedigitalllc`,
      since `vsce publish` wasn't available (Phase 3).
- [x] Confirmed the listing renders correctly.
