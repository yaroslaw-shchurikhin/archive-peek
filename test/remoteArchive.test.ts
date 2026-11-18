import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { URI } from 'vscode-uri';
import { ArchiveManager, ArchiveLimits, DEFAULT_LIMITS } from '../src/archiveManager';
import { RemoteArchiveCache } from '../src/remoteArchiveCache';
import { archiveIdFromUri, uriFromArchiveId, VscodeRemoteFileAccess } from '../src/vscodeFileAccess';
import { ArchiveSourceError, ArchiveTooLargeError, EntryTooLargeError, TooManyEntriesError } from '../src/models';
import { describeError } from '../src/sourceErrors';
import { FakeRemoteFileSystemProvider } from './fakeRemoteFileSystemProvider';
import { buildTar, buildTarGz, buildZip, NESTED_FILES, readFixture } from './remoteFixtures';
import { fixture, HELLO_CONTENT, INDEX_TS_CONTENT, PACKAGE_JSON_CONTENT } from './helpers';

const MB = 1024 * 1024;

/**
 * End-to-end tests of remote archive support, from ArchiveManager down to
 * `vscode.workspace.fs` (mocked) and an in-memory FileSystemProvider that
 * emulates a Remote SSH host. They do not exercise a real SSH connection.
 */
describe('Remote archives (emulated Remote SSH FileSystemProvider)', () => {
  let provider: FakeRemoteFileSystemProvider;
  let registration: { dispose(): void };
  let tmpBase: string;
  let cache: RemoteArchiveCache;
  let manager: ArchiveManager;
  let limits: Partial<ArchiveLimits>;
  let maxArchiveBytes: number;
  let maxCacheBytes: number;

  beforeEach(() => {
    provider = new FakeRemoteFileSystemProvider();
    registration = vscode.workspace.registerFileSystemProvider(
      'vscode-remote',
      provider as unknown as vscode.FileSystemProvider
    );
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-peek-test-'));
    limits = {};
    maxArchiveBytes = 512 * MB;
    maxCacheBytes = 2048 * MB;
    cache = new RemoteArchiveCache(new VscodeRemoteFileAccess(), {
      baseDir: tmpBase,
      maxArchiveBytes: () => maxArchiveBytes,
      maxCacheBytes: () => maxCacheBytes
    });
    manager = new ArchiveManager({ remote: cache, limits: () => limits });
  });

  afterEach(() => {
    cache.dispose();
    registration.dispose();
    fs.rmSync(tmpBase, { recursive: true, force: true });
    // Nothing may ever be written to the remote side
    expect(provider.writeCalls).toBe(0);
  });

  /** Place an archive on the emulated host and return its archive id. */
  function remoteArchive(remotePath: string, data: Buffer): string {
    return archiveIdFromUri(provider.setFile(remotePath, data) as unknown as vscode.Uri);
  }

  describe('URI handling', () => {
    it('keeps scheme, authority and path of remote URIs', () => {
      const uri = vscode.Uri.parse('vscode-remote://ssh-remote+build-host/srv/out/архив сборки.tar.gz');
      const id = archiveIdFromUri(uri);
      expect(id.startsWith('vscode-remote://')).toBe(true);
      const back = uriFromArchiveId(id);
      expect(back.scheme).toBe('vscode-remote');
      expect(back.authority).toBe('ssh-remote+build-host');
      expect(back.path).toBe('/srv/out/архив сборки.tar.gz');
      expect(back.toString()).toBe(uri.toString());
    });

    it('maps file: URIs to local paths (existing local code path)', () => {
      const uri = vscode.Uri.file(fixture('sample.zip'));
      expect(archiveIdFromUri(uri)).toBe(fixture('sample.zip'));
      expect(uriFromArchiveId(fixture('sample.zip')).scheme).toBe('file');
    });

    it('supports non-standard schemes and authorities', async () => {
      const custom = new FakeRemoteFileSystemProvider('dev-container+abc123');
      const reg = vscode.workspace.registerFileSystemProvider('my-fs', {
        stat: (uri: vscode.Uri) => custom.stat(asRemote(uri)),
        readFile: (uri: vscode.Uri) => custom.readFile(asRemote(uri))
      } as unknown as vscode.FileSystemProvider);
      try {
        custom.setFile('/data/a.zip', buildZip({ 'x.txt': 'from custom fs' }));
        const id = vscode.Uri.from({
          scheme: 'my-fs',
          authority: 'dev-container+abc123',
          path: '/data/a.zip'
        }).toString();
        const archive = await manager.openArchive(id);
        expect(archive.source).toBe('remote');
        expect((await manager.readEntry(id, 'x.txt')).toString()).toBe('from custom fs');
      } finally {
        reg.dispose();
      }
    });
  });

  describe('third-party providers with case-sensitive connection names', () => {
    it('opens an archive on a provider whose authority has upper-case letters (acme-sftp)', async () => {
      // Emulates a provider that looks up "Host-A" case-sensitively and answers
      // NoPermissions for unknown names — the failure mode of a lower-cased authority.
      const sftpHost = new FakeRemoteFileSystemProvider('Host-A', 'acme-sftp', 'NoPermissions');
      const reg = vscode.workspace.registerFileSystemProvider(
        'acme-sftp',
        sftpHost as unknown as vscode.FileSystemProvider
      );
      try {
        const uri = sftpHost.setFile('/tmp/work/var/reports/pre_check.tar.gz', await buildTarGz(NESTED_FILES));
        const id = archiveIdFromUri(uri as unknown as vscode.Uri);
        const archive = await manager.openArchive(id);
        expect(archive.entries.filter((e) => !e.isDirectory)).toHaveLength(6);
        expect((await manager.readEntry(id, 'build/logs/app.log')).toString()).toBe(NESTED_FILES['build/logs/app.log']);
        expect(sftpHost.readFileCalls).toBe(1);
      } finally {
        reg.dispose();
      }
    });

    it('opens an archive on a Remote SSH host alias with upper-case letters', async () => {
      const upper = new FakeRemoteFileSystemProvider('ssh-remote+Build-Host');
      const reg = vscode.workspace.registerFileSystemProvider(
        'vscode-remote',
        upper as unknown as vscode.FileSystemProvider
      );
      try {
        const id = archiveIdFromUri(upper.setFile('/srv/a.zip', buildZip({ 'a.txt': 'A' })) as unknown as vscode.Uri);
        expect((await manager.readEntry(id, 'a.txt')).toString()).toBe('A');
      } finally {
        reg.dispose();
      }
    });

    it("includes the provider's own error in the message", async () => {
      const sftpHost = new FakeRemoteFileSystemProvider('Host-A', 'acme-sftp', 'NoPermissions');
      const reg = vscode.workspace.registerFileSystemProvider(
        'acme-sftp',
        sftpHost as unknown as vscode.FileSystemProvider
      );
      try {
        sftpHost.setFile('/r/a.tar.gz', await buildTarGz({ 'a.txt': 'a' }));
        sftpHost.deny('/r/a.tar.gz');
        const error = await manager
          .openArchive(archiveIdFromUri(sftpHost.uri('/r/a.tar.gz') as unknown as vscode.Uri))
          .catch((e) => e);
        expect(error.kind).toBe('no-permission');
        expect(error.message).toContain('workspace.fs.stat: NoPermissions');
      } finally {
        reg.dispose();
      }
    });
  });

  describe('opening', () => {
    it('opens a .tar.gz with nested directories and reports sizes and counts', async () => {
      const id = remoteArchive('/home/user/artifacts/build.tar.gz', await buildTarGz(NESTED_FILES));
      const archive = await manager.openArchive(id);

      expect(archive.source).toBe('remote');
      expect(archive.type).toBe('tar.gz');
      const files = archive.entries.filter((e) => !e.isDirectory);
      const dirs = archive.entries.filter((e) => e.isDirectory);
      expect(files.map((f) => f.path).sort()).toEqual(
        Object.keys(NESTED_FILES)
          .filter((k) => !k.endsWith('/'))
          .sort()
      );
      expect(dirs.map((d) => d.path)).toEqual(
        expect.arrayContaining(['build/', 'build/logs/', 'build/config/', 'build/config/подсистема/'])
      );
      for (const f of files) {
        expect(f.size).toBe(Buffer.byteLength(NESTED_FILES[f.path]));
      }
      expect(archive.diskSize).toBeGreaterThan(0);
      expect(manager.getChildren(archive, 'build/').map((c) => c.name)).toEqual(
        expect.arrayContaining(['logs', 'config'])
      );
    });

    it.each([
      ['sample.tar.gz', '/a/sample.tar.gz'],
      ['sample.tar.gz', '/a/sample.tgz'],
      ['sample.tar', '/a/sample.tar'],
      ['sample.tar.xz', '/a/sample.tar.xz'],
      ['sample.tar.bz2', '/a/sample.tar.bz2'],
      ['sample.zip', '/a/sample.zip']
    ])('opens and reads %s served as %s', async (fixtureName, remotePath) => {
      const id = remoteArchive(remotePath, readFixture(fixtureName));
      const archive = await manager.openArchive(id);
      const hello = archive.entries.find((e) => e.name === 'hello.txt')!;
      const index = archive.entries.find((e) => e.name === 'index.ts')!;
      const pkg = archive.entries.find((e) => e.name === 'package.json')!;
      expect(hello.size).toBe(HELLO_CONTENT.length);
      expect((await manager.readEntry(id, hello.path)).toString()).toBe(HELLO_CONTENT);
      expect((await manager.readEntry(id, index.path)).toString()).toBe(INDEX_TS_CONTENT);
      expect((await manager.readEntry(id, pkg.path)).toString()).toBe(PACKAGE_JSON_CONTENT);
    });

    it.each([
      ['hello.txt.gz', '/var/log/hello.txt.gz'],
      ['hello.txt.bz2', '/var/log/hello.txt.bz2'],
      ['hello.txt.xz', '/var/log/hello.txt.xz']
    ])('opens single-file %s', async (fixtureName, remotePath) => {
      const id = remoteArchive(remotePath, readFixture(fixtureName));
      const archive = await manager.openArchive(id);
      expect(archive.entries).toHaveLength(1);
      expect(archive.entries[0].name).toBe('hello.txt');
      expect(archive.entries[0].size).toBe(HELLO_CONTENT.length);
      expect((await manager.readEntry(id, 'hello.txt')).toString()).toBe(HELLO_CONTENT);
    });

    it('reads nested .log, .txt, .json, .yaml and Unicode-named text files', async () => {
      const id = remoteArchive('/srv/out/build.tar.gz', await buildTarGz(NESTED_FILES));
      for (const [entryPath, content] of Object.entries(NESTED_FILES)) {
        if (entryPath.endsWith('/')) {
          continue;
        }
        expect((await manager.readEntry(id, entryPath)).toString('utf-8')).toBe(content);
      }
    });

    it('handles spaces and Unicode in the archive name and path', async () => {
      const id = remoteArchive('/home/пользователь/build output/артефакты 2026.tar.gz', await buildTarGz(NESTED_FILES));
      const archive = await manager.openArchive(id);
      expect(archive.entries.length).toBeGreaterThan(0);
      expect((await manager.readEntry(id, 'build/logs/kernel messages.txt')).toString()).toBe(
        NESTED_FILES['build/logs/kernel messages.txt']
      );
      // The local copy keeps the original (sanitised) file name and extension
      expect(path.basename(cache.localPathOf(id)!)).toBe('артефакты 2026.tar.gz');
    });

    it('shows an empty archive as empty, not as an error', async () => {
      const id = remoteArchive('/a/empty.tar.gz', await buildTarGz({}));
      const archive = await manager.openArchive(id);
      expect(archive.entries).toEqual([]);

      const zipId = remoteArchive('/a/empty.zip', buildZip({}));
      expect((await manager.openArchive(zipId)).entries).toEqual([]);
    });
  });

  describe('errors', () => {
    it('reports corrupted archives as parse errors', async () => {
      const id = remoteArchive('/a/broken.tar.gz', Buffer.from('this is not gzip data at all'));
      const error = await manager.openArchive(id).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(describeError(error).kind).toBe('parse');

      const zip = buildZip({ 'a.txt': 'x'.repeat(1000) });
      const zipId = remoteArchive('/a/truncated.zip', zip.subarray(0, zip.length - 30));
      expect(describeError(await manager.openArchive(zipId).catch((e) => e)).kind).toBe('parse');
    });

    it('reports a missing remote file as not-found', async () => {
      const id = provider.uri('/does/not/exist.tar.gz').toString();
      const error = await manager.openArchive(id).catch((e) => e);
      expect(error).toBeInstanceOf(ArchiveSourceError);
      expect(error.kind).toBe('not-found');
    });

    it('reports missing permissions as no-permission', async () => {
      const id = remoteArchive('/root/secret.tar.gz', await buildTarGz({ 'a.txt': 'a' }));
      provider.deny('/root/secret.tar.gz');
      const error = await manager.openArchive(id).catch((e) => e);
      expect(error).toBeInstanceOf(ArchiveSourceError);
      expect(error.kind).toBe('no-permission');
    });

    it('reports a lost connection as unavailable', async () => {
      const id = remoteArchive('/a/build.tar.gz', await buildTarGz({ 'a.txt': 'a' }));
      provider.connected = false;
      const error = await manager.openArchive(id).catch((e) => e);
      expect(error).toBeInstanceOf(ArchiveSourceError);
      expect(error.kind).toBe('unavailable');
    });

    it('rejects directories', async () => {
      provider.setFile('/a/dir.tar.gz/inner.txt', 'x');
      const error = await manager.openArchive(provider.uri('/a/dir.tar.gz').toString()).catch((e) => e);
      expect(error).toBeInstanceOf(ArchiveSourceError);
      expect(error.kind).toBe('not-a-file');
    });
  });

  describe('limits', () => {
    it('refuses remote archives above the size limit without transferring them', async () => {
      maxArchiveBytes = 1024;
      // Incompressible content, so the archive itself is above the limit
      const id = remoteArchive('/a/big.zip', buildZip({ 'big.bin': randomBytes(4096) }));
      const error = await manager.openArchive(id).catch((e) => e);
      expect(error).toBeInstanceOf(ArchiveTooLargeError);
      expect(describeError(error).kind).toBe('too-large');
      expect(provider.readFileCalls).toBe(0);

      // "Load Anyway"
      manager.allowOversize(id);
      const archive = await manager.openArchive(id);
      expect(archive.entries.map((e) => e.path)).toEqual(['big.bin']);
      expect(provider.readFileCalls).toBe(1);
    });

    it('rejects archives with too many entries', async () => {
      limits = { maxEntries: 3 };
      const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}.txt`, `${i}`]));
      const tgz = remoteArchive('/a/many.tar.gz', await buildTarGz(files));
      await expect(manager.openArchive(tgz)).rejects.toBeInstanceOf(TooManyEntriesError);
      const zip = remoteArchive('/a/many.zip', buildZip(files));
      await expect(manager.openArchive(zip)).rejects.toBeInstanceOf(TooManyEntriesError);
    });

    it('refuses to decompress entries above the entry size limit (decompression bomb)', async () => {
      limits = { maxEntryBytes: 1 * MB };
      // 32 MB of zeros compresses to ~32 KB
      const bomb = zlib.gzipSync(Buffer.alloc(32 * MB));
      expect(bomb.length).toBeLessThan(1 * MB);
      const id = remoteArchive('/a/zeros.bin.gz', bomb);
      const archive = await manager.openArchive(id);
      expect(archive.entries[0].size).toBe(32 * MB);
      await expect(manager.readEntry(id, 'zeros.bin')).rejects.toBeInstanceOf(EntryTooLargeError);

      const tgz = remoteArchive('/a/zeros.tar.gz', await buildTarGz({ 'zeros.bin': Buffer.alloc(4 * MB) }));
      await manager.openArchive(tgz);
      await expect(manager.readEntry(tgz, 'zeros.bin')).rejects.toBeInstanceOf(EntryTooLargeError);
    });

    it('lists entries with path traversal names without touching the local file system', async () => {
      const id = remoteArchive(
        '/a/evil.tar',
        await buildTar({ '../../outside.txt': 'nope', '/abs/path.txt': 'abs', 'ok.txt': 'ok' })
      );
      const archive = await manager.openArchive(id);
      expect(archive.entries.some((e) => e.path.includes('outside.txt'))).toBe(true);
      const outside = archive.entries.find((e) => e.path.endsWith('outside.txt'))!;
      expect((await manager.readEntry(id, outside.path)).toString()).toBe('nope');
      // Only the archive copy itself exists in the private temp directory
      expect(listFiles(cache.directory!).map((f) => path.basename(f))).toEqual(['evil.tar']);
      expect(fs.existsSync(path.join(cache.directory!, '..', 'outside.txt'))).toBe(false);
    });
  });

  describe('caching', () => {
    it('transfers the archive once, no matter how many entries are opened', async () => {
      const id = remoteArchive('/a/build.tar.gz', await buildTarGz(NESTED_FILES));
      await manager.openArchive(id);
      await manager.readEntry(id, 'build/logs/app.log');
      await manager.readEntry(id, 'build/config/settings.json');
      await manager.readEntry(id, 'build/config/deploy.yaml');
      manager.closeArchive(id);
      await manager.openArchive(id);
      await manager.readEntry(id, 'README.md');
      // One transfer for the first open, one after the explicit close (copy deleted)
      expect(provider.readFileCalls).toBe(2);
    });

    it('shares one transfer between concurrent opens', async () => {
      const id = remoteArchive('/a/build.tar.gz', await buildTarGz(NESTED_FILES));
      await Promise.all([manager.openArchive(id), manager.openArchive(id), manager.readEntry(id, 'README.md')]);
      expect(provider.readFileCalls).toBe(1);
    });

    it('reuses the local copy on refresh when the remote file is unchanged', async () => {
      const id = remoteArchive('/a/build.tar.gz', await buildTarGz(NESTED_FILES));
      await manager.openArchive(id);
      expect(await manager.refreshIfChanged(id)).toBe(false);
      await manager.refreshArchive(id);
      expect(provider.readFileCalls).toBe(1);
    });

    it('reloads a remote archive that changed (size or mtime)', async () => {
      const id = remoteArchive('/a/build.tar.gz', await buildTarGz({ 'version.txt': 'v1' }));
      await manager.openArchive(id);
      expect((await manager.readEntry(id, 'version.txt')).toString()).toBe('v1');

      provider.setFile('/a/build.tar.gz', await buildTarGz({ 'version.txt': 'v2', 'added.txt': 'new' }));
      expect(await manager.refreshIfChanged(id)).toBe(true);
      expect(
        manager
          .getArchive(id)!
          .entries.map((e) => e.path)
          .sort()
      ).toEqual(['added.txt', 'version.txt']);
      expect((await manager.readEntry(id, 'version.txt')).toString()).toBe('v2');
      expect(provider.readFileCalls).toBe(2);
    });

    it('detects a remote change when an entry is opened, even without a watch event', async () => {
      const id = remoteArchive('/a/build.zip', buildZip({ 'version.txt': 'v1', 'other.txt': 'o' }));
      await manager.openArchive(id);
      const events: string[] = [];
      manager.onDidChangeArchive((e) => events.push(e.type));

      provider.setFile('/a/build.zip', buildZip({ 'version.txt': 'v2-longer', 'other.txt': 'o' }));
      expect((await manager.readEntry(id, 'version.txt')).toString()).toBe('v2-longer');
      expect(events).toEqual(['changed']);
      expect(manager.getArchive(id)!.entries.find((e) => e.path === 'version.txt')!.size).toBe(9);
    });

    it('keeps working from the local copy while the connection is lost', async () => {
      const id = remoteArchive('/a/build.tar.gz', await buildTarGz(NESTED_FILES));
      await manager.openArchive(id);
      provider.connected = false;
      expect((await manager.readEntry(id, 'build/logs/app.log')).toString()).toBe(NESTED_FILES['build/logs/app.log']);
      // The watcher must not treat a lost connection as a deletion
      expect(await manager.probe(id)).toBe('unavailable');
      provider.connected = true;
      expect(await manager.probe(id)).toBe('exists');
    });

    it('detects a deleted remote archive', async () => {
      const id = remoteArchive('/a/build.tar.gz', await buildTarGz(NESTED_FILES));
      await manager.openArchive(id);
      const localCopy = cache.localPathOf(id)!;
      provider.removeFile('/a/build.tar.gz');
      expect(await manager.probe(id)).toBe('missing');
      manager.markDeleted(id);
      expect(manager.getArchive(id)).toBeUndefined();
      await waitFor(() => !fs.existsSync(localCopy));
    });

    it('evicts least recently used local copies above the cache size limit', async () => {
      const first = remoteArchive('/a/first.zip', buildZip({ 'a.bin': randomBytes(40 * 1024) }));
      const second = remoteArchive('/a/second.zip', buildZip({ 'b.bin': randomBytes(40 * 1024) }));
      maxCacheBytes = 60 * 1024;
      await manager.openArchive(first);
      const firstCopy = cache.localPathOf(first)!;
      await manager.openArchive(second);
      expect(cache.localPathOf(first)).toBeUndefined();
      await waitFor(() => !fs.existsSync(firstCopy));
      expect(cache.totalBytes).toBeLessThanOrEqual(maxCacheBytes);

      // The evicted archive still works: it is transferred again on demand
      expect((await manager.readEntry(first, 'a.bin')).length).toBe(40 * 1024);
      expect(provider.readFileCalls).toBe(3);
    });
  });

  describe('temporary files', () => {
    it('creates local copies only below the local temp directory, private to the user', async () => {
      const id = remoteArchive('/a/build.tar.gz', await buildTarGz(NESTED_FILES));
      await manager.openArchive(id);
      const copy = cache.localPathOf(id)!;
      expect(copy.startsWith(tmpBase + path.sep)).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
        expect(fs.statSync(cache.directory!).mode & 0o777).toBe(0o700);
      }
      // The remote host is untouched: still exactly the one archive we put there
      expect(provider.listPaths()).toEqual(['/a/build.tar.gz']);
    });

    it('deletes the local copy when the archive is closed', async () => {
      const id = remoteArchive('/a/build.tar.gz', await buildTarGz(NESTED_FILES));
      await manager.openArchive(id);
      const copy = cache.localPathOf(id)!;
      expect(fs.existsSync(copy)).toBe(true);
      manager.closeArchive(id);
      await waitFor(() => !fs.existsSync(path.dirname(copy)));
    });

    it('deletes all local copies on dispose', async () => {
      const id = remoteArchive('/a/build.tar.gz', await buildTarGz(NESTED_FILES));
      await manager.openArchive(id);
      const dir = cache.directory!;
      cache.dispose();
      expect(fs.existsSync(dir)).toBe(false);
    });

    it('removes copies left behind by dead extension hosts only', async () => {
      const dead = path.join(tmpBase, 'archive-peek-remote-999999-abc');
      const alive = path.join(tmpBase, `archive-peek-remote-${process.pid}-xyz`);
      const unrelated = path.join(tmpBase, 'something-else');
      for (const d of [dead, alive, unrelated]) {
        fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, 'x'), 'x');
      }
      expect(await RemoteArchiveCache.cleanupStale(tmpBase)).toBe(1);
      expect(fs.existsSync(dead)).toBe(false);
      expect(fs.existsSync(alive)).toBe(true);
      expect(fs.existsSync(unrelated)).toBe(true);
    });
  });

  describe('local archives (no regression)', () => {
    it('reads local archives with Node fs and never calls the remote file system', async () => {
      const archive = await manager.openArchive(fixture('sample.tar.gz'));
      expect(archive.source).toBe('local');
      expect((await manager.readEntry(fixture('sample.tar.gz'), 'hello.txt')).toString()).toBe(HELLO_CONTENT);
      expect(provider.statCalls + provider.readFileCalls).toBe(0);
      expect(cache.directory).toBeUndefined();
    });

    it('applies the same limits to local archives', async () => {
      limits = { ...DEFAULT_LIMITS, maxEntries: 2 };
      await expect(manager.openArchive(fixture('sample.zip'))).rejects.toBeInstanceOf(TooManyEntriesError);
    });
  });
});

/** The fake provider only knows vscode-remote URIs; re-label a custom-scheme URI. */
function asRemote(uri: vscode.Uri): URI {
  return URI.from({ scheme: 'vscode-remote', authority: uri.authority, path: uri.path });
}

/** Incompressible test data. */
function randomBytes(size: number): Buffer {
  return crypto.randomBytes(size);
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(p));
    } else {
      out.push(p);
    }
  }
  return out;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeAll(() => {
  // The format matrix uses the fixtures from test/fixtures/create-fixtures.sh
  for (const f of ['sample.tar.gz', 'sample.tar', 'sample.tar.xz', 'sample.tar.bz2', 'sample.zip', 'hello.txt.gz']) {
    if (!fs.existsSync(fixture(f))) {
      throw new Error(`Missing fixture ${f}: run ./test/fixtures/create-fixtures.sh`);
    }
  }
});
