// Minimal stand-in for the 'vscode' module so xp.ts's pure logic and
// XpManager's persistence methods can run under vitest (a plain Node
// process, not the extension host where the real 'vscode' module only
// exists at runtime). Backs vscode.workspace.fs with an in-memory map
// instead of the real filesystem.

export class Uri {
  private constructor(public readonly path: string) {}

  static file(path: string): Uri {
    return new Uri(path);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri([base.path, ...segments].join('/'));
  }

  toString(): string {
    return this.path;
  }
}

export class Disposable {
  constructor(private readonly onDispose?: () => void) {}
  dispose(): void {
    this.onDispose?.();
  }
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

const files = new Map<string, Uint8Array>();
const dirs = new Set<string>();

export const workspace = {
  fs: {
    async readFile(uri: Uri): Promise<Uint8Array> {
      const data = files.get(uri.path);
      if (!data) throw new Error(`ENOENT: ${uri.path}`);
      return data;
    },
    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      files.set(uri.path, content);
    },
    async rename(source: Uri, target: Uri, _options?: { overwrite?: boolean }): Promise<void> {
      const data = files.get(source.path);
      if (!data) throw new Error(`ENOENT: ${source.path}`);
      files.delete(source.path);
      files.set(target.path, data);
    },
    async delete(uri: Uri): Promise<void> {
      files.delete(uri.path);
    },
    async createDirectory(uri: Uri): Promise<void> {
      dirs.add(uri.path);
    },
    async readDirectory(uri: Uri): Promise<[string, FileType][]> {
      const prefix = `${uri.path}/`;
      const entries: [string, FileType][] = [];
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
          entries.push([key.slice(prefix.length), FileType.File]);
        }
      }
      return entries;
    },
  },
  getConfiguration() {
    return {
      get<T>(_key: string, defaultValue: T): T {
        return defaultValue;
      },
    };
  },
};

// Test-only helper: clears the fake filesystem between test cases so state
// doesn't leak across tests.
export function __reset(): void {
  files.clear();
  dirs.clear();
}
