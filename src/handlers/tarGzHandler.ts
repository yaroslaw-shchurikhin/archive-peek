import * as fs from 'fs';
import * as zlib from 'zlib';
import { ArchiveEntry, IArchiveHandler, ListOptions, StreamCacheCallback } from '../models';
import { listTarEntries, readTarEntry, TarStreamFactory } from './tarCommon';

const createStream: TarStreamFactory = (archivePath) => {
  const fileStream = fs.createReadStream(archivePath);
  const gunzip = zlib.createGunzip();
  return { output: fileStream.pipe(gunzip), streams: [fileStream, gunzip] };
};

/**
 * Handles reading .tar.gz (and .tgz) archive files using tar-stream + zlib.
 * Streams through the archive to list entries or extract a single file's contents
 * without writing anything to disk.
 */
export class TarGzHandler implements IArchiveHandler {
  supports(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.endsWith('.tar.gz') || lower.endsWith('.tgz');
  }

  listEntries(archivePath: string, options?: ListOptions): Promise<ArchiveEntry[]> {
    return listTarEntries(archivePath, createStream, options);
  }

  readEntry(archivePath: string, entryPath: string, onExtraEntry?: StreamCacheCallback): Promise<Buffer> {
    return readTarEntry(archivePath, entryPath, createStream, onExtraEntry);
  }
}
