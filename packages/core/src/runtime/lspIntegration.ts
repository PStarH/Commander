/**
 * Language Server Protocol integration for real-time diagnostics.
 * Spawns LSP servers over stdin/stdout JSON-RPC for TypeScript/JavaScript.
 * Used to surface diagnostics, type checking, and code quality feedback.
 * This module bridges editor-style analysis into the agent runtime.
 * It supports on-demand inspection of source files during execution.
 * The goal is fast, localized feedback without leaving the workflow.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { getGlobalLogger } from '../logging';
import type { Tool } from '../runtime/types';

interface LSPDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity: number;
  message: string;
  source?: string;
  code?: string | number;
}

interface LSPPublishDiagnosticsParams {
  uri: string;
  diagnostics: LSPDiagnostic[];
}

interface LSPMessage {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class LSPClient {
  private process: ChildProcess | null = null;
  private pendingRequests: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }> = new Map();
  private diagnostics: Map<string, LSPDiagnostic[]> = new Map();
  private messageId = 0;
  private isConnected = false;
  // GAP-20: Bound diagnostics map to prevent unbounded memory growth
  private readonly MAX_DIAGNOSTIC_FILES = 500;
  private readonly MAX_DIAGNOSTICS_PER_FILE = 200;
  private diagnosticsInsertOrder: string[] = [];
  // O(1) membership check alongside the insert-order array
  private diagnosticsFileSet: Set<string> = new Set();

  constructor(
    private serverCommand: string,
    private serverArgs: string[] = [],
    private workspaceRoot: string = process.cwd(),
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.serverCommand, this.serverArgs, {
        cwd: this.workspaceRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: 'development' },
      });

      // Guard against multiple resolve/reject calls (timeout + error + sendRequest can race)
      let settled = false;
      const settle = (fn: () => void): void => {
        if (!settled) { settled = true; fn(); }
      };

      const timeout = setTimeout(() => settle(() => {
        this.process?.kill();
        this.process = null;
        reject(new Error('LSP connection timeout'));
      }), 10000);

      this.process.on('error', (err) => {
        settle(() => {
          clearTimeout(timeout);
          this.process?.kill();
          this.process = null;
          reject(new Error(`LSP process error: ${err.message}`));
        });
      });

      this.process.on('close', (code) => {
        this.isConnected = false;
        if (code !== 0 && code !== null) {
          getGlobalLogger().warn('LSP', 'Server exited with non-zero code', { code });
        }
      });

      let buffer = '';
      this.process.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) this.handleMessage(line);
        }
      });

      this.process.stderr?.on('data', (chunk: Buffer) => {
        getGlobalLogger().warn('LSP', 'stderr output', { output: chunk.toString().slice(0, 200) });
      });

      this.sendRequest('initialize', {
        processId: process.pid ?? null,
        rootUri: `file://${this.workspaceRoot}`,
        capabilities: {
          textDocument: {
            synchronization: { didSave: true },
          },
          workspace: { applyEdit: false },
        },
      })
        .then(() => {
          settle(() => {
            clearTimeout(timeout);
            this.isConnected = true;
            this.sendNotification('initialized', {});
            resolve();
          });
        })
        .catch((e: Error) => settle(() => reject(e)));
    });
  }

  disconnect(): void {
    if (this.process) {
      this.sendNotification('shutdown', {}).catch(e => getGlobalLogger().debug('LSP', 'shutdown error', { error: (e as Error)?.message }));
      this.process.kill();
      this.process = null;
      this.isConnected = false;
      this.pendingRequests.clear();
    }
  }

  get isReady(): boolean {
    return this.isConnected;
  }

  getFileDiagnostics(filePath: string): LSPDiagnostic[] {
    const normalized = path.resolve(filePath);
    return this.diagnostics.get(normalized) || [];
  }

  hasErrors(filePath: string): boolean {
    return this.getFileDiagnostics(filePath).some(d => d.severity === 1);
  }

  getErrorCount(filePath: string): { errors: number; warnings: number } {
    const diagnostics = this.getFileDiagnostics(filePath);
    return {
      errors: diagnostics.filter(d => d.severity === 1).length,
      warnings: diagnostics.filter(d => d.severity === 2 || d.severity === 3).length,
    };
  }

  attachToContent(content: string, filePath: string): string {
    const diagnostics = this.getFileDiagnostics(filePath);
    if (diagnostics.length === 0) return content;

    const lines = content.split('\n');
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const d of diagnostics) {
      const line = d.range.start.line;
      const col = d.range.start.character;
      const msg = d.message.slice(0, 80);
      if (d.severity === 1) {
        errors.push(`  Line ${line + 1}:${col} ERROR: ${msg}`);
      } else if (d.severity === 2) {
        warnings.push(`  Line ${line + 1}:${col} WARN: ${msg}`);
      }
    }

    const result: string[] = [content];
    if (errors.length > 0) result.push('\n--- LSP Errors ---');
    for (const e of errors.slice(0, 10)) result.push(e);
    if (warnings.length > 0) result.push('\n--- LSP Warnings ---');
    for (const w of warnings.slice(0, 10)) result.push(w);
    if (errors.length > 10) result.push(`  ... and ${errors.length - 10} more errors`);
    if (warnings.length > 10) result.push(`  ... and ${warnings.length - 10} more warnings`);

    return result.join('\n');
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error('LSP not connected'));
        return;
      }
      const id = this.messageId++;
      this.pendingRequests.set(id, { resolve, reject });
      const msg: LSPMessage = { jsonrpc: '2.0', id, method, params };
      this.process.stdin.write(JSON.stringify(msg) + '\n');
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`LSP request ${method} timed out`));
        }
      }, 15000);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  private sendNotification(method: string, params: unknown): Promise<void> {
    if (!this.process?.stdin) return Promise.resolve();
    const msg: LSPMessage = { jsonrpc: '2.0', method, params };
    this.process.stdin.write(JSON.stringify(msg) + '\n');
    return Promise.resolve();
  }

  private handleMessage(line: string): void {
    try {
      const msg: LSPMessage = JSON.parse(line);
      if (msg.id !== undefined && this.pendingRequests.has(msg.id as number)) {
        const { resolve, reject } = this.pendingRequests.get(msg.id as number)!;
        this.pendingRequests.delete(msg.id as number);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
      if (msg.method === 'textDocument/publishDiagnostics') {
        const params = msg.params as LSPPublishDiagnosticsParams;
        const filePath = params.uri.replace('file://', '');
        // GAP-20: Bound diagnostics per file
        const diags = params.diagnostics.slice(0, this.MAX_DIAGNOSTICS_PER_FILE);
        // GAP-20: Evict oldest file entries when map grows too large
        if (!this.diagnostics.has(filePath) && this.diagnostics.size >= this.MAX_DIAGNOSTIC_FILES) {
          const oldest = this.diagnosticsInsertOrder.shift();
          if (oldest) {
            this.diagnostics.delete(oldest);
            this.diagnosticsFileSet.delete(oldest);
          }
        }
        this.diagnostics.set(filePath, diags);
        if (!this.diagnosticsFileSet.has(filePath)) {
          this.diagnosticsInsertOrder.push(filePath);
          this.diagnosticsFileSet.add(filePath);
        }
      }
    } catch (e) { getGlobalLogger().warn('LSP', 'Failed to handle message', { error: (e as Error)?.message }); }
  }

  openDocument(filePath: string, content?: string): void {
    const text = content ?? (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '');
    this.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: `file://${filePath}`,
        languageId: this.getLanguageId(filePath),
        version: 1,
        text,
      },
    }).catch(e => getGlobalLogger().debug('LSP', 'didOpen error', { error: (e as Error)?.message }));
  }

  private getLanguageId(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript',
      '.jsx': 'javascript', '.py': 'python', '.rs': 'rust', '.go': 'go',
      '.java': 'java', '.cpp': 'cpp', '.c': 'c', '.cs': 'csharp',
      '.rb': 'ruby', '.php': 'php', '.html': 'html', '.css': 'css',
      '.json': 'json', '.md': 'markdown', '.yaml': 'yaml', '.yml': 'yaml',
    };
    return map[ext] ?? 'plaintext';
  }
}

import { createTenantAwareSingleton } from './tenantAwareSingleton';

let _lspConfig: { command: string; args: string[]; workspaceRoot: string } | null = null;

const lspClientSingleton = createTenantAwareSingleton(() => {
  if (!_lspConfig) throw new Error('LSP not initialized. Call initLSP() first.');
  return new LSPClient(_lspConfig.command, _lspConfig.args, _lspConfig.workspaceRoot);
}, {
  dispose: (client) => client.disconnect(),
});

let globalLSPEnabled = false;

export function initLSP(serverCommand: string, serverArgs: string[], workspaceRoot?: string): Promise<void> {
  _lspConfig = { command: serverCommand, args: serverArgs, workspaceRoot: workspaceRoot ?? process.cwd() };
  lspClientSingleton.reset();
  const client = lspClientSingleton.get();
  return client.connect().then(() => { globalLSPEnabled = true; }).catch(e => { getGlobalLogger().debug('LSP', 'connect failed', { error: (e as Error)?.message }); return; });
}

function getLSPClient(): LSPClient | null {
  if (!_lspConfig) return null;
  try { return lspClientSingleton.get(); } catch { return null; }
}

export function disconnectLSP(): void {
  const client = getLSPClient();
  if (client) client.disconnect();
  lspClientSingleton.reset();
  globalLSPEnabled = false;
}

export function resetLSP(): void {
  const client = getLSPClient();
  if (client) client.disconnect();
  lspClientSingleton.reset();
  globalLSPEnabled = false;
}

export function isLSPReady(): boolean {
  const client = getLSPClient();
  return globalLSPEnabled && (client?.isReady ?? false);
}

export function attachDiagnostics(content: string, filePath: string): string {
  const client = getLSPClient();
  return client?.attachToContent(content, filePath) ?? content;
}

export function getFileDiagnostics(filePath: string): LSPDiagnostic[] {
  const client = getLSPClient();
  return client?.getFileDiagnostics(filePath) ?? [];
}

export function hasLSErrors(filePath: string): boolean {
  const client = getLSPClient();
  return client?.hasErrors(filePath) ?? false;
}

export function getLSErrorCount(filePath: string): { errors: number; warnings: number } {
  const client = getLSPClient();
  return client?.getErrorCount(filePath) ?? { errors: 0, warnings: 0 };
}

export function openLSEDocument(filePath: string, content?: string): void {
  getLSPClient()?.openDocument(filePath, content);
}

export class LSPDiagnosticsTool implements Tool {
  definition = {
    name: 'lsp_diagnostics',
    description: 'Get LSP diagnostics for a file. Returns type errors, lint warnings, and compiler errors from the language server.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the file' },
      },
      required: ['filePath'],
    },
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = String(args.filePath ?? '');
    if (!filePath) return 'Error: filePath is required';

    const diagnostics = getFileDiagnostics(filePath);
    if (diagnostics.length === 0) {
      return `No LSP diagnostics for "${filePath}"`;
    }

    const result: string[] = [`LSP Diagnostics for ${filePath}:`];
    for (const d of diagnostics) {
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const sev = d.severity === 1 ? 'ERROR' : d.severity === 2 ? 'WARNING' : 'INFO';
      const src = d.source ? `[${d.source}] ` : '';
      result.push(`  ${line}:${col} ${sev}: ${src}${d.message}`);
    }
    return result.join('\n');
  }
}

export class LSPAttachTool implements Tool {
  definition = {
    name: 'lsp_attach',
    description: 'Attach LSP diagnostics to file content. Returns file content with inline diagnostics annotations.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the file' },
      },
      required: ['filePath'],
    },
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = String(args.filePath ?? '');
    if (!filePath) return 'Error: filePath is required';
    if (!fs.existsSync(filePath)) return `Error: file not found: ${filePath}`;

    const content = fs.readFileSync(filePath, 'utf-8');
    const enriched = attachDiagnostics(content, filePath);
    return enriched;
  }
}
