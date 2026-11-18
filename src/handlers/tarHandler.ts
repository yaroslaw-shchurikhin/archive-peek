import * as fs from 'fs';
import { ArchiveEntry, IArchiveHandler, ListOptions, StreamCacheCallback } from '../models';
import { listTarEntries, readTarEntry, TarStreamFactory } from './tarCommon';

const createStream: TarStreamFactory = (archivePath) => {
  const fileStream = fs.createReadStream(archivePath);
  return { output: fileStream, streams: [fileStream] };
};

/**
 * Handles reading plain .tar archive files using tar-stream.
 * No decompression needed — streams directly through the tar entries.
 */
export class TarHandler implements IArchiveHandler {
  supports(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return (
      lower.endsWith('.tar') && !lower.endsWith('.tar.gz') && !lower.endsWith('.tar.bz2') && !lower.endsWith('.tar.xz')
    );
  }

  listEntries(archivePath: string, options?: ListOptions): Promise<ArchiveEntry[]> {
    return listTarEntries(archivePath, createStream, options);
  }

  readEntry(archivePath: string, entryPath: string, onExtraEntry?: StreamCacheCallback): Promise<Buffer> {
    return readTarEntry(archivePath, entryPath, createStream, onExtraEntry);
  }
}
