/**
 * MemoryWriteGuard — enforces strict path policies for memory file writes.
 *
 * Mirrors MiMo-Code's memory-path-guard.ts pattern:
 * - Different agents have different allowed write paths
 * - Checkpoint-writer is confined to a precise allowlist
 * - Main agent can only write to MEMORY.md and notes.md (not checkpoint.md or tasks/*)
 * - Subagents bound to a task_id may write anywhere under tasks/<TID>/*
 */

import * as path from 'path';

export interface MemoryWriteContext {
  agentType: 'main' | 'checkpoint-writer' | 'subagent';
  sessionId: string;
  taskId?: string;
}

export interface MemoryWriteResult {
  allowed: boolean;
  reason: string;
  canonicalPath?: string;
}

export class MemoryWriteGuard {
  private dataRoot: string;

  constructor(dataRoot?: string) {
    this.dataRoot =
      dataRoot || path.join(process.env.COMMANDER_DATA_DIR || '/tmp/commander', 'memory');
  }

  /**
   * Assert that a memory write is allowed for the given context.
   * Returns the canonical path if allowed, or throws/rejects if not.
   */
  assertWriteAllowed(targetPath: string, ctx: MemoryWriteContext): MemoryWriteResult {
    const resolved = this.resolveCanonicalPath(targetPath, ctx.sessionId);

    switch (ctx.agentType) {
      case 'checkpoint-writer': {
        // Checkpoint-writer: must write to exact allowlist
        const allowed = this.isCheckpointWriterPath(resolved, ctx.sessionId, ctx.taskId);
        if (!allowed) {
          return {
            allowed: false,
            reason: `Checkpoint-writer can only write to: <pid>/MEMORY.md, <sid>/checkpoint.md, <sid>/notes.md, <sid>/tasks/<TID>/*.md`,
            canonicalPath: resolved,
          };
        }
        return { allowed: true, reason: 'Checkpoint-writer path allowed', canonicalPath: resolved };
      }

      case 'subagent': {
        // Subagent: cannot write <sid>/tasks/* unless bound to that task
        if (this.isTasksPath(resolved, ctx.sessionId) && !ctx.taskId) {
          return {
            allowed: false,
            reason: 'Subagent cannot write to tasks/ unless bound to a task_id',
            canonicalPath: resolved,
          };
        }
        if (ctx.taskId && !resolved.includes(`tasks/${ctx.taskId}/`)) {
          return {
            allowed: false,
            reason: `Subagent bound to task ${ctx.taskId} can only write under tasks/${ctx.taskId}/`,
            canonicalPath: resolved,
          };
        }
        return { allowed: true, reason: 'Subagent path allowed', canonicalPath: resolved };
      }

      case 'main':
      default: {
        // Main agent: cannot write checkpoint.md or tasks/*
        if (this.isCheckpointPath(resolved, ctx.sessionId)) {
          return {
            allowed: false,
            reason: 'Main agent cannot write to checkpoint.md — use checkpoint service instead',
            canonicalPath: resolved,
          };
        }
        if (this.isTasksPath(resolved, ctx.sessionId)) {
          return {
            allowed: false,
            reason: 'Main agent cannot write to tasks/* — reserved for subagents',
            canonicalPath: resolved,
          };
        }
        return { allowed: true, reason: 'Main agent path allowed', canonicalPath: resolved };
      }
    }
  }

  private resolveCanonicalPath(targetPath: string, sessionId: string): string {
    // Normalize to absolute path under data root
    const normalized = path.normalize(targetPath);
    if (normalized.startsWith(this.dataRoot)) {
      return normalized;
    }
    // If relative, resolve under session dir
    if (!path.isAbsolute(normalized)) {
      return path.join(this.dataRoot, sessionId, normalized);
    }
    return normalized;
  }

  private isCheckpointWriterPath(resolved: string, sessionId: string, taskId?: string): boolean {
    // Allow: <sessionId>/MEMORY.md, <sessionId>/memory-<topic>.md, <sessionId>/checkpoint.md, <sessionId>/notes.md, <sessionId>/tasks/<TID>/*.md
    const sessionDir = path.join(this.dataRoot, sessionId);
    if (!resolved.startsWith(sessionDir + path.sep)) return false;

    const relative = path.relative(sessionDir, resolved);
    const parts = relative.split(path.sep);

    // Top-level allowed files
    if (parts.length === 1) {
      const file = parts[0];
      if (file === 'MEMORY.md' || file === 'checkpoint.md' || file === 'notes.md') return true;
      if (file.startsWith('memory-') && file.endsWith('.md')) return true;
      return false;
    }

    // tasks/<TID>/*.md
    if (parts[0] === 'tasks' && parts.length >= 3 && parts[parts.length - 1].endsWith('.md')) {
      if (!taskId) return false;
      return parts[1] === taskId;
    }

    return false;
  }

  private isCheckpointPath(resolved: string, sessionId: string): boolean {
    const sessionDir = path.join(this.dataRoot, sessionId);
    const relative = path.relative(sessionDir, resolved);
    return relative === 'checkpoint.md' || relative.startsWith('checkpoint' + path.sep);
  }

  private isTasksPath(resolved: string, sessionId: string): boolean {
    const sessionDir = path.join(this.dataRoot, sessionId);
    const relative = path.relative(sessionDir, resolved);
    return relative.startsWith('tasks' + path.sep);
  }
}
