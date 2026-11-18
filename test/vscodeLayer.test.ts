import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createdWatchers, FileType } from './mocks/vscode';
import { ArchiveManager } from '../src/archiveManager';
import { RemoteArchiveCache } from '../src/remoteArchiveCache';
import { archiveIdFromUri, uriFromArchiveId, VscodeRemoteFileAccess } from '../src/vscodeFileAccess';
import {
  ArchiveFileSystemProvider,
  archiveEntryUri,
  archiveRootUri,
  decodeArchiveUri
} from '../src/archiveFileSystemProvider';
import { ArchiveWatcher } from '../src/archiveWatcher';
import { ArchiveEditorProvider } from '../src/archiveEditorProvider';
import {
  archiveBaseName,
  describeArchiveId,
  isRemoteId,
  normalizeArchiveId,
  remoteLabel,
  safeLocalFileName
} from '../src/archiveId';
import { classifySourceError, toSourceError } from '../src/sourceErrors';
import { FakeRemoteFileSystemProvider } from './fakeRemoteFileSystemProvider';
import { buildTarGz, NESTED_FILES } from './remoteFixtures';
import { fixture } from './helpers';

describe('archive ids', () => {
  it('distinguishes remote URIs from local (including Windows) paths', () => {
    expect(isRemoteId('vscode-remote://ssh-remote%2Bhost/a.zip')).toBe(true);
    expect(isRemoteId('/home/user/a.zip')).toBe(false);
    expect(isRemoteId('C:\\Users\\me\\a.zip')).toBe(false);
    expect(isRemoteId('file:///tmp/a.zip')).toBe(false);
  });

  it('keeps remote ids unchanged and resolves local paths', () => {
    const id = 'vscode-remote://ssh-remote%2Bhost/srv/a%20b.tar.gz';
    expect(normalizeArchiveId(id)).toBe(id);
    expect(normalizeArchiveId('relative/a.zip')).toBe(path.resolve('relative/a.zip'));
  });

  it('derives names and labels from remote ids', () => {
    const id = vscode.Uri.parse('vscode-remote://ssh-remote+my-box/var/log/сборка 1.tar.gz').toString();
    expect(archiveBaseName(id)).toBe('сборка 1.tar.gz');
    expect(remoteLabel(id)).toBe('SSH: my-box');
    expect(describeArchiveId(id, { redactHost: true })).toBe('vscode-remote://ssh-remote+…/var/log/сборка 1.tar.gz');
    expect(describeArchiveId(id, { redactHost: true })).not.toContain('my-box');
  });

  it('sanitises remote file names for the local temp directory', () => {
    expect(safeLocalFileName('build.tar.gz')).toBe('build.tar.gz');
    expect(safeLocalFileName('a:b|c?.zip')).toBe('a_b_c_.zip');
    expect(safeLocalFileName('..\\..\\evil.zip')).toBe('.._.._evil.zip');
    expect(safeLocalFileName('aux.tar.gz')).toBe('_aux.tar.gz');
    expect(safeLocalFileName('..')).toBe('archive__');
    expect(safeLocalFileName('x'.repeat(300) + '.tar.gz').endsWith('.tar.gz')).toBe(true);
  });
});

describe('lossless remote ids', () => {
  it.each([
    ['acme-sftp://Host-A/tmp/work/var/reports/pre_check.tar.gz'],
    ['vscode-remote://ssh-remote+Build-Host/srv/out/build.tar.gz'],
    ['sftp://Root@Stand_B:2222/home/u/a b/архив.zip'],
    ['my-fs://MyStand%20One/x/100%25 done.tgz?ref=Main#Frag']
  ])('round-trips %s without changing any component', (text) => {
    const uri = vscode.Uri.parse(text);
    const back = uriFromArchiveId(archiveIdFromUri(uri));
    expect(back.scheme).toBe(uri.scheme);
    expect(back.authority).toBe(uri.authority);
    expect(back.path).toBe(uri.path);
    expect(back.query).toBe(uri.query);
    expect(back.fragment).toBe(uri.fragment);
  });

  it('keeps the letter case of the authority (Uri.toString() lower-cases it)', () => {
    const uri = vscode.Uri.parse('acme-sftp://Host-A/opt/x.tar.gz');
    expect(vscode.Uri.parse(uri.toString()).authority).toBe('host-a'); // the pitfall
    const id = archiveIdFromUri(uri);
    expect(uriFromArchiveId(id).authority).toBe('Host-A');
    expect(remoteLabel(id)).toBe('acme-sftp: Host-A');
    expect(archiveBaseName(id)).toBe('x.tar.gz');
  });
});

describe('error classification', () => {
  it.each([
    [vscode.FileSystemError.FileNotFound('x'), 'not-found'],
    [vscode.FileSystemError.NoPermissions('x'), 'no-permission'],
    [vscode.FileSystemError.Unavailable('x'), 'unavailable'],
    [vscode.FileSystemError.FileIsADirectory('x'), 'not-a-file'],
    [Object.assign(new Error('nope'), { code: 'ENOENT' }), 'not-found'],
    [Object.assign(new Error('nope'), { code: 'EACCES' }), 'no-permission'],
    [new Error('Connection to the remote extension host was closed'), 'unavailable'],
    [new Error('Canceled'), 'unavailable'],
    [new Error('something odd'), 'unknown']
  ])('classifies %s as %s', (error, kind) => {
    expect(classifySourceError(error)).toBe(kind);
    expect(toSourceError(error, 'read').kind).toBe(kind);
  });
});

/** Shared setup: emulated remote host + full extension stack (minus the UI). */
function setupStack() {
  const provider = new FakeRemoteFileSystemProvider('ssh-remote+test-host');
  const registration = vscode.workspace.registerFileSystemProvider(
    'vscode-remote',
    provider as unknown as vscode.FileSystemProvider
  );
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-peek-test-'));
  const cache = new RemoteArchiveCache(new VscodeRemoteFileAccess(), { baseDir: tmpBase });
  const manager = new ArchiveManager({ remote: cache });
  return {
    provider,
    cache,
    manager,
    dispose() {
      cache.dispose();
      registration.dispose();
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  };
}

describe('archive:// file system provider with remote archives', () => {
  let stack: ReturnType<typeof setupStack>;
  let fsProvider: ArchiveFileSystemProvider;
  let id: string;

  beforeEach(async () => {
    stack = setupStack();
    fsProvider = new ArchiveFileSystemProvider(stack.manager);
    const uri = stack.provider.setFile('/home/dev/out/build artifacts.tar.gz', await buildTarGz(NESTED_FILES));
    id = archiveIdFromUri(uri as unknown as vscode.Uri);
  });

  afterEach(() => {
    fsProvider.dispose();
    stack.dispose();
  });

  it('round-trips the remote id (scheme, authority, path) through archive:// URIs', () => {
    const entryUri = archiveEntryUri(id, 'build/logs/app.log');
    expect(entryUri.scheme).toBe('archive');
    // Clean tab title: archive name + entry path
    expect(entryUri.path).toBe('/build artifacts.tar.gz/build/logs/app.log');
    const decoded = decodeArchiveUri(vscode.Uri.parse(entryUri.toString()));
    expect(decoded.archivePath).toBe(id);
    expect(decoded.entryPath).toBe('build/logs/app.log');
    expect(archiveRootUri(id).path).toBe('/build artifacts.tar.gz');
  });

  it('serves stat, readDirectory and readFile for entries of a remote archive', async () => {
    const root = archiveRootUri(id);
    expect((await fsProvider.stat(root)).type).toBe(FileType.Directory);

    const logs = await fsProvider.readDirectory(archiveEntryUri(id, 'build/logs'));
    expect(logs.map(([name]) => name).sort()).toEqual(['app.log', 'kernel messages.txt']);

    const yaml = archiveEntryUri(id, 'build/config/deploy.yaml');
    const stat = await fsProvider.stat(yaml);
    expect(stat.type).toBe(FileType.File);
    expect(stat.size).toBe(Buffer.byteLength(NESTED_FILES['build/config/deploy.yaml']));
    expect(Buffer.from(await fsProvider.readFile(yaml)).toString()).toBe(NESTED_FILES['build/config/deploy.yaml']);
    expect(stack.provider.readFileCalls).toBe(1);
  });

  it('is read-only', () => {
    expect(() => fsProvider.writeFile()).toThrow();
    expect(() => fsProvider.delete()).toThrow();
  });

  it('maps a lost connection on a not-yet-opened archive to Unavailable', async () => {
    stack.provider.connected = false;
    const error = await fsProvider.readFile(archiveEntryUri(id, 'README.md')).catch((e) => e);
    expect(error.code).toBe('Unavailable');
  });
});

describe('ArchiveWatcher with remote archives', () => {
  let stack: ReturnType<typeof setupStack>;
  let watcher: ArchiveWatcher;

  beforeEach(() => {
    stack = setupStack();
    createdWatchers.length = 0;
    watcher = new ArchiveWatcher(stack.manager);
  });

  afterEach(() => {
    watcher.dispose();
    stack.dispose();
  });

  it('watches the remote parent folder with the original scheme and authority', async () => {
    const uri = stack.provider.setFile('/srv/out/build.tar.gz', await buildTarGz({ 'v.txt': 'v1' }));
    await stack.manager.openArchive(archiveIdFromUri(uri as unknown as vscode.Uri));
    expect(createdWatchers).toHaveLength(1);
    const pattern = createdWatchers[0].pattern;
    expect(pattern.baseUri.scheme).toBe('vscode-remote');
    expect(pattern.baseUri.authority).toBe('ssh-remote+test-host');
    expect(pattern.baseUri.path).toBe('/srv/out');
    expect(pattern.pattern).toBe('build.tar.gz');
  });

  it('reloads the archive when the provider reports a change', async () => {
    const uri = stack.provider.setFile('/srv/out/build.tar.gz', await buildTarGz({ 'v.txt': 'v1' }));
    const id = archiveIdFromUri(uri as unknown as vscode.Uri);
    await stack.manager.openArchive(id);

    stack.provider.setFile('/srv/out/build.tar.gz', await buildTarGz({ 'v.txt': 'v2', 'new.txt': 'n' }));
    createdWatchers[0].fireChange(uri);
    await waitFor(() => stack.manager.getArchive(id)?.entries.length === 2);
    expect((await stack.manager.readEntry(id, 'v.txt')).toString()).toBe('v2');
  });

  it('does not treat a lost connection as a deletion', async () => {
    const uri = stack.provider.setFile('/srv/out/build.tar.gz', await buildTarGz({ 'v.txt': 'v1' }));
    const id = archiveIdFromUri(uri as unknown as vscode.Uri);
    await stack.manager.openArchive(id);

    stack.provider.connected = false;
    createdWatchers[0].fireChange(uri);
    await new Promise((r) => setTimeout(r, 450));
    expect(stack.manager.getArchive(id)).toBeDefined();
  });

  it('marks the archive deleted when the remote file disappears', async () => {
    const uri = stack.provider.setFile('/srv/out/build.tar.gz', await buildTarGz({ 'v.txt': 'v1' }));
    const id = archiveIdFromUri(uri as unknown as vscode.Uri);
    await stack.manager.openArchive(id);

    stack.provider.removeFile('/srv/out/build.tar.gz');
    createdWatchers[0].fireDelete(uri);
    await waitFor(() => stack.manager.getArchive(id) === undefined);
  });
});

describe('ArchiveEditorProvider', () => {
  let stack: ReturnType<typeof setupStack>;
  let editor: ArchiveEditorProvider;

  beforeEach(() => {
    stack = setupStack();
    editor = new ArchiveEditorProvider(stack.manager);
  });

  afterEach(() => stack.dispose());

  /** Minimal WebviewPanel stand-in that records the rendered HTML. */
  function fakePanel() {
    const panel = {
      html: '',
      active: true,
      messageHandler: undefined as undefined | ((m: { command: string }) => Promise<void>),
      webview: {
        options: {},
        set html(value: string) {
          panel.html = value;
        },
        get html() {
          return panel.html;
        },
        onDidReceiveMessage(handler: (m: { command: string }) => Promise<void>) {
          panel.messageHandler = handler;
          return { dispose() {} };
        }
      },
      onDidChangeViewState: () => ({ dispose() {} }),
      onDidDispose: () => ({ dispose() {} })
    };
    return panel;
  }

  async function open(uri: vscode.Uri) {
    const panel = fakePanel();
    const token = {} as vscode.CancellationToken;
    const doc = await editor.openCustomDocument(uri, {} as vscode.CustomDocumentOpenContext, token);
    await editor.resolveCustomEditor(doc, panel as unknown as vscode.WebviewPanel, token);
    return panel;
  }

  it('renders the contents of a remote archive with real counts and sizes', async () => {
    const uri = stack.provider.setFile('/srv/out/build.tar.gz', await buildTarGz(NESTED_FILES));
    const panel = await open(uri as unknown as vscode.Uri);
    expect(panel.html).toContain('[SSH: test-host] /srv/out/build.tar.gz');
    expect(panel.html).toMatch(/<div class="stat-label">Files<\/div>\s*<div class="stat-value">6<\/div>/);
    expect(panel.html).toContain('TAR.GZ');
    expect(panel.html).not.toContain('class="notice error"');
  });

  it('shows a diagnostic instead of an empty archive with zero sizes', async () => {
    const uri = stack.provider.uri('/srv/out/missing.tar.gz');
    const panel = await open(uri as unknown as vscode.Uri);
    expect(panel.html).toContain('class="notice error"');
    expect(panel.html).toContain('was not found');
    expect(panel.html).toContain('data-command="retry"');
    expect(panel.html).not.toContain('Total Size');
  });

  it('offers "Load Anyway" for archives above the remote size limit', async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-peek-test-'));
    const small = new RemoteArchiveCache(new VscodeRemoteFileAccess(), { baseDir: tmpBase, maxArchiveBytes: () => 10 });
    const manager = new ArchiveManager({ remote: small });
    editor = new ArchiveEditorProvider(manager);
    try {
      const uri = stack.provider.setFile('/srv/out/big.tar.gz', await buildTarGz(NESTED_FILES));
      const panel = await open(uri as unknown as vscode.Uri);
      expect(panel.html).toContain('data-command="loadAnyway"');
      await panel.messageHandler!({ command: 'loadAnyway' });
      expect(panel.html).not.toContain('class="notice error"');
      expect(panel.html).toContain('build');
    } finally {
      small.dispose();
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('still renders local archives as before', async () => {
    const panel = await open(vscode.Uri.file(fixture('sample.zip')) as unknown as vscode.Uri);
    expect(panel.html).toContain(fixture('sample.zip'));
    expect(panel.html).toContain('ZIP');
    expect(panel.html).not.toContain('class="notice error"');
  });

  it('escapes entry names so they cannot break out of the webview script', async () => {
    const uri = stack.provider.setFile(
      '/srv/out/xss.tar.gz',
      await buildTarGz({ '</script><script>alert(1)</script>.txt': 'x' })
    );
    const panel = await open(uri as unknown as vscode.Uri);
    expect(panel.html).not.toContain('</script><script>alert(1)');
    expect(panel.html).toContain('\\u003c/script>');
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
