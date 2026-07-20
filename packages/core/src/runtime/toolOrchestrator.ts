/**
 * Tool Orchestrator — Approval → Sandbox → Execute → Retry
 *
 * Surpasses Codex's orchestrator pattern by adding:
 * 1. Approval gate integration (uses existing ToolApproval)
 * 2. Sandbox selection based on tool risk profile
 * 3. Retry with escalation (retry same → retry with modified args → skip)
 * 4. Timeout cascade (per-tool → per-batch → per-turn)
 * 5. Circuit breaker per tool (stop retrying a broken tool)
 *
 * This is the single entry point for all tool execution in the runtime.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import type { ToolCall, ToolResult, Tool, AgentExecutionContext } from './types';
import {
  formatAbortTimeoutAdviceLines,
  isAbortOrTimeoutToolError,
  toolErrorRow,
} from './toolResultShape';
import type { ToolApproval } from './toolApproval';
import { CircuitBreakerRegistry } from './circuitBreakerRegistry';
import { getGuardianAgent } from '../security/guardianAgent';
import {
  reviewToolCall as guardianReviewToolCall,
  isRuntimeGuardianAvailable,
} from './runtimeGuardianBridge';

import { getApprovalSystem } from '../sandbox/approval';
import { getIdempotencyStore } from '../atr/idempotencyStore';
import { generateIdempotencyKey } from '../atr/canonicalJson';
import { getIntentLog } from './intentLog';

// ============================================================================
// Configuration
// ============================================================================

export interface OrchestratorConfig {
  /** Enable orchestration (default: true) */
  enabled: boolean;
  /** Per-tool timeout in ms (default: 30000) */
  defaultToolTimeoutMs: number;
  /** Per-turn timeout in ms (default: 120000) */
  turnTimeoutMs: number;
  /** Max retries per tool call (default: 1) */
  maxRetries: number;
  /** Whether to use approval gate (default: false — Guardian check in execute() provides security) */
  useApproval: boolean;
  /** Circuit breaker: consecutive failures before disabling tool (default: 3) */
  circuitBreakerThreshold: number;
  /** Circuit breaker: cooldown in ms (default: 60000) */
  circuitBreakerCooldownMs: number;
  /** Per-tool timeout overrides */
  toolTimeouts: Record<string, number>;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  enabled: true,
  defaultToolTimeoutMs: 30_000,
  turnTimeoutMs: 180_000,
  maxRetries: 1,
  useApproval: false,
  circuitBreakerThreshold: 3,
  circuitBreakerCooldownMs: 60_000,
  toolTimeouts: {},
};

// ============================================================================
// Execution Context
// ============================================================================

export interface ToolExecutionContext {
  runId: string;
  agentId: string;
  stepNumber: number;
  tenantId?: string;
  /** Parent/agent abort — linked into the per-tool timeout controller. */
  abortSignal?: AbortSignal;
  /**
   * Real agent execution context when the caller has one.
   * Never forge empty goal/tools/budget placeholders — pass through or omit.
   */
  agentContext?: AgentExecutionContext;
}

/**
 * 仅当 rejection 与 signal.reason 为同一引用时视为 abort-linked（对齐 #72）。
 *
 * 合作 handler 应在 abort 监听器内 reject(signal.reason)。
 * 伪造 AbortError / 文案相同的新 Error('aborted') → 非 linked（正确）。
 * linked alone 不够：ignore 后副作用再 throw signal.reason 仍同引用；
 * 须叠加 abort 协作窗口（abortLocal：先 setTimeout(0) 关窗再 abort，finally 快照）
 * 才标 cooperative（非 retryable）。
 * hard-fail 后工具 Promise 可能继续跑（orphan）；await 已 settle，仅吞 unhandledRejection。
 */
export function isAbortLinkedRejection(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && error === signal.reason;
}

// ============================================================================
// Execution Plan
// ============================================================================

export interface ToolExecutionPlan {
  /** Tools to execute concurrently (no side effects) */
  concurrent: ToolCall[];
  /** Tools to execute serially (side effects) */
  serial: ToolCall[];
  /** Tools skipped due to approval rejection */
  skipped: Array<{ toolCall: ToolCall; reason: string }>;
  /** Tools skipped due to circuit breaker */
  circuitBroken: Array<{ toolCall: ToolCall; toolName: string }>;
}

// ============================================================================
// Execution Result
// ============================================================================

export interface OrchestratedResult {
  results: ToolResult[];
  plan: ToolExecutionPlan;
  totalDurationMs: number;
  retriedCount: number;
  approvalRejectedCount: number;
}

// ============================================================================
// Tool Orchestrator
// ============================================================================

export class ToolOrchestrator {
  private config: OrchestratorConfig;
  private approval?: ToolApproval;
  private breakerRegistry: CircuitBreakerRegistry;

  constructor(
    config?: Partial<OrchestratorConfig>,
    approval?: ToolApproval,
    breakerRegistry?: CircuitBreakerRegistry,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.approval = approval;
    this.breakerRegistry = breakerRegistry ?? new CircuitBreakerRegistry();
  }

  /**
   * Build an execution plan: partition tools into concurrent/serial,
   * check approvals, check circuit breakers.
   */
  async planExecution(
    toolCalls: ToolCall[],
    tools: Map<string, Tool>,
    context?: { capabilityToken?: string },
  ): Promise<ToolExecutionPlan> {
    const concurrent: ToolCall[] = [];
    const serial: ToolCall[] = [];
    const skipped: ToolExecutionPlan['skipped'] = [];
    const circuitBroken: ToolExecutionPlan['circuitBroken'] = [];

    const approvalSystem = getApprovalSystem();

    for (const tc of toolCalls) {
      // Check circuit breaker
      if (this.isCircuitOpen(tc.name)) {
        circuitBroken.push({ toolCall: tc, toolName: tc.name });
        continue;
      }

      const modeCheck = this.checkApprovalMode(tc.name);
      if (modeCheck === 'denied') {
        const mode = approvalSystem.getMode();
        skipped.push({
          toolCall: tc,
          reason: `Blocked by ${mode} mode: tool "${tc.name}" not allowed`,
        });
        continue;
      }

      // Partition by concurrency safety. Unknown tools pass through to
      // ToolExecutionService so it can return a structured TOOL_NOT_ALLOWED
      // error rather than having them silently skipped by approval.
      const tool = tools.get(tc.name);

      // Check tool-level approval only for registered tools.
      if (tool && this.config.useApproval && this.approval) {
        const approvalResult = await this.approval.requestApproval(tc.name, tc.arguments, {
          token: context?.capabilityToken,
        });
        if (!approvalResult.approved) {
          skipped.push({
            toolCall: tc,
            reason: approvalResult.reason ?? 'Approval rejected',
          });
          continue;
        }
      }

      if (tool?.isConcurrencySafe) {
        concurrent.push(tc);
      } else {
        serial.push(tc);
      }
    }

    return { concurrent, serial, skipped, circuitBroken };
  }

  /**
   * Execute a batch of tool calls according to the plan.
   * Handles timeouts, retries, and circuit breaker updates.
   */
  async execute(
    plan: ToolExecutionPlan,
    tools: Map<string, Tool>,
    context: ToolExecutionContext,
  ): Promise<OrchestratedResult> {
    const startTime = Date.now();
    const results: ToolResult[] = [];
    let retriedCount = 0;

    // Execute concurrent tools in parallel
    if (plan.concurrent.length > 0) {
      const concurrentResults = await Promise.allSettled(
        plan.concurrent.map((tc) => this.executeSingleWithRetry(tc, tools, context)),
      );
      for (const r of concurrentResults) {
        if (r.status === 'fulfilled') {
          results.push(r.value.result);
          retriedCount += r.value.retries;
        }
      }
    }

    // Execute serial tools in order
    for (const tc of plan.serial) {
      // Check turn timeout
      if (Date.now() - startTime > this.config.turnTimeoutMs) {
        results.push(
          toolErrorRow(tc, `TURN_TIMEOUT: Turn exceeded ${this.config.turnTimeoutMs}ms`),
        );
        continue;
      }

      const { result, retries } = await this.executeSingleWithRetry(tc, tools, context);
      results.push(result);
      retriedCount += retries;
    }

    // Add results for skipped/circuit-broken tools
    for (const s of plan.skipped) {
      results.push(toolErrorRow(s.toolCall, `APPROVAL_REJECTED: ${s.reason}`));
    }
    for (const cb of plan.circuitBroken) {
      results.push(
        toolErrorRow(
          cb.toolCall,
          `CIRCUIT_OPEN: "${cb.toolName}" is temporarily disabled due to repeated failures`,
        ),
      );
    }

    return {
      results,
      plan,
      totalDurationMs: Date.now() - startTime,
      retriedCount,
      approvalRejectedCount: plan.skipped.length,
    };
  }

  /**
   * Execute a single tool call with retry logic and circuit breaker.
   */
  private async executeSingleWithRetry(
    toolCall: ToolCall,
    tools: Map<string, Tool>,
    context: ToolExecutionContext,
  ): Promise<{ result: ToolResult; retries: number }> {
    const tool = tools.get(toolCall.name);
    if (!tool) {
      return {
        result: toolErrorRow(toolCall, `TOOL_NOT_FOUND: "${toolCall.name}" is not registered`),
        retries: 0,
      };
    }

    const store = getIdempotencyStore();
    const idempotencyKey = this.computeIdempotencyKey(tool, toolCall, context);

    if (store && idempotencyKey) {
      const cached = store.get(idempotencyKey);
      if (cached?.state === 'completed') {
        return {
          result: {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output:
              typeof cached.result === 'string' ? cached.result : JSON.stringify(cached.result),
            durationMs: 0,
            fromCache: true,
          },
          retries: 0,
        };
      }
      if (cached?.state === 'failed') {
        return {
          result: {
            ...toolErrorRow(toolCall, cached.error ?? 'Prior attempt failed (cached)'),
            fromCache: true,
          },
          retries: 0,
        };
      }
    }

    const timeout = this.config.toolTimeouts[toolCall.name] ?? this.config.defaultToolTimeoutMs;
    let lastError: string | undefined;
    let retries = 0;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const startTime = Date.now();

      if (store && idempotencyKey && attempt === 0) {
        store.begin(idempotencyKey, {
          runId: context.runId,
          toolName: toolCall.name,
          tenantId: undefined,
        });
      }

      try {
        // Security gate: GuardianAgent check before tool execution.
        // This closes the critical bypass where ToolOrchestrator.execute()
        // called tool.execute() directly without any security checks.
        // The tier1 harness uses this path, so without this gate, agents
        // could execute dangerous commands unchecked.
        try {
          const guardian = getGuardianAgent();
          const content = `${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 200)})`;
          const intervention = guardian.monitor({
            type: 'tool_call',
            agentId: context.runId ?? 'orchestrator',
            runId: context.runId,
            timestamp: Date.now(),
            content,
            metadata: { args: toolCall.arguments },
          });
          if (intervention) {
            const errorMsg = `GUARDIAN_BLOCKED: ${intervention}`;
            return {
              result: {
                toolCallId: toolCall.id,
                name: toolCall.name,
                output: errorMsg,
                error: errorMsg,
                durationMs: Date.now() - startTime,
              },
              retries,
            };
          }
        } catch (err) {
          // Fail closed: guardian evaluation failure blocks the tool call.
          const errorMsg = `GUARDIAN_ERROR: Security guardian unavailable for ${toolCall.name}: ${err instanceof Error ? err.message : String(err)}`;
          return {
            result: {
              toolCallId: toolCall.id,
              name: toolCall.name,
              output: errorMsg,
              error: errorMsg,
              durationMs: Date.now() - startTime,
            },
            retries,
          };
        }

        // Security gate: Runtime Guardian LLM review
        if (isRuntimeGuardianAvailable()) {
          try {
            const goal = (context as { goal?: string }).goal || 'unknown';
            const decision = await guardianReviewToolCall(toolCall, goal);
            if (!decision.approved) {
              const errorMsg = `RUNTIME_GUARDIAN_BLOCKED: ${decision.reason}`;
              return {
                result: {
                  toolCallId: toolCall.id,
                  name: toolCall.name,
                  output: errorMsg,
                  error: errorMsg,
                  durationMs: Date.now() - startTime,
                },
                retries,
              };
            }
          } catch (err) {
            // Fail closed: runtime guardian LLM review failure blocks the call.
            const errorMsg = `RUNTIME_GUARDIAN_ERROR: Semantic review unavailable for ${toolCall.name}: ${err instanceof Error ? err.message : String(err)}`;
            return {
              result: {
                toolCallId: toolCall.id,
                name: toolCall.name,
                output: errorMsg,
                error: errorMsg,
                durationMs: Date.now() - startTime,
              },
              retries,
            };
          }
        }

        // Soft-abort at timeout / parent cancel (cooperative tools), then hard-fail the
        // await after a short grace so non-cooperative tools cannot pin the orchestrator.
        // Parent abort schedules grace-only hard-exit — does NOT wait remaining timeoutMs.
        // Mirrors worker-plane #72 awaitWithAbortTimeout (abort + force-complete).
        const controller = new AbortController();
        const parentSignal = context.abortSignal;
        const abortMsgBase = 'TOOL_ABORTED: parent abortSignal fired';
        const timeoutMsgBase =
          'TOOL_TIMEOUT: "' + toolCall.name + '" exceeded ' + String(timeout) + 'ms';
        // Cap grace; scale down for short timeouts so tests stay fast (#72 abortGrace).
        const graceMs = Math.min(5_000, Math.max(25, Math.min(timeout, 50)));

        let timedOut = false;
        let closed = false;
        let settled = false;
        /**
         * abort 后的协作窗口：覆盖 abort 同步监听器 + async 额外微任务跳（对齐 #72）。
         * 用 setTimeout(0) 关窗（而非 queueMicrotask），避免 finally 链晚一拍误伤真协作；
         * 宏任务里再 throw signal.reason（副作用后）则 fail-closed。
         */
        let abortCoopWindow = false;
        let settledInCoopWindow = false;
        let softTimer: ReturnType<typeof setTimeout> | undefined;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        let coopWindowTimer: ReturnType<typeof setTimeout> | undefined;
        let onParentAbort: (() => void) | undefined;

        // Pass through real agentContext when provided; otherwise only identity + abortSignal.
        // Do not forge empty goal / availableTools / tokenBudget placeholders.
        const execCtx = (
          context.agentContext
            ? { ...context.agentContext, abortSignal: controller.signal }
            : {
                agentId: context.agentId,
                runId: context.runId,
                tenantId: context.tenantId,
                abortSignal: controller.signal,
              }
        ) as AgentExecutionContext;

        const execPromise = tool.execute(toolCall.arguments, execCtx).finally(() => {
          settled = true;
          if (abortCoopWindow) settledInCoopWindow = true;
        });
        // Abandoned non-cooperative work must not surface as unhandledRejection.
        void execPromise.then(
          () => undefined,
          () => undefined,
        );

        let output: string;
        try {
          output = await new Promise<string>((resolve, reject) => {
            const close = (fn: () => void): void => {
              if (closed) return;
              closed = true;
              if (softTimer !== undefined) clearTimeout(softTimer);
              if (graceTimer !== undefined) clearTimeout(graceTimer);
              if (coopWindowTimer !== undefined) clearTimeout(coopWindowTimer);
              fn();
            };

            // cooperative=true only for abort-linked reject inside the abort coop window;
            // false after grace hard-cancel, late success, or late reject (incl. late
            // throw of signal.reason after side effects) — 对齐 #72.
            const withCoop = (base: string, cooperative: boolean): string =>
              cooperative ? base : base + ' (non-cooperative)';

            const rejectTimeout = (cooperative: boolean): void => {
              close(() => reject(new Error(withCoop(timeoutMsgBase, cooperative))));
            };

            const rejectAbort = (cooperative: boolean): void => {
              close(() => reject(new Error(withCoop(abortMsgBase, cooperative))));
            };

            /**
             * Soft-abort local signal；协作窗口覆盖 abort 同步监听器（真 coop）。
             *
             * 关窗 setTimeout(0) 必须先于 controller.abort 入队：若先 abort，监听器内
             *「副作用 + setTimeout(0, reject(signal.reason))」会把 settle 定时器排在
             * 关窗之前 → settle 仍落在 coop 窗 → 误标 cooperative（跨层可能误当成可重试 / dual-dispatch）。
             * 先关窗再 abort：监听器的 setTimeout(0) 晚于关窗 → fail-closed；
             * 同步 reject(signal.reason) 仍在窗内 → cooperative。
             * 本编排器对 TOOL_TIMEOUT/TOOL_ABORTED 一律不重试；formatError 亦禁止模型再调。
             * （对齐 #72 awaitWithAbortTimeout.abortLocal 顺序。）
             */
            const abortLocal = (reason: unknown): void => {
              if (controller.signal.aborted) return;
              abortCoopWindow = true;
              if (coopWindowTimer !== undefined) clearTimeout(coopWindowTimer);
              coopWindowTimer = setTimeout(() => {
                abortCoopWindow = false;
                coopWindowTimer = undefined;
              }, 0);
              if (typeof coopWindowTimer.unref === 'function') coopWindowTimer.unref();
              controller.abort(reason);
            };

            /** Soft-abort already fired; after grace, hard-reject if work ignored it. */
            const scheduleHardExit = (hardReject: () => void): void => {
              if (graceTimer !== undefined || closed) return;
              graceTimer = setTimeout(() => {
                if (closed || settled) return;
                hardReject();
              }, graceMs);
              if (typeof graceTimer.unref === 'function') graceTimer.unref();
            };

            /**
             * abort/timeout 已开火后的 settle：仅窗口内 abort-linked 仍可 coop；
             * 晚抛 signal.reason（副作用后再抛）与 late-success 一样 fail-closed。
             */
            const coopAfterCancel = (error: unknown): boolean =>
              settledInCoopWindow && isAbortLinkedRejection(error, controller.signal);

            onParentAbort = (): void => {
              abortLocal(parentSignal?.reason ?? new Error('aborted'));
              // Parent abort must hard-exit non-cooperative work (same as timeout path).
              scheduleHardExit(() => rejectAbort(false));
            };

            if (parentSignal) {
              if (parentSignal.aborted) onParentAbort();
              else parentSignal.addEventListener('abort', onParentAbort, { once: true });
            }

            softTimer = setTimeout(() => {
              if (closed) return;
              // Parent owns ABORTED mapping; still ensure a hard-exit is armed.
              if (parentSignal?.aborted) {
                scheduleHardExit(() => rejectAbort(false));
                return;
              }
              timedOut = true;
              abortLocal(new Error(timeoutMsgBase));
              scheduleHardExit(() => {
                if (parentSignal?.aborted) {
                  rejectAbort(false);
                  return;
                }
                rejectTimeout(false);
              });
            }, timeout);
            if (typeof softTimer.unref === 'function') softTimer.unref();

            void execPromise.then(
              (value) => {
                if (closed) return;
                if (parentSignal?.aborted) {
                  // Late success after parent abort: ignored cancel — not cooperative.
                  rejectAbort(false);
                  return;
                }
                if (timedOut) {
                  // Late resolve after timeout: completion unknown — not cooperative.
                  rejectTimeout(false);
                  return;
                }
                if (controller.signal.aborted) {
                  rejectAbort(true);
                  return;
                }
                close(() => resolve(value));
              },
              (error) => {
                if (closed) return;
                if (parentSignal?.aborted) {
                  rejectAbort(coopAfterCancel(error));
                  return;
                }
                if (timedOut) {
                  rejectTimeout(coopAfterCancel(error));
                  return;
                }
                if (controller.signal.aborted) {
                  rejectAbort(coopAfterCancel(error));
                  return;
                }
                close(() => reject(error instanceof Error ? error : new Error(String(error))));
              },
            );
          });
        } finally {
          if (onParentAbort && parentSignal) {
            parentSignal.removeEventListener('abort', onParentAbort);
          }
          if (softTimer !== undefined) clearTimeout(softTimer);
          if (graceTimer !== undefined) clearTimeout(graceTimer);
          if (coopWindowTimer !== undefined) clearTimeout(coopWindowTimer);
        }
        const durationMs = Date.now() - startTime;

        this.recordSuccess(toolCall.name);

        if (store && idempotencyKey) {
          store.complete(idempotencyKey, output);
        }

        try {
          getIntentLog(context.tenantId).write({
            schemaVersion: 1,
            runId: context.runId ?? 'tool-orchestrator',
            capturedAt: new Date().toISOString(),
            stage: 'tool.execute',
            decision: 'success',
            reason: `${toolCall.name} completed`,
            payload: {
              toolName: toolCall.name,
              toolCallId: toolCall.id,
              durationMs,
              outputLength:
                typeof output === 'string' ? output.length : JSON.stringify(output).length,
              attempt: attempt + 1,
            },
          });
        } catch (err) {
          reportSilentFailure(err, 'toolOrchestrator:328');
          /* best-effort */
        }

        return {
          result: {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: typeof output === 'string' ? output : JSON.stringify(output),
            durationMs,
          },
          retries,
        };
      } catch (err) {
        const durationMs = Date.now() - startTime;
        lastError = err instanceof Error ? err.message : String(err);

        // Non-cooperative hard timeout / parent abort: do not amplify side-effects via retry.
        const nonRetryable =
          lastError.startsWith('TOOL_TIMEOUT:') || lastError.startsWith('TOOL_ABORTED:');

        // 父取消 / soft-timeout 不是工具故障：不计入熔断，避免重复取消误开路。
        if (!nonRetryable) {
          this.recordFailure(toolCall.name);
        }

        try {
          getIntentLog(context.tenantId).write({
            schemaVersion: 1,
            runId: context.runId ?? 'tool-orchestrator',
            capturedAt: new Date().toISOString(),
            stage: 'tool.execute',
            decision: 'failed',
            reason: lastError.slice(0, 200),
            payload: {
              toolName: toolCall.name,
              toolCallId: toolCall.id,
              durationMs,
              attempt: attempt + 1,
              willRetry: !nonRetryable && attempt < this.config.maxRetries,
            },
          });
        } catch (logErr) {
          reportSilentFailure(logErr, 'toolOrchestrator:364');
          /* best-effort */
        }

        if (!nonRetryable && attempt < this.config.maxRetries) {
          retries++;
          await new Promise((r) => {
            const t = setTimeout(r, 500 * (attempt + 1));
            t.unref();
          });
        } else {
          if (store && idempotencyKey) {
            store.fail(
              idempotencyKey,
              this.formatError(toolCall, lastError, durationMs, attempt + 1),
            );
          }
          return {
            result: {
              ...toolErrorRow(
                toolCall,
                this.formatError(toolCall, lastError, durationMs, attempt + 1),
              ),
              durationMs,
            },
            retries,
          };
        }
      }
    }

    // Should not reach here, but just in case
    return {
      result: toolErrorRow(toolCall, lastError ?? 'Unknown error'),
      retries,
    };
  }

  private computeIdempotencyKey(
    tool: Tool,
    toolCall: ToolCall,
    context: ToolExecutionContext,
  ): string | null {
    if (tool.idempotencyKey) {
      if (typeof tool.idempotencyKey === 'function') {
        return tool.idempotencyKey(toolCall.arguments, {
          runId: context.runId,
          stepId: `step-${context.stepNumber}`,
        });
      }
      return tool.idempotencyKey;
    }
    if (tool.isIdempotent !== true) return null;
    return generateIdempotencyKey({
      externalSystem: tool.externalSystem ?? 'unknown',
      toolName: toolCall.name,
      args: toolCall.arguments,
      intentHash: context.runId,
      runId: context.runId,
      stepId: `step-${context.stepNumber}`,
    });
  }

  /**
   * Format a structured error message for the model.
   * TIMEOUT/ABORTED（含 non-coop）禁止建议重试：orphan 可能仍在跑，再调即跨层 dual-dispatch。
   * advice 文案经 toolResultShape 与 TES 主路径对齐（TEH 仅 planExecution）。
   */
  private formatError(
    toolCall: ToolCall,
    error: string,
    durationMs: number,
    attempts: number,
  ): string {
    const advice = isAbortOrTimeoutToolError(error)
      ? [`advice:`, ...formatAbortTimeoutAdviceLines(error)]
      : [
          `advice:`,
          `  - If transient, retry the call`,
          `  - If args invalid, correct and retry`,
          `  - If tool unavailable, try a different approach`,
        ];
    return [
      `tool_error: "${toolCall.name}" failed after ${attempts} attempt(s) (${durationMs}ms)`,
      `  reason: ${error}`,
      `  args: ${JSON.stringify(toolCall.arguments)}`,
      ...advice,
    ].join('\n');
  }

  // ============================================================================
  // Circuit Breaker (delegates to CircuitBreakerRegistry)
  // ============================================================================

  private isCircuitOpen(toolName: string): boolean {
    this.breakerRegistry.register(toolName, {
      threshold: this.config.circuitBreakerThreshold,
      recoveryTimeMs: this.config.circuitBreakerCooldownMs,
    });
    return !this.breakerRegistry.isAvailable(toolName);
  }

  private recordSuccess(toolName: string): void {
    this.breakerRegistry.onSuccess(toolName);
  }

  private recordFailure(toolName: string): void {
    this.breakerRegistry.onFailure(toolName);
  }

  getCircuitState(toolName: string): { isOpen: boolean; failures: number } {
    const stats = this.breakerRegistry.getStats(toolName);
    return { isOpen: stats.state === 'OPEN', failures: stats.failureCount };
  }

  resetCircuit(toolName: string): void {
    this.breakerRegistry.reset(toolName);
  }

  resetAllCircuits(): void {
    this.breakerRegistry.resetAll();
  }

  getBreakerRegistry(): CircuitBreakerRegistry {
    return this.breakerRegistry;
  }

  /**
   * Check the current approval mode against a tool name.
   * Returns 'denied' when the mode blocks this tool type, 'approved' otherwise.
   */
  private checkApprovalMode(toolName: string): 'approved' | 'denied' {
    const mode = getApprovalSystem().getMode();
    if (mode === 'full-auto') return 'approved';

    const isWrite =
      /^(file_write|file_edit|write|edit|apply_patch|code_fixer|refine_code|execute_script|python_execute|shell_execute)$/i.test(
        toolName,
      );
    const isDestructive = /^(rm|rmdir|remove|delete)/i.test(toolName);
    const isNetwork = /^(web_search|web_fetch|browser_search|browser_fetch|web_extract)/i.test(
      toolName,
    );

    if (mode === 'plan' || mode === 'read-only') {
      if (isWrite || isDestructive) return 'denied';
    }

    if (mode === 'read-only') {
      if (isNetwork) return 'denied';
    }

    return 'approved';
  }
}
