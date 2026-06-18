/**
 * ATR runtime integration — wrap tool execution with idempotency + compensation.
 *
 * @deprecated Superseded by `ExecutionScheduler` (see `src/atr/scheduler.ts`) which is now wired into AgentRuntime.
 *   The functions exported here (`startATRRun`, `wrapToolExecutionWithATR`, `finalizeATRRun`)
 *   are kept for the public API and existing test coverage but are not used by AgentRuntime.
 *   For new code, use `getExecutionScheduler()` instead.
 *
 * Historical design (pre-ExecutionScheduler):
 *   1. Replay check (completedToolCallIds → return cached)
 *   2. Idempotency check (idempotencyStore.begin → if completed, return cached)
 *   3. Mutation detection + snapshot
 *   4. Tool execution
 *   5. Persist result / fail to idempotency + runLedger
 *   6. Return ToolResult
 *
 * This file remains in place pending a deprecation review (see docs/rfcs/reversibility-rfc.md §3.2).
 */

import type { ToolCall, ToolResult } from '../runtime/types';
import { getRunLedgerBundle } from './runLedger';
import {
  defaultCompensationHandlers,
  resolveMutationFlag,
  takeSnapshot,
} from './defaultCompensation';
import { generateIdempotencyKey, hashIntent } from './canonicalJson';
import { getGlobalLogger } from '../logging';

const log = getGlobalLogger();

export interface ATRContext {
  runId: string;
  leaseToken: string;
  fencingEpoch: number;
  intentHash: string;
  tenantId?: string;
  stepId: string;
  /** Already-completed tool call IDs (from resume). On hit, replay returns cached result. */
  completedToolCallIds: Set<string>;
  /** Idempotency cache for completed actions (for fast replay without re-hitting SQLite). */
  completedActionResults: Map<string, { result: string; error?: string }>;
  /**
   * Optional hook called whenever a tool call is recorded as completed.
   * AgentRuntime passes a function that pushes the ID into the checkpoint
   * tracker, so the next checkpoint.write() includes it.
   */
  onCompleted?: (toolCallId: string, result: string) => void;
}

export interface ATRWrapResult {
  result: ToolResult;
  /** True if this was a replay from idempotency store (tool did not actually run). */
  replayed: boolean;
}

/**
 * Begin a run and return the ATR context. Idempotent: if a run already exists
 * for this runId, returns the existing transaction's context.
 */
export function startATRRun(
  runId: string,
  goal: string,
  options?: { tenantId?: string; metadata?: Record<string, unknown> },
): ATRContext | null {
  const bundle = getRunLedgerBundle();
  const intentHash = hashIntent(goal);
  const { lease, tx } = bundle.ledger.start({
    runId,
    intentHash,
    tenantId: options?.tenantId,
    metadata: options?.metadata,
  });
  bundle.ledger.beginExecuting(runId, tx.leaseToken, tx.fencingEpoch, {
    tenantId: options?.tenantId,
  });
  for (const [name, handler] of Object.entries(defaultCompensationHandlers)) {
    bundle.ledger.registerCompensation(name, handler);
  }
  return {
    runId,
    leaseToken: tx.leaseToken,
    fencingEpoch: tx.fencingEpoch,
    intentHash,
    tenantId: options?.tenantId,
    stepId: '0',
    completedToolCallIds: new Set(),
    completedActionResults: new Map(),
  };
}

/**
 * Resume an existing run from persisted state. Returns null if no such run.
 * Replays only the lease token + epoch + intentHash; the completed-tool
 * tracker is the caller's responsibility.
 */
export function resumeATRRun(runId: string, options?: { tenantId?: string }): ATRContext | null {
  const bundle = getRunLedgerBundle();
  const tx = bundle.ledger.getTransaction(runId, { tenantId: options?.tenantId });
  if (!tx) return null;
  return {
    runId,
    leaseToken: tx.leaseToken,
    fencingEpoch: tx.fencingEpoch,
    intentHash: tx.intentHash,
    tenantId: options?.tenantId,
    stepId: 'resumed',
    completedToolCallIds: new Set(),
    completedActionResults: new Map(),
  };
}

/**
 * Wrap a single tool execution with ATR semantics. Order of operations:
 *
 *   1. Replay check (completedToolCallIds → return cached)
 *   2. Idempotency check (idempotencyStore.begin → if completed, return cached)
 *   3. Mutation detection + snapshot
 *   4. Tool execution
 *   5. Persist result / fail to idempotency + runLedger
 *   6. Return ToolResult
 */
export async function wrapToolExecutionWithATR(
  ctx: ATRContext,
  toolCall: ToolCall,
  toolDefinition: { mutation?: boolean; externalSystem?: string; name: string } | undefined,
  executeInner: () => Promise<ToolResult>,
): Promise<ATRWrapResult> {
  const bundle = getRunLedgerBundle();

  // 1. Replay check from completed set
  if (ctx.completedToolCallIds.has(toolCall.id)) {
    const cached = ctx.completedActionResults.get(toolCall.id);
    if (cached) {
      return {
        result: {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: cached.result,
          error: cached.error,
          durationMs: 0,
        },
        replayed: true,
      };
    }
  }

  // 2. Idempotency check
  const mutation = resolveMutationFlag(toolCall.name, toolDefinition);
  const externalSystem =
    toolDefinition?.externalSystem ?? (mutation.isMutation ? 'unknown' : 'read');
  const idempotencyKey = generateIdempotencyKey({
    externalSystem,
    toolName: toolCall.name,
    args: toolCall.arguments,
    intentHash: ctx.intentHash,
    runId: ctx.runId,
    stepId: `${ctx.stepId}-${toolCall.id}`,
  });

  const beginResult = bundle.idempotency.begin(idempotencyKey, {
    tenantId: ctx.tenantId,
    runId: ctx.runId,
    toolName: toolCall.name,
  });

  if (!beginResult.acquired) {
    if (beginResult.record.state === 'completed') {
      const cached = beginResult.record.result ?? '';
      ctx.completedToolCallIds.add(toolCall.id);
      ctx.completedActionResults.set(toolCall.id, { result: cached });
      log.debug('ATR', `Replay (idempotency hit) for ${toolCall.name}`, {
        runId: ctx.runId,
        key: idempotencyKey.slice(0, 8),
      });
      return {
        result: { toolCallId: toolCall.id, name: toolCall.name, output: cached, durationMs: 0 },
        replayed: true,
      };
    }
    if (beginResult.record.state === 'failed') {
      const cachedErr = beginResult.record.error ?? 'unknown';
      return {
        result: {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: '',
          error: cachedErr,
          durationMs: 0,
        },
        replayed: true,
      };
    }
    // state === 'in_progress': another worker holds the key. Wait briefly then re-check.
    // For simplicity, fail-fast: the caller can retry via retry policy.
  }

  // 3. Snapshot if mutation
  let actionId: string | null = null;
  if (mutation.isMutation) {
    const action = bundle.ledger.recordAction({
      runId: ctx.runId,
      leaseToken: ctx.leaseToken,
      fencingEpoch: ctx.fencingEpoch,
      tenantId: ctx.tenantId,
      toolName: toolCall.name,
      externalSystem,
      args: toolCall.arguments,
      idempotencyKey,
      compensable: !!mutation.handlerName,
      tags: [externalSystem, toolCall.name],
      description: `${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 100)})`,
    });
    if (action) {
      actionId = action.actionId;
      const filePath = (toolCall.arguments.path ?? toolCall.arguments.filePath) as
        | string
        | undefined;
      if (typeof filePath === 'string' && toolCall.name !== 'file_delete') {
        takeSnapshot(filePath, actionId);
      }
    }
  }

  // 4. Execute
  let result: ToolResult;
  try {
    result = await executeInner();
  } catch (err) {
    const errorMsg = (err as Error).message;
    bundle.idempotency.fail(idempotencyKey, errorMsg, { tenantId: ctx.tenantId });
    if (actionId) bundle.ledger.recordError(actionId, errorMsg);
    return {
      result: {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: '',
        error: errorMsg,
        durationMs: 0,
      },
      replayed: false,
    };
  }

  // 5. Persist outcome
  if (result.error) {
    bundle.idempotency.fail(idempotencyKey, result.error, { tenantId: ctx.tenantId });
    if (actionId) bundle.ledger.recordError(actionId, result.error);
  } else {
    bundle.idempotency.complete(idempotencyKey, result.output ?? '', { tenantId: ctx.tenantId });
    if (actionId) bundle.ledger.recordResult(actionId, result.output ?? '');
    ctx.completedToolCallIds.add(toolCall.id);
    ctx.completedActionResults.set(toolCall.id, { result: result.output ?? '' });
    ctx.onCompleted?.(toolCall.id, result.output ?? '');
  }

  return { result, replayed: false };
}

/**
 * Commit or abort the run after the agent's main loop completes.
 * Call this in the `finally` block of execute().
 */
export async function finalizeATRRun(
  ctx: ATRContext,
  outcome: 'success' | 'failed',
  errorMessage?: string,
): Promise<void> {
  const bundle = getRunLedgerBundle();
  if (outcome === 'success') {
    bundle.ledger.commit(ctx.runId, ctx.leaseToken, ctx.fencingEpoch, { tenantId: ctx.tenantId });
  } else {
    await bundle.ledger.abortAndCompensate(
      ctx.runId,
      ctx.leaseToken,
      ctx.fencingEpoch,
      errorMessage ?? 'execution failed',
      { tenantId: ctx.tenantId },
    );
  }
  bundle.lease.release(ctx.runId, ctx.leaseToken, { tenantId: ctx.tenantId });
}
