import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import {
  clipboardState,
  configuration,
  createdTreeViews,
  executedCommands,
  FileType,
  messageAnswers,
  MockMemento,
  registeredCommands,
  TabInputCustom,
  TabInputText,
  ThemeIcon,
  TreeItemCollapsibleState,
  workspaceState
} from './mocks/vscode';
import { ArchiveManager } from '../src/archiveManager';
import { ArchiveIndex } from '../src/archiveIndex';
import { RemoteArchiveCache } from '../src/remoteArchiveCache';
import { archiveIdFromUri, uriFromArchiveId, VscodeRemoteFileAccess } from '../src/vscodeFileAccess';
import {
  ArchiveFileSystemProvider,
  archiveEntryUri,
  archiveRootUri,
  decodeArchiveUri
} from '../src/archiveFileSystemProvider';
import {
  ArchiveEntryElement,
  ArchiveMessageElement,
  ArchiveRootElement,
  ArchiveTreeElement,
  ArchiveTreeProvider,
  TREE_STATE_KEY,
  TREE_VIEW_ID
} from '../src/archiveTreeProvider';
import { archiveIdOfTarget, refreshArchiveSource, registerExplorerIntegration } from '../src/explorerIntegration';
import { ArchiveEditorProvider } from '../src/archiveEditorProvider';
import { ArchiveEntry } from '../src/models';
import { FakeRemoteFileSystemProvider } from './fakeRemoteFileSystemProvider';
import { buildTar, buildTarGz, buildZip, NESTED_FILES } from './remoteFixtures';
import { fixture } from './helpers';

const MB = 1024 * 1024;

function entry(p: string, size = 1): ArchiveEntry {
  const isDirectory = p.endsWith('/');
  const trimmed = p.replace(/\/$/, '');
  return { path: p, name: trimmed.slice(trimmed.lastIndexOf('/') + 1), isDirectory, size: isDirectory ? 0 : size };
}

describe('ArchiveIndex', () => {
  it('synthesises directories the archive does not list', () => {
    const index = new ArchiveIndex([entry('logs/2026/app.log'), entry('report.txt')]);
    expect(index.children('').map((n) => [n.name, n.isDirectory])).toEqual([
      ['logs', true],
      ['report.txt', false]
    ]);
    expect(index.children('logs').map((n) => n.path)).toEqual(['logs/2026']);
    expect(index.get('logs/2026')?.isDirectory).toBe(true);
    expect(index.get('logs/2026/app.log')?.entry?.size).toBe(1);
    expect(index.size).toBe(4);
  });

  it('sorts directories first, then names naturally', () => {
    const index = new ArchiveIndex([
      entry('file10.txt'),
      entry('file2.txt'),
      entry('B.txt'),
      entry('a.txt'),
      entry('zdir/'),
      entry('adir/x')
    ]);
    expect(index.children('').map((n) => n.name)).toEqual([
      'adir',
      'zdir',
      'a.txt',
      'B.txt',
      'file2.txt',
      'file10.txt'
    ]);
  });

  it('normalises ./ prefixes, backslashes and trailing slashes but reads entries by their listed name', () => {
    const index = new ArchiveIndex([entry('./conf/'), entry('./conf/app.json'), entry('win\\path\\x.txt')]);
    expect(index.children('').map((n) => n.name)).toEqual(['conf', 'win']);
    expect(index.get('conf/app.json')?.path).toBe('conf/app.json');
    expect(index.entryPathFor('conf/app.json')).toBe('./conf/app.json');
    expect(index.children('conf/').map((n) => n.name)).toEqual(['app.json']);
    expect(index.children('win/path').map((n) => n.name)).toEqual(['x.txt']);
  });

  it('keeps the directory when a file and a directory share a path', () => {
    const index = new ArchiveIndex([entry('a'), entry('a/b.txt')]);
    expect(index.get('a')?.isDirectory).toBe(true);
    expect(index.children('a').map((n) => n.name)).toEqual(['b.txt']);
  });

  it('is built once per entry list and shared', () => {
    const entries = [entry('x.txt')];
    expect(ArchiveIndex.for(entries)).toBe(ArchiveIndex.for(entries));
    expect(ArchiveIndex.for([...entries])).not.toBe(ArchiveIndex.for(entries));
  });

  it('returns nothing for files and unknown paths', () => {
    const index = new ArchiveIndex([entry('x.txt')]);
    expect(index.children('x.txt')).toEqual([]);
    expect(index.children('nope')).toEqual([]);
    expect(index.get('nope')).toBeUndefined();
  });
});

/** Remote stack: emulated Remote SSH provider → workspace.fs → RemoteArchiveCache → ArchiveManager. */
function setupStack() {
  const provider = new FakeRemoteFileSystemProvider();
  const registration = vscode.workspace.registerFileSystemProvider(
    'vscode-remote',
    provider as unknown as vscode.FileSystemProvider
  );
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-peek-tree-'));
  const limits = { maxArchiveBytes: 512 * MB };
  const cache = new RemoteArchiveCache(new VscodeRemoteFileAccess(), {
    baseDir: tmpBase,
    maxArchiveBytes: () => limits.maxArchiveBytes,
    maxCacheBytes: () => 2048 * MB
  });
  const manager = new ArchiveManager({ remote: cache });
  const fsProvider = new ArchiveFileSystemProvider(manager);
  return {
    provider,
    cache,
    manager,
    fsProvider,
    limits,
    tmpBase,
    dispose() {
      fsProvider.dispose();
      cache.dispose();
      registration.dispose();
      fs.rmSync(tmpBase, { recursive: true, force: true });
      // Nothing may ever be written to the remote side
      expect(provider.writeCalls).toBe(0);
    }
  };
}

type Stack = ReturnType<typeof setupStack>;

function names(elements: ArchiveTreeElement[], tree: ArchiveTreeProvider): string[] {
  return elements.map((e) => tree.getTreeItem(e).label as string);
}

async function childrenAt(tree: ArchiveTreeProvider, root: ArchiveTreeElement, dirPath: string) {
  let element: ArchiveTreeElement = root;
  for (const segment of dirPath ? dirPath.split('/') : []) {
    const children = await tree.getChildren(element);
    const next = children.find((c) => c.kind === 'entry' && c.path.split('/').pop() === segment);
    if (!next) {
      throw new Error(`No ${segment} under ${JSON.stringify(element)}`);
    }
    element = next;
  }
  return tree.getChildren(element);
}

describe('archive:// file system provider uses the shared index', () => {
  let stack: Stack;
  beforeEach(() => (stack = setupStack()));
  afterEach(() => stack.dispose());

  it('lists directories that a tar archive does not store explicitly', async () => {
    // buildTar stores only file entries for build/… (no "build/" entry)
    const uri = stack.provider.setFile('/srv/a.tar', await buildTar(NESTED_FILES));
    const id = archiveIdFromUri(uri as unknown as vscode.Uri);
    const root = await stack.fsProvider.readDirectory(archiveRootUri(id));
    expect(root).toEqual([
      ['build', FileType.Directory],
      ['empty-dir', FileType.Directory],
      ['README.md', FileType.File]
    ]);
    expect((await stack.fsProvider.stat(archiveEntryUri(id, 'build/config'))).type).toBe(FileType.Directory);
    await expect(stack.fsProvider.readDirectory(archiveEntryUri(id, 'README.md'))).rejects.toThrow(/FileNotADirectory/);
  });
  it('answers probes for missing files (e.g. .vscode/settings.json) without reading the archive or logging errors', async () => {
    const errors: string[] = [];
    const fsProvider = new ArchiveFileSystemProvider(stack.manager, {
      trace() {},
      info() {},
      warn() {},
      error: (m) => errors.push(m)
    });
    try {
      const uri = stack.provider.setFile('/srv/b.tar.gz', await buildTarGz(NESTED_FILES));
      const id = archiveIdFromUri(uri as unknown as vscode.Uri);
      await expect(fsProvider.readFile(archiveEntryUri(id, '.vscode/settings.json'))).rejects.toThrow(/FileNotFound/);
      await expect(fsProvider.readFile(archiveEntryUri(id, 'build'))).rejects.toThrow(/FileIsADirectory/);
      expect(Buffer.from(await fsProvider.readFile(archiveEntryUri(id, 'README.md'))).toString()).toBe(
        NESTED_FILES['README.md']
      );
      expect(errors).toEqual([]);
      expect(stack.provider.readFileCalls).toBe(1);
    } finally {
      fsProvider.dispose();
    }
  });
});

describe('Archive Peek tree view (emulated Remote SSH)', () => {
  let stack: Stack;
  let tree: ArchiveTreeProvider;
  let state: MockMemento;
  let id: string;

  beforeEach(async () => {
    stack = setupStack();
    state = new MockMemento();
    tree = new ArchiveTreeProvider(stack.manager, { state });
    const uri = stack.provider.setFile('/tmp/work/var/reports/pre_check.tar.gz', await buildTarGz(NESTED_FILES));
    id = archiveIdFromUri(uri as unknown as vscode.Uri);
  });

  afterEach(() => {
    tree.dispose();
    stack.dispose();
  });

  it('adds an archive without touching the remote host, and loads it once on first expand', async () => {
    const root = tree.add(id);
    expect(stack.provider.readFileCalls).toBe(0);
    expect(stack.provider.statCalls).toBe(0);
    expect(stack.manager.getArchive(id)).toBeUndefined();

    const top = await tree.getChildren(root);
    expect(names(top, tree)).toEqual(['build', 'empty-dir', 'README.md']);
    expect(stack.provider.readFileCalls).toBe(1);
    const statsAfterLoad = stack.provider.statCalls;

    // Expanding directories only reads the in-memory index
    expect(names(await childrenAt(tree, root, 'build'), tree)).toEqual(['config', 'logs']);
    expect(names(await childrenAt(tree, root, 'build/logs'), tree)).toEqual(['app.log', 'kernel messages.txt']);
    expect(names(await childrenAt(tree, root, 'build/config'), tree)).toEqual([
      'подсистема',
      'deploy.yaml',
      'settings.json'
    ]);
    expect(await childrenAt(tree, root, 'empty-dir')).toEqual([]);
    expect(stack.provider.readFileCalls).toBe(1);
    expect(stack.provider.statCalls).toBe(statsAfterLoad);
  });

  it('shows the archive as a collapsible node with the archive file icon and its location', () => {
    const item = tree.getTreeItem(tree.add(id));
    expect(item.label).toBe('pre_check.tar.gz');
    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
    expect(item.iconPath).toBe(ThemeIcon.File);
    expect(item.resourceUri?.toString()).toBe(uriFromArchiveId(id).toString());
    expect(item.description).toBe('SSH: test-host · /tmp/work/var/reports');
    expect(item.contextValue).toBe('archivePeek.archive.remote');
  });

  it('gives files archive:// URIs that open in a regular editor through the read-only file system', async () => {
    const root = tree.add(id);
    const logs = await childrenAt(tree, root, 'build/logs');
    const appLog = logs[0] as ArchiveEntryElement;
    const item = tree.getTreeItem(appLog);

    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
    expect(item.iconPath).toBe(ThemeIcon.File);
    expect(item.contextValue).toBe('archivePeek.file');
    expect(item.description).toBe(`${Buffer.byteLength(NESTED_FILES['build/logs/app.log'])} B`);
    expect(item.resourceUri?.scheme).toBe('archive');
    // The file name (with extension) ends the URI path: VS Code picks icon and language from it
    expect(item.resourceUri?.path).toBe('/pre_check.tar.gz/build/logs/app.log');
    expect(item.command?.command).toBe('vscode.open');
    expect(item.command?.arguments?.[0]).toBe(item.resourceUri);

    const decoded = decodeArchiveUri(item.resourceUri as vscode.Uri);
    expect(decoded).toEqual({ archivePath: id, entryPath: 'build/logs/app.log' });
    const content = await stack.fsProvider.readFile(item.resourceUri as vscode.Uri);
    expect(Buffer.from(content).toString()).toBe(NESTED_FILES['build/logs/app.log']);
    // The archive was not transferred again to open the file
    expect(stack.provider.readFileCalls).toBe(1);

    const dirItem = tree.getTreeItem((await tree.getChildren(root))[0]);
    expect(dirItem.iconPath).toBe(ThemeIcon.Folder);
    expect(dirItem.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
    expect(dirItem.contextValue).toBe('archivePeek.directory');
  });

  it('returns the same element objects and resolves parents (needed for reveal)', async () => {
    const root = tree.add(id);
    const build = (await tree.getChildren(root))[0];
    const logs = (await tree.getChildren(build))[1];
    const appLog = (await tree.getChildren(logs))[0];
    expect(tree.getParent(appLog)).toBe(logs);
    expect(tree.getParent(logs)).toBe(build);
    expect(tree.getParent(build)).toBe(root);
    expect(tree.getParent(root)).toBeUndefined();
    expect(tree.add(id)).toBe(root);
    expect(tree.archives).toEqual([id]);
  });

  it('keeps element ids stable across a refresh so expanded folders stay expanded', async () => {
    const root = tree.add(id);
    const before = (await childrenAt(tree, root, 'build/logs')).map((e) => tree.getTreeItem(e).id);
    const fired: unknown[] = [];
    tree.onDidChangeTreeData((e) => fired.push(e));

    stack.provider.setFile(
      '/tmp/work/var/reports/pre_check.tar.gz',
      await buildTarGz({ ...NESTED_FILES, 'build/logs/new.log': 'new\n' })
    );
    expect(await refreshArchiveSource(stack.manager, id, { trace() {}, info() {}, warn() {}, error() {} })).toBe(true);

    expect(fired).toContain(root);
    const after = await childrenAt(tree, root, 'build/logs');
    expect(names(after, tree)).toEqual(['app.log', 'kernel messages.txt', 'new.log']);
    expect(after.map((e) => tree.getTreeItem(e).id).slice(0, 2)).toEqual(before);
    expect(stack.provider.readFileCalls).toBe(2);
  });

  it('tells apart archives with the same name in different folders and on different hosts', async () => {
    const other = new FakeRemoteFileSystemProvider('Host-B', 'acme-sftp');
    const reg = vscode.workspace.registerFileSystemProvider('acme-sftp', other as unknown as vscode.FileSystemProvider);
    try {
      const data = await buildTarGz({ 'b.txt': 'b' });
      const sameHost = archiveIdFromUri(
        stack.provider.setFile('/srv/other/pre_check.tar.gz', data) as unknown as vscode.Uri
      );
      const otherHost = archiveIdFromUri(
        other.setFile('/tmp/work/var/reports/pre_check.tar.gz', data) as unknown as vscode.Uri
      );
      const roots = [tree.add(id), tree.add(sameHost), tree.add(otherHost)];
      const items = roots.map((r) => tree.getTreeItem(r));
      expect(items.map((i) => i.label)).toEqual(['pre_check.tar.gz', 'pre_check.tar.gz', 'pre_check.tar.gz']);
      expect(items.map((i) => i.description)).toEqual([
        'SSH: test-host · /tmp/work/var/reports',
        'SSH: test-host · /srv/other',
        'acme-sftp: Host-B · /tmp/work/var/reports'
      ]);
      expect(new Set(items.map((i) => i.id)).size).toBe(3);

      const childIds = await Promise.all(
        roots.map(async (r) => (await tree.getChildren(r)).map((c) => tree.getTreeItem(c).id))
      );
      expect(new Set(childIds.flat()).size).toBe(childIds.flat().length);
      // Each archive is read from its own host, keeping the authority's case
      expect(other.readFileCalls).toBe(1);
    } finally {
      reg.dispose();
    }
  });

  it('shows a load error with Retry instead of an empty archive', async () => {
    stack.provider.deny('/tmp/work/var/reports/pre_check.tar.gz');
    const root = tree.add(id);
    const children = await tree.getChildren(root);
    expect(children).toHaveLength(1);
    const message = children[0] as ArchiveMessageElement;
    expect(message.kind).toBe('message');
    expect(message.severity).toBe('error');
    expect(message.text).toMatch(/Permission denied/);
    expect(message.action?.command).toBe('archivePeek.tree.retry');
    expect(tree.getTreeItem(root).iconPath).toEqual(new ThemeIcon('warning'));

    // Stays in the error state (no new requests) until Retry
    const calls = stack.provider.statCalls + stack.provider.readFileCalls;
    await tree.getChildren(root);
    expect(stack.provider.statCalls + stack.provider.readFileCalls).toBe(calls);

    stack.provider.allow('/tmp/work/var/reports/pre_check.tar.gz');
    tree.retry(id);
    expect(names(await tree.getChildren(root), tree)).toEqual(['build', 'empty-dir', 'README.md']);
    expect(tree.getTreeItem(root).iconPath).toBe(ThemeIcon.File);
  });

  it('offers Load Anyway for archives above the remote size limit', async () => {
    stack.limits.maxArchiveBytes = 16;
    const root = tree.add(id);
    const [message] = (await tree.getChildren(root)) as ArchiveMessageElement[];
    expect(message.action?.command).toBe('archivePeek.tree.loadAnyway');
    expect(stack.provider.readFileCalls).toBe(0);

    stack.manager.allowOversize(id);
    tree.retry(id);
    expect(names(await tree.getChildren(root), tree)).toContain('build');
  });

  it('shows "deleted" when the archive disappears, and recovers when it is back', async () => {
    const root = tree.add(id);
    await tree.getChildren(root);
    stack.provider.removeFile('/tmp/work/var/reports/pre_check.tar.gz');
    stack.manager.markDeleted(id);
    const [message] = (await tree.getChildren(root)) as ArchiveMessageElement[];
    expect(message.text).toBe('The archive was deleted.');

    stack.provider.setFile('/tmp/work/var/reports/pre_check.tar.gz', await buildTarGz({ 'x.txt': 'x' }));
    await stack.manager.refreshIfChanged(id);
    expect(names(await tree.getChildren(root), tree)).toEqual(['x.txt']);
  });

  it('shares one load between concurrent expansions', async () => {
    const root = tree.add(id);
    await Promise.all([tree.getChildren(root), tree.getChildren(root), tree.getChildren(root)]);
    expect(stack.provider.readFileCalls).toBe(1);
  });

  it('remembers the archives per workspace without loading them on restore', async () => {
    tree.add(id);
    const second = archiveIdFromUri(
      stack.provider.setFile('/srv/b.zip', buildZip({ 'a.txt': 'a' })) as unknown as vscode.Uri
    );
    tree.add(second);
    expect(state.get(TREE_STATE_KEY, [])).toEqual([id, second]);

    const restored = new ArchiveTreeProvider(stack.manager, { state });
    try {
      expect(restored.archives).toEqual([id, second]);
      expect(stack.provider.readFileCalls).toBe(0);
      restored.remove(id);
      expect(state.get(TREE_STATE_KEY, [])).toEqual([second]);
    } finally {
      restored.dispose();
    }
  });

  it('shows a note for an empty archive', async () => {
    const emptyId = archiveIdFromUri(
      stack.provider.setFile('/srv/empty.tar', await buildTar({})) as unknown as vscode.Uri
    );
    const [message] = (await tree.getChildren(tree.add(emptyId))) as ArchiveMessageElement[];
    expect(message.kind).toBe('message');
    expect(message.text).toBe('This archive is empty.');
  });
});

describe('Archive Peek tree view with local archives', () => {
  it('browses the local fixtures exactly like before (no remote layer involved)', async () => {
    const manager = new ArchiveManager();
    const tree = new ArchiveTreeProvider(manager);
    try {
      for (const name of ['sample.zip', 'sample.tar', 'sample.tar.gz', 'sample.tar.bz2', 'sample.tar.xz']) {
        const root = tree.add(fixture(name));
        const item = tree.getTreeItem(root);
        expect(item.label).toBe(name);
        expect(item.contextValue).toBe('archivePeek.archive.local');
        expect(item.resourceUri?.scheme).toBe('file');
        const top = names(await tree.getChildren(root), tree);
        expect(top).toEqual(['src', 'hello.txt', 'package.json']);
        const src = await childrenAt(tree, root, 'src');
        expect(names(src, tree)).toEqual(['index.ts']);
        const uri = tree.getTreeItem(src[0]).resourceUri as vscode.Uri;
        expect(uri.path).toBe(`/${name}/src/index.ts`);
      }
      const gz = tree.add(fixture('hello.txt.gz'));
      expect(names(await tree.getChildren(gz), tree)).toEqual(['hello.txt']);
    } finally {
      tree.dispose();
    }
  });

  it('reads files of tar archives that store ./-prefixed names', async () => {
    const manager = new ArchiveManager();
    const fsProvider = new ArchiveFileSystemProvider(manager);
    const tree = new ArchiveTreeProvider(manager);
    try {
      const root = tree.add(fixture('sample.tar.gz'));
      const hello = (await tree.getChildren(root)).find(
        (e) => e.kind === 'entry' && e.path === 'hello.txt'
      ) as ArchiveEntryElement;
      const data = await fsProvider.readFile(tree.getTreeItem(hello).resourceUri as vscode.Uri);
      expect(Buffer.from(data).toString()).toBe('Hello, World!\n');
    } finally {
      tree.dispose();
      fsProvider.dispose();
    }
  });
});

describe('Explorer integration commands', () => {
  let stack: Stack;
  let context: { subscriptions: { dispose(): unknown }[] };
  let integration: ReturnType<typeof registerExplorerIntegration>;
  let uri: vscode.Uri;
  let id: string;

  beforeEach(async () => {
    stack = setupStack();
    context = { subscriptions: [] };
    executedCommands.length = 0;
    createdTreeViews.length = 0;
    messageAnswers.length = 0;
    workspaceState.folders = undefined;
    workspaceState.workspaceFile = undefined;
    vscode.window.tabGroups.all.length = 0;
    delete configuration['archivePeek.openMode'];
    integration = registerExplorerIntegration(context, {
      archiveManager: stack.manager,
      showLog: () => {},
      state: new MockMemento() as unknown as vscode.Memento
    });
    uri = stack.provider.setFile(
      '/srv/reports/pre_check.tar.gz',
      await buildTarGz(NESTED_FILES)
    ) as unknown as vscode.Uri;
    id = archiveIdFromUri(uri);
  });

  afterEach(() => {
    for (const d of context.subscriptions) {
      d.dispose();
    }
    vscode.window.tabGroups.all.length = 0;
    workspaceState.folders = undefined;
    delete configuration['archivePeek.openMode'];
    stack.dispose();
  });

  const run = (command: string, ...args: unknown[]) => {
    const handler = registeredCommands.get(command);
    if (!handler) {
      throw new Error(`Command not registered: ${command}`);
    }
    return handler(...args);
  };

  it('registers a tree view in the Explorer', () => {
    expect(createdTreeViews.map((v) => v.id)).toEqual([TREE_VIEW_ID]);
  });

  it('"Open in Archive Peek View" adds the archive, focuses the view and expands the archive', async () => {
    await run('archivePeek.openInTree', uri);
    expect(integration.tree.archives).toEqual([id]);
    expect(executedCommands.map((c) => c.command)).toContain(`${TREE_VIEW_ID}.focus`);
    const [reveal] = createdTreeViews[0].revealed;
    expect(reveal.element).toBe(integration.tree.rootElement(id));
    expect(reveal.options).toEqual({ select: true, focus: true, expand: true });
  });

  it('accepts several archives at once', async () => {
    const second = stack.provider.setFile('/srv/other/pre_check.tar.gz', await buildTarGz({ a: 'a' }));
    await run('archivePeek.openInTree', uri);
    await run('archivePeek.openInTree', second);
    await run('archivePeek.openInTree', uri);
    expect(integration.tree.archives).toEqual([id, archiveIdFromUri(second as unknown as vscode.Uri)]);
  });

  it('"Close Archive" removes it and frees it unless it is open elsewhere', async () => {
    await run('archivePeek.openInTree', uri);
    const root = integration.tree.rootElement(id);
    await integration.tree.getChildren(root);
    expect(stack.manager.getArchive(id)).toBeDefined();
    await run('archivePeek.tree.close', root);
    expect(integration.tree.archives).toEqual([]);
    expect(stack.manager.getArchive(id)).toBeUndefined();

    // Still shown in an archive viewer tab: keep it loaded
    await run('archivePeek.openInTree', uri);
    await integration.tree.getChildren(integration.tree.rootElement(id));
    vscode.window.tabGroups.all.push({ tabs: [{ input: new TabInputCustom(uri as never) }] });
    await run('archivePeek.tree.close', integration.tree.rootElement(id));
    expect(stack.manager.getArchive(id)).toBeDefined();
  });

  it('keeps an archive loaded while one of its files is open in an editor', async () => {
    await run('archivePeek.openInTree', uri);
    await integration.tree.getChildren(integration.tree.rootElement(id));
    vscode.window.tabGroups.all.push({
      tabs: [{ input: new TabInputText(archiveEntryUri(id, 'README.md') as never) }]
    });
    await run('archivePeek.tree.closeAll');
    expect(integration.tree.archives).toEqual([]);
    expect(stack.manager.getArchive(id)).toBeDefined();
  });

  it('copies paths of the archive and of entries', async () => {
    await run('archivePeek.openInTree', uri);
    const root = integration.tree.rootElement(id);
    await run('archivePeek.tree.copyPath', root);
    expect(clipboardState.text).toBe('/srv/reports/pre_check.tar.gz');
    const log = integration.tree.entryElement(id, { path: 'build/logs/app.log', isDirectory: false });
    await run('archivePeek.tree.copyPath', log);
    expect(clipboardState.text).toBe('/srv/reports/pre_check.tar.gz/build/logs/app.log');
    await run('archivePeek.tree.copyPathInArchive', log);
    expect(clipboardState.text).toBe('build/logs/app.log');
  });

  it('reveals the source archive in the Explorer when it is in the workspace', async () => {
    workspaceState.folders = [{ uri: stack.provider.uri('/srv') as never, name: 'srv', index: 0 }];
    await run('archivePeek.openInTree', uri);
    const log = integration.tree.entryElement(id, { path: 'build/logs/app.log', isDirectory: false });
    await run('archivePeek.tree.revealSource', log);
    const reveal = executedCommands.find((c) => c.command === 'revealInExplorer');
    expect((reveal?.args[0] as vscode.Uri).toString()).toBe(uri.toString());
  });

  it('opens files in a regular editor tab', async () => {
    const log = integration.tree.entryElement(id, { path: 'build/config/settings.json', isDirectory: false });
    await run('archivePeek.tree.open', log);
    const open = executedCommands.find((c) => c.command === 'vscode.open');
    expect((open?.args[0] as vscode.Uri).path).toBe('/pre_check.tar.gz/build/config/settings.json');
  });

  it('adds an archive to the workspace as a read-only folder only after confirmation', async () => {
    messageAnswers.push(undefined);
    await run('archivePeek.mountAsWorkspaceFolder', uri);
    expect(vscode.workspace.workspaceFolders).toBeUndefined();

    messageAnswers.push('Add to Workspace');
    await run('archivePeek.mountAsWorkspaceFolder', uri);
    const folders = vscode.workspace.workspaceFolders!;
    expect(folders).toHaveLength(1);
    expect(folders[0].uri.toString()).toBe(archiveRootUri(id).toString());
    expect(folders[0].name).toBe('pre_check.tar.gz (SSH: test-host, read-only archive)');

    // The regular Explorer lists it through the archive:// file system
    const listing = await stack.fsProvider.readDirectory(folders[0].uri);
    expect(listing.map(([n]) => n)).toEqual(['build', 'empty-dir', 'README.md']);

    // Mounting again only reveals it
    await run('archivePeek.mountAsWorkspaceFolder', uri);
    expect(vscode.workspace.workspaceFolders).toHaveLength(1);

    // Removing it from its root folder's context menu
    expect(archiveIdOfTarget(folders[0].uri)).toBe(id);
    await run('archivePeek.unmountWorkspaceFolder', folders[0].uri);
    expect(vscode.workspace.workspaceFolders).toEqual([]);
  });

  it('follows archivePeek.openMode for archives opened from the Explorer', async () => {
    // Default: the viewer
    expect(integration.editorHooks.redirect(id)).toBe(false);

    configuration['archivePeek.openMode'] = 'explorerTree';
    expect(integration.editorHooks.redirect(id)).toBe(true);
    expect(integration.tree.archives).toEqual([id]);

    // "Open in Archive Viewer" still opens the viewer once
    await run('archivePeek.openInViewer', uri);
    const openWith = executedCommands.find((c) => c.command === 'vscode.openWith');
    expect(openWith?.args[1]).toBe('archivePeek.archiveEditor');
    expect(integration.editorHooks.redirect(id)).toBe(false);
    expect(integration.editorHooks.redirect(id)).toBe(true);
  });

  it('the viewer closes itself and hands the archive to the tree in explorerTree mode', async () => {
    configuration['archivePeek.openMode'] = 'explorerTree';
    const editor = new ArchiveEditorProvider(stack.manager, integration.editorHooks);
    const tab = { input: new TabInputCustom(uri as never) };
    vscode.window.tabGroups.all.push({ tabs: [tab] });
    const panel = {
      html: '',
      webview: {
        options: {},
        set html(value: string) {
          panel.html = value;
        },
        onDidReceiveMessage: () => ({ dispose() {} })
      },
      onDidChangeViewState: () => ({ dispose() {} }),
      onDidDispose: () => ({ dispose() {} })
    };
    const token = {} as vscode.CancellationToken;
    const doc = await editor.openCustomDocument(uri, {} as vscode.CustomDocumentOpenContext, token);
    await editor.resolveCustomEditor(doc, panel as unknown as vscode.WebviewPanel, token);
    expect(panel.html).toContain('Opened in the Archive Peek section of the Explorer');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(vscode.window.tabGroups.all[0].tabs).toEqual([]);
    expect(integration.tree.archives).toEqual([id]);
    // The viewer didn't load the archive; the tree loads it when expanded
    expect(stack.provider.readFileCalls).toBe(0);
  });

  it('Refresh reloads a changed archive and keeps it in the tree', async () => {
    await run('archivePeek.openInTree', uri);
    const root = integration.tree.rootElement(id);
    await integration.tree.getChildren(root);
    stack.provider.setFile('/srv/reports/pre_check.tar.gz', await buildTarGz({ 'only.txt': crypto.randomUUID() }));
    await run('archivePeek.tree.refresh', root);
    expect(names(await integration.tree.getChildren(root), integration.tree)).toEqual(['only.txt']);
  });
});

describe('command targets', () => {
  it('maps Explorer URIs, tree elements and mounted roots to archive ids', () => {
    const remote = vscode.Uri.parse('vscode-remote://ssh-remote+Host/a/b.zip');
    const remoteId = archiveIdFromUri(remote);
    expect(archiveIdOfTarget(remote)).toBe(remoteId);
    expect(archiveIdOfTarget({ kind: 'archive', archiveId: remoteId } as ArchiveRootElement)).toBe(remoteId);
    expect(archiveIdOfTarget(archiveRootUri(remoteId))).toBe(remoteId);
    expect(archiveIdOfTarget(vscode.Uri.file('/tmp/x.zip'))).toBe(path.resolve('/tmp/x.zip'));
    expect(archiveIdOfTarget(undefined)).toBeUndefined();
  });
});
