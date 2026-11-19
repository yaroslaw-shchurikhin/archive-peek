import { describe, it, expect } from 'vitest';
import { globToRegExp, walkFolders, WalkOptions } from '../src/folderWalker';
import { DEFAULT_INCLUDE } from '../src/archiveDiscovery';

describe('globToRegExp', () => {
  const matches = (glob: string, path: string) => globToRegExp(glob).test(path);

  it('handles **, *, ? and braces like VS Code globs', () => {
    expect(matches('**/*.tar.gz', 'pre.tar.gz')).toBe(true);
    expect(matches('**/*.tar.gz', 'var/reports/pre.tar.gz')).toBe(true);
    expect(matches('**/*.tar.gz', 'var/reports/pre.tar.gzip')).toBe(false);
    expect(matches('*.zip', 'a/b.zip')).toBe(false);
    expect(matches('*.zip', 'b.zip')).toBe(true);
    expect(matches('file?.txt', 'file1.txt')).toBe(true);
    expect(matches('file?.txt', 'file/.txt')).toBe(false);
    expect(matches(DEFAULT_INCLUDE, 'var/reports/pre_check.tar.gz')).toBe(true);
    expect(matches(DEFAULT_INCLUDE, 'var/reports/report.txt')).toBe(false);
    expect(matches('**/*.{tar.gz,tgz}', 'x/y.tgz')).toBe(true);
    expect(matches('{a,b/{c,d}}/*.zip', 'b/d/x.zip')).toBe(true);
    expect(matches('[ab]*.zip', 'b1.zip')).toBe(true);
    expect(matches('[!ab]*.zip', 'b1.zip')).toBe(false);
  });

  it('matches folders with exclude patterns', () => {
    expect(matches('**/node_modules/**', 'node_modules')).toBe(true);
    expect(matches('**/node_modules/**', 'a/node_modules/x/y.tgz')).toBe(true);
    expect(matches('**/node_modules/**', 'a/node_modulesx')).toBe(false);
    expect(matches('proc/**', 'proc')).toBe(true);
    expect(matches('proc/**', 'opt/proc')).toBe(false);
    expect(matches('**/.git', 'src/.git')).toBe(true);
  });

  it('escapes regular expression characters', () => {
    expect(matches('a+b(1).zip', 'a+b(1).zip')).toBe(true);
    expect(matches('a.zip', 'abzip')).toBe(false);
  });
});

describe('walkFolders', () => {
  /** In-memory tree: folder path → [name, type] entries ('' is the start folder). */
  function tree(entries: Record<string, [string, number][]>) {
    const calls: string[] = [];
    const read = async (p: string) => {
      calls.push(p);
      const listing = entries[p];
      if (!listing) {
        throw new Error(`EACCES: ${p}`);
      }
      return listing;
    };
    return { read, calls };
  }

  const FILE = 1;
  const DIR = 2;
  const LINK = 64;
  const options: WalkOptions = {
    include: DEFAULT_INCLUDE,
    exclude: ['**/node_modules/**'],
    maxResults: 100,
    maxFolders: 1000,
    maxDepth: 32,
    concurrency: 4
  };

  it('finds matching files in all subfolders, without following folder links or entering excluded folders', async () => {
    const t = tree({
      '': [
        ['var', DIR],
        ['bin', FILE],
        ['rootfs', DIR | LINK],
        ['node_modules', DIR],
        ['top.zip', FILE]
      ],
      var: [
        ['reports', DIR],
        ['log', DIR]
      ],
      'var/reports': [
        ['pre_check.tar.gz', FILE],
        ['post_check.tar.gz', FILE],
        ['readme.txt', FILE]
      ],
      'var/log': [['old.log.gz', FILE]]
    });
    const result = await walkFolders(t.read, options);
    expect(result.matches.sort()).toEqual([
      'top.zip',
      'var/log/old.log.gz',
      'var/reports/post_check.tar.gz',
      'var/reports/pre_check.tar.gz'
    ]);
    expect(result.truncated).toBe(false);
    expect(t.calls).not.toContain('rootfs');
    expect(t.calls).not.toContain('node_modules');
    expect(result.foldersListed).toBe(4);
  });

  it('stops at the result, folder and depth limits', async () => {
    const t = tree({
      '': [
        ['a', DIR],
        ['1.zip', FILE],
        ['2.zip', FILE],
        ['3.zip', FILE]
      ],
      a: [['b', DIR]],
      'a/b': [['c', DIR]],
      'a/b/c': [['deep.zip', FILE]]
    });
    const byResults = await walkFolders(t.read, { ...options, maxResults: 2 });
    expect(byResults.matches).toHaveLength(2);
    expect(byResults.limit).toBe('results');

    const byDepth = await walkFolders(t.read, { ...options, maxDepth: 2 });
    expect(byDepth.matches).not.toContain('a/b/c/deep.zip');
    expect(byDepth.limit).toBe('depth');
    expect(byDepth.truncated).toBe(true);

    const byFolders = await walkFolders(t.read, { ...options, maxFolders: 2, concurrency: 1 });
    expect(byFolders.limit).toBe('folders');
    expect(byFolders.foldersListed).toBe(2);
  });

  it('skips folders it cannot list and reports them', async () => {
    const t = tree({
      '': [
        ['secret', DIR],
        ['ok', DIR]
      ],
      ok: [['x.tgz', FILE]]
    });
    const result = await walkFolders(t.read, options);
    expect(result.matches).toEqual(['ok/x.tgz']);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0]).toEqual({ path: 'secret', message: 'EACCES: secret' });
  });

  it('can be cancelled', async () => {
    const t = tree({ '': [['a', DIR]], a: [['x.zip', FILE]] });
    const result = await walkFolders(t.read, { ...options, isCancelled: () => true });
    expect(result.matches).toEqual([]);
    expect(t.calls).toEqual([]);
  });
});
