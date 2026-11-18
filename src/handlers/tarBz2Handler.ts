import * as fs from 'fs';
import { ArchiveEntry, IArchiveHandler, ListOptions, StreamCacheCallback } from '../models';
import { listTarEntries, readTarEntry, TarStreamFactory } from './tarCommon';

const bz2 = require('unbzip2-stream');

const createStream: TarStreamFactory = (archivePath) => {
  const fileStream = fs.createReadStream(archivePath);
  const decompressor = bz2();
  return { output: fileStream.pipe(decompressor), streams: [fileStream, decompressor] };
};

/**
 * Handles reading .tar.bz2 (and .tbz2) archive files using tar-stream + unbzip2-stream.
 * Streams through the archive without writing anything to disk.
 */
export class TarBz2Handler implements IArchiveHandler {
  supports(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2');
  }

  listEntries(archivePath: string, options?: ListOptions): Promise<ArchiveEntry[]> {
    return listTarEntries(archivePath, createStream, options);
  }

  readEntry(archivePath: string, entryPath: string, onExtraEntry?: StreamCacheCallback): Promise<Buffer> {
    return readTarEntry(archivePath, entryPath, createStream, onExtraEntry);
  }
}
