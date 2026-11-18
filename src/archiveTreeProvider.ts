import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ArchiveManager, OpenArchive } from './archiveManager';
import { archiveEntryUri } from './archiveFileSystemProvider';
import { ArchiveIndex, IndexNode } from './archiveIndex';
import {
  archiveBaseName,
  archivePathPart,
  describeArchiveId,
  isRemoteId,
  normalizeArchiveId,
  remoteLabel
} from './archiveId';
import { formatBytes, Logger, NULL_LOGGER } from './models';
import { describeError } from './sourceErrors';
import { uriFromArchiveId } from './vscodeFileAccess';

/** View id of the "Archive Peek" section in the Explorer side bar (package.json → contributes.views.explorer). */
export const TREE_VIEW_ID = 'archivePeek.archives';

/** workspaceState key holding the ids of the archives shown in the tree. */
export const TREE_STATE_KEY = 'archivePeek.tree.archives';

/** An archive shown at the top level of the tree. */
export interface ArchiveRootElement {
  readonly kind: 'archive';
  readonly archiveId: string;
}

/** A file or directory inside an archive. */
export interface ArchiveEntryElement {
  readonly kind: 'entry';
  readonly archiveId: string;
  /** Path inside the archive, as used by ArchiveIndex and archive:// URIs */
  readonly path: string;
  readonly isDirectory: boolean;
}

/** A status line (empty archive, load error…) shown as the only child of an archive. */
export interface ArchiveMessageElement {
  readonly kind: 'message';
  readonly archiveId: string;
  readonly text: string;
  readonly detail?: string;
  readonly severity: 'info' | 'error';
  /** Command run when the line is clicked */
  readonly action?: { command: string; title: string };
}

export type ArchiveTreeElement = ArchiveRootElement | ArchiveEntryElement | ArchiveMessageElement;

/** Storage for the list of archives (an ExtensionContext.workspaceState). */
export interface TreeStateStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface ArchiveTreeOptions {
  /** Where the list of archives is persisted (per workspace). Archives are restored collapsed and not loaded. */
  state?: TreeStateStore;
  logger?: Logger;
}

/** Commands the tree items refer to (registered in extension.ts). */
export const TREE_COMMANDS = {
  retry: 'archivePeek.tree.retry',
  loadAnyway: 'archivePeek.tree.loadAnyway',
  showLog: 'archivePeek.showLog'
} as const;

const SEP = '\u0001';

/**
 * TreeDataProvider for the "Archive Peek" section of the Explorer.
 *
 * Every archive is a top-level node that expands like a read-only folder.
 * The tree is a thin view over the existing machinery: archives are loaded by
 * ArchiveManager (which already handles local and remote sources, the remote
 * copy cache, size limits and change detection), browsed through the shared
 * ArchiveIndex, and files are opened through their archive:// URIs, i.e. by
 * the same FileSystemProvider the archive viewer uses.
 *
 * - Lazy: adding an archive does nothing but show it. It is loaded when it is
 *   first expanded; expanding directories afterwards only reads the in-memory
 *   index (no file system requests, no second transfer of a remote archive).
 *   File contents are read only when a file is opened.
 * - Stable ids (archive id + path inside the archive), so VS Code keeps
 *   expanded directories and the selection when an archive is refreshed.
 * - Archives with the same file name are told apart by their location
 *   (directory, and remote host for remote archives).
 */
export class ArchiveTreeProvider implements vscode.TreeDataProvider<ArchiveTreeElement>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ArchiveTreeElement | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private roots: string[] = [];
  /** Element objects by tree id, so the same element is returned every time (needed by TreeView.reveal) */
  private readonly elements = new Map<string, ArchiveRootElement | ArchiveEntryElement>();
  /** Load failures of archives that aren't loaded, shown instead of their contents */
  private readonly errors = new Map<string, { kind: string; message: string }>();
  private readonly loading = new Map<string, Promise<OpenArchive | undefined>>();
  private readonly subscription: { dispose(): void };
  private readonly logger: Logger;

  constructor(
    private readonly archiveManager: ArchiveManager,
    private readonly options: ArchiveTreeOptions = {}
  ) {
    this.logger = options.logger ?? NULL_LOGGER;
    const saved = options.state?.get<unknown>(TREE_STATE_KEY, []);
    if (Array.isArray(saved)) {
      for (const id of saved) {
        if (typeof id === 'string' && archiveManager.isSupported(id) && !this.roots.includes(id)) {
          this.roots.push(id);
        }
      }
    }
    this.subscription = archiveManager.onDidChangeArchive((event) => {
      if (!this.roots.includes(event.filePath)) {
        return;
      }
      if (event.type === 'opened' || event.type === 'changed') {
        this.errors.delete(event.filePath);
      } else if (event.type === 'deleted') {
        this.errors.set(event.filePath, { kind: 'not-found', message: 'The archive was deleted.' });
      }
      // Re-query the archive node; VS Code re-reads the children of expanded nodes and keeps their state
      this.emitter.fire(this.rootElement(event.filePath));
    });
  }

  // ─── Archive list ────────────────────────────────────────────────────

  /** Ids of the archives in the tree, in display order. */
  get archives(): readonly string[] {
    return this.roots;
  }

  has(archiveId: string): boolean {
    return this.roots.includes(normalizeArchiveId(archiveId));
  }

  /** Add an archive to the tree (without loading it) and return its node. */
  add(archiveId: string): ArchiveRootElement {
    const id = normalizeArchiveId(archiveId);
    if (!this.roots.includes(id)) {
      this.roots.push(id);
      this.persist();
      this.emitter.fire();
    }
    return this.rootElement(id);
  }

  /** Remove an archive from the tree. Returns false if it wasn't there. */
  remove(archiveId: string): boolean {
    const id = normalizeArchiveId(archiveId);
    const index = this.roots.indexOf(id);
    if (index === -1) {
      return false;
    }
    this.roots.splice(index, 1);
    this.forget(id);
    this.persist();
    this.emitter.fire();
    return true;
  }

  /** Clear a recorded load error and show the archive again (it is reloaded when expanded). */
  retry(archiveId: string): void {
    const id = normalizeArchiveId(archiveId);
    this.errors.delete(id);
    if (this.roots.includes(id)) {
      this.emitter.fire(this.rootElement(id));
    }
  }

  /** Re-render the whole tree. */
  refreshView(): void {
    this.emitter.fire();
  }

  // ─── Elements ────────────────────────────────────────────────────────

  rootElement(archiveId: string): ArchiveRootElement {
    const key = `a${SEP}${archiveId}`;
    let element = this.elements.get(key) as ArchiveRootElement | undefined;
    if (!element) {
      element = { kind: 'archive', archiveId };
      this.elements.set(key, element);
    }
    return element;
  }

  entryElement(archiveId: string, node: Pick<IndexNode, 'path' | 'isDirectory'>): ArchiveEntryElement {
    const key = `e${SEP}${archiveId}${SEP}${node.path}`;
    let element = this.elements.get(key) as ArchiveEntryElement | undefined;
    if (!element || element.isDirectory !== node.isDirectory) {
      element = { kind: 'entry', archiveId, path: node.path, isDirectory: node.isDirectory };
      this.elements.set(key, element);
    }
    return element;
  }

  /** Stable tree item id of an element. */
  static idOf(element: ArchiveTreeElement): string {
    switch (element.kind) {
      case 'archive':
        return `a${SEP}${element.archiveId}`;
      case 'entry':
        return `e${SEP}${element.archiveId}${SEP}${element.path}`;
      case 'message':
        return `m${SEP}${element.archiveId}${SEP}${element.text}`;
    }
  }

  // ─── TreeDataProvider ────────────────────────────────────────────────

  getTreeItem(element: ArchiveTreeElement): vscode.TreeItem {
    switch (element.kind) {
      case 'archive':
        return this.archiveItem(element);
      case 'entry':
        return this.entryItem(element);
      case 'message':
        return this.messageItem(element);
    }
  }

  async getChildren(element?: ArchiveTreeElement): Promise<ArchiveTreeElement[]> {
    if (!element) {
      return this.roots.map((id) => this.rootElement(id));
    }
    if (element.kind === 'message' || (element.kind === 'entry' && !element.isDirectory)) {
      return [];
    }
    const id = element.archiveId;
    const archive = this.archiveManager.getArchive(id) ?? (this.errors.has(id) ? undefined : await this.load(id));
    if (!archive) {
      return [this.errorMessage(id)];
    }
    const dirPath = element.kind === 'archive' ? '' : element.path;
    const children = ArchiveIndex.for(archive.entries).children(dirPath);
    if (children.length === 0 && element.kind === 'archive') {
      return [{ kind: 'message', archiveId: id, text: 'This archive is empty.', severity: 'info' }];
    }
    return children.map((node) => this.entryElement(id, node));
  }

  getParent(element: ArchiveTreeElement): ArchiveTreeElement | undefined {
    if (element.kind === 'archive') {
      return undefined;
    }
    if (element.kind === 'message') {
      return this.rootElement(element.archiveId);
    }
    const slash = element.path.lastIndexOf('/');
    if (slash === -1) {
      return this.rootElement(element.archiveId);
    }
    return this.entryElement(element.archiveId, { path: element.path.slice(0, slash), isDirectory: true });
  }

  // ─── Tree items ──────────────────────────────────────────────────────

  private archiveItem(element: ArchiveRootElement): vscode.TreeItem {
    const id = element.archiveId;
    const item = new vscode.TreeItem(archiveBaseName(id), vscode.TreeItemCollapsibleState.Collapsed);
    item.id = ArchiveTreeProvider.idOf(element);
    // The archive's own URI: the file icon theme picks the archive icon, and
    // decorations of the source file (e.g. git status) are shown.
    item.resourceUri = uriFromArchiveId(id);
    item.description = locationDescription(id);
    const archive = this.archiveManager.getArchive(id);
    const error = archive ? undefined : this.errors.get(id);
    item.iconPath = error ? new vscode.ThemeIcon('warning') : vscode.ThemeIcon.File;
    const lines = [archiveLocation(id)];
    if (archive) {
      const index = ArchiveIndex.for(archive.entries);
      lines.push(
        `${archive.type.toUpperCase()} · ${formatBytes(archive.diskSize)} · ${index.size.toLocaleString('en-US')} items`
      );
    } else if (error) {
      lines.push(error.message);
    }
    item.tooltip = lines.join('\n');
    item.contextValue = `archivePeek.archive${isRemoteId(id) ? '.remote' : '.local'}`;
    return item;
  }

  private entryItem(element: ArchiveEntryElement): vscode.TreeItem {
    const name = element.path.slice(element.path.lastIndexOf('/') + 1);
    const item = new vscode.TreeItem(
      name,
      element.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    item.id = ArchiveTreeProvider.idOf(element);
    // archive:// URI: the icon theme picks the icon by name, and opening it
    // goes through the read-only archive file system (syntax highlighting by extension).
    const uri = archiveEntryUri(element.archiveId, element.path);
    item.resourceUri = uri;
    item.iconPath = element.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    const entry = this.archiveManager.getArchive(element.archiveId)
      ? ArchiveIndex.for(this.archiveManager.getArchive(element.archiveId)!.entries).get(element.path)?.entry
      : undefined;
    const tooltip = [element.path];
    if (!element.isDirectory) {
      if (entry) {
        item.description = formatBytes(entry.size);
        tooltip.push(`Size: ${formatBytes(entry.size)}`);
        if (entry.compressedSize !== undefined && entry.compressedSize !== entry.size) {
          tooltip.push(`Compressed: ${formatBytes(entry.compressedSize)}`);
        }
      }
      item.command = { command: 'vscode.open', title: 'Open', arguments: [uri, { preview: true }] };
    }
    if (entry?.modifiedTime && !Number.isNaN(entry.modifiedTime.getTime())) {
      tooltip.push(`Modified: ${entry.modifiedTime.toLocaleString()}`);
    }
    item.tooltip = tooltip.join('\n');
    item.contextValue = element.isDirectory ? 'archivePeek.directory' : 'archivePeek.file';
    return item;
  }

  private messageItem(element: ArchiveMessageElement): vscode.TreeItem {
    const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
    item.id = ArchiveTreeProvider.idOf(element);
    item.iconPath = new vscode.ThemeIcon(element.severity === 'error' ? 'error' : 'info');
    item.tooltip = element.detail ?? element.text;
    item.contextValue = 'archivePeek.message';
    if (element.action) {
      item.command = { ...element.action, arguments: [element.archiveId] };
      item.description = element.action.title;
    }
    return item;
  }

  private errorMessage(archiveId: string): ArchiveMessageElement {
    const error = this.errors.get(archiveId) ?? { kind: 'unknown', message: 'The archive could not be loaded.' };
    const action =
      error.kind === 'too-large'
        ? { command: TREE_COMMANDS.loadAnyway, title: 'Load Anyway' }
        : { command: TREE_COMMANDS.retry, title: 'Retry' };
    return {
      kind: 'message',
      archiveId,
      text: error.message,
      detail: `${error.message}\n\nClick to ${action.title.toLowerCase()}. Details are in the Archive Peek output channel.`,
      severity: 'error',
      action
    };
  }

  // ─── Loading ─────────────────────────────────────────────────────────

  /**
   * Load an archive through ArchiveManager, with a progress bar on the view
   * (and a notification with transfer progress for remote archives).
   * Concurrent requests share one load. Failures are recorded and shown as a
   * message node instead of the archive's contents.
   */
  load(archiveId: string): Promise<OpenArchive | undefined> {
    const id = normalizeArchiveId(archiveId);
    let pending = this.loading.get(id);
    if (!pending) {
      pending = this.doLoad(id).finally(() => this.loading.delete(id));
      this.loading.set(id, pending);
    }
    return pending;
  }

  private async doLoad(id: string): Promise<OpenArchive | undefined> {
    const name = archiveBaseName(id);
    const open = (report?: (message: string) => void) =>
      this.archiveManager.openArchive(id, { onProgress: report ? (message) => report(message) : undefined });
    try {
      return await vscode.window.withProgress({ location: { viewId: TREE_VIEW_ID } }, () =>
        isRemoteId(id)
          ? vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: `Archive Peek: ${name}` },
              (progress) => open((message) => progress.report({ message }))
            )
          : open()
      );
    } catch (error) {
      const { kind, message } = describeError(error);
      this.logger.error(
        `Failed to open ${describeArchiveId(id, { redactHost: true })} in the tree [${kind}]: ${message}`
      );
      if (this.roots.includes(id)) {
        this.errors.set(id, { kind, message });
        // Update the archive node's icon and tooltip
        this.emitter.fire(this.rootElement(id));
      }
      return undefined;
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private forget(archiveId: string): void {
    this.errors.delete(archiveId);
    const prefixes = [`a${SEP}${archiveId}`, `e${SEP}${archiveId}${SEP}`];
    for (const key of [...this.elements.keys()]) {
      if (key === prefixes[0] || key.startsWith(prefixes[1])) {
        this.elements.delete(key);
      }
    }
  }

  private persist(): void {
    void Promise.resolve(this.options.state?.update(TREE_STATE_KEY, [...this.roots])).catch((error) =>
      this.logger.warn(`Failed to save the list of archives: ${String(error)}`)
    );
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

/**
 * Short location shown next to an archive's name, so archives with the same
 * name in different directories or on different hosts can be told apart:
 * `~/builds/x86`, `SSH: build-01 · /opt/reports`.
 */
export function locationDescription(archiveId: string): string {
  const dir = path.posix.dirname(archivePathPart(archiveId).replace(/\\/g, '/'));
  const label = remoteLabel(archiveId);
  if (label) {
    return `${label} · ${dir}`;
  }
  return tildify(path.dirname(archiveId));
}

/** Full location of an archive for tooltips and copying: local path, or `[SSH: host] /remote/path`. */
export function archiveLocation(archiveId: string): string {
  const label = remoteLabel(archiveId);
  return label ? `[${label}] ${archivePathPart(archiveId)}` : archiveId;
}

function tildify(dir: string): string {
  const home = os.homedir();
  if (home && (dir === home || dir.startsWith(home + path.sep))) {
    return `~${dir.slice(home.length)}`;
  }
  return dir;
}
