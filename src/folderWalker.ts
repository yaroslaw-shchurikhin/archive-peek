/**
 * Finding files by listing folders through the VS Code file system API
 * (`workspace.fs.readDirectory`), for file systems that have no search
 * provider — e.g. third-party SFTP providers, where `workspace.findFiles`
 * never returns.
 *
 * Every folder costs one readDirectory request over the provider's existing
 * connection; nothing runs on the remote host. Symbolic links to folders are
 * not followed, and the walk is bounded by depth, number of folders and
 * number of results.
 */

/** Translate a VS Code-style glob (`**`, `*`, `?`, `{a,b}`, `[...]`) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globSource(glob)}$`);
}

function globSource(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" matches zero or more folders, "**" anything (also across "/")
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      out += '[^/]';
      i++;
    } else if (c === '{') {
      const end = matchingBrace(glob, i);
      if (end === -1) {
        out += '\\{';
        i++;
        continue;
      }
      const alternatives = splitTopLevel(glob.slice(i + 1, end));
      out += `(?:${alternatives.map(globSource).join('|')})`;
      i = end + 1;
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) {
        out += '\\[';
        i++;
        continue;
      }
      let body = glob.slice(i + 1, end);
      if (body.startsWith('!')) {
        body = '^' + body.slice(1);
      }
      out += `[${body.replace(/\\/g, '\\\\')}]`;
      i = end + 1;
    } else if (c === '/' && glob.slice(i, i + 4) === '/**' && i + 3 === glob.length) {
      // Trailing "/**": the folder itself and everything below it
      out += '(?:/.*)?';
      i += 3;
    } else {
      out += c.replace(/[.+^$()|\\\]]/g, '\\$&');
      i++;
    }
  }
  return out;
}

function matchingBrace(glob: string, start: number): number {
  let depth = 0;
  for (let i = start; i < glob.length; i++) {
    if (glob[i] === '{') {
      depth++;
    } else if (glob[i] === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of body) {
    if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}

/** File type bits as in vscode.FileType. */
const FILE = 1;
const DIRECTORY = 2;
const SYMBOLIC_LINK = 64;

export interface WalkOptions {
  /** Glob relative to the start folder */
  include: string;
  /** Globs relative to the start folder; matching folders are not entered */
  exclude: readonly string[];
  /** Stop after this many matches */
  maxResults: number;
  /** Stop after listing this many folders */
  maxFolders: number;
  /** Do not go deeper than this many levels below the start folder */
  maxDepth: number;
  /** Concurrent readDirectory requests */
  concurrency: number;
  /** Return true to stop (e.g. the search was superseded) */
  isCancelled?: () => boolean;
}

export interface WalkResult {
  /** Paths of matching files, relative to the start folder */
  matches: string[];
  foldersListed: number;
  /** Stopped early: results, folder or depth limit reached */
  truncated: boolean;
  /** Why the walk stopped early, for the log */
  limit?: 'results' | 'folders' | 'depth';
  /** Folders that could not be listed (permission denied…), at most a few */
  errors: { path: string; message: string }[];
  errorCount: number;
}

/**
 * Walk a folder tree breadth-first. `readDirectory(relativePath)` lists one
 * folder ('' is the start folder) and returns [name, fileTypeBits] pairs.
 */
export async function walkFolders(
  readDirectory: (relativePath: string) => PromiseLike<[string, number][]>,
  options: WalkOptions
): Promise<WalkResult> {
  const include = globToRegExp(options.include);
  const excludes = options.exclude.filter(Boolean).map(globToRegExp);
  const isExcluded = (relative: string) => excludes.some((re) => re.test(relative) || re.test(`${relative}/\u0001`));

  const result: WalkResult = { matches: [], foldersListed: 0, truncated: false, errors: [], errorCount: 0 };
  let queue: { path: string; depth: number }[] = [{ path: '', depth: 0 }];

  const stop = (limit: WalkResult['limit']) => {
    result.truncated = true;
    result.limit ??= limit;
  };

  while (queue.length > 0) {
    if (options.isCancelled?.()) {
      return result;
    }
    const batch = queue.splice(0, Math.max(1, options.concurrency));
    const listings = await Promise.all(
      batch.map(async (folder) => {
        try {
          return { folder, entries: await readDirectory(folder.path) };
        } catch (error) {
          result.errorCount++;
          if (result.errors.length < 5) {
            result.errors.push({
              path: folder.path || '.',
              message: error instanceof Error ? error.message : String(error)
            });
          }
          return { folder, entries: [] as [string, number][] };
        }
      })
    );
    const next: { path: string; depth: number }[] = [];
    for (const { folder, entries } of listings) {
      result.foldersListed++;
      for (const [name, type] of entries) {
        const relative = folder.path ? `${folder.path}/${name}` : name;
        if ((type & DIRECTORY) !== 0) {
          // Never follow links to folders: they can point back up (e.g. to /)
          if ((type & SYMBOLIC_LINK) !== 0 || isExcluded(relative)) {
            continue;
          }
          if (folder.depth + 1 > options.maxDepth) {
            stop('depth');
            continue;
          }
          next.push({ path: relative, depth: folder.depth + 1 });
        } else if ((type & FILE) !== 0 && include.test(relative) && !isExcluded(relative)) {
          result.matches.push(relative);
          if (result.matches.length >= options.maxResults) {
            stop('results');
            return result;
          }
        }
      }
    }
    queue = queue.concat(next);
    if (result.foldersListed >= options.maxFolders && queue.length > 0) {
      stop('folders');
      return result;
    }
  }
  return result;
}
