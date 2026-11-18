# Archive Peek for VS Code

Peek inside archive files directly in VS Code — without extracting them to disk. Simply click an archive in the Explorer and get an interactive file browser with stats, right inside the editor.

> **This build adds Remote SSH support** (`local.archive-peek-remote`): archives on a Remote SSH host
> open the same way as local ones, without installing anything on the server. See
> [Remote SSH Support](#remote-ssh-support).

![Archive Peek screenshot](images/Screenshot.png)

## Supported Formats

| Format | Extension(s) | Library Used
|---|---|---|
| ZIP          | `.zip`                    | yauzl
| JAR          | `.jar`, `.war`, `.ear`    | yauzl
| VS Code Ext  | `.vsix`                   | yauzl
| NuGet        | `.nupkg`                  | yauzl
| Android      | `.apk`, `.aar`            | yauzl
| Python Wheel | `.whl`                    | yauzl
| Firefox Ext  | `.xpi`                    | yauzl
| eBook        | `.epub`                   | yauzl
| Tar          | `.tar`                    | tar-stream
| Tar.gz       | `.tar.gz`, `.tgz`         | tar-stream + zlib
| Tar.bz2      | `.tar.bz2`, `.tbz2`       | tar-stream + unbzip2-stream
| Tar.xz       | `.tar.xz`, `.txz`         | tar-stream + xz-decompress
| Gzip         | `.gz`                     | zlib
| Bzip2        | `.bz2`                    | unbzip2-stream
| XZ           | `.xz`                     | xz-decompress
| RAR          | `.rar`                    | node-unrar-js
| 7-Zip        | `.7z`                     | node-7z + 7zip-bin

## Features

- **Click to browse** — click any archive in the Explorer and it opens an interactive file tree with stats in the editor
- **Open files inline** — click any file in the archive tree to view its contents in VS Code (read-only)
- **No extraction** — files are read directly from the archive stream; local archives are never copied (remote archives are copied once into the local temp directory, see [Remote SSH Support](#remote-ssh-support))
- **Remote SSH** — click an archive on a Remote SSH host (or WSL / Dev Container / any VS Code file system) and browse it like a local one; nothing is installed on or written to the remote host
- **No sidebar clutter** — everything lives in the editor tab, no extra panels
- **23 file extensions** — covers ZIP-based, tar variants, standalone compressed, RAR, and 7z out of the box
- **Context menu integration** — right-click archive files in the Explorer for quick access
- **Auto-refresh** — when an opened archive is rebuilt or replaced on disk, the archive tab and any files opened from it reload automatically
- **Light on memory** — ZIP-based archives are streamed: only the file list is kept in memory, and the archive file is never held open, so build tools can overwrite it at any time

## Usage

1. Click any supported archive file in the VS Code Explorer
2. The archive opens in an editor tab showing format info, file/directory counts, total size, and a browsable file tree
3. Click any file in the tree to view its contents

You can also right-click an archive and select **Open Archive**, or use the command palette: `Archive Peek: Open Archive`.

## Commands

| Command                          | Description                                |
|----------------------------------|--------------------------------------------|
| `Archive Peek: Open Archive`    | Open an archive file for browsing          |
| `Archive Peek: Refresh`          | Re-read all opened archives and reload files opened from them |
| `Archive Peek: Close Archive`    | Close an opened archive                    |

## Settings

| Setting                  | Default | Description                                                                 |
|--------------------------|---------|-----------------------------------------------------------------------------|
| `archivePeek.autoRefresh` | `true`  | Reload opened archives (and files opened from them) when they change on disk |
| `archivePeek.remote.maxArchiveSizeMB` | `512` | Largest remote archive that is loaded (see [memory use](#memory-use-and-size-limit)). Larger archives show a warning with **Load Anyway** |
| `archivePeek.remote.cacheSizeMB` | `2048` | Total size of local copies of remote archives kept in the OS temp directory (LRU) |
| `archivePeek.maxEntries` | `500000` | Maximum number of entries per archive (archive-bomb protection) |
| `archivePeek.maxEntrySizeMB` | `256` | Largest uncompressed file that can be opened from an archive (decompression-bomb protection) |

## Remote SSH Support

Archive Peek works in VS Code **Remote SSH** windows: click a `.tar.gz` (or any other supported
archive) in the Explorer of a remote folder and you get the same interactive view as for a local
archive — tree, sizes, file/directory counts, and nested files opening read-only in the editor with
syntax highlighting.

**Nothing is installed on, started on, or written to the remote host.** No Node.js, Python, `tar`
or `unzip` is needed on the server, no extra SSH connection is opened, no SSHFS is needed and no
credentials are asked for. This also works for minimal embedded Linux targets.

### Why it did not work before (root cause)

The original extension read archives exclusively with Node's `fs` module, addressing them by
`uri.fsPath`:

- `ArchiveEditorProvider.resolveCustomEditor` did `archivePath = document.uri.fsPath`,
- `ArchiveManager` called `fs.promises.stat(path)` and every handler called
  `fs.createReadStream(path)` / `fs.promises.open(path)`,
- `ArchiveWatcher` watched `vscode.Uri.file(path.dirname(path))`.

For a remote resource such as `vscode-remote://ssh-remote+host/var/build/out.tar.gz`, `fsPath`
silently drops the scheme and authority and returns `/var/build/out.tar.gz` — a path that does not
exist on the machine where the extension host runs. `fs.stat` then failed with `ENOENT`
("no such file or directory"). `resolveCustomEditor` caught the error, showed a short notification
and **still rendered the editor with `archive = undefined`**, which is why the view showed format
"Unknown", 0 files, 0 directories and "0 B".

In addition, `package.json` declared no `extensionKind`. An extension with a `main` entry defaults
to `"workspace"`, i.e. VS Code wants it installed on the remote host (in the VS Code Server), which
is exactly what must be avoided here.

### How it works

```
 Local machine (macOS / Windows)                                Remote Linux host
┌──────────────────────────────────────────────────────┐       ┌──────────────────────┐
│ Local extension host  (extensionKind: ["ui"])         │       │ VS Code Server       │
│                                                        │       │ (already there for   │
│ ArchiveEditorProvider / archive:// FileSystemProvider  │       │  Remote SSH; nothing │
│              │  archive id (path or full URI)          │       │  added by us)        │
│              ▼                                         │       │                      │
│ ArchiveManager ── file:  ──► Node fs (streaming, as before)    │                      │
│              │                                         │       │                      │
│              └── other schemes ──► RemoteArchiveCache  │       │                      │
│                     1. workspace.fs.stat(uri)  ────────┼──SSH──┼─► stat              │
│                     2. size limit check                │       │                      │
│                     3. workspace.fs.readFile(uri) ─────┼──SSH──┼─► read (whole file)  │
│                     4. write private local copy        │       │                      │
│                        (OS temp dir, mode 0600)        │       │                      │
│                     5. handlers stream from the copy   │       │                      │
└──────────────────────────────────────────────────────┘       └──────────────────────┘
```

- **`extensionKind: ["ui"]`** — the extension always runs in the *local* extension host, also in
  Remote SSH windows. It must therefore never use `fsPath` for non-`file:` resources.
- **Archive ids** (`src/archiveId.ts`) — local archives are keyed by their absolute path (the
  original, optimised code path is unchanged); every other resource is keyed by a losslessly
  encoded URI, so `scheme`, `authority` and `path` are preserved end-to-end, including in the
  `archive://` URIs of opened nested files. `Uri.toString()` is deliberately not used: it
  lower-cases the host part of the authority (`acme-sftp://Host-A/…` → `host-a`), which
  providers that look up connections by name reject (e.g. with `NoPermissions`).
- **`VscodeRemoteFileAccess`** (`src/vscodeFileAccess.ts`) — reads remote files only through
  `vscode.workspace.fs.stat()` / `vscode.workspace.fs.readFile()`. VS Code routes these to the
  FileSystemProvider of the URI's scheme, i.e. over the existing Remote SSH connection. Any
  scheme works the same way (`vscode-remote://wsl+…`, `vscode-remote://dev-container+…`,
  virtual file systems, …).
- **`RemoteArchiveCache`** (`src/remoteArchiveCache.ts`) — a bounded local cache of remote
  archives (see below). All decompression and parsing happens locally with the same handlers as
  for local archives (yauzl, tar-stream + zlib / unbzip2-stream / xz-decompress, node-unrar-js,
  7zip-bin — the 7z binary also runs locally, on the local copy).
- **Change detection** — the per-archive `FileSystemWatcher` is created for the remote parent
  folder (`RelativePattern(vscode-remote://…/dir, name)`); Remote SSH forwards these events from
  the server's file watcher. As a fallback for providers without watch support, a remote archive
  is also re-checked with one `stat` when its editor tab becomes active again and whenever a
  nested file is opened, and **Archive Peek: Refresh Archives** works as before.
- **Diagnostics** — instead of an empty "0 B" view, the editor shows what went wrong (not found,
  permission denied, remote host unreachable / SSH connection lost, archive corrupted, too large,
  too many entries) with **Retry** and **Show Log** buttons.

### VS Code API limitation: no streaming for remote files

`vscode.workspace.fs` has no stable API to stream or range-read a file that belongs to another
FileSystemProvider: `readFile()` always returns the **whole file** as one `Uint8Array`. (Streaming
`open/read/close` exists only on the *provider* side, which an extension cannot call for another
provider's files.) Consequently:

- a remote archive is transferred **completely**, once, even if you only look at one small file;
- there is no byte-level progress for the transfer (the notification shows the size and an
  indeterminate spinner) and a running transfer cannot be cancelled;
- Archive Peek does **not** pretend to stream: it transfers the archive once, writes it to a local
  copy, releases the buffer, and streams from the local copy from then on.

### Local cache

- Copies live in a private directory `archive-peek-remote-<pid>-XXXXXX` under the **local** OS
  temp directory (`os.tmpdir()`), created with mode `0700`, files with mode `0600`. Nothing is
  ever created on the remote host.
- A copy is reused as long as the remote file's **size and mtime** are unchanged — opening any
  number of nested files, re-opening the tab or a manual refresh of an unchanged archive does not
  re-transfer it. A changed size/mtime invalidates the copy and the archive is reloaded.
- If the SSH connection drops, an already-loaded archive keeps working from its local copy (the
  Output channel logs a warning); a lost connection is never mistaken for a deleted archive.
- Copies are deleted when the archive is closed, when it is deleted on the remote host, when the
  total exceeds `archivePeek.remote.cacheSizeMB` (least recently used first; an evicted archive
  is transferred again on demand), when the extension is deactivated and on process exit. Copies
  left behind by a crashed VS Code window are removed on the next start.
- Decompressed file contents are cached in memory in the existing 50 MB LRU buffer cache, as for
  local archives. Entries are decompressed only when they are opened.

### Memory use and size limit

While a remote archive is being transferred, its full size is held in memory once in the
extension host (plus whatever VS Code itself buffers in its IPC layers while forwarding the file).
It is released right after the local copy is written; afterwards memory use is the same as for a
local archive (the entry list plus the bounded buffer cache).

To keep this under control, archives larger than `archivePeek.remote.maxArchiveSizeMB`
(default **512 MB**) are not transferred automatically. The size is checked with
`workspace.fs.stat()` *before* anything is read; the editor then shows a warning with
**Load Anyway** (for this archive only) and **Settings**. Multi-gigabyte remote archives are
possible but need correspondingly more free RAM during the transfer.

### Safety limits

- `archivePeek.maxEntries` (500 000) — listing stops with an error above this many entries
  (zip archives are rejected from the declared entry count before parsing).
- `archivePeek.maxEntrySizeMB` (256 MB) — larger files are not decompressed into the editor.
  Single-file `.gz/.bz2/.xz` sizes are counted while streaming, without holding the data.
- Entry names are never used as file system paths (path traversal such as `../../x` is harmless);
  the only extraction to disk is the 7z handler, which uses flat (`e`) mode into a fresh private
  temp directory. Remote file names are sanitised before the local copy is created (also for
  Windows-reserved names and characters).
- Entry names are escaped before being embedded in the archive view.

### Installing the VSIX (local machine only)

The VSIX is built into `dist/`. Install it **into the local VS Code only** — never into the remote:

```bash
code --install-extension dist/archive-peek-remote-0.1.1.vsix
```

(or Extensions view → `…` → **Install from VSIX…**, *in a local window*). Because of
`extensionKind: ["ui"]`, VS Code runs it locally in Remote SSH windows; it does not offer to
install it "in SSH: host" and you should not use **Install in SSH**.

#### Coexistence with the original Archive Peek

This build has its own identifier, `local.archive-peek-remote` (display name
"Archive Peek (Remote SSH)"), so Marketplace updates of the original `Dzuelu.archive-peek` never
overwrite it. Both versions register the same commands, the same `archive://` scheme and the same
custom editor, so **only one of them may be enabled at a time**:

1. Extensions view → **Archive Peek** (Dzuelu) → **Disable** (or `code --uninstall-extension Dzuelu.archive-peek`).
   If it was also installed on the remote host, disable/uninstall it there as well.
2. Install this VSIX (above) and reload the window.
3. To switch back: disable or uninstall `local.archive-peek-remote`, enable `Dzuelu.archive-peek`, reload.

Settings (`archivePeek.*`) are shared by both versions.

### Checking it on a Remote SSH host

1. Open a local VS Code window and connect: F1 → **Remote-SSH: Connect to Host…**, open a folder that contains an archive.
2. Click e.g. `build.tar.gz` in the Explorer (or right-click → **Open Archive**).
3. The tab shows `[SSH: <host>] /path/build.tar.gz`, the format, real file/directory counts and the
   uncompressed size, and the tree. Click a `.log` / `.json` / `.yaml` file: it opens read-only with
   syntax highlighting.
4. View → Output → **Archive Peek** shows where the extension runs (`activated in the local (UI
   extension host); remote window: ssh-remote`), the transfer size and time, and any errors.
5. Rebuild or `touch` the archive on the server: the view reloads (or switch tabs / run
   **Archive Peek: Refresh Archives**).
6. Nothing is left on the server; local copies are in `<os.tmpdir()>/archive-peek-remote-*` and
   disappear when the archive is closed or VS Code exits.

The automated tests emulate a remote host with an in-memory FileSystemProvider
(`test/fakeRemoteFileSystemProvider.ts`) behind a mock of `vscode.workspace.fs`. **They are not a
substitute for a test against a real Remote SSH connection**, which is not part of the automated
test suite.

## Development

```bash
# Install dependencies
npm ci

# macOS/Windows only: the committed lock file only lists the Linux native binding of rolldown
# (used by vitest), so add the one for your platform without touching the lock file, e.g.:
npm install --no-save @rolldown/binding-darwin-arm64@$(node -p "require('rolldown/package.json').version")

# Validate - Compile + lint
npm run validate

# Watch mode
npm run watch

# Tests
npm test

# Test fixtures (needed once before running the tests)
./test/fixtures/create-fixtures.sh

# Build the VSIX into dist/
npm run package

# Benchmarks. Large fixture archives are generated in the OS temp dir on first run.
npm run bench            # speed benchmarks
npm run bench:memory     # memory retained while archives are open
npm run bench:baseline   # record speed + memory results into bench-results/ (e.g. on main)
npm run bench:compare    # compare the current code against that baseline (same machine only)
```

Timings depend on the machine, so only compare results recorded on the same machine. CI does this
on every push: it benchmarks `main`, then tests and benchmarks the pushed commit on the same runner,
and shows the comparison in the workflow log and on the run's summary page. The report
(`scripts/bench-report.mjs`) compares median times and only flags changes of at least 10% that are also
larger than the combined margin of error; smaller differences are runner noise.

Press **F5** to launch the Extension Development Host. To try remote archives, use the
**Run Extension (Remote SSH testing)** launch configuration (it keeps the Remote - SSH extension
enabled) and connect the development window to an SSH host.

Unit tests import the `vscode` module from `test/mocks/vscode.ts` (aliased in `vitest.config.ts`),
which uses `vscode-uri` — the same `Uri` implementation as VS Code.

## Requirements

- VS Code 1.101.0+ (desktop)
- Remote archives: any VS Code remote (Remote - SSH, WSL, Dev Containers…). Nothing is required on the remote host.
- For `.7z` support: the bundled `7zip-bin` package provides the 7z binary
- For `.tar.bz2` support: `unbzip2-stream`
- For `.tar.xz` support: `xz-decompress` (pure JS/WASM — no native binaries needed)
- For `.rar` support: `node-unrar-js` (pure JS/WASM — no native binaries needed)
