import * as fs from 'fs';
import * as zlib from 'zlib';
import { ArchiveEntry, IArchiveHandler } from '../models';
import { DecompressStreamFactory, innerName, listSingleFile, readSingleFile } from './singleFileCommon';

const EXTENSION = /\.gz$/i;

const createStream: DecompressStreamFactory = (archivePath) => {
  const fileStream = fs.createReadStream(archivePath);
  const gunzip = zlib.createGunzip();
  return { output: fileStream.pipe(gunzip), streams: [fileStream, gunzip] };
};

/**
 * Handles reading plain .gz (gzip) compressed files.
 * A .gz file contains a single compressed file — this handler exposes it
 * as a one-entry archive whose name is the original filename (sans .gz).
 */
export class GzHandler implements IArchiveHandler {
  supports(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.endsWith('.gz') && !lower.endsWith('.tar.gz');
  }

  listEntries(archivePath: string): Promise<ArchiveEntry[]> {
    return listSingleFile(archivePath, innerName(archivePath, EXTENSION), createStream);
  }

  async readEntry(archivePath: string, entryPath: string): Promise<Buffer> {
    if (entryPath !== innerName(archivePath, EXTENSION)) {
      throw new Error(`Entry not found: ${entryPath}`);
    }
    return readSingleFile(archivePath, createStream);
  }
}
