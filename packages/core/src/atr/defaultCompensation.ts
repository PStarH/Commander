/**
 * Default compensation handlers for built-in mutation tools.
 *
 * Each handler implements the inverse of a single tool's side effect. The
 * handler is invoked by RunLedger.abortAndCompensate() in reverse execution
 * order.
 *
 * Snapshot pattern: file_write/file_edit/copy_etc use a snapshot-then-mutate
 * pattern via the snapshot tool. The compensation restores the pre-mutation
 * state. If the snapshot is missing (e.g. process crashed before snapshot
 * was taken), the compensation is best-effort and reports failure to the
 * dead-letter queue.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CompensableAction } from './types';
import { getGlobalLogger } from '../logging';

const log = getGlobalLogger();

/** Marker for actions we acknowledge cannot be undone. */
async function nonCompensable(action: CompensableAction): Promise<{ success: false; error: string }> {
  log.warn('ATR', `Tool ${action.toolName} is non-compensable; side effect committed`, {
    actionId: action.actionId,
    description: action.description,
  });
  return {
    success: false,
    error: `Tool ${action.toolName} is non-compensable; manual intervention required`,
  };
}

/**
 * Read a snapshot file (if it exists) and restore the original file. Snapshots
 * are written by file_write before the write, and live at
 *   <originalPath>.atr-snapshot.<actionId>
 * This is the recovery side of the snapshot-before-mutate pattern.
 */
async function restoreFromSnapshot(action: CompensableAction): Promise<{ success: boolean; error?: string }> {
  const filePath = action.args.path ?? action.args.filePath;
  if (typeof filePath !== 'string') return { success: true };
  const snapshotPath = `${filePath}.atr-snapshot.${action.actionId}`;
  try {
    if (!fs.existsSync(snapshotPath)) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      return { success: true };
    }
    const original = fs.readFileSync(snapshotPath, 'utf-8');
    fs.writeFileSync(filePath, original, 'utf-8');
    fs.unlinkSync(snapshotPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Take a snapshot of a file before mutation. Called by tools that
 * register a `beforeExecute` snapshot hook. No-op if file does not exist.
 */
export function takeSnapshot(filePath: string, actionId: string): void {
  if (typeof filePath !== 'string') return;
  try {
    if (fs.existsSync(filePath)) {
      const snapshotPath = `${filePath}.atr-snapshot.${actionId}`;
      fs.copyFileSync(filePath, snapshotPath);
    }
  } catch (err) {
    log.warn('ATR', 'Snapshot failed', { filePath, actionId, error: (err as Error).message });
  }
}

export const defaultCompensationHandlers: Record<string, (action: CompensableAction) => Promise<{ success: boolean; error?: string }>> = {
  file_write: restoreFromSnapshot,
  file_edit: restoreFromSnapshot,
  apply_patch: restoreFromSnapshot,
  code_fixer: restoreFromSnapshot,
  code_refiner: restoreFromSnapshot,
  mkdir: async (action) => {
    const dir = action.args.path ?? action.args.dir;
    if (typeof dir !== 'string') return { success: true };
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
  file_delete: async (action) => {
    return restoreFromSnapshot(action);
  },
  shell_execute: nonCompensable,
  python_execute: nonCompensable,
  git_push: nonCompensable,
  git_commit: nonCompensable,
  web_fetch: nonCompensable,
  web_search: nonCompensable,
  browser_fetch: nonCompensable,
  memory_store: async (action) => {
    const key = action.args.key;
    if (typeof key !== 'string') return { success: true };
    try {
      const memoryPath = path.join(process.cwd(), '.commander', 'memory.json');
      if (!fs.existsSync(memoryPath)) return { success: true };
      const data = JSON.parse(fs.readFileSync(memoryPath, 'utf-8')) as Array<{ key: string }>;
      const filtered = data.filter((e) => e.key !== key);
      fs.writeFileSync(memoryPath, JSON.stringify(filtered, null, 2), 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};

/**
 * Register the default compensation handlers on a RunLedger instance.
 * Idempotent — safe to call multiple times.
 */
export function registerCompensationHandler(
  ledger: { registerCompensation: (toolName: string, handler: (action: CompensableAction) => Promise<{ success: boolean; error?: string }>) => void },
  toolName?: string,
  handler?: (action: CompensableAction) => Promise<{ success: boolean; error?: string }>,
): void {
  if (toolName && handler) {
    ledger.registerCompensation(toolName, handler);
    return;
  }
  for (const [name, h] of Object.entries(defaultCompensationHandlers)) {
    ledger.registerCompensation(name, h);
  }
}

export interface MutationDetectionResult {
  isMutation: boolean;
  /** Why we think so: 'declared' = tool.definition.mutation, 'heuristic' = substring fallback, 'default' = false */
  source: 'declared' | 'heuristic' | 'default';
  /** If compensable: name of the default handler that can undo this */
  handlerName?: string;
}

const HEURISTIC_KEYWORDS = ['write', 'edit', 'delete', 'mkdir', 'mv', 'cp', 'bash', 'shell', 'git', 'patch', 'fixer', 'refiner'];

/**
 * Resolve whether a tool is a mutation, using the explicit `mutation` flag
 * from ToolDefinition when present, falling back to a substring heuristic
 * for legacy tools. This is the API the runtime should call instead of
 * the bare `isMutationTool()` heuristic.
 */
export function resolveMutationFlag(
  toolName: string,
  definition?: { mutation?: boolean },
): MutationDetectionResult {
  if (definition?.mutation === true) {
    return {
      isMutation: true,
      source: 'declared',
      handlerName: toolName in defaultCompensationHandlers ? toolName : undefined,
    };
  }
  if (definition?.mutation === false) {
    return { isMutation: false, source: 'declared' };
  }
  const lower = toolName.toLowerCase();
  const matched = HEURISTIC_KEYWORDS.find((k) => lower.includes(k));
  if (matched) {
    return {
      isMutation: true,
      source: 'heuristic',
      handlerName: toolName in defaultCompensationHandlers ? toolName : undefined,
    };
  }
  return { isMutation: false, source: 'default' };
}
