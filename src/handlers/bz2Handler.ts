import * as fs from 'fs';
import { ArchiveEntry, IArchiveHandler } from '../models';
import { DecompressStreamFactory, innerName, listSingleFile, readSingleFile } from './singleFileCommon';

const bz2 = require('unbzip2-stream');

const EXTENSION = /\.bz2$/i;

const createStream: DecompressStreamFactory = (archivePath) => {
  const fileStream = fs.createReadStream(archivePath);
  const decompressor = bz2();
  return { output: fileStream.pipe(decompressor), streams: [fileStream, decompressor] };
};

/**
 * Handles reading plain .bz2 (bzip2) compressed files.
 * A .bz2 file contains a single compressed file — this handler exposes it
 * as a one-entry archive whose name is the original filename (sans .bz2).
 */
export class Bz2Handler implements IArchiveHandler {
  supports(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.endsWith('.bz2') && !lower.endsWith('.tar.bz2');
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
