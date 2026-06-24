/**
 * ToolOutputStore — offloads large tool outputs to managed files.
 *
 * Mirrors OpenCode's tool-output-store.ts pattern:
 * - Large tool outputs (> maxLines or > maxBytes) are written to managed files
 * - Only a bounded preview (head/tail sampling) is returned to the model
 * - Configurable retention with periodic cleanup
 *
 * This prevents huge tool outputs from consuming the entire context window.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { getGlobalLogger } from '../logging';

export interface ToolOutputEntry {
  toolCallId: string;
  toolName: string;
  /** Path to the managed output file */
  filePath: string;
  /** Original output size in bytes */
  originalSize: number;
  /** Preview returned to the model */
  preview: string;
  /** Timestamp when the output was stored */
  storedAt: number;
  /** Retention deadline (ms) */
  expiresAt: number;
}

export interface ToolOutputStoreConfig {
  /** Max lines before offloading (default: 2000) */
  maxLines: number;
  /** Max bytes before offloading (default: 50KB) */
  maxBytes: number;
  /** Preview head lines (default: 50) */
  previewHeadLines: number;
  /** Preview tail lines (default: 50) */
  previewTailLines: number;
  /** Retention in ms (default: 7 days) */
  retentionMs: number;
  /** Directory for managed output files */
  outputDir: string;
}

const DEFAULT_CONFIG: ToolOutputStoreConfig = {
  maxLines: 2000,
  maxBytes: 50_000,
  previewHeadLines: 50,
  previewTailLines: 50,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  outputDir: path.join(process.env.COMMANDER_DATA_DIR || '/tmp/commander', 'tool-output'),
};

export class ToolOutputStore {
  private config: ToolOutputStoreConfig;
  private entries: Map<string, ToolOutputEntry> = new Map();

  constructor(config?: Partial<ToolOutputStoreConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureDir();
  }

  /**
   * Check if output should be offloaded, and if so, store it and return preview.
   * If output is small enough, return it as-is.
   */
  async process(toolCallId: string, toolName: string, output: string): Promise<string> {
    const lines = output.split('\n');
    const bytes = Buffer.byteLength(output, 'utf8');

    if (lines.length <= this.config.maxLines && bytes <= this.config.maxBytes) {
      return output;
    }

    const preview = this.buildPreview(output);
    const filePath = path.join(this.config.outputDir, `${toolCallId}.txt`);
    const now = Date.now();

    try {
      await fsp.writeFile(filePath, output, 'utf-8');
    } catch (err) {
      getGlobalLogger().warn('ToolOutputStore', 'Failed to write output file', {
        error: (err as Error)?.message,
      });
      // Fail open — return truncated output rather than losing it
      return preview;
    }

    const entry: ToolOutputEntry = {
      toolCallId,
      toolName,
      filePath,
      originalSize: bytes,
      preview,
      storedAt: now,
      expiresAt: now + this.config.retentionMs,
    };

    this.entries.set(toolCallId, entry);
    return preview;
  }

  /**
   * Get the full output for a previously stored tool call.
   */
  async getFullOutput(toolCallId: string): Promise<string | null> {
    const entry = this.entries.get(toolCallId);
    if (!entry) return null;

    try {
      return await fsp.readFile(entry.filePath, 'utf-8');
    } catch (err) {
      reportSilentFailure(err, 'toolOutputStore:114');
      return null;
    }
  }

  /**
   * Clean up expired entries.
   */
  async cleanup(): Promise<number> {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, entry] of this.entries) {
      if (now > entry.expiresAt) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      const entry = this.entries.get(id);
      if (entry) {
        try {
          await fsp.unlink(entry.filePath);
        } catch (err) {
          reportSilentFailure(err, 'toolOutputStore:138');
        }
        this.entries.delete(id);
      }
    }

    if (toDelete.length > 0) {
      getGlobalLogger().info('ToolOutputStore', `Cleaned up ${toDelete.length} expired entries`);
    }

    return toDelete.length;
  }

  /**
   * Get stats about the store.
   */
  getStats(): { entries: number; totalBytes: number } {
    let totalBytes = 0;
    for (const entry of this.entries.values()) {
      totalBytes += entry.originalSize;
    }
    return { entries: this.entries.size, totalBytes };
  }

  private buildPreview(output: string): string {
    const lines = output.split('\n');
    const head = lines.slice(0, this.config.previewHeadLines).join('\n');
    const tail = lines.slice(-this.config.previewTailLines).join('\n');

    if (lines.length <= this.config.previewHeadLines + this.config.previewTailLines) {
      return output;
    }

    return `${head}\n\n... [${lines.length - this.config.previewHeadLines - this.config.previewTailLines} lines omitted] ...\n\n${tail}`;
  }

  private async ensureDir(): Promise<void> {
    try {
      await fsp.mkdir(this.config.outputDir, { recursive: true });
    } catch (err) {
      reportSilentFailure(err, 'toolOutputStore:178');
    }
  }
}
