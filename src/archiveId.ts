import * as path from 'path';

/**
 * Archive identifiers.
 *
 * Every archive tracked by the ArchiveManager is keyed by a string id:
 *
 * - **Local** archives (`file:` URIs) use their absolute file system path,
 *   exactly as before Remote SSH support was added. They are read with
 *   Node's `fs`, which keeps the optimised streaming / random-access code paths.
 * - **Remote** archives (any other scheme, e.g.
 *   `vscode-remote://ssh-remote+host/var/log/build.tar.gz`) use a URI string
 *   built by formatRemoteId(), which percent-encodes every component and is
 *   decoded back exactly. They are never turned into local paths; their bytes
 *   are fetched through `vscode.workspace.fs` instead.
 *
 *   `vscode.Uri.toString()` is deliberately NOT used: it lower-cases the host
 *   part of the authority (`acme-sftp://Host-A/…` → `acme-sftp://host-a/…`),
 *   so a URI rebuilt from it may no longer be recognised by the
 *   FileSystemProvider that owns it.
 *
 * This module is deliberately free of the `vscode` module so it can be used
 * (and unit-tested) from the plain Node parts of the extension.
 */

/** `scheme://authority/path` — scheme must be at least two characters so `C:\…` is never mistaken for a URI. */
const URI_RE = /^([a-zA-Z][a-zA-Z0-9+.-]+):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/;

export interface ParsedRemoteId {
  scheme: string;
  /** Decoded authority, exactly as in the original URI (case preserved) */
  authority: string;
  /** Decoded URI path */
  path: string;
  /** Decoded query ('' if none) */
  query: string;
  /** Decoded fragment ('' if none) */
  fragment: string;
}

/**
 * Build a lossless id from URI components. Every component is
 * percent-encoded with encodeURIComponent (path segment by segment), so
 * parseRemoteId() returns exactly the same components — including the
 * letter case of the authority, user names, ports, spaces and Unicode.
 */
export function formatRemoteId(parts: {
  scheme: string;
  authority: string;
  path: string;
  query?: string;
  fragment?: string;
}): string {
  const encodedPath = parts.path.split('/').map(encodeURIComponent).join('/');
  let id = `${parts.scheme}://${encodeURIComponent(parts.authority)}${encodedPath}`;
  if (parts.query) {
    id += `?${encodeURIComponent(parts.query)}`;
  }
  if (parts.fragment) {
    id += `#${encodeURIComponent(parts.fragment)}`;
  }
  return id;
}

/** True if the id refers to an archive that must be read through the VS Code file system API. */
export function isRemoteId(id: string): boolean {
  const m = URI_RE.exec(id);
  return m !== null && m[1].toLowerCase() !== 'file';
}

/** Parse a remote id. Returns undefined for local paths. */
export function parseRemoteId(id: string): ParsedRemoteId | undefined {
  const m = URI_RE.exec(id);
  if (!m || m[1].toLowerCase() === 'file') {
    return undefined;
  }
  return {
    scheme: m[1],
    authority: safeDecode(m[2]),
    path: safeDecode(m[3]),
    query: m[4] ? safeDecode(m[4].slice(1)) : '',
    fragment: m[5] ? safeDecode(m[5].slice(1)) : ''
  };
}

/** Canonical form of an id: absolute path for local archives, unchanged URI string for remote ones. */
export function normalizeArchiveId(id: string): string {
  return isRemoteId(id) ? id : path.resolve(id);
}

/** The (decoded) path component used for display and format detection. */
export function archivePathPart(id: string): string {
  const remote = parseRemoteId(id);
  return remote ? remote.path || '/' : id;
}

/** File name of the archive, e.g. `build output.tar.gz`. */
export function archiveBaseName(id: string): string {
  const remote = parseRemoteId(id);
  if (remote) {
    return path.posix.basename(remote.path);
  }
  return path.basename(id);
}

/**
 * Human-readable location for UI and logs. The authority's host part is kept
 * for the UI (the user knows which host they are connected to) but can be
 * redacted for logs.
 */
export function describeArchiveId(id: string, options: { redactHost?: boolean } = {}): string {
  const remote = parseRemoteId(id);
  if (!remote) {
    return id;
  }
  return `${remote.scheme}://${options.redactHost ? redactAuthority(remote.authority) : remote.authority}${remote.path}`;
}

/** `ssh-remote+my-host` → `ssh-remote+…` (keeps the remote kind, drops the host name). */
export function redactAuthority(authority: string): string {
  const plus = authority.indexOf('+');
  if (plus === -1) {
    return authority ? '…' : '';
  }
  return `${authority.slice(0, plus)}+…`;
}

/** Short label for the kind of remote, e.g. `SSH: my-host` for `ssh-remote+my-host`. */
export function remoteLabel(id: string): string | undefined {
  const remote = parseRemoteId(id);
  if (!remote) {
    return undefined;
  }
  if (remote.scheme === 'vscode-remote') {
    const plus = remote.authority.indexOf('+');
    const kind = plus === -1 ? remote.authority : remote.authority.slice(0, plus);
    const host = plus === -1 ? '' : remote.authority.slice(plus + 1);
    const kindLabel = kind === 'ssh-remote' ? 'SSH' : kind;
    return host ? `${kindLabel}: ${host}` : kindLabel;
  }
  return remote.authority ? `${remote.scheme}: ${remote.authority}` : remote.scheme;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Characters that are invalid in file names on Windows or path separators anywhere. */
const UNSAFE_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/**
 * Turn an arbitrary remote file name into a name that is safe to create in a
 * local temp directory on macOS, Linux and Windows. The extension (which the
 * archive handlers rely on) is preserved.
 */
export function safeLocalFileName(name: string): string {
  let safe = name.replace(UNSAFE_FILE_CHARS, '_');
  if (WINDOWS_RESERVED.test(safe)) {
    safe = `_${safe}`;
  }
  if (safe === '' || safe === '.' || safe === '..') {
    safe = `archive${safe.replace(/\./g, '_')}`;
  }
  // Keep names well below common path-length limits; preserve the end (extension)
  if (safe.length > 120) {
    safe = safe.slice(safe.length - 120);
  }
  return safe;
}
