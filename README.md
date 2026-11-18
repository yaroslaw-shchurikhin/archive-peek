# Archive Peek for VS Code

Peek inside archive files directly in VS Code — without extracting them to disk. Simply click an archive in the Explorer and get an interactive file browser with stats, right inside the editor.

> **This build adds Remote SSH support** (`local.archive-peek-remote`): archives on a Remote SSH host
> open the same way as local ones, without installing anything on the server. See
> [Remote SSH Support](#remote-ssh-support).
>
> **Since 0.2.0 archives can also be browsed as expandable folders in the Explorer side bar** —
> see [Explorer Integration](#explorer-integration).

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
- **Two ways to browse** — the archive viewer (an editor tab with stats and a file tree), or the **Archive Peek** section of the Explorer, where archives expand like read-only folders next to your files; pick the default with `archivePeek.openMode`
- **Archive as a workspace folder** — on request, add an archive to the workspace as a read-only folder that the regular Explorer tree shows
- **23 file extensions** — covers ZIP-based, tar variants, standalone compressed, RAR, and 7z out of the box
- **Context menu integration** — right-click archive files in the Explorer for quick access
- **Auto-refresh** — when an opened archive is rebuilt or replaced on disk, the archive tab and any files opened from it reload automatically
- **Light on memory** — ZIP-based archives are streamed: only the file list is kept in memory, and the archive file is never held open, so build tools can overwrite it at any time

## Usage

1. Click any supported archive file in the VS Code Explorer
2. The archive opens in an editor tab showing format info, file/directory counts, total size, and a browsable file tree
3. Click any file in the tree to view its contents

Right-click an archive in the Explorer for:

- **Open in Archive Peek View** — show it as an expandable folder in the Archive Peek section of the Explorer
- **Open in Archive Viewer** — the editor-tab viewer
- **Add Archive to Workspace as Read-Only Folder** — mount it in the regular Explorer tree (asks first)

To make clicking an archive open it in the Explorer tree instead of the viewer, set
`"archivePeek.openMode": "explorerTree"`. The command palette has `Archive Peek: Open Archive`
(follows that setting) and the commands below.

## Commands

| Command                          | Description                                |
|----------------------------------|--------------------------------------------|
| `Archive Peek: Open Archive`    | Open an archive file for browsing (in the viewer or the Explorer tree, per `archivePeek.openMode`) |
| `Archive Peek: Open in Archive Peek View` | Show an archive as an expandable folder in the Explorer's Archive Peek section |
| `Archive Peek: Open in Archive Viewer` | Open an archive in the editor-tab viewer |
| `Archive Peek: Add Archive to Workspace as Read-Only Folder` | Mount an archive as a workspace folder (archive:// file system) |
| `Archive Peek: Refresh Archives` | Re-read all opened archives and reload files opened from them |
| `Archive Peek: Refresh All Archives` / `Close All Archives` | The same, for the archives in the Explorer tree |
| `Archive Peek: Close Archive`    | Close an opened archive                    |
| `Archive Peek: Show Log`         | Show the Archive Peek output channel |

In the Archive Peek section, right-click an item for **Open**, **Open to the Side**, **Open in
Archive Viewer**, **Reveal Archive in Explorer**, **Copy Path** (archive path, or
`archive path/entry path`), **Copy Path Inside Archive**, **Refresh**, **Add to Workspace as
Read-Only Folder** and **Close Archive**. Refresh and Close are also inline buttons on each archive.

## Settings

| Setting                  | Default | Description                                                                 |
|--------------------------|---------|-----------------------------------------------------------------------------|
| `archivePeek.openMode` | `viewer` | How archives open when clicked in the Explorer: `viewer` (editor tab) or `explorerTree` (expandable folder in the Archive Peek section of the Explorer). The other mode stays available from the context menu |
| `archivePeek.autoRefresh` | `true`  | Reload opened archives (and files opened from them) when they change on disk |
| `archivePeek.remote.maxArchiveSizeMB` | `512` | Largest remote archive that is loaded (see [memory use](#memory-use-and-size-limit)). Larger archives show a warning with **Load Anyway** |
| `archivePeek.remote.cacheSizeMB` | `2048` | Total size of local copies of remote archives kept in the OS temp directory (LRU) |
| `archivePeek.maxEntries` | `500000` | Maximum number of entries per archive (archive-bomb protection) |
| `archivePeek.maxEntrySizeMB` | `256` | Largest uncompressed file that can be opened from an archive (decompression-bomb protection) |

## Explorer Integration

Archives can be browsed as expandable, read-only folders in the Explorer side bar:

```
EXPLORER
├── MY-PROJECT
│   └── reports/
│       ├── pre_check.tar.gz
│       └── post_check.tar.gz
└── ARCHIVE PEEK
    ├── pre_check.tar.gz           SSH: build-01 · /tmp/work/var/reports
    │   ├── logs/
    │   │   ├── service.log        12.4 KB
    │   │   └── system.log         3.1 KB
    │   ├── config.json            220 B
    │   └── report.txt             1.2 KB
    └── post_check.tar.gz          SSH: build-01 · /tmp/work/var/reports
```

### Which integration was chosen, and why

The three options from the public VS Code Extension API, in order of preference:

1. **Expanding the archive file itself inside the regular Explorer tree — not possible.** The
   Explorer tree is built by VS Code from the workspace folders' FileSystemProviders, and a node that
   the provider reports as a *file* can never get children. The public API has no way to add children
   to, or replace, a node of the built-in Explorer (`FileDecorationProvider` can only add a badge,
   color and tooltip). Doing it anyway would need internal APIs, patched VS Code sources or injected
   workbench JavaScript, which this extension deliberately does not use.
2. **The archive as a read-only workspace folder in the regular Explorer — implemented, on request.**
   The existing `archive://` FileSystemProvider (read-only) serves the archive's contents, and
   `workspace.updateWorkspaceFolders` adds `archive://…/name.tar.gz` as a workspace folder, so the
   standard Explorer shows it with all its features. This changes the workspace, so it is only done
   via the explicit command **Add Archive to Workspace as Read-Only Folder** (Explorer context menu,
   tree context menu, command palette) after a confirmation. It works in Remote SSH windows: the
   provider runs in the local extension host, and VS Code routes `archive://` requests to it.
3. **A dedicated "Archive Peek" section inside the Explorer side bar (TreeDataProvider) — the main
   mode.** Archives appear as top-level nodes that expand like folders, without touching the
   workspace. Several archives can be open at the same time.

### What the Archive Peek section does

- **Native look**: files and folders use `ThemeIcon.File` / `ThemeIcon.Folder` with an `archive://`
  `resourceUri`, so the current file icon theme picks icons by file name and extension. The archive
  node uses the archive's own URI, so it gets the archive's icon and its Explorer decorations
  (e.g. git status).
- **Open files in regular editor tabs**: clicking a file runs `vscode.open` on its `archive://` URI.
  The language (and therefore syntax highlighting) is detected from the file's extension, binary
  files and images get VS Code's normal handling, and editors are read-only because the file system
  is registered with `isReadonly: true` (writes are rejected; the archive is never modified).
- **Focus**: opening an archive reveals, selects, expands and focuses its node.
- **Stable ids** (archive id + path inside the archive): expanded folders and the selection survive
  a refresh, including the automatic refresh when the archive changes on disk.
- **Same names**: each archive node shows its location as description — the directory for local
  archives, `SSH: host · /remote/dir` (or `scheme: authority · /dir`) for remote ones — and archives
  are keyed by their full, case-preserving id, so equal names in other folders or on other hosts
  never collide.
- **Errors in place**: permission problems, lost connections, the remote size limit (with **Load
  Anyway**), deleted archives and empty archives are shown as a line under the archive, with a
  click to retry.
- The list of archives is remembered per workspace; archives are restored collapsed and are **not**
  loaded until they are expanded.
- **Close Archive** frees the archive's memory and the local copy of a remote archive, unless the
  archive is still shown in a viewer tab, an editor, or as a workspace folder.

### Performance

The tree is a view over the existing machinery, not a second archive implementation: loading,
caching, change detection and size/bomb limits are those of `ArchiveManager` and
`RemoteArchiveCache`. The flat entry list is indexed once per archive version (`ArchiveIndex`) and
the same index serves the tree and the `archive://` file system.

- Adding an archive costs nothing; it is loaded on first expansion (for a remote archive: one `stat`
  + one transfer, exactly as in the viewer).
- Expanding folders afterwards only reads the in-memory index: no file system requests, no second
  transfer.
- File contents are read only when a file is opened (remote archives: from the local copy, after a
  single `stat` that checks the archive hasn't changed).
- Nothing scans the workspace for archives; only archives the user opens are touched.

### Limitations of the public API

- An archive file in the regular Explorer cannot itself be expanded (see above); use the Archive Peek
  section or mount the archive as a workspace folder.
- Adding a folder to a window that has a single folder open turns it into an (untitled) multi-root
  workspace, and VS Code restarts the extension host. This is VS Code's behavior and the reason
  mounting asks first.
- **Search** (Ctrl+P, Find in Files) does not cover mounted archive folders: that needs
  `FileSearchProvider` / `TextSearchProvider`, which are proposed APIs (not in the stable `@types/vscode`) that an installed VSIX cannot use.
- The tree's icons follow the icon theme by file name; folder-specific icons depend on the theme.
- With `archivePeek.openMode: "explorerTree"`, clicking an archive still briefly opens the viewer
  tab: archives are bound to the custom editor in `package.json`, which can't change at runtime. The
  viewer immediately hands the archive to the tree and closes its tab.

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
code --install-extension dist/archive-peek-remote-0.2.0.vsix --force
```

(or Extensions view → `…` → **Install from VSIX…**, *in a local window*), then run
**Developer: Reload Window**. 0.2.0 installs over 0.1.x (same identifier
`local.archive-peek-remote`); settings and everything else carry over. Because of
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
6. Right-click the archive → **Open in Archive Peek View**: the **Archive Peek** section of the
   Explorer gets focus with the archive expanded and `SSH: <host> · /path` next to its name. Expand
   folders, click a file (it opens in a normal tab), right-click → **Copy Path**, **Refresh**,
   **Close Archive**.
7. Nothing is left on the server; local copies are in `<os.tmpdir()>/archive-peek-remote-*` and
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
