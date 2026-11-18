/**
 * Minimal stand-in for the `vscode` module, used by unit tests (aliased in
 * vitest.config.ts). `Uri` is Microsoft's own implementation from the
 * `vscode-uri` package, so URI parsing/encoding behaves exactly like VS Code.
 *
 * `workspace.fs` routes each request to the FileSystemProvider registered for
 * the URI's scheme — like VS Code does — and serves `file:` URIs from disk.
 * Tests register a FakeRemoteFileSystemProvider for `vscode-remote` to emulate
 * a Remote SSH host.
 */
import * as nodeFs from 'fs';
import { URI, Utils } from 'vscode-uri';

export class Uri extends URI {
  static joinPath(base: URI, ...segments: string[]): URI {
    return Utils.joinPath(base, ...segments);
  }
}
// URI's static factories return URI instances; that's all the code under test needs.

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64
}

export enum FileChangeType {
  Changed = 1,
  Created = 2,
  Deleted = 3
}

export enum ExtensionKind {
  UI = 1,
  Workspace = 2
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15
}

export class FileSystemError extends Error {
  constructor(
    messageOrUri: string | URI | undefined,
    public readonly code: string
  ) {
    super(typeof messageOrUri === 'string' ? messageOrUri : `${code}: ${messageOrUri?.toString() ?? ''}`);
    this.name = `${code} (FileSystemError)`;
  }
  static FileNotFound(messageOrUri?: string | URI) {
    return new FileSystemError(messageOrUri, 'FileNotFound');
  }
  static FileExists(messageOrUri?: string | URI) {
    return new FileSystemError(messageOrUri, 'FileExists');
  }
  static FileNotADirectory(messageOrUri?: string | URI) {
    return new FileSystemError(messageOrUri, 'FileNotADirectory');
  }
  static FileIsADirectory(messageOrUri?: string | URI) {
    return new FileSystemError(messageOrUri, 'FileIsADirectory');
  }
  static NoPermissions(messageOrUri?: string | URI) {
    return new FileSystemError(messageOrUri, 'NoPermissions');
  }
  static Unavailable(messageOrUri?: string | URI) {
    return new FileSystemError(messageOrUri, 'Unavailable');
  }
}

export class Disposable {
  constructor(private readonly fn: () => void = () => {}) {}
  dispose(): void {
    this.fn();
  }
}

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => void>();
  event = (listener: (e: T) => void) => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) {
      l(e);
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class RelativePattern {
  constructor(
    public readonly baseUri: URI,
    public readonly pattern: string
  ) {}
}

export class TabInputText {
  constructor(public readonly uri: URI) {}
}
export class TabInputCustom {
  constructor(public readonly uri: URI) {}
}
export class TabInputTextDiff {
  constructor(
    public readonly original: URI,
    public readonly modified: URI
  ) {}
}

export interface FileStat {
  type: FileType;
  ctime: number;
  mtime: number;
  size: number;
}

/** The FileSystemProvider methods workspace.fs needs. */
export interface MockFileSystemProvider {
  stat(uri: URI): FileStat | Promise<FileStat>;
  readFile(uri: URI): Uint8Array | Promise<Uint8Array>;
}

const providers = new Map<string, MockFileSystemProvider>();

/** Node fs errors → FileSystemError, like VS Code's disk provider. */
function fromNodeError(error: unknown, uri: URI): FileSystemError {
  const e = error as NodeJS.ErrnoException | undefined;
  switch (e?.code) {
    case 'ENOENT':
      return FileSystemError.FileNotFound(uri);
    case 'EACCES':
    case 'EPERM':
      return FileSystemError.NoPermissions(uri);
    case 'EISDIR':
      return FileSystemError.FileIsADirectory(uri);
    default:
      return new FileSystemError(e?.message ?? String(error), 'Unknown');
  }
}

/** Watchers created through workspace.createFileSystemWatcher, for assertions. */
export const createdWatchers: MockFileSystemWatcher[] = [];

export class MockFileSystemWatcher {
  private created = new EventEmitter<URI>();
  private changed = new EventEmitter<URI>();
  private deleted = new EventEmitter<URI>();
  readonly onDidCreate = this.created.event;
  readonly onDidChange = this.changed.event;
  readonly onDidDelete = this.deleted.event;
  disposed = false;
  constructor(public readonly pattern: RelativePattern) {}
  fireChange(uri: URI): void {
    this.changed.fire(uri);
  }
  fireCreate(uri: URI): void {
    this.created.fire(uri);
  }
  fireDelete(uri: URI): void {
    this.deleted.fire(uri);
  }
  dispose(): void {
    this.disposed = true;
  }
}

export const configuration: Record<string, unknown> = {};
const configListeners = new EventEmitter<{ affectsConfiguration(key: string): boolean }>();

export const workspace = {
  textDocuments: [] as { uri: URI }[],
  fs: {
    async stat(uri: URI): Promise<FileStat> {
      if (uri.scheme === 'file') {
        try {
          const s = await nodeFs.promises.stat(uri.fsPath);
          return {
            type: s.isDirectory() ? FileType.Directory : FileType.File,
            ctime: s.ctimeMs,
            mtime: s.mtimeMs,
            size: s.size
          };
        } catch (error) {
          throw fromNodeError(error, uri);
        }
      }
      const provider = providers.get(uri.scheme);
      if (!provider) {
        throw FileSystemError.Unavailable(`No file system provider for scheme ${uri.scheme}`);
      }
      return provider.stat(uri);
    },
    async readFile(uri: URI): Promise<Uint8Array> {
      if (uri.scheme === 'file') {
        try {
          return await nodeFs.promises.readFile(uri.fsPath);
        } catch (error) {
          throw fromNodeError(error, uri);
        }
      }
      const provider = providers.get(uri.scheme);
      if (!provider) {
        throw FileSystemError.Unavailable(`No file system provider for scheme ${uri.scheme}`);
      }
      return provider.readFile(uri);
    }
  },
  registerFileSystemProvider(scheme: string, provider: MockFileSystemProvider) {
    providers.set(scheme, provider);
    return new Disposable(() => providers.delete(scheme));
  },
  createFileSystemWatcher(pattern: RelativePattern) {
    const watcher = new MockFileSystemWatcher(pattern);
    createdWatchers.push(watcher);
    return watcher;
  },
  getConfiguration(section?: string) {
    return {
      get<T>(key: string, fallback?: T): T {
        const full = section ? `${section}.${key}` : key;
        return (full in configuration ? configuration[full] : fallback) as T;
      }
    };
  },
  onDidChangeConfiguration: configListeners.event
};

/** Messages shown through window.show*Message, for assertions. */
export const shownMessages: { level: string; message: string }[] = [];

export const window = {
  tabGroups: { all: [] as { tabs: { input: unknown }[] }[] },
  async withProgress<T>(
    _options: unknown,
    task: (progress: { report(value: { message?: string }): void }, token: unknown) => Promise<T>
  ): Promise<T> {
    return task({ report: () => {} }, { isCancellationRequested: false });
  },
  async showErrorMessage(message: string) {
    shownMessages.push({ level: 'error', message });
    return undefined;
  },
  async showWarningMessage(message: string) {
    shownMessages.push({ level: 'warning', message });
    return undefined;
  },
  async showInformationMessage(message: string) {
    shownMessages.push({ level: 'info', message });
    return undefined;
  }
};

export const commands = {
  async executeCommand() {
    return undefined;
  }
};
