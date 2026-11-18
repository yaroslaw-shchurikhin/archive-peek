import * as fs from 'fs';
import { Readable } from 'stream';
import { XzReadableStream } from 'xz-decompress';
import { ArchiveEntry, IArchiveHandler, ListOptions, StreamCacheCallback } from '../models';
import { listTarEntries, readTarEntry, TarStreamFactory } from './tarCommon';

const createStream: TarStreamFactory = (archivePath) => {
  const fileStream = fs.createReadStream(archivePath);
  const webStream = Readable.toWeb(fileStream) as ReadableStream<Uint8Array>;
  const xzStream = new XzReadableStream(webStream);
  const decompressed = Readable.fromWeb(xzStream as any);
  return { output: decompressed, streams: [fileStream] };
};

/**
 * Handles reading .tar.xz (and .txz) archive files using tar-stream + xz-decompress.
 * Streams through the archive without writing anything to disk.
 */
export class TarXzHandler implements IArchiveHandler {
  supports(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.endsWith('.tar.xz') || lower.endsWith('.txz');
  }

  listEntries(archivePath: string, options?: ListOptions): Promise<ArchiveEntry[]> {
    return listTarEntries(archivePath, createStream, options);
  }

  readEntry(archivePath: string, entryPath: string, onExtraEntry?: StreamCacheCallback): Promise<Buffer> {
    return readTarEntry(archivePath, entryPath, createStream, onExtraEntry);
  }
}
