import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// xp.ts imports the real 'vscode' module, which only exists inside the
// extension host at runtime (there's no npm package to resolve under
// vitest's plain Node environment) — alias it to a lightweight in-memory
// stand-in so the module can load and XpManager's persistence methods can
// be exercised without a real filesystem or VS Code instance.
export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(dirname, 'test/vscode-mock.ts'),
    },
  },
});
