import * as fs from 'fs';
import * as zlib from 'zlib';
import * as tar from 'tar-stream';
import AdmZip from 'adm-zip';
import { fixture } from './helpers';

/** Text files placed in the nested test archives (one per typical artifact type). */
export const NESTED_FILES: Record<string, string> = {
  'build/logs/app.log': '2026-01-01T00:00:00Z INFO started\n2026-01-01T00:00:01Z WARN low disk\n',
  'build/logs/kernel messages.txt': 'kernel: booted in 1.2s\n',
  'build/config/settings.json': '{"debug":false,"level":3}\n',
  'build/config/deploy.yaml': 'service:\n  name: api\n  replicas: 2\n',
  'build/config/подсистема/параметры.conf': 'ключ=значение\n',
  'README.md': '# Build artifacts\n',
  'empty-dir/': ''
};

/** Build an uncompressed tar from a file map (keys ending in "/" are directories). */
export async function buildTar(files: Record<string, string | Buffer>): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    pack.on('end', () => resolve());
    pack.on('error', reject);
  });
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith('/')) {
      pack.entry({ name, type: 'directory', mtime: new Date(2025, 0, 1) });
    } else {
      pack.entry({ name, mtime: new Date(2025, 0, 1) }, typeof content === 'string' ? Buffer.from(content) : content);
    }
  }
  pack.finalize();
  await done;
  return Buffer.concat(chunks);
}

export async function buildTarGz(files: Record<string, string | Buffer>): Promise<Buffer> {
  return zlib.gzipSync(await buildTar(files));
}

export function buildZip(files: Record<string, string | Buffer>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith('/')) {
      zip.addFile(name, Buffer.alloc(0));
    } else {
      zip.addFile(name, typeof content === 'string' ? Buffer.from(content) : content);
    }
  }
  return zip.toBuffer();
}

/** The fixture archives produced by test/fixtures/create-fixtures.sh, as bytes. */
export function readFixture(name: string): Buffer {
  return fs.readFileSync(fixture(name));
}
