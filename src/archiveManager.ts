import * as fs from 'fs';
import {
  ArchiveChangedError,
  ArchiveEntry,
  ArchiveSourceError,
  EntryTooLargeError,
  IArchiveHandler,
  ArchiveType,
  formatBytes,
  Logger,
  NULL_LOGGER
} from './models';
import { BufferCache } from './bufferCache';
import { archivePathPart, describeArchiveId, isRemoteId, normalizeArchiveId } from './archiveId';
import { ProgressReporter, RemoteArchiveCache } from './remoteArchiveCache';
import { toSourceError } from './sourceErrors';
import {
  ZipHandler,
  TarHandler,
  TarGzHandler,
  TarBz2Handler,
  TarXzHandler,
  GzHandler,
  Bz2Handler,
  XzHandler,
  RarHandler,
  SevenZipHandler
} from './handlers';

/**
 * Represents a currently-opened archive with its resolved entries
 * organized into a tree structure.
 */
export interface OpenArchive {
  /**
   * Archive id: the absolute path of a local archive, or the full URI string
   * of a remote one (see archiveId.ts).
   */
  filePath: string;
  /** Where the archive lives: read with Node `fs`, or through the VS Code file system API */
  source: 'local' | 'remote';
  /** The detected archive type */
  type: ArchiveType;
  /** Flat list of all entries */
  entries: ArchiveEntry[];
  /** Modification time (ms) of the archive file on disk when it was last read */
  diskMtime: number;
  /** Size (bytes) of the archive file on disk when it was last read */
  diskSize: number;
}

/** Safety limits (archive bomb protection). */
export interface ArchiveLimits {
  /** Maximum number of entries listed per archive */
  maxEntries: number;
  /** Maximum uncompressed size of a single entry that may be opened */
  maxEntryBytes: number;
}

export const DEFAULT_LIMITS: ArchiveLimits = {
  maxEntries: 500_000,
  maxEntryBytes: 256 * 1024 * 1024
};

export interface ArchiveManagerOptions {
  /** Access to non-`file:` archives. Without it, remote archive ids are rejected. */
  remote?: RemoteArchiveCache;
  logger?: Logger;
  limits?: () => Partial<ArchiveLimits>;
}

export interface OpenOptions {
  onProgress?: ProgressReporter;
}

/** Result of probing an archive's file: used by the watcher to tell "deleted" from "connection lost". */
export type ProbeResult = 'exists' | 'missing' | 'unavailable';

/**
 * Lifecycle event for an archive tracked by the ArchiveManager.
 *
 * - `opened`:  the archive was read for the first time
 * - `changed`: the archive was re-read after changing on disk (or a manual refresh)
 * - `deleted`: the archive file disappeared from disk
 * - `closed`:  the archive was explicitly closed by the user
 */
export type ArchiveChangeEvent =
  | { type: 'opened'; filePath: string; archive: OpenArchive }
  | { type: 'changed'; filePath: string; archive: OpenArchive; previousEntries: ArchiveEntry[] }
  | { type: 'deleted'; filePath: string; previousEntries: ArchiveEntry[] }
  | { type: 'closed'; filePath: string };

export type ArchiveChangeListener = (event: ArchiveChangeEvent) => void;

/**
 * Central service that manages opened archives and delegates
 * to the correct handler for each archive type.
 */
export class ArchiveManager {
  private handlers: IArchiveHandler[] = [];
  private openArchives: Map<string, OpenArchive> = new Map();
  /** LRU cache for file content buffers (default 50 MB cap). */
  private bufferCache = new BufferCache();
  private listeners = new Set<ArchiveChangeListener>();
  /** Per-archive refresh counter so a slow, superseded refresh can't overwrite a newer one. */
  private refreshGeneration = new Map<string, number>();
  private readonly remote?: RemoteArchiveCache;
  private readonly logger: Logger;
  private readonly getLimits: () => Partial<ArchiveLimits>;

  constructor(options: ArchiveManagerOptions = {}) {
    this.remote = options.remote;
    this.logger = options.logger ?? NULL_LOGGER;
    this.getLimits = options.limits ?? (() => ({}));
    // When a local copy of a remote archive is deleted, handlers must drop
    // any index they built for that copy's path.
    this.remote?.onDidEvict((localPath) => {
      for (const handler of this.handlers) {
        handler.dispose?.(localPath);
      }
    });

    this.handlers.push(new ZipHandler());
    this.handlers.push(new TarHandler());
    this.handlers.push(new TarGzHandler());
    this.handlers.push(new TarBz2Handler());
    this.handlers.push(new TarXzHandler());
    this.handlers.push(new GzHandler());
    this.handlers.push(new Bz2Handler());
    this.handlers.push(new XzHandler());
    this.handlers.push(new RarHandler());
    this.handlers.push(new SevenZipHandler());
  }

  /**
   * Subscribe to archive lifecycle events. Returns a disposable-like handle.
   */
  onDidChangeArchive(listener: ArchiveChangeListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private emit(event: ArchiveChangeEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  private get limits(): ArchiveLimits {
    return { ...DEFAULT_LIMITS, ...this.getLimits() };
  }

  /**
   * Detect the archive type from a file path or remote archive URI.
   */
  getArchiveType(filePath: string): ArchiveType | undefined {
    const lower = archivePathPart(filePath).toLowerCase();
    if (
      lower.endsWith('.zip') ||
      lower.endsWith('.jar') ||
      lower.endsWith('.war') ||
      lower.endsWith('.ear') ||
      lower.endsWith('.vsix') ||
      lower.endsWith('.nupkg') ||
      lower.endsWith('.apk') ||
      lower.endsWith('.whl') ||
      lower.endsWith('.xpi') ||
      lower.endsWith('.epub') ||
      lower.endsWith('.aar')
    ) {
      return 'zip';
    }
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      return 'tar.gz';
    }
    if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) {
      return 'tar.bz2';
    }
    if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) {
      return 'tar.xz';
    }
    if (lower.endsWith('.tar')) {
      return 'tar';
    }
    if (lower.endsWith('.rar')) {
      return 'rar';
    }
    if (lower.endsWith('.7z')) {
      return '7z';
    }
    if (lower.endsWith('.gz')) {
      return 'gz';
    }
    if (lower.endsWith('.bz2')) {
      return 'bz2';
    }
    if (lower.endsWith('.xz')) {
      return 'xz';
    }
    return undefined;
  }

  /**
   * Check if a file path is a supported archive.
   */
  isSupported(filePath: string): boolean {
    return this.getArchiveType(filePath) !== undefined;
  }

  /**
   * Get the handler for a given file path.
   */
  private getHandler(filePath: string): IArchiveHandler {
    const name = archivePathPart(filePath);
    for (const handler of this.handlers) {
      if (handler.supports(name)) {
        return handler;
      }
    }
    throw new Error(`No handler found for: ${filePath}`);
  }

  /**
   * Open an archive: list its entries and cache them.
   */
  async openArchive(filePath: string, options: OpenOptions = {}): Promise<OpenArchive> {
    const absPath = normalizeArchiveId(filePath);
    const existing = this.openArchives.get(absPath);
    if (existing) {
      return existing;
    }

    const archiveType = this.getArchiveType(absPath);
    if (!archiveType) {
      throw new Error(`Unsupported archive format: ${absPath}`);
    }

    let pending = this.pendingOpens.get(absPath);
    if (!pending) {
      // Concurrent opens of the same archive (custom editor + archive:// stat
      // calls) share one load, so a remote archive is transferred only once.
      pending = this.loadArchive(absPath, archiveType, options).finally(() => this.pendingOpens.delete(absPath));
      this.pendingOpens.set(absPath, pending);
    }
    const archive = await pending;
    const raced = this.openArchives.get(absPath);
    if (raced) {
      return raced;
    }
    this.openArchives.set(absPath, archive);
    this.emit({ type: 'opened', filePath: absPath, archive });
    return archive;
  }

  private pendingOpens = new Map<string, Promise<OpenArchive>>();

  /** True if the id refers to an archive read through the VS Code file system API. */
  isRemote(filePath: string): boolean {
    return isRemoteId(filePath);
  }

  /** Remote access layer, if configured. */
  private requireRemote(id: string): RemoteArchiveCache {
    if (!this.remote) {
      throw new ArchiveSourceError(
        'unavailable',
        `Remote archives are not supported in this context: ${describeArchiveId(id, { redactHost: true })}`
      );
    }
    return this.remote;
  }

  /** Allow one remote archive to exceed archivePeek.remote.maxArchiveSizeMB. */
  allowOversize(filePath: string): void {
    this.remote?.allowOversize(normalizeArchiveId(filePath));
  }

  /** Current size and mtime of the archive file, local or remote. */
  async statSource(filePath: string): Promise<{ size: number; mtime: number }> {
    const id = normalizeArchiveId(filePath);
    if (isRemoteId(id)) {
      const stat = await this.requireRemote(id).stat(id);
      return { size: stat.size, mtime: stat.mtime };
    }
    try {
      const stat = await fs.promises.stat(id);
      if (!stat.isFile()) {
        throw new ArchiveSourceError('not-a-file', 'The selected resource is not a file.');
      }
      return { size: stat.size, mtime: stat.mtimeMs };
    } catch (error) {
      throw toSourceError(error, 'stat');
    }
  }

  /** Check whether the archive file still exists, distinguishing a lost connection from a deletion. */
  async probe(filePath: string): Promise<ProbeResult> {
    try {
      await this.statSource(filePath);
      return 'exists';
    } catch (error) {
      const kind = error instanceof ArchiveSourceError ? error.kind : 'unknown';
      if (kind === 'not-found' || kind === 'not-a-file') {
        return 'missing';
      }
      if (!isRemoteId(normalizeArchiveId(filePath))) {
        // Previous behaviour for local files: anything that can't be stat'ed is gone
        return 'missing';
      }
      return 'unavailable';
    }
  }

  /**
   * Read the archive's disk metadata and entry list.
   */
  private async loadArchive(
    absPath: string,
    archiveType: ArchiveType,
    options: OpenOptions = {}
  ): Promise<OpenArchive> {
    const handler = this.getHandler(absPath);
    const listOptions = { maxEntries: this.limits.maxEntries };

    if (isRemoteId(absPath)) {
      const started = Date.now();
      const copy = await this.requireRemote(absPath).materialize(absPath, { onProgress: options.onProgress });
      const transferred = Date.now();
      options.onProgress?.('Reading archive index…');
      const entries = await handler.listEntries(copy.localPath, listOptions);
      this.logger.info(
        `Indexed remote ${archiveType} archive ${describeArchiveId(absPath, { redactHost: true })}: ` +
          `${entries.length} entries, ${formatBytes(copy.size)}, ` +
          `${copy.downloaded ? `transfer ${transferred - started} ms` : 'local copy reused'}, index ${Date.now() - transferred} ms`
      );
      return {
        filePath: absPath,
        source: 'remote',
        type: archiveType,
        entries,
        diskMtime: copy.mtime,
        diskSize: copy.size
      };
    }

    const started = Date.now();
    let diskStat: fs.Stats;
    try {
      diskStat = await fs.promises.stat(absPath);
    } catch (error) {
      throw toSourceError(error, 'stat');
    }
    const entries = await handler.listEntries(absPath, listOptions);
    this.logger.trace(
      `Indexed local ${archiveType} archive ${absPath}: ${entries.length} entries, ${formatBytes(diskStat.size)}, ${Date.now() - started} ms`
    );
    return {
      filePath: absPath,
      source: 'local',
      type: archiveType,
      entries,
      diskMtime: diskStat.mtimeMs,
      diskSize: diskStat.size
    };
  }

  /**
   * Drop cached buffers and handler state for an archive. The local copy of a
   * remote archive is kept on refresh (it is reused if the remote file is
   * unchanged) and deleted otherwise.
   */
  private releaseResources(absPath: string, options: { keepRemoteCopy?: boolean } = {}): void {
    this.bufferCache.evictArchive(absPath);
    for (const handler of this.handlers) {
      if (handler.dispose) {
        handler.dispose(absPath);
      }
    }
    if (!options.keepRemoteCopy && isRemoteId(absPath)) {
      this.remote?.release(absPath);
    }
  }

  /**
   * Read a single file's contents from an archive.
   * Results are cached in an LRU buffer cache to avoid re-reading.
   */
  async readEntry(archivePath: string, entryPath: string): Promise<Buffer> {
    const absPath = normalizeArchiveId(archivePath);

    // Check cache first
    const cached = this.bufferCache.get(absPath, entryPath);
    if (cached) {
      return cached;
    }

    if (isRemoteId(absPath)) {
      return this.readRemoteEntry(absPath, entryPath);
    }

    this.checkEntrySize(absPath, entryPath);
    const handler = this.getHandler(absPath);

    // Provide a callback so streaming handlers (tar) can opportunistically
    // cache small files they encounter while scanning for the target entry.
    const onExtraEntry = (extraPath: string, data: Buffer) => {
      this.bufferCache.set(absPath, extraPath, data);
    };

    let buffer: Buffer;
    try {
      buffer = await handler.readEntry(absPath, entryPath, onExtraEntry);
    } catch (error) {
      if (!(error instanceof ArchiveChangedError)) {
        throw error;
      }
      // The archive changed since it was listed (e.g. the watcher hasn't
      // caught up yet). Re-read it so listeners see the new contents, then retry once.
      if (this.openArchives.has(absPath)) {
        await this.refreshArchive(absPath);
      } else {
        this.releaseResources(absPath);
      }
      buffer = await handler.readEntry(absPath, entryPath, onExtraEntry);
    }

    // Cache the requested result
    this.bufferCache.set(absPath, entryPath, buffer);
    return buffer;
  }

  /** Refuse to decompress entries above archivePeek.maxEntrySizeMB (uses the size from the listing). */
  private checkEntrySize(absPath: string, entryPath: string): void {
    const archive = this.openArchives.get(absPath);
    const entry = archive?.entries.find((e) => !e.isDirectory && e.path === entryPath);
    const limit = this.limits.maxEntryBytes;
    if (entry && entry.size > limit) {
      throw new EntryTooLargeError(entryPath, entry.size, limit);
    }
  }

  /**
   * Read an entry of a remote archive from its local copy. The remote file is
   * stat'ed first (one cheap round trip); if it changed since it was listed,
   * the archive is refreshed before reading so the entry list and the
   * contents always come from the same version. If the connection is lost,
   * the last local copy is used.
   */
  private async readRemoteEntry(absPath: string, entryPath: string): Promise<Buffer> {
    const remote = this.requireRemote(absPath);
    let archive = this.openArchives.get(absPath) ?? (await this.openArchive(absPath));

    let copy = await remote.materialize(absPath, { allowStale: true });
    if (!copy.stale && (copy.size !== archive.diskSize || copy.mtime !== archive.diskMtime)) {
      this.logger.info(
        `Remote archive changed since it was listed; refreshing ${describeArchiveId(absPath, { redactHost: true })}`
      );
      archive = (await this.refreshArchive(absPath)) ?? archive;
      copy = await remote.materialize(absPath, { allowStale: true });
    }

    this.checkEntrySize(absPath, entryPath);
    const handler = this.getHandler(absPath);
    const started = Date.now();
    const buffer = await handler.readEntry(copy.localPath, entryPath, (extraPath, data) => {
      this.bufferCache.set(absPath, extraPath, data);
    });
    this.logger.trace(
      `Read ${formatBytes(buffer.length)} entry from remote archive local copy in ${Date.now() - started} ms`
    );
    this.bufferCache.set(absPath, entryPath, buffer);
    return buffer;
  }

  /**
   * Close an opened archive.
   */
  closeArchive(filePath: string): void {
    const absPath = normalizeArchiveId(filePath);
    this.openArchives.delete(absPath);
    this.releaseResources(absPath);
    this.emit({ type: 'closed', filePath: absPath });
  }

  /**
   * Forget an archive whose file was deleted from disk.
   */
  markDeleted(filePath: string): void {
    const absPath = normalizeArchiveId(filePath);
    const existing = this.openArchives.get(absPath);
    if (!existing) {
      return;
    }
    this.openArchives.delete(absPath);
    this.refreshGeneration.set(absPath, (this.refreshGeneration.get(absPath) ?? 0) + 1);
    this.releaseResources(absPath);
    this.emit({ type: 'deleted', filePath: absPath, previousEntries: existing.entries });
  }

  /**
   * Get all currently opened archives.
   */
  getOpenArchives(): OpenArchive[] {
    return Array.from(this.openArchives.values());
  }

  /**
   * Get a specific opened archive.
   */
  getArchive(filePath: string): OpenArchive | undefined {
    return this.openArchives.get(normalizeArchiveId(filePath));
  }

  /**
   * Refresh an already-opened archive (re-read entries).
   *
   * If the archive can't be read (e.g. it's still being written), the
   * previous entries are kept and the error is rethrown.
   */
  async refreshArchive(filePath: string, options: OpenOptions = {}): Promise<OpenArchive | undefined> {
    const absPath = normalizeArchiveId(filePath);
    const previous = this.openArchives.get(absPath);
    if (!previous) {
      return undefined;
    }

    const generation = (this.refreshGeneration.get(absPath) ?? 0) + 1;
    this.refreshGeneration.set(absPath, generation);

    // Release handler caches first so the re-read sees the new file contents
    this.releaseResources(absPath, { keepRemoteCopy: true });
    const archive = await this.loadArchive(absPath, previous.type, options);

    if (this.refreshGeneration.get(absPath) !== generation || !this.openArchives.has(absPath)) {
      // Superseded by a newer refresh, or closed/deleted while we were reading
      return this.openArchives.get(absPath);
    }

    this.openArchives.set(absPath, archive);
    // Drop anything cached from the old file while the re-read was in flight
    this.bufferCache.evictArchive(absPath);
    this.emit({ type: 'changed', filePath: absPath, archive, previousEntries: previous.entries });
    return archive;
  }

  /**
   * Re-read an archive only if its size or mtime on disk differs from what
   * was last read. Also re-opens an archive previously marked as deleted
   * that has reappeared. Returns true if the archive was reloaded.
   */
  async refreshIfChanged(filePath: string): Promise<boolean> {
    const absPath = normalizeArchiveId(filePath);
    const diskStat = await this.statSource(absPath);
    const existing = this.openArchives.get(absPath);

    if (!existing) {
      const archive = await this.openArchive(absPath);
      this.emit({ type: 'changed', filePath: absPath, archive, previousEntries: [] });
      return true;
    }

    if (existing.diskMtime === diskStat.mtime && existing.diskSize === diskStat.size) {
      return false;
    }
    await this.refreshArchive(absPath);
    return true;
  }

  /**
   * Get child entries for a given directory path within an archive.
   */
  getChildren(archive: OpenArchive, parentPath: string): ArchiveEntry[] {
    const normalizedParent = parentPath === '' ? '' : parentPath.endsWith('/') ? parentPath : parentPath + '/';

    return archive.entries.filter((entry) => {
      const entryDir = entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path;

      if (normalizedParent === '') {
        // Root level: entries with no slashes (or directory entries at root)
        const slashCount = entryDir.split('/').length;
        return slashCount === 1;
      } else {
        // Only direct children of parentPath
        if (!entry.path.startsWith(normalizedParent)) {
          return false;
        }
        const relative = entry.path.slice(normalizedParent.length).replace(/\/$/, '');
        return relative.length > 0 && !relative.includes('/');
      }
    });
  }
}
