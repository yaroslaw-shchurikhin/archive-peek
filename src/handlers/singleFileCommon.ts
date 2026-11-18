import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { ArchiveEntry } from '../models';

/** Creates the decompressed byte stream for a single-file compressed archive (.gz, .bz2, .xz). */
export type DecompressStreamFactory = (archivePath: string) => { output: Readable; streams: { destroy(): void }[] };

/** Strip the compression extension to get the inner file name (`app.log.gz` → `app.log`). */
export function innerName(archivePath: string, extension: RegExp): string {
  const base = path.basename(archivePath);
  return base.replace(extension, '') || base;
}

/**
 * Describe the single entry of a compressed file. The uncompressed size is
 * counted while streaming, without keeping the data in memory, so a
 * decompression bomb costs CPU time but not memory.
 */
export async function listSingleFile(
  archivePath: string,
  name: string,
  createStream: DecompressStreamFactory
): Promise<ArchiveEntry[]> {
  const stat = await fs.promises.stat(archivePath);
  let size = 0;
  await consume(createStream(archivePath), (chunk) => {
    size += chunk.length;
  });
  return [
    {
      path: name,
      name,
      isDirectory: false,
      size,
      compressedSize: stat.size,
      modifiedTime: stat.mtime
    }
  ];
}

/** Decompress the whole file into memory. */
export async function readSingleFile(archivePath: string, createStream: DecompressStreamFactory): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await consume(createStream(archivePath), (chunk) => chunks.push(chunk));
  return Buffer.concat(chunks);
}

function consume(
  pipeline: { output: Readable; streams: { destroy(): void }[] },
  onData: (chunk: Buffer) => void
): Promise<void> {
  const { output, streams } = pipeline;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const s of [...streams, output]) {
        try {
          s.destroy();
        } catch {
          // already closed
        }
      }
      reject(err);
    };
    for (const s of streams) {
      (s as unknown as Readable).on?.('error', fail);
    }
    output.on('error', fail);
    output.on('data', (chunk: Buffer) => onData(chunk));
    output.on('end', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
  });
}
