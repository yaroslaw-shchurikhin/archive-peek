import * as vscode from 'vscode';
import { ArchiveManager } from './archiveManager';
import { ArchiveFileSystemProvider, ARCHIVE_SCHEME } from './archiveFileSystemProvider';
import { ArchiveEditorProvider } from './archiveEditorProvider';
import { ArchiveWatcher } from './archiveWatcher';
import { archiveBaseName, archivePathPart, isRemoteId, remoteLabel } from './archiveId';
import { OutputChannelLogger } from './logger';
import { RemoteArchiveCache } from './remoteArchiveCache';
import { archiveLimits, maxRemoteArchiveBytes, maxRemoteCacheBytes, openMode } from './config';
import { pickArchive, refreshArchiveSource, registerExplorerIntegration } from './explorerIntegration';
import { archiveIdFromUri, VscodeRemoteFileAccess } from './vscodeFileAccess';

let archiveManager: ArchiveManager;
let fsProvider: ArchiveFileSystemProvider;
let remoteCache: RemoteArchiveCache | undefined;

export function activate(context: vscode.ExtensionContext) {
  const logger = new OutputChannelLogger();
  context.subscriptions.push(logger);
  logEnvironment(context, logger);

  // Remote archives (any non-file: URI, e.g. vscode-remote://ssh-remote+host/…) are
  // read through vscode.workspace.fs over the existing VS Code connection and
  // processed locally; see remoteArchiveCache.ts.
  remoteCache = new RemoteArchiveCache(new VscodeRemoteFileAccess(), {
    maxArchiveBytes: maxRemoteArchiveBytes,
    maxCacheBytes: maxRemoteCacheBytes,
    logger
  });
  const cache = remoteCache;
  context.subscriptions.push({ dispose: () => cache.dispose() });
  void RemoteArchiveCache.cleanupStale(undefined, logger);

  archiveManager = new ArchiveManager({ remote: remoteCache, logger, limits: archiveLimits });
  fsProvider = new ArchiveFileSystemProvider(archiveManager, logger);
  context.subscriptions.push(fsProvider);

  // Automatically refresh opened archives when they change on disk
  const watcher = new ArchiveWatcher(archiveManager, logger);
  context.subscriptions.push(watcher);

  // Register the virtual filesystem for the archive:/ scheme
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(ARCHIVE_SCHEME, fsProvider, {
      isCaseSensitive: true,
      isReadonly: true
    })
  );

  // "Archive Peek" section of the Explorer: archives as expandable read-only folders
  const explorer = registerExplorerIntegration(context, {
    archiveManager,
    logger,
    showLog: () => logger.show(),
    state: context.workspaceState
  });

  // Register the custom editor — clicking an archive opens stats + embedded file tree
  // (or, with archivePeek.openMode = explorerTree, shows it in the Explorer tree instead)
  const editorProvider = new ArchiveEditorProvider(archiveManager, {
    ...explorer.editorHooks,
    logger,
    showLog: () => logger.show(),
    onDidActivate: (archiveId) => {
      // Cheap re-check for remote archives, in case the provider doesn't deliver watch events
      if (isRemoteId(archiveId)) {
        watcher.check(archiveId);
      }
    }
  });
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(ArchiveEditorProvider.viewType, editorProvider, {
      webviewOptions: { retainContextWhenHidden: false },
      supportsMultipleEditorsPerDocument: false
    })
  );

  // ─── Command: Open Archive (follows archivePeek.openMode) ───────────
  context.subscriptions.push(
    vscode.commands.registerCommand('archivePeek.openArchive', async (uri?: vscode.Uri) => {
      const archiveUri = uri ?? (await pickArchive('Open Archive'));
      if (!archiveUri) {
        return;
      }

      // Keep scheme + authority (vscode-remote://…); never use fsPath for remote resources
      const archivePath = archiveIdFromUri(archiveUri);
      const fileName = archiveBaseName(archivePath);
      if (!archiveManager.isSupported(archivePath)) {
        vscode.window.showErrorMessage(`Unsupported archive format: ${fileName}`);
        return;
      }

      if (openMode() === 'explorerTree') {
        await explorer.openInTree(archivePath);
        return;
      }
      // The custom editor loads the archive (with progress and error reporting)
      await vscode.commands.executeCommand('archivePeek.openInViewer', archiveUri);
    })
  );

  // ─── Command: Refresh ────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('archivePeek.refresh', async () => {
      const archives = archiveManager.getOpenArchives();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Archive Peek: refreshing archives' },
        async (progress) => {
          for (const archive of archives) {
            await refreshArchiveSource(archiveManager, archive.filePath, logger, (message) =>
              progress.report({ message })
            );
          }
        }
      );
    })
  );

  // ─── Command: Close Archive (from command palette) ───────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('archivePeek.closeArchive', async () => {
      const archives = archiveManager.getOpenArchives();
      if (archives.length === 0) {
        vscode.window.showInformationMessage('No archives are currently open.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        archives.map((a) => ({
          label: archiveBaseName(a.filePath),
          description: remoteLabel(a.filePath)
            ? `[${remoteLabel(a.filePath)}] ${archivePathPart(a.filePath)}`
            : a.filePath,
          archivePath: a.filePath
        })),
        { placeHolder: 'Select an archive to close' }
      );

      if (!picked) {
        return;
      }
      archiveManager.closeArchive(picked.archivePath);
      explorer.tree.remove(picked.archivePath);
    })
  );
}

export function deactivate() {
  // Delete local copies of remote archives (also done via context.subscriptions)
  remoteCache?.dispose();
}

/** Log where the extension runs, so Remote SSH problems can be diagnosed from the Output channel. */
function logEnvironment(context: vscode.ExtensionContext, logger: OutputChannelLogger): void {
  const kind =
    context.extension.extensionKind === vscode.ExtensionKind.UI
      ? 'local (UI extension host)'
      : 'remote (workspace extension host)';
  logger.info(
    `Archive Peek ${context.extension.packageJSON.version} activated in the ${kind}; ` +
      `remote window: ${vscode.env.remoteName ?? 'none'}; UI: ${vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop'}; ` +
      `platform: ${process.platform}`
  );
  if (vscode.env.remoteName && context.extension.extensionKind !== vscode.ExtensionKind.UI) {
    logger.warn(
      'Archive Peek is running on the remote host. It is designed to run locally (extensionKind "ui"); ' +
        'check the "remote.extensionKind" setting.'
    );
  }
}
