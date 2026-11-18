import { URI } from 'vscode-uri';
import { EventEmitter, FileChangeType, FileStat, FileSystemError, FileType } from './mocks/vscode';

interface FakeFile {
  data: Uint8Array;
  mtime: number;
  ctime: number;
}

/**
 * In-memory FileSystemProvider emulating a remote host reached through
 * VS Code Remote SSH (`vscode-remote://ssh-remote+<host>/…`).
 *
 * It implements the provider side of the API (stat / readFile / writeFile /
 * watch …) and can simulate a lost connection, permission errors and remote
 * changes. Calls are counted so tests can assert that archives are transferred
 * only when needed and that nothing is ever written to the remote side.
 *
 * This is an emulation for automated tests only — it does not replace a test
 * against a real Remote SSH connection.
 */
export class FakeRemoteFileSystemProvider {
  private files = new Map<string, FakeFile>();
  private denied = new Set<string>();
  private changeEmitter = new EventEmitter<{ type: FileChangeType; uri: URI }[]>();
  readonly onDidChangeFile = this.changeEmitter.event;

  connected = true;
  readFileCalls = 0;
  statCalls = 0;
  /** Writes attempted by the code under test (must stay 0). */
  writeCalls = 0;
  private clock = Date.UTC(2026, 0, 1);

  /**
   * @param authority Connection name. Compared case-sensitively, like providers
   *   that look up configured connections by name.
   * @param scheme URI scheme served by this provider.
   * @param unknownAuthority Error for a URI whose authority doesn't match any
   *   connection. Some third-party providers answer NoPermissions here.
   */
  constructor(
    readonly authority = 'ssh-remote+test-host',
    readonly scheme = 'vscode-remote',
    private readonly unknownAuthority: 'Unavailable' | 'NoPermissions' = 'Unavailable'
  ) {}

  /** URI of a path on the emulated host. */
  uri(path: string): URI {
    return URI.from({ scheme: this.scheme, authority: this.authority, path });
  }

  /** Test setup: place a file on the emulated host (bumps its mtime). */
  setFile(path: string, data: Uint8Array | string): URI {
    const bytes = typeof data === 'string' ? Buffer.from(data) : data;
    this.clock += 1000;
    const existing = this.files.get(path);
    this.files.set(path, { data: bytes, mtime: this.clock, ctime: existing?.ctime ?? this.clock });
    const uri = this.uri(path);
    this.changeEmitter.fire([{ type: existing ? FileChangeType.Changed : FileChangeType.Created, uri }]);
    return uri;
  }

  /** Test setup: remove a file from the emulated host. */
  removeFile(path: string): void {
    this.files.delete(path);
    this.changeEmitter.fire([{ type: FileChangeType.Deleted, uri: this.uri(path) }]);
  }

  deny(path: string): void {
    this.denied.add(path);
  }

  allow(path: string): void {
    this.denied.delete(path);
  }

  private check(uri: URI): void {
    if (uri.authority !== this.authority) {
      throw this.unknownAuthority === 'NoPermissions'
        ? FileSystemError.NoPermissions(`No connection configured for "${uri.authority}"`)
        : FileSystemError.Unavailable(`Unknown remote ${uri.authority}`);
    }
    if (!this.connected) {
      // What VS Code reports while the SSH connection is down
      throw FileSystemError.Unavailable('Connection to the remote extension host was closed');
    }
    if (this.denied.has(uri.path)) {
      throw FileSystemError.NoPermissions(uri);
    }
  }

  // ─── FileSystemProvider API ─────────────────────────────────────────

  watch(): { dispose(): void } {
    return { dispose: () => {} };
  }

  stat(uri: URI): FileStat {
    this.statCalls++;
    this.check(uri);
    const file = this.files.get(uri.path);
    if (file) {
      return { type: FileType.File, ctime: file.ctime, mtime: file.mtime, size: file.data.byteLength };
    }
    const prefix = uri.path.endsWith('/') ? uri.path : `${uri.path}/`;
    if ([...this.files.keys()].some((p) => p.startsWith(prefix))) {
      return { type: FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    throw FileSystemError.FileNotFound(uri);
  }

  readFile(uri: URI): Uint8Array {
    this.readFileCalls++;
    this.check(uri);
    const file = this.files.get(uri.path);
    if (!file) {
      if (this.stat(uri).type === FileType.Directory) {
        throw FileSystemError.FileIsADirectory(uri);
      }
      throw FileSystemError.FileNotFound(uri);
    }
    // Return a copy, like a real transfer would
    return new Uint8Array(file.data);
  }

  readDirectory(): [string, FileType][] {
    return [];
  }

  writeFile(): void {
    this.writeCalls++;
    throw FileSystemError.NoPermissions('The emulated remote host is read-only for the code under test');
  }

  createDirectory(): void {
    this.writeCalls++;
    throw FileSystemError.NoPermissions('read-only');
  }

  delete(): void {
    this.writeCalls++;
    throw FileSystemError.NoPermissions('read-only');
  }

  rename(): void {
    this.writeCalls++;
    throw FileSystemError.NoPermissions('read-only');
  }

  /** Paths of all files on the emulated host. */
  listPaths(): string[] {
    return [...this.files.keys()].sort();
  }
}
