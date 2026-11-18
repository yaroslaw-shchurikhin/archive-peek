import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { archiveBaseName, describeArchiveId, safeLocalFileName } from './archiveId';
import { ArchiveSourceError, ArchiveTooLargeError, formatBytes, Logger, NULL_LOGGER } from './models';

/** Metadata of a remote file, as reported by `vscode.workspace.fs.stat()`. */
export interface RemoteFileStat {
  size: number;
  /** Modification time in milliseconds since the epoch */
  mtime: number;
  isFile: boolean;
}

/**
 * The subset of the VS Code file system API needed to read remote archives.
 * Implementations must throw ArchiveSourceError so failures can be classified
 * (not found / no permission / connection lost …).
 *
 * In the extension this is backed by `vscode.workspace.fs`; in tests by an
 * in-memory FileSystemProvider that emulates a remote host.
 */
export interface RemoteFileAccess {
  stat(id: string): Promise<RemoteFileStat>;
  readFile(id: string): Promise<Uint8Array>;
}

/** A local copy of a remote archive. */
export interface MaterializedArchive {
  /** Path of the local copy; handlers read this file. */
  localPath: string;
  /** Size of the remote file when it was copied */
  size: number;
  /** Modification time (ms) of the remote file when it was copied */
  mtime: number;
  /** True if the copy was (re)downloaded by this call */
  downloaded: boolean;
  /** True if the remote host could not be reached and the last known copy is returned */
  stale: boolean;
}

export type ProgressReporter = (message: string) => void;

export interface RemoteArchiveCacheOptions {
  /** Base directory for local copies. Defaults to the OS temp directory. */
  baseDir?: string;
  /** Largest remote archive that may be transferred (bytes). */
  maxArchiveBytes?: () => number;
  /** Total size of local copies to keep (bytes). Least recently used copies are deleted first. */
  maxCacheBytes?: () => number;
  logger?: Logger;
}

interface Mirror {
  id: string;
  dir: string;
  localPath: string;
  size: number;
  mtime: number;
  lastUsed: number;
}

const SESSION_PREFIX = 'archive-peek-remote-';
export const DEFAULT_MAX_REMOTE_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_CACHE_BYTES = 2048 * 1024 * 1024;

/**
 * Local, size-bounded cache of remote archives.
 *
 * VS Code's file system API (`workspace.fs.readFile`) can only return a whole
 * file — there is no stable API to stream or range-read a file served by
 * another FileSystemProvider (such as the Remote SSH one). So a remote archive
 * is transferred once over the existing VS Code connection, written to a
 * private directory under the *local* OS temp directory and released from
 * memory. The archive handlers then stream from that local copy exactly as
 * they do for local archives, so opening nested files never re-transfers it.
 *
 * A copy is reused as long as the remote file's size and mtime are unchanged.
 * Copies are deleted when the archive is closed or deleted, when the cache
 * exceeds its size limit (LRU), and when the extension is deactivated. Copies
 * left behind by a crashed VS Code window are removed on the next start.
 *
 * Nothing is ever written to the remote host.
 */
export class RemoteArchiveCache {
  private readonly baseDir: string;
  private sessionDir?: string;
  private sessionDirPromise?: Promise<string>;
  private mirrors = new Map<string, Mirror>();
  private inflight = new Map<string, Promise<MaterializedArchive>>();
  private oversizeAllowed = new Set<string>();
  private evictionListeners = new Set<(localPath: string) => void>();
  private disposed = false;
  private readonly logger: Logger;
  private readonly exitHandler = () => this.dispose();

  constructor(
    private readonly access: RemoteFileAccess,
    private readonly options: RemoteArchiveCacheOptions = {}
  ) {
    this.baseDir = options.baseDir ?? os.tmpdir();
    this.logger = options.logger ?? NULL_LOGGER;
    process.once('exit', this.exitHandler);
  }

  private get maxArchiveBytes(): number {
    return this.options.maxArchiveBytes?.() ?? DEFAULT_MAX_REMOTE_ARCHIVE_BYTES;
  }

  private get maxCacheBytes(): number {
    return this.options.maxCacheBytes?.() ?? DEFAULT_MAX_CACHE_BYTES;
  }

  /** Called with the local path of every copy that is deleted, so handlers can drop their indexes. */
  onDidEvict(listener: (localPath: string) => void): { dispose(): void } {
    this.evictionListeners.add(listener);
    return { dispose: () => this.evictionListeners.delete(listener) };
  }

  /** Stat the remote file; rejects directories and other non-files. */
  async stat(id: string): Promise<RemoteFileStat> {
    const stat = await this.access.stat(id);
    if (!stat.isFile) {
      throw new ArchiveSourceError('not-a-file', 'The selected resource is not a file.');
    }
    return stat;
  }

  /** Allow a single archive to exceed the size limit (the user explicitly asked to load it). */
  allowOversize(id: string): void {
    this.oversizeAllowed.add(id);
  }

  /**
   * Return an up-to-date local copy of a remote archive, transferring it if
   * there is no copy yet or the remote file changed.
   *
   * With `allowStale`, a connection failure returns the last known copy
   * (marked `stale`) instead of failing, so already-open archives keep working
   * while the SSH connection is re-established.
   */
  async materialize(
    id: string,
    options: { allowStale?: boolean; onProgress?: ProgressReporter } = {}
  ): Promise<MaterializedArchive> {
    this.assertNotDisposed();
    let stat: RemoteFileStat;
    try {
      stat = await this.stat(id);
    } catch (error) {
      const existing = this.mirrors.get(id);
      if (
        options.allowStale &&
        existing &&
        error instanceof ArchiveSourceError &&
        error.kind === 'unavailable' &&
        (await exists(existing.localPath))
      ) {
        this.logger.warn(
          `Remote host unreachable for ${this.describe(id)}; using the cached local copy (${error.message})`
        );
        existing.lastUsed = Date.now();
        return { ...this.result(existing, false), stale: true };
      }
      throw error;
    }

    const existing = this.mirrors.get(id);
    if (
      existing &&
      existing.size === stat.size &&
      existing.mtime === stat.mtime &&
      (await exists(existing.localPath))
    ) {
      existing.lastUsed = Date.now();
      return this.result(existing, false);
    }

    const key = `${id}\0${stat.size}\0${stat.mtime}`;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.download(id, stat, options.onProgress).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  /** Delete the local copy of an archive (it was closed or deleted). */
  release(id: string): void {
    const mirror = this.mirrors.get(id);
    this.oversizeAllowed.delete(id);
    if (!mirror) {
      return;
    }
    this.mirrors.delete(id);
    this.removeMirror(mirror);
  }

  /** Local path of the current copy, if any (for diagnostics and tests). */
  localPathOf(id: string): string | undefined {
    return this.mirrors.get(id)?.localPath;
  }

  /** Total bytes of local copies currently kept. */
  get totalBytes(): number {
    let total = 0;
    for (const m of this.mirrors.values()) {
      total += m.size;
    }
    return total;
  }

  /** Directory holding this session's copies (created lazily). */
  get directory(): string | undefined {
    return this.sessionDir;
  }

  /** Delete all local copies. Synchronous so it also works from `process.on('exit')`. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    process.removeListener('exit', this.exitHandler);
    for (const mirror of this.mirrors.values()) {
      this.notifyEvicted(mirror.localPath);
    }
    this.mirrors.clear();
    if (this.sessionDir) {
      try {
        fs.rmSync(this.sessionDir, { recursive: true, force: true });
      } catch (error: any) {
        this.logger.warn(`Could not delete temporary directory ${this.sessionDir}: ${error.message}`);
      }
    }
  }

  /**
   * Remove copies left behind by extension hosts that no longer run
   * (e.g. after a crash). Directories of live processes are left alone.
   */
  static async cleanupStale(baseDir: string = os.tmpdir(), logger: Logger = NULL_LOGGER): Promise<number> {
    let removed = 0;
    let names: string[];
    try {
      names = await fs.promises.readdir(baseDir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const m = /^archive-peek-remote-(\d+)-/.exec(name);
      if (!m) {
        continue;
      }
      const pid = Number(m[1]);
      if (pid === process.pid || isProcessAlive(pid)) {
        continue;
      }
      try {
        await fs.promises.rm(path.join(baseDir, name), { recursive: true, force: true });
        removed++;
      } catch (error: any) {
        logger.warn(`Could not delete stale temporary directory ${name}: ${error.message}`);
      }
    }
    if (removed > 0) {
      logger.info(`Removed ${removed} stale temporary director${removed === 1 ? 'y' : 'ies'} from a previous session`);
    }
    return removed;
  }

  // ─── internals ──────────────────────────────────────────────────────

  private async download(
    id: string,
    stat: RemoteFileStat,
    onProgress?: ProgressReporter
  ): Promise<MaterializedArchive> {
    const limit = this.maxArchiveBytes;
    if (stat.size > limit && !this.oversizeAllowed.has(id)) {
      throw new ArchiveTooLargeError(stat.size, limit);
    }

    this.makeRoom(id, stat.size);

    onProgress?.(`Transferring ${formatBytes(stat.size)} over the remote connection…`);
    this.logger.info(`Transferring ${this.describe(id)} (${formatBytes(stat.size)}) via vscode.workspace.fs.readFile`);
    const started = Date.now();
    let data: Uint8Array | undefined = await this.access.readFile(id);
    const elapsed = Date.now() - started;
    this.assertNotDisposed();

    let size = stat.size;
    let mtime = stat.mtime;
    if (data.byteLength !== stat.size) {
      // The file changed while it was being read. Use what was read and the
      // newest metadata, so the next check detects any further change.
      this.logger.warn(
        `Size of ${this.describe(id)} changed during transfer (${stat.size} → ${data.byteLength} bytes); the archive is being rewritten?`
      );
      const fresh = await this.stat(id).catch(() => undefined);
      size = data.byteLength;
      mtime = fresh && fresh.size === data.byteLength ? fresh.mtime : -1;
      if (size > limit && !this.oversizeAllowed.has(id)) {
        data = undefined;
        throw new ArchiveTooLargeError(size, limit);
      }
    }
    this.logger.info(
      `Transferred ${formatBytes(size)} in ${elapsed} ms (${formatRate(size, elapsed)}) for ${this.describe(id)}`
    );

    onProgress?.('Writing local cache copy…');
    const sessionDir = await this.ensureSessionDir();
    const dir = await fs.promises.mkdtemp(path.join(sessionDir, 'a-'));
    const localPath = path.join(dir, safeLocalFileName(archiveBaseName(id)));
    if (path.dirname(localPath) !== dir) {
      throw new Error('Refusing to write outside of the temporary directory');
    }
    try {
      await fs.promises.writeFile(localPath, data, { mode: 0o600, flag: 'wx' });
      data = undefined; // release the transferred bytes as early as possible
      if (mtime > 0) {
        // Keep the remote modification time so handlers report it for entries
        await fs.promises.utimes(localPath, new Date(mtime), new Date(mtime)).catch(() => undefined);
      }
    } catch (error) {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    if (this.disposed) {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      this.assertNotDisposed();
    }

    const previous = this.mirrors.get(id);
    const mirror: Mirror = { id, dir, localPath, size, mtime, lastUsed: Date.now() };
    this.mirrors.set(id, mirror);
    if (previous) {
      this.removeMirror(previous);
    }
    this.makeRoom(id, 0);
    return this.result(mirror, true);
  }

  /** Evict least recently used copies (other than `keepId`) so `incoming` more bytes fit. */
  private makeRoom(keepId: string, incoming: number): void {
    const max = this.maxCacheBytes;
    // The copy being (re)placed counts with its new size; any older copy of it is about to be replaced
    let total = incoming > 0 ? incoming : (this.mirrors.get(keepId)?.size ?? 0);
    for (const m of this.mirrors.values()) {
      if (m.id !== keepId) {
        total += m.size;
      }
    }
    if (total <= max) {
      return;
    }
    const candidates = [...this.mirrors.values()]
      .filter((m) => m.id !== keepId)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const mirror of candidates) {
      if (total <= max) {
        break;
      }
      this.mirrors.delete(mirror.id);
      total -= mirror.size;
      this.logger.info(`Cache limit reached; deleted local copy of ${this.describe(mirror.id)}`);
      this.removeMirror(mirror);
    }
  }

  private removeMirror(mirror: Mirror): void {
    this.notifyEvicted(mirror.localPath);
    fs.promises.rm(mirror.dir, { recursive: true, force: true }).catch((error) => {
      this.logger.warn(`Could not delete temporary copy ${mirror.localPath}: ${error.message}`);
    });
  }

  private notifyEvicted(localPath: string): void {
    for (const listener of [...this.evictionListeners]) {
      try {
        listener(localPath);
      } catch {
        // listeners must not break eviction
      }
    }
  }

  private ensureSessionDir(): Promise<string> {
    if (this.sessionDir) {
      return Promise.resolve(this.sessionDir);
    }
    if (!this.sessionDirPromise) {
      this.sessionDirPromise = fs.promises
        .mkdtemp(path.join(this.baseDir, `${SESSION_PREFIX}${process.pid}-`))
        .then((dir) => {
          this.sessionDir = dir;
          this.logger.info(`Local cache directory for remote archives: ${dir}`);
          return dir;
        });
    }
    return this.sessionDirPromise;
  }

  private result(mirror: Mirror, downloaded: boolean): MaterializedArchive {
    return { localPath: mirror.localPath, size: mirror.size, mtime: mirror.mtime, downloaded, stale: false };
  }

  private describe(id: string): string {
    return describeArchiveId(id, { redactHost: true });
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('The remote archive cache has been disposed');
    }
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error.code === 'EPERM';
  }
}

function formatRate(bytes: number, ms: number): string {
  if (ms <= 0) {
    return 'instant';
  }
  return `${formatBytes((bytes / ms) * 1000)}/s`;
}
