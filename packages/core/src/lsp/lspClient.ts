/**
 * LSP Client — JSON-RPC 2.0 communication with a Language Server over stdio.
 *
 * Handles message framing (Content-Length header), request/response matching,
 * and notification dispatch. Stateless per-request — each call is a fresh
 * request/response cycle.
 *
 * Inspired by OhMyPi's LSP integration. The agent uses this to query
 * code intelligence (diagnostics, go-to-definition, references, etc.)
 * without needing an IDE.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { reportSilentFailure } from '../silentFailureReporter';

// ============================================================================
// Types
// ============================================================================

export interface LspPosition {
  line: number; // 0-indexed
  character: number; // 0-indexed
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspDiagnostic {
  range: LspRange;
  severity: 1 | 2 | 3 | 4; // 1=Error, 2=Warning, 3=Info, 4=Hint
  code?: string | number;
  source?: string;
  message: string;
  relatedInformation?: Array<{
    location: LspLocation;
    message: string;
  }>;
}

export interface LspHover {
  contents: { kind: string; value: string } | string;
  range?: LspRange;
}

export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string;
  insertText?: string;
}

export interface LspCodeAction {
  title: string;
  kind?: string;
  edit?: LspWorkspaceEdit;
  command?: { title: string; command: string; arguments?: unknown[] };
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: unknown[];
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspInitializeResult {
  capabilities: Record<string, unknown>;
  serverInfo?: { name: string; version?: string };
}

// ============================================================================
// JSON-RPC Wire Protocol
// ============================================================================

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: unknown;
}

// ============================================================================
// LSP Client
// ============================================================================

export class LspClient {
  private process: ChildProcess | null = null;
  private idCounter = 0;
  private pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private buffer = '';
  private initialized = false;
  private serverCapabilities: Record<string, unknown> = {};
  private diagnostics: Map<string, LspDiagnostic[]> = new Map();
  private onDiagnosticsCallback: ((uri: string, diags: LspDiagnostic[]) => void) | null = null;

  /** Timeout for LSP requests (ms) */
  private requestTimeout: number;

  constructor(options?: { requestTimeout?: number }) {
    this.requestTimeout = options?.requestTimeout ?? 15000;
  }

  /**
   * Start the LSP server process.
   */
  async start(
    command: string,
    args: string[] = [],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
    },
  ): Promise<LspInitializeResult> {
    if (this.process) {
      throw new Error('LSP client already started');
    }

    const env = { ...process.env, ...options?.env };

    this.process = spawn(command, args, {
      cwd: options?.cwd ?? process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.on('error', (err) => {
      reportSilentFailure(err, 'lspClient:processError');
    });

    this.process.on('exit', (code) => {
      // Clean up pending requests
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`LSP server exited with code ${code}`));
      }
      this.pendingRequests.clear();
      this.initialized = false;
    });

    // Listen for responses
    this.process.stdout!.on('data', (chunk: Buffer) => {
      this.handleData(chunk.toString());
    });

    this.process.stderr!.on('data', (chunk: Buffer) => {
      // LSP servers often log to stderr, ignore
    });

    // Send initialize request
    const result = await this.initialize(options?.cwd ?? process.cwd());
    this.initialized = true;

    // Send initialized notification
    this.sendNotification('initialized', {});

    return result;
  }

  /**
   * Stop the LSP server.
   */
  async stop(): Promise<void> {
    if (!this.process) return;

    try {
      this.sendNotification('exit', {});
    } catch {
      // Ignore — server might already be dead
    }

    this.process.kill('SIGTERM');
    // Give it a moment to exit gracefully
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (this.process && !this.process.killed) {
      this.process.kill('SIGKILL');
    }
    this.process = null;
    this.initialized = false;
    this.pendingRequests.clear();
    this.buffer = '';
  }

  get isRunning(): boolean {
    return this.process !== null && !this.process.killed && this.initialized;
  }

  get capabilities(): Record<string, unknown> {
    return { ...this.serverCapabilities };
  }

  /**
   * Register a callback for diagnostics notifications.
   */
  onDiagnostics(cb: (uri: string, diags: LspDiagnostic[]) => void): void {
    this.onDiagnosticsCallback = cb;
  }

  // ========================================================================
  // LSP Methods
  // ========================================================================

  /**
   * Open a text document in the LSP server (required before queries).
   */
  async openDocument(uri: string, languageId: string, text: string): Promise<void> {
    this.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text,
      },
    });
  }

  /**
   * Notify the server that a document has changed.
   */
  async changeDocument(uri: string, text: string, version: number): Promise<void> {
    this.sendNotification('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  /**
   * Close a text document.
   */
  async closeDocument(uri: string): Promise<void> {
    this.sendNotification('textDocument/didClose', {
      textDocument: { uri },
    });
  }

  /**
   * Get diagnostics for a file.
   */
  async getDiagnostics(uri: string): Promise<LspDiagnostic[]> {
    // Try pull diagnostics first (LSP 3.17+)
    if (this.serverCapabilities['diagnosticProvider']) {
      try {
        const result = await this.request('textDocument/diagnostic', {
          textDocument: { uri },
        });
        const items = (result as { items?: LspDiagnostic[] })?.items ?? [];
        this.diagnostics.set(uri, items);
        return items;
      } catch {
        // Fall back to push diagnostics (already cached)
      }
    }

    // Return cached push diagnostics
    return this.diagnostics.get(uri) ?? [];
  }

  /**
   * Go to definition.
   */
  async goToDefinition(uri: string, line: number, character: number): Promise<LspLocation[]> {
    const result = await this.request('textDocument/definition', {
      textDocument: { uri },
      position: { line, character },
    });

    if (!result) return [];
    if (Array.isArray(result)) return result as LspLocation[];
    // Single location
    return [result as LspLocation];
  }

  /**
   * Find references.
   */
  async findReferences(uri: string, line: number, character: number): Promise<LspLocation[]> {
    const result = await this.request('textDocument/references', {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    });

    return (result as LspLocation[]) ?? [];
  }

  /**
   * Hover information.
   */
  async hover(uri: string, line: number, character: number): Promise<LspHover | null> {
    const result = await this.request('textDocument/hover', {
      textDocument: { uri },
      position: { line, character },
    });

    return (result as LspHover) ?? null;
  }

  /**
   * Rename a symbol.
   */
  async rename(
    uri: string,
    line: number,
    character: number,
    newName: string,
  ): Promise<LspWorkspaceEdit | null> {
    const result = await this.request('textDocument/rename', {
      textDocument: { uri },
      position: { line, character },
      newName,
    });

    return (result as LspWorkspaceEdit) ?? null;
  }

  /**
   * Get code actions.
   */
  async getCodeActions(uri: string, range: LspRange): Promise<LspCodeAction[]> {
    const result = await this.request('textDocument/codeAction', {
      textDocument: { uri },
      range,
      context: {
        diagnostics: this.diagnostics.get(uri) ?? [],
        only: ['quickfix', 'refactor', 'source'],
      },
    });

    return (result as LspCodeAction[]) ?? [];
  }

  /**
   * Get document symbols.
   */
  async getDocumentSymbols(uri: string): Promise<unknown[]> {
    const result = await this.request('textDocument/documentSymbol', {
      textDocument: { uri },
    });

    return (result as unknown[]) ?? [];
  }

  /**
   * Format a document.
   */
  async formatDocument(uri: string): Promise<LspTextEdit[] | null> {
    const result = await this.request('textDocument/formatting', {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    });

    return (result as LspTextEdit[]) ?? null;
  }

  // ========================================================================
  // Internal: JSON-RPC
  // ========================================================================

  private async initialize(rootUri: string): Promise<LspInitializeResult> {
    const result = await this.request('initialize', {
      processId: process.pid,
      rootUri: `file://${rootUri}`,
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          diagnostic: { dynamicRegistration: true },
          definition: { dynamicRegistration: true },
          references: { dynamicRegistration: true },
          hover: { dynamicRegistration: true, contentFormat: ['markdown', 'plaintext'] },
          rename: { dynamicRegistration: true },
          codeAction: {
            dynamicRegistration: true,
            codeActionLiteralSupport: {
              codeActionKind: { valueSet: ['quickfix', 'refactor', 'source'] },
            },
          },
          documentSymbol: { dynamicRegistration: true },
          formatting: { dynamicRegistration: true },
        },
        workspace: {
          diagnostic: { dynamicRegistration: true },
        },
      },
      initializationOptions: {},
      workspaceFolders: [{ uri: `file://${rootUri}`, name: path.basename(rootUri) || 'root' }],
    });

    const initResult = result as {
      capabilities: Record<string, unknown>;
      serverInfo?: { name: string; version?: string };
    };
    this.serverCapabilities = initResult.capabilities ?? {};
    return initResult as LspInitializeResult;
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    if (!this.process || !this.process.stdin) {
      return Promise.reject(new Error('LSP server not running'));
    }

    const id = ++this.idCounter;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request timeout: ${method} (${this.requestTimeout}ms)`));
      }, this.requestTimeout);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const content = JSON.stringify(request);
      const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
      this.process!.stdin!.write(header + content);
    });
  }

  /** Alias for sendRequest */
  private request = this.sendRequest;

  /** @deprecated Use sendRequest instead */
  private sendNotification(method: string, params: unknown): void {
    if (!this.process || !this.process.stdin) return;

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const content = JSON.stringify(notification);
    const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
    this.process.stdin.write(header + content);
  }

  private handleData(data: string): void {
    this.buffer += data;

    while (true) {
      // Parse Content-Length header
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length: (\d+)/i);
      if (!match) {
        // Malformed, skip
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.buffer.length < messageEnd) break;

      const content = this.buffer.slice(messageStart, messageEnd);
      this.buffer = this.buffer.slice(messageEnd);

      try {
        const message = JSON.parse(content);
        this.handleMessage(message);
      } catch (err) {
        reportSilentFailure(err, 'lspClient:handleData');
      }
    }
  }

  private handleMessage(message: JsonRpcResponse | JsonRpcNotification): void {
    // Response to a pending request
    if ('id' in message && typeof message.id === 'number') {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;

      clearTimeout(pending.timer);
      this.pendingRequests.delete(message.id);

      if ('error' in message && message.error) {
        pending.reject(new Error(`LSP error ${message.error.code}: ${message.error.message}`));
      } else {
        pending.resolve('result' in message ? message.result : undefined);
      }
      return;
    }

    // Notification
    const notif = message as JsonRpcNotification;

    switch (notif.method) {
      case 'textDocument/publishDiagnostics': {
        const params = notif.params as {
          uri: string;
          diagnostics: LspDiagnostic[];
        };
        this.diagnostics.set(params.uri, params.diagnostics);
        if (this.onDiagnosticsCallback) {
          this.onDiagnosticsCallback(params.uri, params.diagnostics);
        }
        break;
      }
    }
  }
}
