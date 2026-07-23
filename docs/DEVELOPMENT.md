# Development

Notes for building and running Codex Pet from source. If you just want to
use the extension, install it from the Marketplace instead — see the main
[README](../README.md).

## Run it

```bash
npm install
npm run compile
```

Then press F5 in VS Code (or "Run Extension" in the debug panel) to launch an
Extension Development Host. A paw icon appears in the Activity Bar (the far
left icon strip) — click it to reveal the pet view. **Codex Pet: Reveal Pet
View** from the Command Palette does the same thing.

## Installing as a real (non-dev-host) extension

```bash
npm run install-extension
```

This packages a `.vsix` (via `npx @vscode/vsce package`) and installs it with
`code --install-extension`. To cut a new version first, use
`npm run release [patch|minor|major|x.y.z]` (see [scripts/release.js](../scripts/release.js)).

Or in VS Code: Extensions view → `...` menu → **Install from VSIX...**.
