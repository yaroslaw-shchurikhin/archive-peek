import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { URI } from 'vscode-uri';
import {
  configuration,
  createdWatchers,
  MockMemento,
  RelativePattern,
  ThemeIcon,
  TreeItemCollapsibleState,
  workspaceState
} from './mocks/vscode';
import { ArchiveManager } from '../src/archiveManager';
import { RemoteArchiveCache } from '../src/remoteArchiveCache';
import { archiveIdFromUri, VscodeRemoteFileAccess } from '../src/vscodeFileAccess';
import { archiveRootUri } from '../src/archiveFileSystemProvider';
import {
  ArchiveMessageElement,
  ArchiveRootElement,
  ArchiveTreeElement,
  ArchiveTreeProvider,
  TREE_HIDDEN_KEY
} from '../src/archiveTreeProvider';
import {
  ArchiveDiscovery,
  buildExcludePattern,
  DEFAULT_INCLUDE,
  readDiscoverySettings,
  workspaceRelativeLocation
} from '../src/archiveDiscovery';
import { FakeRemoteFileSystemProvider } from './fakeRemoteFileSystemProvider';
import { buildTarGz, NESTED_FILES } from './remoteFixtures';

const MB = 1024 * 1024;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('discovery settings', () => {
  afterEach(() => {
    for (const key of Object.keys(configuration)) {
      delete configuration[key];
    }
  });

  it('is off by default and searches all supported archive types', () => {
    const settings = readDiscoverySettings();
    expect(settings).toEqual({
      enabled: false,
      include: DEFAULT_INCLUDE,
      exclude: '**/node_modules/**',
      maxResults: 200
    });
    expect(DEFAULT_INCLUDE).toContain('gz');
    expect(DEFAULT_INCLUDE).toContain('tgz');
    expect(DEFAULT_INCLUDE).toContain('zip');
  });

  it('falls back to defaults for invalid values', () => {
    configuration['archivePeek.tree.autoDiscover'] = true;
    configuration['archivePeek.tree.autoDiscoverInclude'] = '  ';
    configuration['archivePeek.tree.autoDiscoverMaxResults'] = -5;
    const settings = readDiscoverySettings();
    expect(settings.enabled).toBe(true);
    expect(settings.include).toBe(DEFAULT_INCLUDE);
    expect(settings.maxResults).toBe(200);
  });

  it('merges files.exclude into the exclude pattern', () => {
    expect(buildExcludePattern('**/node_modules/**', { '**/.git': true, '**/tmp': false, '**/x': { when: 'y' } })).toBe(
      '{**/node_modules/**,**/.git}'
    );
    expect(buildExcludePattern('', { '**/.git': true })).toBe('**/.git');
    expect(buildExcludePattern('', undefined)).toBeUndefined();
  });
});

describe('Found in Workspace (archivePeek.tree.autoDiscover)', () => {
  let provider: FakeRemoteFileSystemProvider;
  let registration: { dispose(): void };
  let tmpBase: string;
  let cache: RemoteArchiveCache;
  let manager: ArchiveManager;
  let tree: ArchiveTreeProvider;
  let discovery: ArchiveDiscovery;
  let state: MockMemento;
  let folder: { uri: URI; name: string; index: number };
  /** Archives the emulated search service returns, by path on the host */
  let searchResults: string[];

  beforeEach(async () => {
    provider = new FakeRemoteFileSystemProvider();
    registration = vscode.workspace.registerFileSystemProvider(
      'vscode-remote',
      provider as unknown as vscode.FileSystemProvider
    );
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-peek-discovery-'));
    cache = new RemoteArchiveCache(new VscodeRemoteFileAccess(), {
      baseDir: tmpBase,
      maxArchiveBytes: () => 512 * MB,
      maxCacheBytes: () => 2048 * MB
    });
    manager = new ArchiveManager({ remote: cache });
    state = new MockMemento();

    folder = { uri: provider.uri('/srv/project'), name: 'project', index: 0 };
    workspaceState.folders = [folder];
    workspaceState.findFilesCalls.length = 0;
    createdWatchers.length = 0;
    const data = await buildTarGz(NESTED_FILES);
    searchResults = [
      '/srv/project/reports/pre_check.tar.gz',
      '/srv/project/reports/post_check.tar.gz',
      '/srv/project/build/out.zip',
      '/srv/project/notes.txt'
    ];
    for (const p of searchResults) {
      provider.setFile(p, data);
    }
    workspaceState.findFiles = async (_include, _exclude, maxResults) =>
      searchResults.slice(0, maxResults).map((p) => provider.uri(p));
    configuration['archivePeek.tree.autoDiscover'] = true;
    createTree();
  });

  function createTree() {
    tree = new ArchiveTreeProvider(manager, {
      state,
      relativeLocation: workspaceRelativeLocation,
      onDidRequestDiscovery: () => discovery.request()
    });
    discovery = new ArchiveDiscovery(tree, manager, undefined, undefined, () => ({ '**/.git': true }));
  }

  afterEach(() => {
    discovery.dispose();
    tree.dispose();
    cache.dispose();
    registration.dispose();
    fs.rmSync(tmpBase, { recursive: true, force: true });
    workspaceState.folders = undefined;
    workspaceState.findFiles = async () => [];
    for (const key of Object.keys(configuration)) {
      delete configuration[key];
    }
    expect(provider.writeCalls).toBe(0);
  });

  const id = (p: string) => archiveIdFromUri(provider.uri(p) as unknown as vscode.Uri);
  const label = (e: ArchiveTreeElement) => tree.getTreeItem(e).label;

  /** Show the tree (as VS Code does) and wait for the search to finish. */
  async function showTree(): Promise<ArchiveTreeElement[]> {
    await tree.getChildren();
    await flush();
    await flush();
    return tree.getChildren();
  }

  async function groupChildren(): Promise<ArchiveTreeElement[]> {
    const roots = await tree.getChildren();
    const group = roots.find((r) => r.kind === 'group');
    if (!group) {
      throw new Error('No "Found in Workspace" group');
    }
    return tree.getChildren(group);
  }

  it('searches only once the section is shown, and lists archives without reading them', async () => {
    expect(workspaceState.findFilesCalls).toHaveLength(0);
    const roots = await showTree();
    expect(roots.map((r) => r.kind)).toEqual(['group']);
    expect(workspaceState.findFilesCalls).toHaveLength(1);

    const call = workspaceState.findFilesCalls[0];
    expect(call.include).toBeInstanceOf(RelativePattern);
    expect((call.include as RelativePattern).baseUri.toString()).toBe(folder.uri.toString());
    expect((call.include as RelativePattern).pattern).toBe(DEFAULT_INCLUDE);
    expect(call.exclude).toBe('{**/node_modules/**,**/.git}');
    expect(call.maxResults).toBe(201);

    const found = await groupChildren();
    // notes.txt is not an archive; sorted by location
    expect(found.map(label)).toEqual(['out.zip', 'post_check.tar.gz', 'pre_check.tar.gz']);
    expect(found.map((e) => tree.getTreeItem(e).description)).toEqual(['build', 'reports', 'reports']);
    // Only listed: nothing was transferred or even stat'ed
    expect(provider.readFileCalls).toBe(0);
    expect(provider.statCalls).toBe(0);

    const groupItem = tree.getTreeItem(roots[0]);
    expect(groupItem.label).toBe('Found in Workspace');
    expect(groupItem.description).toBe('3 archives');
    expect(groupItem.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
    expect(groupItem.contextValue).toBe('archivePeek.discoveredGroup');
    expect(tree.allArchives).toHaveLength(3);
  });

  it('loads a found archive only when it is expanded', async () => {
    await showTree();
    const pre = (await groupChildren()).find((e) => label(e) === 'pre_check.tar.gz') as ArchiveRootElement;
    expect(tree.getParent(pre)).toEqual({ kind: 'group' });
    expect(tree.getTreeItem(pre).contextValue).toBe('archivePeek.archive.remote.discovered');
    const children = await tree.getChildren(pre);
    expect(children.map(label)).toEqual(['build', 'empty-dir', 'README.md']);
    expect(provider.readFileCalls).toBe(1);
    expect(tree.getParent(children[0])).toBe(pre);
  });

  it('does not search when it is off (the default)', async () => {
    delete configuration['archivePeek.tree.autoDiscover'];
    discovery.dispose();
    tree.dispose();
    createTree();
    expect(await tree.getChildren()).toEqual([]);
    await flush();
    expect(workspaceState.findFilesCalls).toHaveLength(0);
    expect(createdWatchers).toHaveLength(0);
  });

  it('marks the list as cut off above the maximum', async () => {
    configuration['archivePeek.tree.autoDiscoverMaxResults'] = 2;
    discovery.applySettings(readDiscoverySettings());
    await showTree();
    expect(workspaceState.findFilesCalls.at(-1)?.maxResults).toBe(3);
    const roots = await tree.getChildren();
    expect(tree.discoveryState.truncated).toBe(true);
    expect(tree.getTreeItem(roots[0]).description).toBe('2+ archives');
  });

  it('keeps the list current with a file watcher instead of searching again', async () => {
    await showTree();
    expect(createdWatchers).toHaveLength(1);
    const watcher = createdWatchers[0];
    expect(watcher.pattern.pattern).toBe(DEFAULT_INCLUDE);

    watcher.fireCreate(provider.uri('/srv/project/new/fresh.tgz'));
    watcher.fireCreate(provider.uri('/srv/project/node_modules/pkg/pkg.tgz'));
    watcher.fireCreate(provider.uri('/srv/project/readme.md'));
    expect((await groupChildren()).map(label)).toContain('fresh.tgz');
    expect((await groupChildren()).map(label)).not.toContain('pkg.tgz');
    expect((await groupChildren()).map(label)).not.toContain('readme.md');

    watcher.fireDelete(provider.uri('/srv/project/build/out.zip'));
    expect((await groupChildren()).map(label)).not.toContain('out.zip');
    expect(workspaceState.findFilesCalls).toHaveLength(1);
  });

  it('hides a closed found archive until Rescan', async () => {
    await showTree();
    tree.remove(id('/srv/project/build/out.zip'));
    expect((await groupChildren()).map(label)).toEqual(['post_check.tar.gz', 'pre_check.tar.gz']);
    expect(state.get(TREE_HIDDEN_KEY, [])).toEqual([id('/srv/project/build/out.zip')]);

    // Also after a reload of the window
    discovery.dispose();
    tree.dispose();
    createTree();
    await showTree();
    expect((await groupChildren()).map(label)).toEqual(['post_check.tar.gz', 'pre_check.tar.gz']);

    await discovery.scan({ resetHidden: true });
    expect((await groupChildren()).map(label)).toEqual(['out.zip', 'post_check.tar.gz', 'pre_check.tar.gz']);
    expect(state.get(TREE_HIDDEN_KEY, [])).toEqual([]);
  });

  it('moves a found archive to the top when it is opened explicitly', async () => {
    await showTree();
    const preId = id('/srv/project/reports/pre_check.tar.gz');
    const root = tree.add(preId);
    const roots = await tree.getChildren();
    expect(roots[0]).toBe(root);
    expect(roots[1].kind).toBe('group');
    expect((await groupChildren()).map(label)).toEqual(['out.zip', 'post_check.tar.gz']);
    expect(tree.getParent(root)).toBeUndefined();
    expect(tree.getTreeItem(root).description).toBe('SSH: test-host · /srv/project/reports');
  });

  it('skips folders mounted from archives, and searches again when folders change', async () => {
    await showTree();
    vscode.workspace.updateWorkspaceFolders(1, 0, {
      uri: archiveRootUri(id('/srv/project/build/out.zip')) as never,
      name: 'out.zip'
    });
    await flush();
    expect(workspaceState.findFilesCalls).toHaveLength(2);
    expect(
      workspaceState.findFilesCalls.every((c) => (c.include as RelativePattern).baseUri.scheme === 'vscode-remote')
    ).toBe(true);
  });

  it('shows a search error with Rescan', async () => {
    workspaceState.findFiles = async () => {
      throw new Error('search service unavailable');
    };
    await showTree();
    const [message] = (await groupChildren()) as ArchiveMessageElement[];
    expect(message.kind).toBe('message');
    expect(message.severity).toBe('error');
    expect(message.action?.command).toBe('archivePeek.tree.rescan');
    expect(tree.getParent(message)).toEqual({ kind: 'group' });
  });

  it('says so when nothing is found', async () => {
    workspaceState.findFiles = async () => [];
    await showTree();
    const [message] = (await groupChildren()) as ArchiveMessageElement[];
    expect(message.text).toBe('No archives found in the workspace.');
    expect(tree.getTreeItem(message).iconPath).toEqual(new ThemeIcon('info'));
  });

  it('removes the group and stops watching when it is turned off', async () => {
    await showTree();
    expect(createdWatchers[0].disposed).toBe(false);
    configuration['archivePeek.tree.autoDiscover'] = false;
    discovery.applySettings(readDiscoverySettings());
    expect(await tree.getChildren()).toEqual([]);
    expect(tree.allArchives).toEqual([]);
    expect(createdWatchers[0].disposed).toBe(true);
  });

  it('labels found archives by workspace folder in multi-root workspaces', () => {
    workspaceState.folders = [folder, { uri: provider.uri('/srv/other'), name: 'other', index: 1 }];
    expect(workspaceRelativeLocation(id('/srv/project/reports/a.zip'))).toBe('project/reports');
    expect(workspaceRelativeLocation(id('/srv/other/a.zip'))).toBe('other');
    workspaceState.folders = [folder];
    expect(workspaceRelativeLocation(id('/srv/project/a.zip'))).toBe('.');
    expect(workspaceRelativeLocation(id('/elsewhere/a.zip'))).toBeUndefined();
  });
});
