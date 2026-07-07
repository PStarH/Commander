/**
 * LSP Manager — Manages LSP server lifecycle, caching, and multi-language support.
 *
 * Key responsibilities:
 * - Start/stop LSP servers on demand (lazy initialization)
 * - Keep track of open documents per server
 * - Cache diagnostics and other results
 * - Detect project root for a given file
 * - Graceful cleanup on shutdown
 *
 * Inspired by OhMyPi's LSP integration.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  LspClient,
  type LspDiagnostic,
  type LspLocation,
  type LspHover,
  type LspCodeAction,
  type LspTextEdit,
} from './lspClient';
import { findLspConfig, buildExtensionMap, type LspLanguageConfig } from './lspConfig';
import { reportSilentFailure } from '../silentFailureReporter';

// ============================================================================
// Types
// ============================================================================

export interface LspServerEntry {
  config: LspLanguageConfig;
  client: LspClient;
  rootUri: string;
  /** Set of open document URIs */
  openDocuments: Set<string>;
  /** Last activity timestamp */
  lastActivity: number;
}

export interface LspDiagnosticResult {
  uri: string;
  diagnostics: LspDiagnostic[];
  error?: string;
}

export interface LspDefinitionResult {
  uri: string;
  locations: LspLocation[];
  error?: string;
}

export interface LspReferencesResult {
  uri: string;
  locations: LspLocation[];
  error?: string;
}

export interface LspHoverResult {
  uri: string;
  hover: LspHover | null;
  error?: string;
}

export interface LspRenameResult {
  uri: string;
  success: boolean;
  editCount?: number;
  error?: string;
}

export interface LspCodeActionResult {
  uri: string;
  actions: LspCodeAction[];
  error?: string;
}

export interface LspFormatResult {
  uri: string;
  edits: LspTextEdit[];
  error?: string;
}

// ============================================================================
// LSP Manager
// ============================================================================

export class LspManager {
  /** Active servers, keyed by languageId */
  private servers = new Map<string, LspServerEntry>();
  /** Extension → language config map */
  private extensionMap = buildExtensionMap();
  /** Idle timeout for server cleanup (ms) */
  private idleTimeout: number;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(options?: { idleTimeout?: number }) {
    this.idleTimeout = options?.idleTimeout ?? 300000; // 5 minutes
  }

  // ========================================================================
  // Core: Ensure server is running for a file
  // ========================================================================

  /**
   * Ensure an LSP server is running for the given file.
   * Returns the server entry and the file URI.
   */
  async ensureServer(filePath: string): Promise<{
    entry: LspServerEntry;
    uri: string;
  } | null> {
    const config = findLspConfig(filePath, this.extensionMap);
    if (!config) return null;

    const rootUri = this.detectProjectRoot(filePath, config);
    const uri = `file://${path.resolve(filePath)}`;

    let entry = this.servers.get(config.languageId);

    if (entry && entry.rootUri !== rootUri) {
      // Different project root — stop old server
      await this.stopServer(config.languageId);
      entry = undefined;
    }

    if (!entry) {
      entry = (await this.startServer(config, rootUri)) ?? undefined;
      if (!entry) return null;
    }

    // Open document if not already open
    if (!entry.openDocuments.has(uri)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        await entry.client.openDocument(uri, config.languageId, content);
        entry.openDocuments.add(uri);
      } catch (err) {
        reportSilentFailure(err, 'lspManager:ensureServer:openDocument');
        // Continue — server might still work for diagnostics
      }
    }

    entry.lastActivity = Date.now();
    return { entry, uri };
  }

  /**
   * Notify the server that a file has been modified (e.g., after an edit).
   */
  async notifyChange(filePath: string, newContent?: string): Promise<void> {
    const config = findLspConfig(filePath, this.extensionMap);
    if (!config) return;

    const entry = this.servers.get(config.languageId);
    if (!entry) return;

    const uri = `file://${path.resolve(filePath)}`;
    if (!entry.openDocuments.has(uri)) return;

    try {
      const content = newContent ?? fs.readFileSync(filePath, 'utf-8');
      await entry.client.changeDocument(uri, content, Date.now());
      entry.lastActivity = Date.now();
    } catch (err) {
      reportSilentFailure(err, 'lspManager:notifyChange');
    }
  }

  // ========================================================================
  // LSP Operations
  // ========================================================================

  /**
   * Get diagnostics for a file.
   */
  async getDiagnostics(filePath: string): Promise<LspDiagnosticResult> {
    const ensured = await this.ensureServer(filePath);
    if (!ensured) {
      return {
        uri: `file://${filePath}`,
        diagnostics: [],
        error: 'No LSP server available for this file type',
      };
    }

    try {
      const diagnostics = await ensured.entry.client.getDiagnostics(ensured.uri);
      return { uri: ensured.uri, diagnostics };
    } catch (err) {
      return {
        uri: ensured.uri,
        diagnostics: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Go to definition at a position.
   */
  async goToDefinition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspDefinitionResult> {
    const ensured = await this.ensureServer(filePath);
    if (!ensured) {
      return { uri: `file://${filePath}`, locations: [], error: 'No LSP server available' };
    }

    try {
      const locations = await ensured.entry.client.goToDefinition(ensured.uri, line, character);
      return { uri: ensured.uri, locations };
    } catch (err) {
      return {
        uri: ensured.uri,
        locations: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Find references at a position.
   */
  async findReferences(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspReferencesResult> {
    const ensured = await this.ensureServer(filePath);
    if (!ensured) {
      return { uri: `file://${filePath}`, locations: [], error: 'No LSP server available' };
    }

    try {
      const locations = await ensured.entry.client.findReferences(ensured.uri, line, character);
      return { uri: ensured.uri, locations };
    } catch (err) {
      return {
        uri: ensured.uri,
        locations: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Get hover information at a position.
   */
  async hover(filePath: string, line: number, character: number): Promise<LspHoverResult> {
    const ensured = await this.ensureServer(filePath);
    if (!ensured) {
      return { uri: `file://${filePath}`, hover: null, error: 'No LSP server available' };
    }

    try {
      const hover = await ensured.entry.client.hover(ensured.uri, line, character);
      return { uri: ensured.uri, hover };
    } catch (err) {
      return {
        uri: ensured.uri,
        hover: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Rename a symbol at a position.
   */
  async rename(
    filePath: string,
    line: number,
    character: number,
    newName: string,
  ): Promise<LspRenameResult> {
    const ensured = await this.ensureServer(filePath);
    if (!ensured) {
      return { uri: `file://${filePath}`, success: false, error: 'No LSP server available' };
    }

    try {
      const edit = await ensured.entry.client.rename(ensured.uri, line, character, newName);
      if (!edit) {
        return {
          uri: ensured.uri,
          success: false,
          error: 'Rename not supported or no symbol at position',
        };
      }

      // Apply workspace edits
      let editCount = 0;
      if (edit.changes) {
        for (const [docUri, textEdits] of Object.entries(edit.changes)) {
          const docPath = docUri.replace('file://', '');
          try {
            let content = fs.readFileSync(docPath, 'utf-8');
            // Apply edits in reverse order to preserve positions
            const sorted = [...textEdits].sort((a, b) => {
              if (a.range.start.line !== b.range.start.line) {
                return b.range.start.line - a.range.start.line;
              }
              return b.range.start.character - a.range.start.character;
            });
            for (const te of sorted) {
              const lines = content.split('\n');
              const startOffset = this.positionToOffset(lines, te.range.start);
              const endOffset = this.positionToOffset(lines, te.range.end);
              content = content.slice(0, startOffset) + te.newText + content.slice(endOffset);
            }
            fs.writeFileSync(docPath, content, 'utf-8');
            editCount += textEdits.length;

            // Notify the LSP server of the change
            await this.notifyChange(docPath, content);
          } catch (err) {
            reportSilentFailure(err, 'lspManager:rename:applyEdit');
          }
        }
      }

      return { uri: ensured.uri, success: true, editCount };
    } catch (err) {
      return {
        uri: ensured.uri,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Get code actions for a range.
   */
  async getCodeActions(
    filePath: string,
    startLine: number,
    startChar: number,
    endLine: number,
    endChar: number,
  ): Promise<LspCodeActionResult> {
    const ensured = await this.ensureServer(filePath);
    if (!ensured) {
      return { uri: `file://${filePath}`, actions: [], error: 'No LSP server available' };
    }

    try {
      const actions = await ensured.entry.client.getCodeActions(ensured.uri, {
        start: { line: startLine, character: startChar },
        end: { line: endLine, character: endChar },
      });
      return { uri: ensured.uri, actions };
    } catch (err) {
      return {
        uri: ensured.uri,
        actions: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Format a document.
   */
  async formatDocument(filePath: string): Promise<LspFormatResult> {
    const ensured = await this.ensureServer(filePath);
    if (!ensured) {
      return { uri: `file://${filePath}`, edits: [], error: 'No LSP server available' };
    }

    try {
      const edits = await ensured.entry.client.formatDocument(ensured.uri);
      if (!edits || edits.length === 0) {
        return { uri: ensured.uri, edits: [] };
      }

      // Apply formatting edits
      let content = fs.readFileSync(filePath, 'utf-8');
      const sorted = [...edits].sort((a, b) => {
        if (a.range.start.line !== b.range.start.line) {
          return b.range.start.line - a.range.start.line;
        }
        return b.range.start.character - a.range.start.character;
      });

      for (const edit of sorted) {
        const lines = content.split('\n');
        const startOffset = this.positionToOffset(lines, edit.range.start);
        const endOffset = this.positionToOffset(lines, edit.range.end);
        content = content.slice(0, startOffset) + edit.newText + content.slice(endOffset);
      }

      fs.writeFileSync(filePath, content, 'utf-8');
      await this.notifyChange(filePath, content);

      return { uri: ensured.uri, edits };
    } catch (err) {
      return {
        uri: ensured.uri,
        edits: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ========================================================================
  // Server Lifecycle
  // ========================================================================

  private async startServer(
    config: LspLanguageConfig,
    rootUri: string,
  ): Promise<LspServerEntry | null> {
    // Check if command is available
    try {
      const result = execSync(`which ${config.command}`, { encoding: 'utf-8' }).trim();
      if (!result) {
        // Command not found
        return null;
      }
    } catch {
      return null;
    }

    const client = new LspClient({ requestTimeout: 15000 });

    try {
      await client.start(config.command, config.args ?? [], {
        cwd: rootUri,
        env: config.env,
      });

      const entry: LspServerEntry = {
        config,
        client,
        rootUri: `file://${rootUri}`,
        openDocuments: new Set(),
        lastActivity: Date.now(),
      };

      this.servers.set(config.languageId, entry);

      // Start cleanup timer if not already running
      if (!this.cleanupTimer) {
        this.cleanupTimer = setInterval(() => this.cleanupIdleServers(), 60000);
      }

      return entry;
    } catch (err) {
      reportSilentFailure(err, 'lspManager:startServer');
      try {
        await client.stop();
      } catch {
        /* ignore */
      }
      return null;
    }
  }

  private async stopServer(languageId: string): Promise<void> {
    const entry = this.servers.get(languageId);
    if (!entry) return;

    await entry.client.stop();
    this.servers.delete(languageId);
  }

  /**
   * Stop all servers and cleanup.
   */
  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    const promises = Array.from(this.servers.keys()).map((id) => this.stopServer(id));
    await Promise.allSettled(promises);
  }

  private cleanupIdleServers(): void {
    const now = Date.now();
    for (const [languageId, entry] of this.servers) {
      if (now - entry.lastActivity > this.idleTimeout) {
        this.stopServer(languageId);
      }
    }

    if (this.servers.size === 0 && this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  /**
   * Detect the project root for a file by looking for root pattern files.
   */
  detectProjectRoot(filePath: string, config: LspLanguageConfig): string {
    if (!config.rootPatterns || config.rootPatterns.length === 0) {
      return path.dirname(path.resolve(filePath));
    }

    let dir = path.dirname(path.resolve(filePath));
    while (dir !== path.dirname(dir)) {
      // Check for root patterns
      for (const pattern of config.rootPatterns) {
        if (pattern.includes('*')) {
          // Glob patterns — check with simple glob
          try {
            const entries = fs.readdirSync(dir);
            const globPattern = pattern.replace(/\*/g, '');
            if (entries.some((e) => e.endsWith(globPattern))) {
              return dir;
            }
          } catch {
            // Ignore read errors
          }
        } else {
          if (fs.existsSync(path.join(dir, pattern))) {
            return dir;
          }
        }
      }
      dir = path.dirname(dir);
    }

    return path.dirname(path.resolve(filePath));
  }

  /**
   * Convert an LSP position (line, character) to a byte offset in the content.
   */
  private positionToOffset(lines: string[], pos: { line: number; character: number }): number {
    let offset = 0;
    for (let i = 0; i < pos.line && i < lines.length; i++) {
      offset += lines[i].length + 1; // +1 for newline
    }
    offset += Math.min(pos.character, lines[pos.line]?.length ?? 0);
    return offset;
  }

  /**
   * Get the list of active servers and their status.
   */
  getStatus(): Array<{
    languageId: string;
    serverName: string;
    rootUri: string;
    openDocuments: number;
    uptime: number;
  }> {
    const now = Date.now();
    return Array.from(this.servers.entries()).map(([id, entry]) => ({
      languageId: id,
      serverName: entry.config.command,
      rootUri: entry.rootUri,
      openDocuments: entry.openDocuments.size,
      uptime: now - entry.lastActivity,
    }));
  }
}

// ============================================================================
// Global Singleton
// ============================================================================

let globalLspManager: LspManager | null = null;

export function getLspManager(): LspManager {
  if (!globalLspManager) {
    globalLspManager = new LspManager();
  }
  return globalLspManager;
}

export function resetLspManager(): void {
  if (globalLspManager) {
    globalLspManager.shutdown();
  }
  globalLspManager = null;
}
