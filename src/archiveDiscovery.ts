import * as vscode from 'vscode';
import { ARCHIVE_SCHEME } from './archiveFileSystemProvider';
import { ArchiveTreeProvider } from './archiveTreeProvider';
import { ArchiveManager } from './archiveManager';
import { describeArchiveId } from './archiveId';
import { Logger, NULL_LOGGER } from './models';
import { describeError } from './sourceErrors';
import { archiveIdFromUri, uriFromArchiveId } from './vscodeFileAccess';

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

export interface DiscoverySettings {
  enabled: boolean;
  include: string;
  exclude: string;
  maxResults: number;
  /** Folders to search instead of the workspace folders (absolute on the workspace's host, or relative to each workspace folder) */
  folders: string[];
}

export function readDiscoverySettings(): DiscoverySettings {
  const config = vscode.workspace.getConfiguration('archivePeek.tree');
  const include = config.get<string>('autoDiscoverInclude', DEFAULT_INCLUDE);
  const exclude = config.get<string>('autoDiscoverExclude', DEFAULT_EXCLUDE);
  const max = config.get<number>('autoDiscoverMaxResults', DEFAULT_MAX_RESULTS);
  const folders = config.get<unknown>('autoDiscoverFolders', []);
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
      : []
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
  const segments = settings.include.replace(/^\.\//, '').split('/');
  const firstGlob = segments.findIndex((segment) => GLOB_CHARS.test(segment));
  const literal = firstGlob > 0 ? segments.slice(0, firstGlob) : [];
  const pattern = literal.length > 0 ? segments.slice(firstGlob).join('/') : settings.include;

  const roots = new Map<string, SearchRoot>();
  for (const base of bases) {
    const root = literal.length > 0 ? vscode.Uri.joinPath(base, ...literal) : base;
    roots.set(root.toString(), {
      base: root,
      pattern,
      // Unix file system root: don't walk pseudo file systems (harmless where they don't exist)
      extraExclude: root.path === '/' ? ROOT_PSEUDO_EXCLUDE : undefined
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
  if (patterns.size === 0) {
    return undefined;
  }
  return patterns.size === 1 ? [...patterns][0] : `{${[...patterns].join(',')}}`;
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
}

const defaultHost: DiscoveryHost = {
  workspaceFolders: () => vscode.workspace.workspaceFolders ?? [],
  findFiles: (include, exclude, maxResults, token) => vscode.workspace.findFiles(include, exclude, maxResults, token),
  createWatcher: (pattern) => vscode.workspace.createFileSystemWatcher(pattern, false, true, false)
};

/**
 * Finds archives in the workspace folders for the "Found in Workspace" group
 * (opt-in: archivePeek.tree.autoDiscover).
 *
 * - One `workspace.findFiles` query per workspace folder, run by VS Code's
 *   search service — for a Remote SSH folder, by the VS Code Server on the
 *   host, with the ripgrep it ships. Nothing is installed or started by this
 *   extension, and no extra connection is opened.
 * - Archives are only listed. Nothing is read until an archive is expanded.
 * - Then a file watcher on the same pattern keeps the list current, so the
 *   workspace is not searched again (except on Rescan, when the settings or
 *   the workspace folders change).
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

  constructor(
    private readonly tree: ArchiveTreeProvider,
    private readonly archiveManager: ArchiveManager,
    private readonly logger: Logger = NULL_LOGGER,
    private readonly host: DiscoveryHost = defaultHost,
    private readonly filesExclude: () => Record<string, unknown> | undefined = () =>
      vscode.workspace.getConfiguration('files').get<Record<string, unknown>>('exclude')
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

  /** Apply changed settings: start, stop or rerun the search. */
  applySettings(settings: DiscoverySettings, options: { force?: boolean } = {}): void {
    const changed = JSON.stringify(settings) !== JSON.stringify(this.settings);
    this.settings = settings;
    if (!changed && !(options.force && settings.enabled && this.started)) {
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
   * archives the user closed before.
   */
  async scan(options: { resetHidden?: boolean } = {}): Promise<void> {
    if (!this.settings.enabled) {
      return;
    }
    this.started = true;
    const generation = ++this.generation;
    this.cancel?.cancel();
    this.cancel?.dispose();
    const cancel = new vscode.CancellationTokenSource();
    this.cancel = cancel;
    this.disposeWatchers();

    const { maxResults } = this.settings;
    const filesExclude = this.filesExclude();
    const roots = computeSearchRoots(this.host.workspaceFolders(), this.settings);
    this.tree.setScanning(true);
    const started = Date.now();
    const found: string[] = [];
    let truncated = false;
    try {
      for (const root of roots) {
        const remaining = maxResults - found.length;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        const rootExclude = buildExcludePattern(this.settings.exclude, filesExclude, root.extraExclude);
        // One more than needed tells whether the list is cut off
        const uris = await this.host.findFiles(
          new vscode.RelativePattern(root.base, root.pattern),
          rootExclude,
          remaining + 1,
          cancel.token
        );
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
      this.logger.warn(`Searching the workspace for archives failed: ${message}`);
      this.tree.setScanning(false, message);
      return;
    }

    this.logger.info(
      `Found ${found.length}${truncated ? '+' : ''} archive(s) in ${roots.length} folder(s) in ${Date.now() - started} ms` +
        ` (${roots.map((r) => describeArchiveId(archiveIdFromUri(r.base), { redactHost: true })).join(', ')})`
    );
    this.tree.setDiscovered(found, { truncated, resetHidden: options.resetHidden });
    this.watch(roots);
  }

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
    const exclude = this.settings.exclude;
    // Common case: "**/<dir>/**"
    const dirMatch = /^\*\*\/([^*{}/]+)\/\*\*$/.exec(exclude);
    if (dirMatch) {
      return relative.split('/').slice(0, -1).includes(dirMatch[1]);
    }
    return false;
  }

  private stop(): void {
    this.started = false;
    this.generation++;
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
