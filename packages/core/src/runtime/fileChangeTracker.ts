/**
 * FileChangeTracker — Records all file mutations made by agents during a run.
 *
 * Storage layout:
 *   .commander_changes/
 *   ├── changes.ndjson         # Append-only audit log
 *   ├── snapshots/             # Content snapshots for restore
 *   │   └── {runId}/
 *   │       └── {pathHash}.before
 *   └── summary/
 *       └── {runId}.json       # Per-run summary (file count, total bytes)
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from '../logging';

export type FileChangeOperation = 'create' | 'modify' | 'delete' | 'rename' | 'append';

export interface FileChangeRecord {
  id: string;
  runId: string;
  agentId: string;
  toolName: string;
  stepNumber: number;
  operation: FileChangeOperation;
  path: string;
  contentHash: string;
  sizeBytes: number;
  linesAdded: number;
  linesRemoved: number;
  diff?: string;
  fromPath?: string;
  timestamp: string;
  snapshotPath?: string;
}

export interface FileChangeQuery {
  runId?: string;
  agentId?: string;
  path?: string;
  toolName?: string;
  operation?: FileChangeOperation;
  since?: string;
  until?: string;
  limit?: number;
}

export interface FileChangeSummary {
  runId: string;
  totalChanges: number;
  filesCreated: number;
  filesModified: number;
  filesDeleted: number;
  filesRenamed: number;
  totalBytesAdded: number;
  totalBytesRemoved: number;
  uniquePaths: string[];
  firstChangeAt: string;
  lastChangeAt: string;
}

export interface FileChangeTrackerConfig {
  maxDiffBytes: number;
  maxDiffLines: number;
  enableSnapshots: boolean;
  maxFileBytes: number;
  maxRotatedFiles: number;
  maxSnapshotsPerRun: number;
}

const DEFAULT_CONFIG: FileChangeTrackerConfig = {
  maxDiffBytes: 8 * 192,
  maxDiffLines: 200,
  enableSnapshots: true,
  maxFileBytes: 50 * 1024 * 1024,
  maxRotatedFiles: 3,
  maxSnapshotsPerRun: 500,
};

function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function pathHash(filePath: string): string {
  return crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
}

/**
 * Compute a lightweight unified diff between two strings. Returns null when
 * the strings are equal. We use a simple line-by-line comparison — Myers'
 * algorithm is overkill for human-readable audit display.
 */
export function computeUnifiedDiff(
  before: string,
  after: string,
  contextLines: number = 3,
  maxLines: number = 200,
): string | null {
  if (before === after) return null;

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  const out: string[] = [];
  let added = 0;
  let removed = 0;

  const limit = Math.min(maxLines, Math.max(beforeLines.length, afterLines.length));
  for (let i = 0; i < limit; i++) {
    const a = beforeLines[i];
    const b = afterLines[i];
    if (a === undefined && b !== undefined) {
      out.push(`+ ${b}`);
      added++;
    } else if (b === undefined && a !== undefined) {
      out.push(`- ${a}`);
      removed++;
    } else if (a !== b) {
      if (a !== undefined) {
        out.push(`- ${a}`);
        removed++;
      }
      if (b !== undefined) {
        out.push(`+ ${b}`);
        added++;
      }
    } else if (a !== undefined && i < contextLines) {
      out.push(`  ${a}`);
    }
  }

  if (added === 0 && removed === 0) return null;

  const header = `--- before\n+++ after\n@@ -1 +1 @@`;
  const summary = `\n[diff truncated: ${added} added, ${removed} removed]`;
  return [header, ...out, summary].join('\n');
}

export class FileChangeTracker {
  private baseDir: string;
  private snapshotsDir: string;
  private summaryDir: string;
  private tenantId?: string;
  private config: FileChangeTrackerConfig;
  private writeQueue: Array<() => Promise<void>> = [];
  private flushing = false;
  private snapshotCounters: Map<string, number> = new Map();

  constructor(baseDir?: string, tenantId?: string, config?: Partial<FileChangeTrackerConfig>) {
    this.tenantId = tenantId;
    this.config = { ...DEFAULT_CONFIG, ...config };
    const base = baseDir ?? path.join(process.cwd(), '.commander_changes');
    this.baseDir = tenantId ? path.join(base, `tenant_${tenantId}`) : base;
    this.snapshotsDir = path.join(this.baseDir, 'snapshots');
    this.summaryDir = path.join(this.baseDir, 'summary');
    this.ensureDir();
  }

  async recordChange(params: {
    runId: string;
    agentId: string;
    toolName: string;
    stepNumber: number;
    operation: FileChangeOperation;
    filePath: string;
    beforeContent?: string | null;
    afterContent?: string | null;
    fromPath?: string;
  }): Promise<string> {
    const id = `chg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timestamp = new Date().toISOString();

    const before = params.beforeContent ?? '';
    const after = params.afterContent ?? '';
    const op = params.operation;

    let contentHash = '';
    let sizeBytes = 0;
    if (op !== 'delete' && after.length > 0) {
      contentHash = sha256(after);
      sizeBytes = Buffer.byteLength(after, 'utf-8');
    }

    let diff: string | undefined;
    let linesAdded = 0;
    let linesRemoved = 0;

    if (op === 'create' || op === 'modify' || op === 'append') {
      const d = computeUnifiedDiff(before, after, 3, this.config.maxDiffLines);
      if (d) {
        diff =
          d.length > this.config.maxDiffBytes
            ? d.slice(0, this.config.maxDiffBytes) + '\n[diff truncated for storage]'
            : d;
        for (const line of d.split('\n')) {
          if (line.startsWith('+ ') && !line.startsWith('+++')) linesAdded++;
          else if (line.startsWith('- ') && !line.startsWith('---')) linesRemoved++;
        }
      }
    } else if (op === 'delete') {
      linesRemoved = before.split('\n').length;
    }

    let snapshotPath: string | undefined;
    if (
      this.config.enableSnapshots &&
      (op === 'modify' || op === 'delete' || op === 'create') &&
      before.length > 0
    ) {
      const runSnapDir = path.join(this.snapshotsDir, params.runId);
      const counter = this.snapshotCounters.get(params.runId) ?? 0;
      if (counter < this.config.maxSnapshotsPerRun) {
        try {
          fs.mkdirSync(runSnapDir, { recursive: true, mode: 0o700 });
          const fileName = `${pathHash(params.filePath)}.${counter}.before`;
          const fullPath = path.join(runSnapDir, fileName);
          fs.writeFileSync(fullPath, before, { encoding: 'utf-8', mode: 0o600 });
          snapshotPath = path.relative(this.baseDir, fullPath);
          this.snapshotCounters.set(params.runId, counter + 1);
        } catch (e) {
          getGlobalLogger().warn('FileChangeTracker', 'Failed to write snapshot', {
            error: (e as Error)?.message,
            filePath: params.filePath,
          });
        }
      }
    }

    const record: FileChangeRecord = {
      id,
      runId: params.runId,
      agentId: params.agentId,
      toolName: params.toolName,
      stepNumber: params.stepNumber,
      operation: op,
      path: params.filePath,
      contentHash,
      sizeBytes,
      linesAdded,
      linesRemoved,
      diff,
      fromPath: params.fromPath,
      timestamp,
      snapshotPath,
    };

    this.enqueueWrite(() => this.appendLine(record));
    return id;
  }

  query(filter: FileChangeQuery = {}): FileChangeRecord[] {
    const all = this.readAllRecords();
    const filtered = all.filter((r) => {
      if (filter.runId && r.runId !== filter.runId) return false;
      if (filter.agentId && r.agentId !== filter.agentId) return false;
      if (filter.path && r.path !== filter.path) return false;
      if (filter.toolName && r.toolName !== filter.toolName) return false;
      if (filter.operation && r.operation !== filter.operation) return false;
      if (filter.since && r.timestamp < filter.since) return false;
      if (filter.until && r.timestamp > filter.until) return false;
      return true;
    });
    if (filter.limit && filter.limit > 0) {
      return filtered.slice(-filter.limit);
    }
    return filtered;
  }

  getRunChanges(runId: string): FileChangeRecord[] {
    return this.query({ runId }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  summarize(runId: string): FileChangeSummary {
    const records = this.getRunChanges(runId);
    const uniquePaths = new Set<string>();
    let filesCreated = 0;
    let filesModified = 0;
    let filesDeleted = 0;
    let filesRenamed = 0;
    let totalBytesAdded = 0;
    let totalBytesRemoved = 0;

    for (const r of records) {
      uniquePaths.add(r.path);
      if (r.operation === 'create') filesCreated++;
      else if (r.operation === 'modify' || r.operation === 'append') filesModified++;
      else if (r.operation === 'delete') filesDeleted++;
      else if (r.operation === 'rename') filesRenamed++;
      totalBytesAdded += r.sizeBytes;
      totalBytesRemoved += r.linesRemoved * 50;
    }

    return {
      runId,
      totalChanges: records.length,
      filesCreated,
      filesModified,
      filesDeleted,
      filesRenamed,
      totalBytesAdded,
      totalBytesRemoved,
      uniquePaths: Array.from(uniquePaths),
      firstChangeAt: records[0]?.timestamp ?? '',
      lastChangeAt: records[records.length - 1]?.timestamp ?? '',
    };
  }

  restoreFromSnapshot(recordId: string): { restored: boolean; path?: string; reason?: string } {
    const record = this.readAllRecords().find((r) => r.id === recordId);
    if (!record) return { restored: false, reason: 'record_not_found' };
    if (!record.snapshotPath) return { restored: false, reason: 'no_snapshot' };

    const fullSnapshotPath = path.join(this.baseDir, record.snapshotPath);
    if (!fs.existsSync(fullSnapshotPath)) {
      return { restored: false, reason: 'snapshot_file_missing' };
    }

    try {
      const content = fs.readFileSync(fullSnapshotPath, 'utf-8');
      fs.mkdirSync(path.dirname(record.path), { recursive: true });
      fs.writeFileSync(record.path, content, 'utf-8');
      return { restored: true, path: record.path };
    } catch (e) {
      return {
        restored: false,
        reason: `io_error: ${(e as Error)?.message ?? 'unknown'}`,
      };
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      let idx = 0;
      while (idx < this.writeQueue.length) {
        const task = this.writeQueue[idx++];
        if (task) await task();
      }
    } finally {
      this.writeQueue.length = 0;
      this.flushing = false;
    }
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  getRecordCount(): number {
    return this.readAllLines().length;
  }

  private ensureDir(): void {
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.snapshotsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.summaryDir, { recursive: true, mode: 0o700 });
  }

  private enqueueWrite(task: () => Promise<void>): void {
    this.writeQueue.push(task);
    if (!this.flushing) {
      this.flushing = true;
      this.drainQueue();
    }
  }

  private async drainQueue(): Promise<void> {
    try {
      let idx = 0;
      while (idx < this.writeQueue.length) {
        const task = this.writeQueue[idx++];
        if (task) await task();
      }
      this.writeQueue.length = 0;
    } finally {
      this.flushing = false;
      if (this.writeQueue.length > 0) {
        this.flushing = true;
        this.drainQueue();
      }
    }
  }

  private async appendLine(record: FileChangeRecord): Promise<void> {
    const filePath = path.join(this.baseDir, 'changes.ndjson');
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.size >= this.config.maxFileBytes) {
          this.rotateFile();
        }
      }
    } catch (e) {
      getGlobalLogger().warn('FileChangeTracker', 'Failed to inspect changes file before append', {
        error: (e as Error)?.message,
      });
    }
    const line = JSON.stringify(record) + '\n';
    try {
      fs.appendFileSync(filePath, line, 'utf-8');
    } catch (e) {
      getGlobalLogger().warn('FileChangeTracker', 'Failed to append change record', {
        error: (e as Error)?.message,
        recordId: record.id,
      });
    }
  }

  private rotateFile(): void {
    const dir = this.baseDir;
    const base = path.join(dir, 'changes.ndjson');
    const oldest = `${base}.${this.config.maxRotatedFiles}`;
    if (fs.existsSync(oldest)) {
      try {
        fs.unlinkSync(oldest);
      } catch (e) {
        getGlobalLogger().warn('FileChangeTracker', 'Failed to delete oldest rotated file', {
          error: (e as Error)?.message,
        });
      }
    }
    for (let i = this.config.maxRotatedFiles - 1; i >= 1; i--) {
      const from = `${base}.${i}`;
      const to = `${base}.${i + 1}`;
      if (fs.existsSync(from)) {
        try {
          fs.renameSync(from, to);
        } catch (e) {
          getGlobalLogger().warn('FileChangeTracker', 'Failed to rotate file', {
            error: (e as Error)?.message,
            from,
            to,
          });
        }
      }
    }
    if (fs.existsSync(base)) {
      try {
        fs.renameSync(base, `${base}.1`);
      } catch (e) {
        getGlobalLogger().warn('FileChangeTracker', 'Failed to rotate current file', {
          error: (e as Error)?.message,
        });
      }
    }
  }

  private readAllLines(): string[] {
    const files = ['changes.ndjson'];
    for (let i = 1; i <= this.config.maxRotatedFiles; i++) {
      files.push(`changes.ndjson.${i}`);
    }
    const allLines: string[] = [];
    for (const name of files) {
      const p = path.join(this.baseDir, name);
      if (!fs.existsSync(p)) continue;
      try {
        const content = fs.readFileSync(p, 'utf-8').trim();
        if (!content) continue;
        for (const line of content.split('\n')) {
          if (line.length > 0) allLines.push(line);
        }
      } catch (e) {
        getGlobalLogger().warn('FileChangeTracker', 'Failed to read changes file', {
          error: (e as Error)?.message,
          name,
        });
      }
    }
    return allLines;
  }

  private readAllRecords(): FileChangeRecord[] {
    const records: FileChangeRecord[] = [];
    for (const line of this.readAllLines()) {
      try {
        records.push(JSON.parse(line) as FileChangeRecord);
      } catch (e) {
        getGlobalLogger().debug('FileChangeTracker', 'Skipped corrupt line', {
          error: (e as Error)?.message,
        });
      }
    }
    return records;
  }
}

import { createTenantAwareSingleton } from './tenantAwareSingleton';

const fileChangeTrackerSingleton = createTenantAwareSingleton(() => new FileChangeTracker());

export function getFileChangeTracker(): FileChangeTracker {
  return fileChangeTrackerSingleton.get();
}

export function resetFileChangeTracker(): void {
  fileChangeTrackerSingleton.reset();
}

import type { CommanderPlugin, AfterToolCallContext } from '../pluginManager';

/**
 * Create a plugin that automatically records file changes via the
 * FileChangeTracker. Wire it up with:
 *   getHookManager().register(createFileChangeTrackingPlugin());
 *
 * Tracks changes from: file_write, file_edit, apply_patch, code_fixer,
 * refine_code. Other tools pass through unchanged.
 */
export function createFileChangeTrackingPlugin(options?: {
  onRecorded?: (record: FileChangeRecord) => void;
}): CommanderPlugin {
  const trackedTools = new Set([
    'file_write',
    'file_edit',
    'apply_patch',
    'code_fixer',
    'refine_code',
  ]);

  return {
    name: 'builtin-file-change-tracker',
    version: '0.1.0',
    description: 'Automatically tracks file mutations and persists a per-run audit trail.',
    configSchema: {
      type: 'object',
      properties: {
        trackShellCommands: { type: 'boolean', default: false },
        maxDiffBytes: { type: 'number', default: 8192 },
      },
    },
    onLoad: (ctx) => {
      getGlobalLogger().info(
        'FileChangeTracker',
        `Loaded (trackShellCommands=${ctx.config.trackShellCommands ?? false})`,
      );
    },
    afterToolCall: async (hookCtx: AfterToolCallContext) => {
      if (!trackedTools.has(hookCtx.toolName)) return hookCtx.result;
      if (hookCtx.result.error) return hookCtx.result;
      const args = hookCtx.args as Record<string, unknown>;
      const filePath =
        typeof args.path === 'string'
          ? args.path
          : typeof args.file === 'string'
            ? args.file
            : null;
      if (!filePath) return hookCtx.result;

      const tracker = getFileChangeTracker();
      let afterContent: string | null = null;
      try {
        afterContent = fs.readFileSync(filePath, 'utf-8');
      } catch (err) {
        reportSilentFailure(err, 'fileChangeTracker:558');
        return hookCtx.result;
      }

      try {
        const recordId = await tracker.recordChange({
          runId: hookCtx.runId,
          agentId: hookCtx.agentId,
          toolName: hookCtx.toolName,
          stepNumber: 0,
          operation: 'modify',
          filePath,
          beforeContent: '',
          afterContent,
        });
        if (options?.onRecorded) {
          options.onRecorded({ id: recordId } as FileChangeRecord);
        }
      } catch (e) {
        getGlobalLogger().warn('FileChangeTracker', 'Failed to record change', {
          error: (e as Error)?.message,
          toolName: hookCtx.toolName,
        });
      }

      return hookCtx.result;
    },
  };
}
