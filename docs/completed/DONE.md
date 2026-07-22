# Completed work

## Archived 2026-07-22

### Publish to the VS Code Marketplace

Shipped the first public release of Codex Pet. Plan doc:
[docs/plans/marketplace-publish.md](../plans/marketplace-publish.md)
(kept in place with its checklist fully checked — has the detailed
per-phase notes this entry summarizes).

- Stood up `vscode-codex-pet` as a standalone GitHub repo under the
  `TempusShift` account (`https://github.com/TempusShift/vscode-codex-pet`,
  private). The originally-planned `git filter-repo --subdirectory-filter`
  extraction from a `Firefox_Extensions` monorepo turned out to be
  unnecessary — this working copy had no prior git history, so it was a
  plain `git init` instead.
- Made `package.json` publishable: dropped `"private": true`, added a
  128×128 PNG Marketplace icon (`media/icons/marketplace-icon.png`, cropped
  from the cinder pet's idle sprite frame), pointed `repository.url` at the
  new GitHub repo, and bumped `version` to `0.1.0` for the first release.
- Created Marketplace publisher `dinohousedigitalllc` via the web management
  portal — not `andrewdeck` as the original plan assumed.
- `vsce login` was blocked by a persistent Azure AD tenant error ("Selected
  user account does not exist in tenant 'Microsoft Services'") that
  resisted account/tenant-switching fixes, so publishing went through the
  Marketplace's manual drag-and-drop `.vsix` upload flow instead of
  `vsce publish`. Revisit CLI publishing later if this becomes a recurring
  friction point.
- Local install/test of the packaged `.vsix` (via `code --install-extension`)
  surfaced and fixed two real bugs before anything went live:
  - **Pet view never appeared on a fresh install.** `activationEvents` was
    `[]`, and the panel/sidebar views are gated behind context keys
    (`codexPet.showInSidebar`/`showInPanel`) that are only set inside
    `activate()`. Nothing implicit triggered activation on startup, so the
    context stayed unset and the view never showed — it only ever worked
    during dev because manually running "Codex Pet: Reveal Pet View" from
    the Command Palette activated the extension as a side effect. Fixed by
    adding `"onStartupFinished"` to `activationEvents`.
  - **Stale local installs collided with the packaged one.** Leftover dev
    installs (`andrewdeck.vscode-codex-pet@0.0.1`,
    `undefined_publisher.vscode-codex-pet-0.0.1`) contributed the same view
    container IDs as the new package and shadowed it. Fixed by uninstalling
    the old copies.
- Also excluded internal planning docs (`docs/plans/`, `TODO.md`) from the
  packaged `.vsix` via `.vscodeignore` — they were being bundled into the
  public artifact.
- Follow-on (same session, small enough not to need its own plan doc):
  replaced the `reactToAiActivity`/`reactToCopilotActivity` booleans with a
  single `codexPet.aiActivitySources` array setting, and made the busy
  speech bubble show *what* Claude Code is doing (tool name via
  `PreToolUse`'s hook JSON payload, or "Thinking" during
  `UserPromptSubmit`) instead of a generic "...". Required rewriting
  `~/.codex-pet/report-status.sh`'s generation logic and updating the
  already-installed Claude Code hooks in `~/.claude/settings.json` to match.
