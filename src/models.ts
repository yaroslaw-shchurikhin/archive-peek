/**
 * Common types and interfaces for the Archive Peek extension.
 */

/** Represents a single entry (file or directory) inside an archive */
export interface ArchiveEntry {
  /** Full path within the archive (e.g. "src/index.ts") */
  path: string;
  /** Just the file/folder name */
  name: string;
  /** Whether this entry is a directory */
  isDirectory: boolean;
  /** Uncompressed size in bytes */
  size: number;
  /** Compressed size in bytes (if available) */
  compressedSize?: number;
  /** Last modification time */
  modifiedTime?: Date;
}

/** Supported archive types */
export type ArchiveType = 'zip' | '7z' | 'rar' | 'tar' | 'tar.gz' | 'tar.bz2' | 'tar.xz' | 'gz' | 'bz2' | 'xz';

/** Callback to opportunistically cache files encountered while streaming */
export type StreamCacheCallback = (entryPath: string, data: Buffer) => void;

/** Interface that all archive handlers must implement */
export interface IArchiveHandler {
  /** List all entries in the archive */
  listEntries(archivePath: string, options?: ListOptions): Promise<ArchiveEntry[]>;
  /** Read the contents of a specific file entry */
  readEntry(archivePath: string, entryPath: string, onExtraEntry?: StreamCacheCallback): Promise<Buffer>;
  /** Check whether this handler supports the given file */
  supports(filePath: string): boolean;
  /** Optional: release any cached resources for a specific archive */
  dispose?(archivePath: string): void;
}

/**
 * Thrown by a handler when the archive on disk no longer matches the state
 * it was listed from (size or mtime changed), so cached offsets can't be trusted.
 */
export class ArchiveChangedError extends Error {
  constructor(archivePath: string) {
    super(`Archive changed on disk: ${archivePath}`);
    this.name = 'ArchiveChangedError';
  }
}

/** Options passed to IArchiveHandler.listEntries. */
export interface ListOptions {
  /** Abort listing with TooManyEntriesError once more than this many entries were seen. */
  maxEntries?: number;
}

/** Thrown when an archive has more entries than the configured limit (archive bomb protection). */
export class TooManyEntriesError extends Error {
  constructor(public readonly limit: number) {
    super(`The archive contains more than ${limit.toLocaleString('en-US')} entries (archivePeek.maxEntries).`);
    this.name = 'TooManyEntriesError';
  }
}

/** Thrown when a single entry is larger than the configured limit. */
export class EntryTooLargeError extends Error {
  constructor(
    public readonly entryPath: string,
    public readonly size: number,
    public readonly limit: number
  ) {
    super(
      `"${entryPath}" is ${formatBytes(size)} uncompressed, which exceeds the ${formatBytes(limit)} limit (archivePeek.maxEntrySizeMB).`
    );
    this.name = 'EntryTooLargeError';
  }
}

/** Kind of failure when accessing the archive file itself (local or remote). */
export type SourceErrorKind = 'not-found' | 'no-permission' | 'unavailable' | 'too-large' | 'not-a-file' | 'unknown';

/**
 * Failure to access the archive file itself, as opposed to a failure to parse it.
 * `kind` drives both the user-facing message and how the watcher reacts
 * (e.g. `unavailable` must not be treated as "deleted").
 */
export class ArchiveSourceError extends Error {
  constructor(
    public readonly kind: SourceErrorKind,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ArchiveSourceError';
  }
}

/** Thrown when a remote archive exceeds archivePeek.remote.maxArchiveSizeMB. */
export class ArchiveTooLargeError extends ArchiveSourceError {
  constructor(
    public readonly size: number,
    public readonly limit: number
  ) {
    super(
      'too-large',
      `The remote archive is ${formatBytes(size)}, which exceeds the ${formatBytes(limit)} limit for remote archives (archivePeek.remote.maxArchiveSizeMB). VS Code can only transfer remote files as a whole, so the archive would have to be loaded into memory completely.`
    );
    this.name = 'ArchiveTooLargeError';
  }
}

/** Minimal logger interface so non-vscode modules can report diagnostics. */
export interface Logger {
  trace(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const NULL_LOGGER: Logger = {
  trace: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
};

/** Human-readable byte size, e.g. `12.3 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const size = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);
  return `${size} ${units[i]}`;
}
