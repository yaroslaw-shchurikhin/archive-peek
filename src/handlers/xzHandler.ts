import * as fs from 'fs';
import { Readable } from 'stream';
import { XzReadableStream } from 'xz-decompress';
import { ArchiveEntry, IArchiveHandler } from '../models';
import { DecompressStreamFactory, innerName, listSingleFile, readSingleFile } from './singleFileCommon';

const EXTENSION = /\.xz$/i;

const createStream: DecompressStreamFactory = (archivePath) => {
  const fileStream = fs.createReadStream(archivePath);
  const webStream = Readable.toWeb(fileStream) as ReadableStream<Uint8Array>;
  const xzStream = new XzReadableStream(webStream);
  const decompressed = Readable.fromWeb(xzStream as any);
  return { output: decompressed, streams: [fileStream] };
};

/**
 * Handles reading plain .xz compressed files.
 * An .xz file contains a single compressed file — this handler exposes it
 * as a one-entry archive whose name is the original filename (sans .xz).
 */
export class XzHandler implements IArchiveHandler {
  supports(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.endsWith('.xz') && !lower.endsWith('.tar.xz');
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
