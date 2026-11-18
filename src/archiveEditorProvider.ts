import * as vscode from 'vscode';
import { ArchiveManager, OpenArchive } from './archiveManager';
import { archiveEntryUri } from './archiveFileSystemProvider';
import { archiveBaseName, archivePathPart, describeArchiveId, isRemoteId, remoteLabel } from './archiveId';
import { formatBytes, Logger, NULL_LOGGER } from './models';
import { describeError } from './sourceErrors';
import { archiveIdFromUri } from './vscodeFileAccess';

/** A loading or error state shown instead of the archive contents. */
interface ViewStatus {
  kind: 'loading' | 'error' | 'info';
  message: string;
  actions?: { command: string; label: string }[];
}

/** Hooks the editor needs from the rest of the extension. */
export interface ArchiveEditorHooks {
  logger?: Logger;
  /** Show the Archive Peek output channel */
  showLog?: () => void;
  /** Called when an archive editor becomes active again (cheap change check) */
  onDidActivate?: (archiveId: string) => void;
  /**
   * Called before an archive is shown. Returning true means the archive was
   * opened elsewhere instead (the Explorer tree, archivePeek.openMode), so
   * this editor shows a short note and closes itself.
   */
  redirect?: (archiveId: string) => boolean;
  /** Show this archive in the viewer even if redirect() would move it elsewhere */
  forceViewer?: (archiveId: string) => void;
}

/**
 * Tree node structure passed to the webview as JSON.
 */
interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  children?: TreeNode[];
}

/**
 * CustomReadonlyEditorProvider that shows archive stats and an interactive
 * file browser when an archive is clicked in the Explorer.
 *
 * The file tree is rendered inside the webview so there's no separate
 * sidebar panel — everything is self-contained in the editor tab.
 */
export class ArchiveEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'archivePeek.archiveEditor';

  private readonly logger: Logger;

  constructor(
    private readonly archiveManager: ArchiveManager,
    private readonly hooks: ArchiveEditorHooks = {}
  ) {
    this.logger = hooks.logger ?? NULL_LOGGER;
  }

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // Keep the URI's scheme and authority: in a Remote SSH window this is a
    // vscode-remote:// URI that must not be turned into a local path.
    const archivePath = archiveIdFromUri(document.uri);
    const fileName = archiveBaseName(archivePath);
    const remote = isRemoteId(archivePath);

    webviewPanel.webview.options = { enableScripts: true };
    let disposed = false;

    if (this.hooks.redirect?.(archivePath)) {
      this.render(webviewPanel, fileName, archivePath, undefined, undefined, {
        kind: 'info',
        message: 'Opened in the Archive Peek section of the Explorer (setting "archivePeek.openMode").',
        actions: [
          { command: 'showHere', label: 'Show Here' },
          { command: 'openSettings', label: 'Settings' }
        ]
      });
      const messages = webviewPanel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === 'showHere') {
          messages.dispose();
          this.hooks.forceViewer?.(archivePath);
          await vscode.commands.executeCommand('vscode.openWith', document.uri, ArchiveEditorProvider.viewType);
        } else if (message.command === 'openSettings') {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'archivePeek.openMode');
        }
      });
      webviewPanel.onDidDispose(() => messages.dispose());
      // Close this tab once VS Code has finished opening it
      setTimeout(() => void closeEditorTab(document.uri), 0);
      return;
    }

    const load = async () => {
      this.render(webviewPanel, fileName, archivePath, undefined, undefined, {
        kind: 'loading',
        message: remote ? 'Loading archive from the remote host…' : 'Loading archive…'
      });
      try {
        const archive = await this.openWithProgress(archivePath, fileName);
        if (!disposed) {
          this.render(webviewPanel, fileName, archivePath, archive);
        }
      } catch (error) {
        const { kind, message } = describeError(error);
        this.logger.error(
          `Failed to open ${describeArchiveId(archivePath, { redactHost: true })} [${kind}]: ${message}`
        );
        if (disposed) {
          return;
        }
        const actions = [{ command: 'retry', label: 'Retry' }];
        if (kind === 'too-large') {
          actions.unshift({ command: 'loadAnyway', label: 'Load Anyway' });
          actions.push({ command: 'openSettings', label: 'Settings' });
        } else if (kind === 'too-many-entries') {
          actions.push({ command: 'openSettings', label: 'Settings' });
        }
        actions.push({ command: 'showLog', label: 'Show Log' });
        this.render(webviewPanel, fileName, archivePath, undefined, undefined, { kind: 'error', message, actions });
      }
    };

    // Re-render when the archive changes or disappears on disk
    const subscription = this.archiveManager.onDidChangeArchive((event) => {
      if (event.filePath !== archivePath) {
        return;
      }
      if (event.type === 'changed') {
        this.render(webviewPanel, fileName, archivePath, event.archive);
      } else if (event.type === 'deleted') {
        this.render(webviewPanel, fileName, archivePath, undefined, undefined, {
          kind: 'error',
          message: 'This archive was deleted from disk.',
          actions: [{ command: 'retry', label: 'Retry' }]
        });
      }
    });
    const viewState = webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active && this.archiveManager.getArchive(archivePath)) {
        this.hooks.onDidActivate?.(archivePath);
      }
    });
    webviewPanel.onDidDispose(() => {
      disposed = true;
      subscription.dispose();
      viewState.dispose();
    });

    // Handle messages from the webview
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'openFile':
          await this.openEntry(archivePath, message.entryPath);
          break;
        case 'retry':
          await load();
          break;
        case 'loadAnyway':
          this.archiveManager.allowOversize(archivePath);
          await load();
          break;
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'archivePeek');
          break;
        case 'showLog':
          this.hooks.showLog?.();
          break;
      }
    }, undefined);

    await load();
  }

  /** Open (or reuse) the archive, with a progress indicator for remote and large archives. */
  private openWithProgress(archivePath: string, fileName: string): Promise<OpenArchive> {
    const existing = this.archiveManager.getArchive(archivePath);
    if (existing) {
      return Promise.resolve(existing);
    }
    const remote = isRemoteId(archivePath);
    return Promise.resolve(
      vscode.window.withProgress(
        {
          // Remote transfers can take a while: show a notification. Local archives only get a status bar spinner.
          location: remote ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
          title: `Archive Peek: ${fileName}`,
          cancellable: false
        },
        (progress) =>
          this.archiveManager.openArchive(archivePath, {
            onProgress: (message) => progress.report({ message })
          })
      )
    );
  }

  /** Open one entry of the archive as a read-only text document. */
  private async openEntry(archivePath: string, entryPath: string): Promise<void> {
    try {
      const uri = archiveEntryUri(archivePath, entryPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        preview: true
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to open "${entryPath}" from ${describeArchiveId(archivePath, { redactHost: true })}: ${error.message}`
      );
      const choice = await vscode.window.showErrorMessage(`Failed to open file: ${error.message}`, 'Show Log');
      if (choice === 'Show Log') {
        this.hooks.showLog?.();
      }
    }
  }

  private render(
    webviewPanel: vscode.WebviewPanel,
    fileName: string,
    archivePath: string,
    archive: OpenArchive | undefined,
    notice?: string,
    status?: ViewStatus
  ): void {
    if (archive && archive.entries.length === 0 && !notice) {
      notice = 'This archive is empty.';
    }
    const fileCount = archive ? archive.entries.filter((e) => !e.isDirectory).length : 0;
    const dirCount = archive ? archive.entries.filter((e) => e.isDirectory).length : 0;
    const archiveType = archive ? archive.type.toUpperCase() : 'Unknown';
    const totalSize = archive ? archive.entries.reduce((sum, e) => sum + e.size, 0) : 0;

    // Build the tree structure for the webview
    const tree = archive ? this.buildTree(archive) : [];

    webviewPanel.webview.html = this.getWebviewHtml(
      fileName,
      displayLocation(archivePath),
      archiveType,
      fileCount,
      dirCount,
      totalSize,
      tree,
      notice,
      status
    );
  }

  /**
   * Build a hierarchical tree from the flat list of archive entries.
   */
  private buildTree(archive: OpenArchive): TreeNode[] {
    const nodeMap: Map<string, TreeNode> = new Map();

    // Ensure all directory nodes exist
    for (const entry of archive.entries) {
      if (entry.isDirectory) {
        this.ensureDir(nodeMap, entry.path.replace(/\/$/, ''));
      }
    }

    // Add files (and ensure their parent directories exist)
    for (const entry of archive.entries) {
      if (!entry.isDirectory) {
        const parts = entry.path.split('/');
        const fileName = parts.pop()!;

        const fileNode: TreeNode = {
          name: fileName,
          path: entry.path,
          isDirectory: false,
          size: entry.size
        };

        if (parts.length === 0) {
          // Root level file
          nodeMap.set(entry.path, fileNode);
        } else {
          const dirPath = parts.join('/');
          const parentNode = this.ensureDir(nodeMap, dirPath);
          if (!parentNode.children!.find((c) => c.path === entry.path)) {
            parentNode.children!.push(fileNode);
          }
        }
      }
    }

    // Collect root-level nodes (no slashes in their path)
    const rootNodes = Array.from(nodeMap.values()).filter((n) => {
      const p = n.path.replace(/\/$/, '');
      return !p.includes('/');
    });

    this.sortTree(rootNodes);
    return rootNodes;
  }

  private ensureDir(nodeMap: Map<string, TreeNode>, dirPath: string): TreeNode {
    const existing = nodeMap.get(dirPath);
    if (existing) {
      return existing;
    }

    const parts = dirPath.split('/');
    const name = parts[parts.length - 1];

    const node: TreeNode = {
      name,
      path: dirPath,
      isDirectory: true,
      size: 0,
      children: []
    };

    nodeMap.set(dirPath, node);

    if (parts.length > 1) {
      // Nested — ensure parent exists and add as child
      const parentPath = parts.slice(0, -1).join('/');
      const parentNode = this.ensureDir(nodeMap, parentPath);
      if (!parentNode.children!.find((c) => c.path === dirPath)) {
        parentNode.children!.push(node);
      }
    }

    return node;
  }

  private sortTree(nodes: TreeNode[]): void {
    nodes.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) {
        return -1;
      }
      if (!a.isDirectory && b.isDirectory) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.children) {
        this.sortTree(node.children);
      }
    }
  }

  private getWebviewHtml(
    fileName: string,
    filePath: string,
    archiveType: string,
    fileCount: number,
    dirCount: number,
    totalSize: number,
    tree: TreeNode[],
    notice?: string,
    status?: ViewStatus
  ): string {
    // Entry names come from the archive: escape "<" so a name like
    // "</script>" can't break out of the inline script.
    const treeJson = JSON.stringify(tree).replace(/</g, '\\u003c');
    const statusHtml = status
      ? `
  <div class="notice ${status.kind}">
    <div>${escapeHtml(status.message)}</div>${
      status.actions && status.actions.length > 0
        ? `
    <div class="actions">${status.actions
      .map((a) => `<button data-command="${escapeHtml(a.command)}">${escapeHtml(a.label)}</button>`)
      .join('')}</div>`
        : ''
    }
  </div>
`
      : '';
    const showContents = !status;

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(fileName)}</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px 24px;
      line-height: 1.5;
      margin: 0;
    }

    /* ── Header ── */
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
    }
    .icon { font-size: 32px; opacity: 0.8; }
    h1 {
      font-size: 18px;
      font-weight: 600;
      margin: 0;
    }
    .subtitle {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
      word-break: break-all;
    }
    .notice {
      background: var(--vscode-inputValidation-warningBackground);
      border: 1px solid var(--vscode-inputValidation-warningBorder);
      padding: 8px 12px;
      margin-bottom: 20px;
      border-radius: 4px;
    }
    .notice.error {
      background: var(--vscode-inputValidation-errorBackground);
      border-color: var(--vscode-inputValidation-errorBorder);
    }
    .notice.loading {
      background: var(--vscode-editorWidget-background);
      border-color: var(--vscode-editorWidget-border, var(--vscode-widget-border, transparent));
    }
    .notice .actions {
      margin-top: 8px;
      display: flex;
      gap: 8px;
    }
    .notice button {
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
      border: none;
      padding: 4px 10px;
      border-radius: 2px;
      cursor: pointer;
      font-family: inherit;
      font-size: inherit;
    }
    .notice button:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
    }

    /* ── Stats ── */
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .stat-card {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border, transparent));
      border-radius: 5px;
      padding: 12px;
    }
    .stat-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 2px;
    }
    .stat-value {
      font-size: 18px;
      font-weight: 600;
    }

    /* ── File Tree ── */
    .tree-header {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border, transparent));
    }
    .tree {
      font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
      font-size: 13px;
    }
    .tree ul {
      list-style: none;
      margin: 0;
      padding-left: 16px;
    }
    .tree > ul {
      padding-left: 0;
    }
    .tree li {
      margin: 0;
    }
    .tree-row {
      display: flex;
      align-items: center;
      padding: 2px 6px;
      cursor: pointer;
      border-radius: 3px;
      user-select: none;
      gap: 4px;
    }
    .tree-row:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .tree-row .chevron {
      width: 16px;
      text-align: center;
      font-size: 12px;
      color: var(--vscode-foreground);
      flex-shrink: 0;
      transition: transform 0.1s ease;
    }
    .tree-row .chevron.expanded {
      transform: rotate(90deg);
    }
    .tree-row .chevron.hidden {
      visibility: hidden;
    }
    .tree-row .node-icon {
      width: 16px;
      text-align: center;
      flex-shrink: 0;
      font-size: 14px;
    }
    .tree-row .node-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tree-row .node-size {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-left: 8px;
      flex-shrink: 0;
    }
    .tree-row.file-row:hover .node-name {
      color: var(--vscode-textLink-foreground);
      text-decoration: underline;
    }
    .tree ul.collapsed {
      display: none;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="icon">📦</div>
    <div>
      <h1>${escapeHtml(fileName)}</h1>
      <div class="subtitle">${escapeHtml(filePath)}</div>
    </div>
  </div>
${notice ? `\n  <div class="notice">${escapeHtml(notice)}</div>\n` : ''}${statusHtml}${
      showContents
        ? `
  <div class="stats">
    <div class="stat-card">
      <div class="stat-label">Format</div>
      <div class="stat-value">${escapeHtml(archiveType)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Files</div>
      <div class="stat-value">${fileCount}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Directories</div>
      <div class="stat-value">${dirCount}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Size (uncompressed)</div>
      <div class="stat-value">${formatSize(totalSize)}</div>
    </div>
  </div>

  <div class="tree-header">Contents</div>
  <div class="tree" id="fileTree"></div>
`
        : ''
    }

  <script>
    const vscode = acquireVsCodeApi();
    const treeData = ${treeJson};

    function formatSize(bytes) {
      if (bytes === 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      const size = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);
      return size + ' ' + units[i];
    }

    function getFileIcon(name) {
      const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
      const iconMap = {
        'js': '📄', 'ts': '📄', 'jsx': '📄', 'tsx': '📄',
        'json': '📋', 'xml': '📋', 'yaml': '📋', 'yml': '📋', 'toml': '📋',
        'md': '📝', 'txt': '📝', 'rst': '📝',
        'html': '🌐', 'css': '🎨', 'scss': '🎨', 'less': '🎨',
        'py': '📄', 'rb': '📄', 'go': '📄', 'rs': '📄', 'java': '📄',
        'c': '📄', 'cpp': '📄', 'h': '📄', 'hpp': '📄',
        'sh': '⚙️', 'bash': '⚙️', 'zsh': '⚙️', 'bat': '⚙️', 'ps1': '⚙️',
        'png': '🖼️', 'jpg': '🖼️', 'jpeg': '🖼️', 'gif': '🖼️', 'svg': '🖼️', 'ico': '🖼️',
        'zip': '📦', '7z': '📦', 'gz': '📦', 'tar': '📦',
        'lock': '🔒',
      };
      return iconMap[ext] || '📄';
    }

    function buildTreeHtml(nodes, expanded) {
      const ul = document.createElement('ul');
      if (!expanded) ul.classList.add('collapsed');

      for (const node of nodes) {
        const li = document.createElement('li');

        const row = document.createElement('div');
        row.classList.add('tree-row');

        const chevron = document.createElement('span');
        chevron.classList.add('chevron');

        const icon = document.createElement('span');
        icon.classList.add('node-icon');

        const name = document.createElement('span');
        name.classList.add('node-name');
        name.textContent = node.name;

        if (node.isDirectory) {
          chevron.textContent = '▶';
          chevron.classList.add('expanded');
          icon.textContent = '📁';

          row.addEventListener('click', function(e) {
            e.stopPropagation();
            const childUl = li.querySelector(':scope > ul');
            if (childUl) {
              childUl.classList.toggle('collapsed');
              chevron.classList.toggle('expanded');
            }
          });

          row.appendChild(chevron);
          row.appendChild(icon);
          row.appendChild(name);
          li.appendChild(row);

          if (node.children && node.children.length > 0) {
            li.appendChild(buildTreeHtml(node.children, true));
          }
        } else {
          chevron.classList.add('hidden');
          row.classList.add('file-row');
          icon.textContent = getFileIcon(node.name);

          const size = document.createElement('span');
          size.classList.add('node-size');
          size.textContent = node.size > 0 ? formatSize(node.size) : '';

          row.addEventListener('click', function(e) {
            e.stopPropagation();
            vscode.postMessage({ command: 'openFile', entryPath: node.path });
          });

          row.appendChild(chevron);
          row.appendChild(icon);
          row.appendChild(name);
          row.appendChild(size);
          li.appendChild(row);
        }

        ul.appendChild(li);
      }

      return ul;
    }

    const container = document.getElementById('fileTree');
    if (container) {
      container.appendChild(buildTreeHtml(treeData, true));
    }
    for (const button of document.querySelectorAll('button[data-command]')) {
      button.addEventListener('click', () => vscode.postMessage({ command: button.dataset.command }));
    }
  </script>
</body>
</html>`;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatSize(bytes: number): string {
  return formatBytes(bytes);
}

/** Subtitle: the local path, or "[SSH: host] /remote/path" for remote archives. */
function displayLocation(archivePath: string): string {
  const label = remoteLabel(archivePath);
  return label ? `[${label}] ${archivePathPart(archivePath)}` : archivePath;
}

/** Close the custom editor tab showing `uri`, if it is still open. */
async function closeEditorTab(uri: vscode.Uri): Promise<void> {
  const target = uri.toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        input instanceof vscode.TabInputCustom &&
        input.viewType === ArchiveEditorProvider.viewType &&
        input.uri.toString() === target
      ) {
        try {
          await vscode.window.tabGroups.close(tab, true);
        } catch {
          // Leave the note visible; the user can close the tab
        }
        return;
      }
    }
  }
}
