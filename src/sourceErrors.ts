import {
  ArchiveSourceError,
  ArchiveTooLargeError,
  EntryTooLargeError,
  SourceErrorKind,
  TooManyEntriesError
} from './models';

/**
 * Map an error thrown by `vscode.workspace.fs` (a `vscode.FileSystemError`,
 * identified by its `code`) or by Node's `fs` (identified by its errno code)
 * to an ArchiveSourceError kind.
 *
 * Lost Remote SSH connections do not have a dedicated error code: depending on
 * the VS Code version they surface as `Unavailable`, as a cancellation, or as a
 * generic error mentioning the connection, so the message is inspected too.
 */
export function classifySourceError(error: unknown): SourceErrorKind {
  if (error instanceof ArchiveSourceError) {
    return error.kind;
  }
  const e = error as { code?: unknown; name?: unknown; message?: unknown } | undefined;
  const code = typeof e?.code === 'string' ? e.code : '';
  const name = typeof e?.name === 'string' ? e.name : '';
  const message = typeof e?.message === 'string' ? e.message : String(error ?? '');

  switch (code) {
    case 'FileNotFound':
    case 'EntryNotFound':
    case 'ENOENT':
    case 'ENOTDIR':
      return 'not-found';
    case 'NoPermissions':
    case 'EACCES':
    case 'EPERM':
      return 'no-permission';
    case 'Unavailable':
    case 'ECONNRESET':
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'EPIPE':
      return 'unavailable';
    case 'FileIsADirectory':
    case 'EntryIsADirectory':
    case 'EISDIR':
      return 'not-a-file';
  }

  const text = `${name} ${message}`;
  if (/EntryNotFound|FileNotFound|ENOENT|no such file/i.test(text)) {
    return 'not-found';
  }
  if (/NoPermissions|EACCES|EPERM|permission denied/i.test(text)) {
    return 'no-permission';
  }
  if (
    /Unavailable|connection|disconnect|reconnect|socket|ECONNRESET|ETIMEDOUT|timed? ?out|unreachable|Canceled|closed/i.test(
      text
    )
  ) {
    return 'unavailable';
  }
  if (/IsADirectory|EISDIR/i.test(text)) {
    return 'not-a-file';
  }
  return 'unknown';
}

/** Wrap any error from the file system layer in an ArchiveSourceError. */
export function toSourceError(error: unknown, action: 'stat' | 'read'): ArchiveSourceError {
  if (error instanceof ArchiveSourceError) {
    return error;
  }
  const kind = classifySourceError(error);
  const op = action === 'stat' ? 'workspace.fs.stat' : 'workspace.fs.readFile';
  const messages: Record<SourceErrorKind, string> = {
    'not-found': `The archive file was not found. It may have been moved or deleted.`,
    'no-permission': `Permission denied: the archive file cannot be ${action === 'stat' ? 'accessed' : 'read'}.`,
    unavailable: `The remote host is unavailable (the remote connection may have been lost). Try again after VS Code reconnects.`,
    'too-large': `The archive is too large.`,
    'not-a-file': `The selected resource is not a file.`,
    unknown: `Could not ${action === 'stat' ? 'access' : 'read'} the archive file.`
  };
  // Keep what the file system provider actually reported: it is often the
  // only clue (e.g. a third-party provider that answers NoPermissions for an
  // unknown connection name).
  return new ArchiveSourceError(kind, `${messages[kind]} (${op}: ${rawErrorSummary(error)})`, error);
}

/** "Code: message" of an error as reported by a FileSystemProvider or Node, single line, bounded length. */
export function rawErrorSummary(error: unknown): string {
  const e = error as { code?: unknown; name?: unknown; message?: unknown } | undefined;
  const code = typeof e?.code === 'string' && e.code ? e.code : typeof e?.name === 'string' ? e.name : 'Error';
  const message = typeof e?.message === 'string' ? e.message : String(error);
  const text = `${code}: ${message}`.replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** One-line description of any error for the UI, without stack traces. */
export function describeError(error: unknown): {
  kind: SourceErrorKind | 'too-many-entries' | 'entry-too-large' | 'parse';
  message: string;
} {
  if (error instanceof ArchiveTooLargeError) {
    return { kind: 'too-large', message: error.message };
  }
  if (error instanceof ArchiveSourceError) {
    return { kind: error.kind, message: error.message };
  }
  if (error instanceof TooManyEntriesError) {
    return { kind: 'too-many-entries', message: error.message };
  }
  if (error instanceof EntryTooLargeError) {
    return { kind: 'entry-too-large', message: error.message };
  }
  const message = (error as { message?: string } | undefined)?.message ?? String(error);
  return {
    kind: 'parse',
    message: `The archive could not be read. It may be corrupted, truncated or in an unsupported variant of the format. (${message})`
  };
}
