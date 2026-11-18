import * as vscode from 'vscode';
import { ArchiveLimits } from './archiveManager';

const MB = 1024 * 1024;

function getNumber(key: string, fallback: number): number {
  const value = vscode.workspace.getConfiguration('archivePeek').get<number>(key, fallback);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** archivePeek.remote.maxArchiveSizeMB in bytes */
export function maxRemoteArchiveBytes(): number {
  return getNumber('remote.maxArchiveSizeMB', 512) * MB;
}

/** archivePeek.remote.cacheSizeMB in bytes */
export function maxRemoteCacheBytes(): number {
  return getNumber('remote.cacheSizeMB', 2048) * MB;
}

export function archiveLimits(): ArchiveLimits {
  return {
    maxEntries: Math.floor(getNumber('maxEntries', 500_000)),
    maxEntryBytes: getNumber('maxEntrySizeMB', 256) * MB
  };
}
