import * as vscode from 'vscode';
import { ArchiveManager } from './archiveManager';
import { ARCHIVE_SCHEME, archiveEntryUri, archiveRootUri, decodeArchiveUri } from './archiveFileSystemProvider';
import { ArchiveEditorProvider } from './archiveEditorProvider';
import {
  ArchiveEntryElement,
  ArchiveNode,
  ArchiveTreeElement,
  ArchiveTreeProvider,
  archiveLocation,
  TREE_COMMANDS,
  TREE_VIEW_ID
} from './archiveTreeProvider';
import {
  archiveBaseName,
  archivePathPart,
  describeArchiveId,
  isRemoteId,
  normalizeArchiveId,
  remoteLabel
} from './archiveId';
import { openMode } from './config';
import { ArchiveDiscovery, workspaceRelativeLocation } from './archiveDiscovery';
import { Logger, NULL_LOGGER } from './models';
import { describeError } from './sourceErrors';
import { archiveIdFromUri, uriFromArchiveId } from './vscodeFileAccess';

/** File dialog filters for picking an archive. */
export const ARCHIVE_DIALOG_FILTERS: Record<string, string[]> = {
  Archives: [
    'zip',
    '7z',
    'rar',
    'tar',
    'gz',
    'bz2',
    'xz',
    'tar.gz',
    'tgz',
    'tar.bz2',
    'tbz2',
    'tar.xz',
    'txz',
    'jar',
    'war',
    'ear',
    'vsix',
    'nupkg',
    'apk',
    'whl',
    'xpi',
    'epub',
    'aar'
  ],
  'ZIP Files': ['zip', 'jar', 'war', 'ear', 'vsix', 'nupkg', 'apk', 'whl', 'xpi', 'epub', 'aar'],
  '7-Zip Files': ['7z'],
  'RAR Files': ['rar'],
  'GZip Files': ['gz'],
  'BZip2 Files': ['bz2'],
  'XZ Files': ['xz'],
  'Tar Files': ['tar', 'tar.gz', 'tgz', 'tar.bz2', 'tbz2', 'tar.xz', 'txz'],
  'All Files': ['*']
};

/** Ask the user for an archive (in a Remote SSH window the dialog browses the remote host). */
export async function pickArchive(openLabel: string): Promise<vscode.Uri | undefined> {
  const result = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel,
    filters: ARCHIVE_DIALOG_FILTERS
  });
  return result?.[0];
}

/**
 * Re-check one archive and re-read it if it is still there. Returns false if
 * the refresh failed (the previous contents are kept).
 */
export async function refreshArchiveSource(
  archiveManager: ArchiveManager,
  archiveId: string,
  logger: Logger,
  report?: (message: string) => void
): Promise<boolean> {
  const name = archiveBaseName(archiveId);
  try {
    const state = await archiveManager.probe(archiveId);
    if (state === 'missing') {
      archiveManager.markDeleted(archiveId);
      return true;
    }
    await archiveManager.refreshArchive(archiveId, {
      onProgress: (message) => report?.(`${name}: ${message}`)
    });
    logger.info(`Refreshed ${describeArchiveId(archiveId, { redactHost: true })}`);
    return true;
  } catch (error) {
    const { kind, message } = describeError(error);
    logger.warn(`Failed to refresh ${describeArchiveId(archiveId, { redactHost: true })} [${kind}]: ${message}`);
    vscode.window.showWarningMessage(`Failed to refresh ${name}: ${message}`);
    return false;
  }
}

/**
 * True if an archive is still shown somewhere other than the tree: an
 * archive viewer tab, an editor with one of its files, or a workspace folder.
 * Used to decide whether closing it in the tree may free its resources.
 */
export function archiveInUse(archiveId: string): boolean {
  const sourceUri = uriFromArchiveId(archiveId).toString();
  const authority = archiveRootUri(archiveId).authority;
  const isOurs = (uri: vscode.Uri | undefined) => !!uri && uri.scheme === ARCHIVE_SCHEME && uri.authority === authority;

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputCustom) {
        if (input.uri.toString() === sourceUri || isOurs(input.uri)) {
          return true;
        }
      } else if (input instanceof vscode.TabInputText) {
        if (isOurs(input.uri)) {
          return true;
        }
      } else if (input instanceof vscode.TabInputTextDiff) {
        if (isOurs(input.original) || isOurs(input.modified)) {
          return true;
        }
      }
    }
  }
  return (vscode.workspace.workspaceFolders ?? []).some((folder) => isOurs(folder.uri));
}

/** Workspace folder that shows an archive, if it is mounted. */
export function mountedFolder(archiveId: string): vscode.WorkspaceFolder | undefined {
  const authority = archiveRootUri(archiveId).authority;
  return (vscode.workspace.workspaceFolders ?? []).find(
    (folder) => folder.uri.scheme === ARCHIVE_SCHEME && folder.uri.authority === authority
  );
}

/** Name of the workspace folder for a mounted archive, e.g. `build.tar.gz (SSH: host)`. */
export function mountedFolderName(archiveId: string): string {
  const label = remoteLabel(archiveId);
  return `${archiveBaseName(archiveId)} (${label ? `${label}, ` : ''}read-only archive)`;
}

/**
 * Add an archive to the workspace as a read-only folder (archive:// file
 * system), so it appears in the regular Explorer tree. Only done on explicit
 * request, after confirmation: VS Code turns a single-folder window into an
 * (untitled) multi-root workspace and restarts extensions when a folder is added.
 */
export async function mountArchive(archiveId: string): Promise<boolean> {
  const existing = mountedFolder(archiveId);
  if (existing) {
    await vscode.commands.executeCommand('workbench.view.explorer');
    await vscode.commands.executeCommand('revealInExplorer', existing.uri);
    return true;
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  const singleFolder = folders.length > 0 && !vscode.workspace.workspaceFile;
  const detail = [
    `"${archiveBaseName(archiveId)}" will appear in the Explorer as a read-only folder. The archive itself is not changed.`,
    singleFolder
      ? 'This window has a single folder open, so VS Code will turn it into an untitled multi-root workspace and restart extensions. You can remove the folder again with "Remove Folder from Workspace".'
      : 'You can remove it again with "Remove Folder from Workspace".'
  ].join('\n\n');
  const choice = await vscode.window.showWarningMessage(
    'Add the archive to the workspace as a folder?',
    { modal: true, detail },
    'Add to Workspace'
  );
  if (choice !== 'Add to Workspace') {
    return false;
  }
  const added = vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
    uri: archiveRootUri(archiveId),
    name: mountedFolderName(archiveId)
  });
  if (!added) {
    vscode.window.showErrorMessage('VS Code did not accept the workspace folder change.');
    return false;
  }
  await vscode.commands.executeCommand('workbench.view.explorer');
  return true;
}

/** Remove a mounted archive folder from the workspace. */
export function unmountArchive(archiveId: string): boolean {
  const folder = mountedFolder(archiveId);
  if (!folder) {
    return false;
  }
  return vscode.workspace.updateWorkspaceFolders(folder.index, 1);
}

/** What a command was invoked on: an Explorer resource, or a node of the Archive Peek tree. */
type CommandTarget = vscode.Uri | ArchiveTreeElement | string | undefined;

/** Archive id of a command target (for archive:// URIs: the archive they belong to). */
export function archiveIdOfTarget(target: CommandTarget): string | undefined {
  if (!target) {
    return undefined;
  }
  if (typeof target === 'string') {
    return normalizeArchiveId(target);
  }
  if (target instanceof vscode.Uri || ('scheme' in target && 'authority' in target)) {
    const uri = target as vscode.Uri;
    if (uri.scheme === ARCHIVE_SCHEME && decodeArchiveUri(uri).entryPath === '') {
      // Root of a mounted archive folder
      return decodeArchiveUri(uri).archivePath;
    }
    return archiveIdFromUri(uri);
  }
  const element = target as ArchiveTreeElement;
  return element.kind === 'group' || (element.kind === 'message' && !element.archiveId) ? undefined : element.archiveId;
}

export interface ExplorerIntegrationOptions {
  archiveManager: ArchiveManager;
  logger?: Logger;
  showLog: () => void;
  state?: vscode.Memento;
}

/**
 * The "Archive Peek" section of the Explorer and its commands. Returns hooks
 * for the archive viewer so archivePeek.openMode can send archives clicked in
 * the Explorer to the tree instead.
 */
export function registerExplorerIntegration(
  context: { subscriptions: { dispose(): unknown }[] },
  options: ExplorerIntegrationOptions
): {
  tree: ArchiveTreeProvider;
  openInTree: (archiveId: string) => Promise<void>;
  editorHooks: { redirect: (archiveId: string) => boolean; forceViewer: (archiveId: string) => void };
} {
  const { archiveManager, showLog } = options;
  const logger = options.logger ?? NULL_LOGGER;
  // Created below; the tree asks it to search once it is shown
  const discoveryRef: { current?: ArchiveDiscovery } = {};
  const tree = new ArchiveTreeProvider(archiveManager, {
    state: options.state,
    logger,
    relativeLocation: workspaceRelativeLocation,
    onDidRequestDiscovery: () => discoveryRef.current?.request()
  });
  const view = vscode.window.createTreeView(TREE_VIEW_ID, {
    treeDataProvider: tree,
    showCollapseAll: true,
    canSelectMany: false
  });
  const discovery = new ArchiveDiscovery(tree, archiveManager, logger);
  discoveryRef.current = discovery;
  context.subscriptions.push(tree, view, discovery);

  const updateContext = () =>
    void vscode.commands.executeCommand('setContext', 'archivePeek.hasArchives', tree.allArchives.length > 0);
  updateContext();
  context.subscriptions.push(tree.onDidChangeTreeData(updateContext));

  /** Archives that must open in the viewer once, even in explorerTree mode. */
  const viewerOnce = new Set<string>();

  const openInTree = async (archiveId: string) => {
    const id = normalizeArchiveId(archiveId);
    if (!archiveManager.isSupported(id)) {
      vscode.window.showErrorMessage(`Unsupported archive format: ${archiveBaseName(id)}`);
      return;
    }
    const root = tree.add(id);
    logger.info(`Showing ${describeArchiveId(id, { redactHost: true })} in the Explorer tree`);
    try {
      // Make the section visible and move focus to the archive; expanding it loads the archive
      await vscode.commands.executeCommand(`${TREE_VIEW_ID}.focus`);
      await view.reveal(root, { select: true, focus: true, expand: true });
    } catch (error) {
      logger.warn(`Could not reveal the archive in the tree: ${String(error)}`);
    }
  };

  const openInViewer = async (archiveId: string) => {
    viewerOnce.add(archiveId);
    try {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        uriFromArchiveId(archiveId),
        ArchiveEditorProvider.viewType
      );
    } catch (error) {
      viewerOnce.delete(archiveId);
      const { message } = describeError(error);
      logger.error(`Failed to open ${describeArchiveId(archiveId, { redactHost: true })}: ${message}`);
      vscode.window.showErrorMessage(`Failed to open archive: ${message}`);
    }
  };

  const closeInTree = (archiveId: string) => {
    tree.remove(archiveId);
    // Free memory and the local copy of a remote archive unless it's still shown elsewhere
    if (archiveManager.getArchive(archiveId) && !archiveInUse(archiveId)) {
      archiveManager.closeArchive(archiveId);
    }
  };

  const register = (command: string, handler: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));

  const resolveTarget = async (target: CommandTarget, openLabel: string): Promise<string | undefined> => {
    const id = archiveIdOfTarget(target) ?? archiveIdOfTarget(await pickArchive(openLabel));
    if (!id) {
      return undefined;
    }
    if (!archiveManager.isSupported(id)) {
      vscode.window.showErrorMessage(`Unsupported archive format: ${archiveBaseName(id)}`);
      return undefined;
    }
    return id;
  };

  // ─── Opening archives ────────────────────────────────────────────────

  register('archivePeek.openInTree', async (target?: CommandTarget) => {
    const id = await resolveTarget(target, 'Open in Explorer');
    if (id) {
      await openInTree(id);
    }
  });

  register('archivePeek.openInViewer', async (target?: CommandTarget) => {
    const id = await resolveTarget(target, 'Open Archive');
    if (id) {
      await openInViewer(id);
    }
  });

  register('archivePeek.mountAsWorkspaceFolder', async (target?: CommandTarget) => {
    const id = await resolveTarget(target, 'Add to Workspace');
    if (id) {
      await mountArchive(id);
    }
  });

  register('archivePeek.unmountWorkspaceFolder', (target?: CommandTarget) => {
    const id = archiveIdOfTarget(target);
    if (id && !unmountArchive(id)) {
      vscode.window.showInformationMessage('This archive is not a workspace folder.');
    }
  });

  // ─── Tree commands ───────────────────────────────────────────────────

  register('archivePeek.tree.open', async (element?: ArchiveNode) => {
    if (element?.kind === 'entry' && !element.isDirectory) {
      await vscode.commands.executeCommand('vscode.open', archiveEntryUri(element.archiveId, element.path), {
        preview: false
      });
    } else if (element?.kind === 'archive') {
      await view.reveal(element, { expand: true, focus: true, select: true });
    }
  });

  register('archivePeek.tree.openToSide', async (element?: ArchiveEntryElement) => {
    if (element?.kind === 'entry' && !element.isDirectory) {
      await vscode.commands.executeCommand('vscode.open', archiveEntryUri(element.archiveId, element.path), {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false
      });
    }
  });

  register('archivePeek.tree.openInViewer', async (element?: ArchiveNode) => {
    if (element) {
      await openInViewer(element.archiveId);
    }
  });

  register('archivePeek.tree.refresh', async (element?: ArchiveNode) => {
    const ids = element ? [element.archiveId] : [...tree.allArchives];
    await vscode.window.withProgress({ location: { viewId: TREE_VIEW_ID }, title: 'Refreshing archives' }, async () => {
      for (const id of ids) {
        if (archiveManager.getArchive(id)) {
          await refreshArchiveSource(archiveManager, id, logger);
        } else {
          // Not loaded (or failed to load): reload when it is next expanded
          tree.retry(id);
        }
      }
    });
  });

  register('archivePeek.tree.refreshAll', () => vscode.commands.executeCommand('archivePeek.tree.refresh'));

  register('archivePeek.tree.close', (element?: ArchiveNode) => {
    if (element) {
      closeInTree(element.archiveId);
    }
  });

  register('archivePeek.tree.closeAll', async () => {
    for (const id of [...tree.archives]) {
      closeInTree(id);
    }
    // Found archives stay listed; free the loaded ones and collapse them
    for (const id of tree.discoveredArchives) {
      if (archiveManager.getArchive(id) && !archiveInUse(id)) {
        archiveManager.closeArchive(id);
      }
    }
    await vscode.commands.executeCommand(`workbench.actions.treeView.${TREE_VIEW_ID}.collapseAll`);
  });

  register(TREE_COMMANDS.rescan, async () => {
    if (!tree.discoveryState.enabled) {
      return;
    }
    await discovery.scan({ resetHidden: true });
  });

  const setAutoDiscover = async (enabled: boolean) => {
    // User settings only: a workspace setting would be written into the
    // workspace's .vscode folder, which may be on the remote host.
    await vscode.workspace
      .getConfiguration('archivePeek.tree')
      .update('autoDiscover', enabled, vscode.ConfigurationTarget.Global);
    if (enabled) {
      await vscode.commands.executeCommand(`${TREE_VIEW_ID}.focus`);
    }
  };
  register('archivePeek.tree.enableAutoDiscover', () => setAutoDiscover(true));
  register('archivePeek.tree.disableAutoDiscover', () => setAutoDiscover(false));

  register('archivePeek.tree.copyPath', async (element?: ArchiveNode) => {
    if (!element) {
      return;
    }
    const source = archivePathPart(element.archiveId);
    const value = element.kind === 'entry' ? `${source.replace(/[\\/]+$/, '')}/${element.path}` : source;
    await vscode.env.clipboard.writeText(value);
  });

  register('archivePeek.tree.copyPathInArchive', async (element?: ArchiveNode) => {
    if (element?.kind === 'entry') {
      await vscode.env.clipboard.writeText(element.path);
    }
  });

  register('archivePeek.tree.revealSource', async (element?: ArchiveNode) => {
    if (!element) {
      return;
    }
    const uri = uriFromArchiveId(element.archiveId);
    if (vscode.workspace.getWorkspaceFolder(uri)) {
      await vscode.commands.executeCommand('revealInExplorer', uri);
      return;
    }
    const where = archiveLocation(element.archiveId);
    if (!isRemoteId(element.archiveId)) {
      const choice = await vscode.window.showInformationMessage(
        `The archive is outside the open workspace folders: ${where}`,
        process.platform === 'darwin' ? 'Reveal in Finder' : 'Reveal in File Explorer'
      );
      if (choice) {
        await vscode.commands.executeCommand('revealFileInOS', uri);
      }
    } else {
      vscode.window.showInformationMessage(`The archive is outside the open workspace folders: ${where}`);
    }
  });

  register('archivePeek.tree.mount', async (element?: ArchiveNode) => {
    if (element) {
      await mountArchive(element.archiveId);
    }
  });

  register(TREE_COMMANDS.retry, (archiveId?: string) => {
    if (archiveId) {
      tree.retry(archiveId);
    }
  });

  register(TREE_COMMANDS.loadAnyway, (archiveId?: string) => {
    if (archiveId) {
      archiveManager.allowOversize(archiveId);
      tree.retry(archiveId);
    }
  });

  register(TREE_COMMANDS.showLog, () => showLog());

  const editorHooks = {
    redirect: (archiveId: string) => {
      if (viewerOnce.delete(archiveId) || openMode() !== 'explorerTree') {
        return false;
      }
      void openInTree(archiveId);
      return true;
    },
    forceViewer: (archiveId: string) => {
      viewerOnce.add(archiveId);
    }
  };

  return { tree, openInTree, editorHooks };
}
