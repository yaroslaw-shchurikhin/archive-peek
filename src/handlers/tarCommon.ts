import { Readable } from 'stream';
import * as tar from 'tar-stream';
import { ArchiveEntry, ListOptions, StreamCacheCallback, TooManyEntriesError } from '../models';

/** Max size of files to opportunistically cache while streaming (1 MB) */
const STREAM_CACHE_THRESHOLD = 1 * 1024 * 1024;

/**
 * Creates the (decompressed) tar byte stream for an archive, plus every
 * stream in the pipeline so errors and teardown can be wired up.
 */
export type TarStreamFactory = (archivePath: string) => { output: Readable; streams: { destroy(): void }[] };

/** Destroy every stream of a pipeline, ignoring errors from already-closed streams. */
function destroyAll(streams: { destroy(): void }[]): void {
  for (const s of streams) {
    try {
      s.destroy();
    } catch {
      // already closed
    }
  }
}

/**
 * List the entries of a tar stream. Shared by the plain, gzip, bzip2 and xz
 * tar handlers, which only differ in how the byte stream is produced.
 */
export function listTarEntries(
  archivePath: string,
  createStream: TarStreamFactory,
  options: ListOptions = {}
): Promise<ArchiveEntry[]> {
  return new Promise<ArchiveEntry[]>((resolve, reject) => {
    const entries: ArchiveEntry[] = [];
    const seenDirs = new Set<string>();
    const maxEntries = options.maxEntries ?? Infinity;
    let settled = false;

    const extract = tar.extract();
    const { output, streams } = createStream(archivePath);
    const fail = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      destroyAll([...streams, output, extract]);
      reject(err);
    };

    extract.on('entry', (header, stream, next) => {
      const entryPath = header.name.replace(/^\.\//, '');
      if (entryPath === '' || entryPath === './') {
        stream.resume();
        next();
        return;
      }

      const parts = entryPath.split('/');
      let dirPath = '';
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i] === '') {
          continue;
        }
        dirPath += parts[i] + '/';
        if (!seenDirs.has(dirPath)) {
          seenDirs.add(dirPath);
          entries.push({
            path: dirPath,
            name: parts[i],
            isDirectory: true,
            size: 0
          });
        }
      }

      const isDir = header.type === 'directory';
      if (!isDir) {
        const name = parts[parts.length - 1];
        if (name) {
          entries.push({
            path: entryPath.replace(/\/$/, ''),
            name,
            isDirectory: false,
            size: header.size || 0,
            modifiedTime: header.mtime
          });
        }
      }

      if (entries.length > maxEntries) {
        fail(new TooManyEntriesError(maxEntries));
        return;
      }

      // We must consume the stream even though we don't need data for listing
      stream.resume();
      next();
    });

    extract.on('finish', () => {
      if (!settled) {
        settled = true;
        resolve(entries);
      }
    });
    extract.on('error', fail);
    for (const s of streams) {
      (s as unknown as Readable).on?.('error', fail);
    }
    output.on('error', fail);
    output.pipe(extract);
  });
}

/**
 * Read a single entry from a tar stream, opportunistically handing small
 * files that are passed over to `onExtraEntry` so they can be cached.
 */
export function readTarEntry(
  archivePath: string,
  entryPath: string,
  createStream: TarStreamFactory,
  onExtraEntry?: StreamCacheCallback
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const extract = tar.extract();
    const { output, streams } = createStream(archivePath);
    let found = false;
    let settled = false;
    const targetPath = entryPath.replace(/^\.\//, '').replace(/\/$/, '');

    const fail = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      destroyAll([...streams, output, extract]);
      reject(err);
    };

    extract.on('entry', (header, stream, next) => {
      const currentPath = header.name.replace(/^\.\//, '').replace(/\/$/, '');

      if (currentPath === targetPath) {
        found = true;
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          if (!settled) {
            settled = true;
            resolve(Buffer.concat(chunks));
          }
          next();
        });
        stream.on('error', fail);
      } else if (
        onExtraEntry &&
        header.type === 'file' &&
        header.size != null &&
        header.size > 0 &&
        header.size <= STREAM_CACHE_THRESHOLD
      ) {
        // Opportunistically cache small files we pass over
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          onExtraEntry(currentPath, Buffer.concat(chunks));
          next();
        });
        stream.on('error', () => {
          stream.resume();
          next();
        });
      } else {
        stream.resume();
        next();
      }
    });

    extract.on('finish', () => {
      if (!found) {
        fail(new Error(`Entry not found in archive: ${entryPath}`));
      }
    });
    extract.on('error', fail);
    for (const s of streams) {
      (s as unknown as Readable).on?.('error', fail);
    }
    output.on('error', fail);
    output.pipe(extract);
  });
}
