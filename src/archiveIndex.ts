import { ArchiveEntry } from './models';

/**
 * One file or directory in an archive's directory tree.
 *
 * Directories that the archive does not list explicitly (common in tar
 * archives, which often store only `logs/app.log` and no `logs/` entry) are
 * synthesised from the paths of their descendants.
 */
export interface IndexNode {
  /** Last path segment */
  name: string;
  /** Path inside the archive without a trailing slash ('' for the root). Used in archive:// URIs. */
  path: string;
  isDirectory: boolean;
  /** The listed entry, if the archive lists this path explicitly */
  entry?: ArchiveEntry;
}

interface DirectoryNode extends IndexNode {
  isDirectory: true;
  children: Map<string, IndexNode>;
  /** Children sorted for display, computed on first access */
  sorted?: IndexNode[];
}

/**
 * Directory index of an archive's flat entry list: O(1) lookup of a path and
 * of a directory's children.
 *
 * Built once per entry list (ArchiveManager replaces the list on refresh) and
 * shared by everything that browses an archive — the archive:// file system
 * provider (used by editors and by archives mounted as workspace folders) and
 * the Explorer tree view — so archives are never indexed twice.
 */
export class ArchiveIndex {
  private static readonly cache = new WeakMap<readonly ArchiveEntry[], ArchiveIndex>();

  /** The index for an entry list, built on first use and cached for as long as the list exists. */
  static for(entries: readonly ArchiveEntry[]): ArchiveIndex {
    let index = ArchiveIndex.cache.get(entries);
    if (!index) {
      index = new ArchiveIndex(entries);
      ArchiveIndex.cache.set(entries, index);
    }
    return index;
  }

  private readonly root: DirectoryNode = { name: '', path: '', isDirectory: true, children: new Map() };
  private readonly nodes = new Map<string, IndexNode>([['', this.root]]);

  constructor(entries: readonly ArchiveEntry[]) {
    for (const entry of entries) {
      const path = ArchiveIndex.normalize(entry.path);
      if (path === '') {
        continue;
      }
      if (entry.isDirectory) {
        const dir = this.ensureDirectory(path);
        dir.entry = entry;
      } else {
        const slash = path.lastIndexOf('/');
        const parent = this.ensureDirectory(slash === -1 ? '' : path.slice(0, slash));
        const name = slash === -1 ? path : path.slice(slash + 1);
        const existing = parent.children.get(name);
        if (existing?.isDirectory) {
          // A file and a directory with the same path: keep the directory, so its children stay reachable
          continue;
        }
        const node: IndexNode = { name, path, isDirectory: false, entry };
        parent.children.set(name, node);
        this.nodes.set(path, node);
      }
    }
  }

  /** Path inside the archive as used by the index: no leading `./` or `/`, no trailing or doubled slashes. */
  static normalize(path: string): string {
    return path
      .replace(/\\/g, '/')
      .split('/')
      .filter((segment) => segment !== '' && segment !== '.')
      .join('/');
  }

  /**
   * Path to pass to ArchiveManager.readEntry for a path from the index: the
   * entry's path exactly as the archive lists it (e.g. with a leading `./`).
   */
  entryPathFor(path: string): string {
    return this.get(path)?.entry?.path ?? path;
  }

  /** The node at a path, or undefined if the archive has no such file or directory. */
  get(path: string): IndexNode | undefined {
    return this.nodes.get(ArchiveIndex.normalize(path));
  }

  /** Children of a directory: directories first, then files, each sorted by name. Empty for files and unknown paths. */
  children(path: string): readonly IndexNode[] {
    const node = this.nodes.get(ArchiveIndex.normalize(path));
    if (!node || !node.isDirectory) {
      return [];
    }
    const dir = node as DirectoryNode;
    if (!dir.sorted) {
      dir.sorted = [...dir.children.values()].sort(compareNodes);
    }
    return dir.sorted;
  }

  /** Number of files and directories (explicit and synthesised), excluding the root. */
  get size(): number {
    return this.nodes.size - 1;
  }

  private ensureDirectory(path: string): DirectoryNode {
    const existing = this.nodes.get(path);
    if (existing?.isDirectory) {
      return existing as DirectoryNode;
    }
    const slash = path.lastIndexOf('/');
    const parent = this.ensureDirectory(slash === -1 ? '' : path.slice(0, slash));
    const name = slash === -1 ? path : path.slice(slash + 1);
    const dir: DirectoryNode = { name, path, isDirectory: true, children: new Map() };
    // Replaces a file of the same name (see constructor)
    parent.children.set(name, dir);
    this.nodes.set(path, dir);
    return dir;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareNodes(a: IndexNode, b: IndexNode): number {
  if (a.isDirectory !== b.isDirectory) {
    return a.isDirectory ? -1 : 1;
  }
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
