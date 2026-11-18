import * as vscode from 'vscode';
import { Logger } from './models';

/**
 * Logger backed by the "Archive Peek" Output channel (View → Output →
 * Archive Peek). The log level follows "Developer: Set Log Level…".
 *
 * Only metadata is logged — archive locations (with the remote host name
 * redacted), sizes, timings and error messages. File contents are never logged.
 */
export class OutputChannelLogger implements Logger, vscode.Disposable {
  readonly channel: vscode.LogOutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel('Archive Peek', { log: true });
  }

  trace(message: string): void {
    this.channel.trace(message);
  }

  info(message: string): void {
    this.channel.info(message);
  }

  warn(message: string): void {
    this.channel.warn(message);
  }

  error(message: string): void {
    this.channel.error(message);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
