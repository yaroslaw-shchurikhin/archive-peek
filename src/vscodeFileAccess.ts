import * as vscode from 'vscode';
import { formatRemoteId, normalizeArchiveId, parseRemoteId } from './archiveId';
import { RemoteFileAccess, RemoteFileStat } from './remoteArchiveCache';
import { toSourceError } from './sourceErrors';

/**
 * Archive id for a resource URI.
 *
 * `file:` URIs map to their local path so local archives keep using the
 * streaming Node `fs` code paths. Every other URI — notably
 * `vscode-remote://ssh-remote+host/path` in a Remote SSH window, or a
 * third-party provider such as `acme-sftp://Host-A/path` — is encoded
 * losslessly with formatRemoteId(). Remote URIs are never converted with
 * `fsPath` (drops scheme and authority) nor with `Uri.toString()` (lower-cases
 * the authority's host, which providers may treat as a different host).
 */
export function archiveIdFromUri(uri: vscode.Uri): string {
  if (uri.scheme === 'file') {
    return normalizeArchiveId(uri.fsPath);
  }
  return formatRemoteId({
    scheme: uri.scheme,
    authority: uri.authority,
    path: uri.path,
    query: uri.query,
    fragment: uri.fragment
  });
}

/** Inverse of archiveIdFromUri: rebuilds a Uri with exactly the original components. */
export function uriFromArchiveId(id: string): vscode.Uri {
  const remote = parseRemoteId(id);
  if (!remote) {
    return vscode.Uri.file(id);
  }
  return vscode.Uri.from({
    scheme: remote.scheme,
    authority: remote.authority,
    path: remote.path,
    query: remote.query,
    fragment: remote.fragment
  });
}

/**
 * RemoteFileAccess backed by `vscode.workspace.fs`, which routes requests to
 * whichever FileSystemProvider owns the URI's scheme — for Remote SSH, the
 * built-in provider that talks to the VS Code Server over the existing SSH
 * connection. Nothing extra is installed on, or written to, the remote host.
 */
export class VscodeRemoteFileAccess implements RemoteFileAccess {
  constructor(private readonly fs: vscode.FileSystem = vscode.workspace.fs) {}

  async stat(id: string): Promise<RemoteFileStat> {
    try {
      const stat = await this.fs.stat(uriFromArchiveId(id));
      return {
        size: stat.size,
        mtime: stat.mtime,
        // A symlink to a file reports File | SymbolicLink
        isFile: (stat.type & vscode.FileType.File) !== 0
      };
    } catch (error) {
      throw toSourceError(error, 'stat');
    }
  }

  async readFile(id: string): Promise<Uint8Array> {
    try {
      return await this.fs.readFile(uriFromArchiveId(id));
    } catch (error) {
      throw toSourceError(error, 'read');
    }
  }
}
