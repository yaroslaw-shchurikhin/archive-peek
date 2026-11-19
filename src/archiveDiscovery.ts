import * as vscode from 'vscode';
import { ARCHIVE_SCHEME } from './archiveFileSystemProvider';
import { ArchiveTreeProvider } from './archiveTreeProvider';
import { ArchiveManager } from './archiveManager';
import { describeArchiveId } from './archiveId';
import { Logger, NULL_LOGGER } from './models';
import { describeError } from './sourceErrors';
import { archiveIdFromUri, uriFromArchiveId } from './vscodeFileAccess';
import { globToRegExp, walkFolders } from './folderWalker';

export const AUTO_DISCOVER_SETTING = 'archivePeek.tree.autoDiscover';

/** Extensions of all supported archives, for the default search pattern. */
export const ARCHIVE_EXTENSIONS = [
  'zip',
  '7z',
  'rar',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'tbz2',
  'xz',
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
];

export const DEFAULT_INCLUDE = `**/*.{${ARCHIVE_EXTENSIONS.join(',')}}`;
export const DEFAULT_EXCLUDE = '**/node_modules/**';
export const DEFAULT_MAX_RESULTS = 200;
/** Shortest automatic rescan interval, in seconds (shorter values are raised to it). */
export const MIN_RESCAN_INTERVAL = 10;
/** Longest automatic rescan interval, in seconds (one day). */
const MAX_RESCAN_INTERVAL = 86_400;

/** How the workspace is searched (archivePeek.tree.autoDiscoverMethod). */
export type DiscoveryMethod = 'auto' | 'search' | 'walk';

/**
 * Schemes whose files VS Code's search service can search (`workspace.findFiles`).
 * For other schemes findFiles waits for a search provider that never comes,
 * so their folders are listed with readDirectory instead.
 */
const SEARCHABLE_SCHEMES = new Set(['file', 'vscode-remote', 'vscode-userdata']);

export interface DiscoveryLimits {
  /** findFiles time limit before falling back to listing folders (method "auto") */
  searchTimeoutMs: number;
  maxFolders: number;
  maxDepth: number;
  concurrency: number;
}

export const DEFAULT_DISCOVERY_LIMITS: DiscoveryLimits = {
  searchTimeoutMs: 30_000,
  maxFolders: 20_000,
  maxDepth: 32,
  concurrency: 8
};

export interface DiscoverySettings {
  enabled: boolean;
  include: string;
  exclude: string;
  maxResults: number;
  /** Folders to search instead of the workspace folders (absolute on the workspace's host, or relative to each workspace folder) */
  folders: string[];
  method: DiscoveryMethod;
  /** Search again every this many seconds; 0 = only on Rescan, setting or folder changes */
  rescanInterval: number;
}

export function readDiscoverySettings(): DiscoverySettings {
  const config = vscode.workspace.getConfiguration('archivePeek.tree');
  const include = config.get<string>('autoDiscoverInclude', DEFAULT_INCLUDE);
  const exclude = config.get<string>('autoDiscoverExclude', DEFAULT_EXCLUDE);
  const max = config.get<number>('autoDiscoverMaxResults', DEFAULT_MAX_RESULTS);
  const folders = config.get<unknown>('autoDiscoverFolders', []);
  const method = config.get<string>('autoDiscoverMethod', 'auto');
  const interval = config.get<number>('autoDiscoverRescanInterval', 0);
  return {
    enabled: config.get<boolean>('autoDiscover', false) === true,
    include: typeof include === 'string' && include.trim() ? include.trim() : DEFAULT_INCLUDE,
    exclude: typeof exclude === 'string' ? exclude.trim() : DEFAULT_EXCLUDE,
    maxResults:
      typeof max === 'number' && Number.isFinite(max) && max > 0
        ? Math.min(Math.floor(max), 10_000)
        : DEFAULT_MAX_RESULTS,
    folders: Array.isArray(folders)
      ? folders.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map((f) => f.trim())
      : [],
    method: method === 'search' || method === 'walk' ? method : 'auto',
    rescanInterval:
      typeof interval === 'number' && Number.isFinite(interval) && interval > 0
        ? Math.min(Math.max(Math.round(interval), MIN_RESCAN_INTERVAL), MAX_RESCAN_INTERVAL)
        : 0
  };
}

/** Where one findFiles query runs. */
export interface SearchRoot {
  /** Folder the search starts in */
  base: vscode.Uri;
  /** Glob relative to `base` */
  pattern: string;
  /** Extra excludes for this root (pseudo file systems when searching from `/`) */
  extraExclude?: readonly string[];
  /**
   * The include pattern started with the search folder's own path (e.g.
   * folder `/opt/app`, pattern `opt/app/**\/*.tgz`), which was not appended again.
   */
  repeatedPath?: boolean;
}

/** Linux pseudo file systems that must not be walked when searching from `/`. */
export const ROOT_PSEUDO_EXCLUDE: readonly string[] = ['proc/**', 'sys/**', 'dev/**', 'run/**'];

const GLOB_CHARS = /[*?[\]{}]/;

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
}

/**
 * The folders to search and the pattern for each.
 *
 * - `archivePeek.tree.autoDiscoverFolders` replaces the workspace folders:
 *   absolute paths are on the host of the (first) workspace folder — the
 *   Remote SSH host in a remote window — and relative paths are resolved
 *   against every workspace folder.
 * - A literal leading part of the include pattern (`tmp/work/**\/*.tgz`)
 *   becomes part of the search folder, so the search service walks only that
 *   subtree instead of the whole folder and filtering afterwards.
 * - Searching from `/` skips /proc, /sys, /dev and /run.
 */
export function computeSearchRoots(
  workspaceFolders: readonly { uri: vscode.Uri }[],
  settings: Pick<DiscoverySettings, 'include' | 'folders'>
): SearchRoot[] {
  const folders = workspaceFolders.filter((f) => f.uri.scheme !== ARCHIVE_SCHEME);
  let bases: vscode.Uri[];
  if (settings.folders.length > 0) {
    bases = [];
    for (const folder of settings.folders) {
      if (isAbsolutePath(folder)) {
        const host = folders[0]?.uri;
        if (!host || host.scheme === 'file') {
          bases.push(vscode.Uri.file(folder));
        } else {
          const posix = folder.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
          bases.push(host.with({ path: posix, query: '', fragment: '' }));
        }
      } else {
        for (const f of folders) {
          bases.push(vscode.Uri.joinPath(f.uri, folder));
        }
      }
    }
  } else {
    bases = folders.map((f) => f.uri);
  }

  // Move the literal leading segments of the pattern into the base folder
  const segments = settings.include.replace(/^\.?\/+/, '').split('/');
  const firstGlob = segments.findIndex((segment) => GLOB_CHARS.test(segment));
  const literal = firstGlob > 0 ? segments.slice(0, firstGlob) : [];
  const pattern = literal.length > 0 ? segments.slice(firstGlob).join('/') : settings.include;

  const roots = new Map<string, SearchRoot>();
  for (const base of bases) {
    let root = base;
    let repeatedPath = false;
    if (literal.length > 0) {
      // A pattern written from the file system root ("opt/app/…") for a folder
      // that already is /opt/app (or a parent of the literal path): use that
      // path as is instead of appending it to the folder a second time.
      const basePath = base.path.replace(/\/+$/, '');
      const fromRoot = '/' + literal.join('/');
      if (basePath !== '' && (fromRoot === basePath || fromRoot.startsWith(basePath + '/'))) {
        root = base.with({ path: fromRoot });
        repeatedPath = true;
      } else {
        root = vscode.Uri.joinPath(base, ...literal);
      }
    }
    roots.set(root.toString(), {
      base: root,
      pattern,
      // Unix file system root: don't walk pseudo file systems (harmless where they don't exist)
      extraExclude: root.path === '/' ? ROOT_PSEUDO_EXCLUDE : undefined,
      repeatedPath: repeatedPath || undefined
    });
  }
  return [...roots.values()];
}

/**
 * Exclude pattern for workspace.findFiles. Passing any exclude pattern turns
 * off VS Code's default `files.exclude` handling, so the enabled
 * `files.exclude` patterns are merged in.
 */
export function buildExcludePattern(
  exclude: string,
  filesExclude: Record<string, unknown> | undefined,
  extra: readonly string[] = []
): string | undefined {
  const patterns = excludeList(exclude, filesExclude, extra);
  if (patterns.length === 0) {
    return undefined;
  }
  return patterns.length === 1 ? patterns[0] : `{${patterns.join(',')}}`;
}

/** The exclude patterns as a list (setting, extra excludes, enabled files.exclude entries). */
export function excludeList(
  exclude: string,
  filesExclude: Record<string, unknown> | undefined,
  extra: readonly string[] = []
): string[] {
  const patterns = new Set<string>();
  if (exclude) {
    patterns.add(exclude);
  }
  for (const pattern of extra) {
    patterns.add(pattern);
  }
  for (const [pattern, value] of Object.entries(filesExclude ?? {})) {
    // Only plain `true` entries; `{ when: … }` conditions can't be expressed in one glob
    if (value === true && !/[{}]/.test(pattern)) {
      patterns.add(pattern);
    }
  }
  return [...patterns];
}

/** The VS Code calls discovery needs (replaced in tests). */
export interface DiscoveryHost {
  workspaceFolders(): readonly vscode.WorkspaceFolder[];
  findFiles(
    include: vscode.GlobPattern,
    exclude: string | undefined,
    maxResults: number,
    token: vscode.CancellationToken
  ): Thenable<vscode.Uri[]>;
  createWatcher(pattern: vscode.GlobPattern): vscode.FileSystemWatcher;
  readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]>;
}

const defaultHost: DiscoveryHost = {
  workspaceFolders: () => vscode.workspace.workspaceFolders ?? [],
  readDirectory: (uri) => vscode.workspace.fs.readDirectory(uri),
  findFiles: (include, exclude, maxResults, token) => vscode.workspace.findFiles(include, exclude, maxResults, token),
  createWatcher: (pattern) => vscode.workspace.createFileSystemWatcher(pattern, false, true, false)
};

/**
 * Finds archives in the workspace folders for the "Found in Workspace" group
 * (opt-in: archivePeek.tree.autoDiscover).
 *
 * - `file:` and Remote SSH (`vscode-remote:`) folders: one
 *   `workspace.findFiles` query per searched folder, run by VS Code's search
 *   service — for Remote SSH, by the VS Code Server on the host with the
 *   ripgrep it ships. If it doesn't answer within 30 s, folders are listed instead.
 * - Other file systems (e.g. third-party SFTP providers): VS Code has no
 *   search for them (findFiles would wait forever), so folders are listed with
 *   `workspace.fs.readDirectory` through the same provider the Explorer uses —
 *   without following symbolic links to folders, and bounded by depth and
 *   number of folders (see folderWalker.ts).
 * - Nothing is installed or started by this extension, and no extra
 *   connection is opened.
 * - Archives are only listed. Nothing is read until an archive is expanded.
 * - Then a file watcher on the same pattern keeps the list current, so the
 *   workspace is not searched again (except on Rescan, when the settings or
 *   the workspace folders change).
 * - Optionally (archivePeek.tree.autoDiscoverRescanInterval) it searches again
 *   every N seconds, for file systems that send no file events (SFTP
 *   providers). The next search is timed from the end of the previous one, so
 *   searches never overlap, and it waits while the section is hidden.
 * - The search only starts once the Archive Peek section is shown.
 * - Folders mounted from archives (archive://) are skipped.
 */
export class ArchiveDiscovery implements vscode.Disposable {
  private settings: DiscoverySettings;
  private watchers: vscode.Disposable[] = [];
  private disposables: vscode.Disposable[] = [];
  private cancel?: vscode.CancellationTokenSource;
  private generation = 0;
  /** True once the tree asked for results (the section was shown) */
  private requested = false;
  /** True once a search ran for the current settings */
  private started = false;
  /** Timer of the next automatic rescan */
  private rescanTimer?: NodeJS.Timeout;
  /** The automatic rescan came due while the section was hidden */
  private rescanDue = false;
  /** Whether the Archive Peek section is visible (automatic rescans wait while it is not) */
  private visible = true;
  /** Last error of an automatic rescan, so the same one is not logged every time */
  private lastPeriodicError?: string;

  constructor(
    private readonly tree: ArchiveTreeProvider,
    private readonly archiveManager: ArchiveManager,
    private readonly logger: Logger = NULL_LOGGER,
    private readonly host: DiscoveryHost = defaultHost,
    private readonly filesExclude: () => Record<string, unknown> | undefined = () =>
      vscode.workspace.getConfiguration('files').get<Record<string, unknown>>('exclude'),
    private readonly limits: DiscoveryLimits = DEFAULT_DISCOVERY_LIMITS
  ) {
    this.settings = readDiscoverySettings();
    tree.setDiscoveryEnabled(this.settings.enabled);
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('archivePeek.tree') || e.affectsConfiguration('files.exclude')) {
          this.applySettings(readDiscoverySettings(), { force: e.affectsConfiguration('files.exclude') });
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (this.settings.enabled && this.requested) {
          void this.scan();
        }
      })
    );
  }

  /** Called by the tree when it is first shown with discovery enabled. */
  request(): void {
    this.requested = true;
    if (this.settings.enabled && !this.started) {
      void this.scan();
    }
  }

  /** The Archive Peek section was shown or hidden. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && this.rescanDue) {
      this.rescanDue = false;
      void this.scan({ periodic: true });
    }
  }

  /** Apply changed settings: start, stop or rerun the search. */
  applySettings(settings: DiscoverySettings, options: { force?: boolean } = {}): void {
    const searchKey = (s: DiscoverySettings) => JSON.stringify({ ...s, rescanInterval: undefined });
    const changed = searchKey(settings) !== searchKey(this.settings);
    const intervalChanged = settings.rescanInterval !== this.settings.rescanInterval;
    this.settings = settings;
    if (!changed && !(options.force && settings.enabled && this.started)) {
      if (intervalChanged && this.started) {
        // Only the rescan interval changed: no need to search again now
        this.scheduleRescan();
      }
      return;
    }
    this.started = false;
    if (!settings.enabled) {
      this.stop();
      this.tree.setDiscoveryEnabled(false);
      return;
    }
    // Enabling resets the "requested" state in the tree; it asks again when shown
    this.tree.setDiscoveryEnabled(true);
    if (this.requested) {
      void this.scan();
    }
  }

  /**
   * Search the workspace folders. `resetHidden` (Rescan) also shows found
   * archives the user closed before. `periodic` (automatic rescan) keeps the
   * current list on screen while searching, updates it only if it changed, and
   * logs only the changes.
   */
  async scan(options: { resetHidden?: boolean; periodic?: boolean } = {}): Promise<void> {
    if (!this.settings.enabled) {
      return;
    }
    this.started = true;
    const generation = ++this.generation;
    this.clearRescanTimer();
    this.cancel?.cancel();
    this.cancel?.dispose();
    const cancel = new vscode.CancellationTokenSource();
    this.cancel = cancel;
    try {
      await this.runScan(generation, cancel.token, options);
    } finally {
      if (generation === this.generation) {
        this.scheduleRescan();
      }
    }
  }

  private async runScan(
    generation: number,
    token: vscode.CancellationToken,
    options: { resetHidden?: boolean; periodic?: boolean }
  ): Promise<void> {
    const periodic = options.periodic === true;
    // Automatic rescans log the search steps at trace level only
    const log = periodic ? (m: string) => this.logger.trace(m) : (m: string) => this.logger.info(m);
    if (!periodic) {
      this.disposeWatchers();
    }

    const { maxResults } = this.settings;
    const filesExclude = this.filesExclude();
    const roots = computeSearchRoots(this.host.workspaceFolders(), this.settings);
    for (const root of roots.filter((r) => r.repeatedPath)) {
      log(
        `archivePeek.tree.autoDiscoverInclude starts with the path of the searched folder; searching ` +
          `${describeArchiveId(archiveIdFromUri(root.base), { redactHost: true })} for "${root.pattern}"`
      );
    }
    if (!periodic) {
      this.tree.setScanning(true);
    }
    const started = Date.now();
    const found: string[] = [];
    let truncated = false;
    this.walkTruncated = false;
    try {
      for (const root of roots) {
        const remaining = maxResults - found.length;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        // One more than needed tells whether the list is cut off
        const uris = await this.findInRoot(root, remaining + 1, filesExclude, token, generation, log);
        if (generation !== this.generation) {
          return;
        }
        const ids = uris.map((uri) => archiveIdFromUri(uri)).filter((id) => this.archiveManager.isSupported(id));
        if (ids.length > remaining) {
          truncated = true;
        }
        found.push(...ids.slice(0, remaining));
      }
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      const { message } = describeError(error);
      if (periodic) {
        // Keep the list (the host may be briefly unreachable); log each new error once
        if (message !== this.lastPeriodicError) {
          this.logger.warn(`Automatic rescan for archives failed: ${message}`);
        }
        this.lastPeriodicError = message;
        return;
      }
      this.logger.warn(`Searching the workspace for archives failed: ${message}`);
      this.tree.setScanning(false, message);
      return;
    }
    this.lastPeriodicError = undefined;

    log(
      `Found ${found.length}${truncated ? '+' : ''} archive(s) in ${roots.length} folder(s) in ${Date.now() - started} ms` +
        ` (${roots.map((r) => describeArchiveId(archiveIdFromUri(r.base), { redactHost: true })).join(', ')})`
    );
    truncated ||= this.walkTruncated;
    if (periodic) {
      this.applyRescan(found, truncated);
      if (this.watchers.length === 0) {
        this.watch(roots);
      }
      return;
    }
    this.tree.setDiscovered(found, { truncated, resetHidden: options.resetHidden });
    this.watch(roots);
  }

  /** Update the list after an automatic rescan, only if something changed. */
  private applyRescan(found: readonly string[], truncated: boolean): void {
    const before = new Set(this.tree.discoveredArchives);
    const now = new Set(found);
    const added = found.filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !now.has(id));
    if (added.length === 0 && removed.length === 0 && truncated === this.tree.discoveryState.truncated) {
      return;
    }
    const describe = (ids: readonly string[]) =>
      ids
        .slice(0, 5)
        .map((id) => describeArchiveId(id, { redactHost: true }))
        .join(', ') + (ids.length > 5 ? `, … (${ids.length})` : '');
    this.logger.info(
      `Automatic rescan: ${added.length} new, ${removed.length} removed archive(s)` +
        (added.length ? `; new: ${describe(added)}` : '') +
        (removed.length ? `; removed: ${describe(removed)}` : '')
    );
    this.tree.setDiscovered(found, { truncated });
  }

  /** Time the next automatic rescan from now (archivePeek.tree.autoDiscoverRescanInterval). */
  private scheduleRescan(): void {
    this.clearRescanTimer();
    const seconds = this.settings.rescanInterval;
    if (!this.settings.enabled || !this.started || seconds <= 0) {
      return;
    }
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = undefined;
      if (this.visible) {
        void this.scan({ periodic: true });
      } else {
        // Search once the section is shown again
        this.rescanDue = true;
      }
    }, seconds * 1000);
    // Don't keep a process alive for this timer (tests, shutdown)
    this.rescanTimer.unref?.();
  }

  private clearRescanTimer(): void {
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = undefined;
    }
    this.rescanDue = false;
  }

  /**
   * Find matching files below one search root: with VS Code's search service
   * where it can search the scheme, otherwise (or if it doesn't answer in
   * time) by listing folders.
   */
  private async findInRoot(
    root: SearchRoot,
    maxResults: number,
    filesExclude: Record<string, unknown> | undefined,
    token: vscode.CancellationToken,
    generation: number,
    log: (message: string) => void = (m) => this.logger.info(m)
  ): Promise<vscode.Uri[]> {
    const where = describeArchiveId(archiveIdFromUri(root.base), { redactHost: true });
    const method = this.settings.method;
    const searchable = SEARCHABLE_SCHEMES.has(root.base.scheme);
    if (method === 'search' || (method === 'auto' && searchable)) {
      log(`Searching ${where} for "${root.pattern}" with VS Code's search service`);
      const search = Promise.resolve(
        this.host.findFiles(
          new vscode.RelativePattern(root.base, root.pattern),
          buildExcludePattern(this.settings.exclude, filesExclude, root.extraExclude),
          maxResults,
          token
        )
      );
      if (method === 'search') {
        return search;
      }
      const timeout = Symbol('timeout');
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        search,
        new Promise<typeof timeout>((resolve) => {
          timer = setTimeout(() => resolve(timeout), this.limits.searchTimeoutMs);
        })
      ]).finally(() => clearTimeout(timer));
      if (outcome !== timeout) {
        return outcome;
      }
      search.catch(() => undefined);
      this.logger.warn(
        `VS Code's search service did not answer within ${Math.round(this.limits.searchTimeoutMs / 1000)} s; listing folders instead`
      );
    } else if (method === 'auto') {
      log(`No search service for "${root.base.scheme}:" folders; listing folders of ${where} for "${root.pattern}"`);
    } else {
      log(`Listing folders of ${where} for "${root.pattern}"`);
    }

    const started = Date.now();
    const result = await walkFolders(
      (relative) =>
        this.host.readDirectory(relative ? vscode.Uri.joinPath(root.base, ...relative.split('/')) : root.base),
      {
        include: root.pattern,
        exclude: excludeList(this.settings.exclude, filesExclude, root.extraExclude),
        maxResults,
        maxFolders: this.limits.maxFolders,
        maxDepth: this.limits.maxDepth,
        concurrency: this.limits.concurrency,
        isCancelled: () => generation !== this.generation || token.isCancellationRequested
      }
    );
    log(
      `Listed ${result.foldersListed} folder(s) of ${where} in ${Date.now() - started} ms, ${result.matches.length} match(es)` +
        (result.limit && result.limit !== 'results' ? `; stopped at the ${result.limit} limit` : '') +
        (result.errorCount
          ? `; ${result.errorCount} folder(s) could not be listed, e.g. ${result.errors[0].path}: ${result.errors[0].message}`
          : '')
    );
    if (result.foldersListed === result.errorCount && result.errorCount > 0) {
      throw new Error(`Cannot list ${where}: ${result.errors[0].message}`);
    }
    const matches = result.matches.map((relative) => vscode.Uri.joinPath(root.base, ...relative.split('/')));
    if (result.limit === 'folders' || result.limit === 'depth') {
      // More archives may exist below the folders that weren't listed
      this.walkTruncated = true;
    }
    return matches;
  }

  /** Set when a folder walk stopped at a folder/depth limit. */
  private walkTruncated = false;

  /** Keep the list current from file events instead of searching again. */
  private watch(roots: readonly SearchRoot[]): void {
    this.disposeWatchers();
    for (const root of roots) {
      const watcher = this.host.createWatcher(new vscode.RelativePattern(root.base, root.pattern));
      this.watchers.push(
        watcher,
        watcher.onDidCreate((uri) => {
          const id = archiveIdFromUri(uri);
          if (this.archiveManager.isSupported(id) && !this.isExcluded(uri, root.base)) {
            this.logger.info(`New archive in the workspace: ${describeArchiveId(id, { redactHost: true })}`);
            this.tree.addDiscovered(id);
          }
        }),
        watcher.onDidDelete((uri) => {
          const id = archiveIdFromUri(uri);
          if (this.tree.discoveredArchives.includes(id)) {
            this.logger.info(`Archive removed from the workspace: ${describeArchiveId(id, { redactHost: true })}`);
          }
          this.tree.removeDiscovered(id);
        })
      );
    }
  }

  /** Apply the exclude setting to watcher events (the watcher only matches the include pattern). */
  private isExcluded(uri: vscode.Uri, base: vscode.Uri): boolean {
    const basePath = base.path.replace(/\/$/, '');
    const relative = uri.path.startsWith(basePath + '/') ? uri.path.slice(basePath.length + 1) : uri.path;
    const patterns = excludeList(this.settings.exclude, this.filesExclude()).map(globToRegExp);
    const parts = relative.split('/');
    // Excluded if the file or any of its folders matches
    for (let n = 1; n <= parts.length; n++) {
      const prefix = parts.slice(0, n).join('/');
      if (patterns.some((re) => re.test(prefix))) {
        return true;
      }
    }
    return false;
  }

  private stop(): void {
    this.started = false;
    this.generation++;
    this.clearRescanTimer();
    this.cancel?.cancel();
    this.cancel?.dispose();
    this.cancel = undefined;
    this.disposeWatchers();
  }

  private disposeWatchers(): void {
    for (const d of this.watchers) {
      d.dispose();
    }
    this.watchers = [];
  }

  dispose(): void {
    this.stop();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/** `project/reports` for an archive in a workspace folder, if it is in one. */
export function workspaceRelativeLocation(archiveId: string): string | undefined {
  const uri = uriFromArchiveId(archiveId);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return undefined;
  }
  const base = folder.uri.path.replace(/\/$/, '');
  const dir = uri.path.slice(0, uri.path.lastIndexOf('/'));
  const relative = dir.length > base.length ? dir.slice(base.length + 1) : '';
  const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  if (multiRoot) {
    return relative ? `${folder.name}/${relative}` : folder.name;
  }
  return relative || '.';
}
