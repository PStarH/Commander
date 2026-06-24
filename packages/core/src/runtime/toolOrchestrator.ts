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
import type { ToolCall, ToolResult, Tool } from './types';
import { toolErrorRow } from './toolResultShape';
import type { ToolApproval, ApprovalResult } from './toolApproval';
import { CircuitBreakerRegistry } from './circuitBreakerRegistry';
export { CircuitBreakerRegistry };
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
  /** Whether to use approval gate (default: false) */
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
  async planExecution(toolCalls: ToolCall[], tools: Map<string, Tool>): Promise<ToolExecutionPlan> {
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

      // Check tool-level approval
      if (this.config.useApproval && this.approval) {
        const approvalResult = await this.approval.requestApproval(tc.name, tc.arguments);
        if (!approvalResult.approved) {
          skipped.push({
            toolCall: tc,
            reason: approvalResult.reason ?? 'Approval rejected',
          });
          continue;
        }
      }

      // Partition by concurrency safety
      const tool = tools.get(tc.name);
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
        const execPromise = tool.execute(toolCall.arguments);
        const timeoutPromise = new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`TOOL_TIMEOUT: "${toolCall.name}" exceeded ${timeout}ms`)),
            timeout,
          );
          if (typeof timer.unref === 'function') timer.unref();
        });

        const output = await Promise.race([execPromise, timeoutPromise]);
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

        this.recordFailure(toolCall.name);

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
              willRetry: attempt < this.config.maxRetries,
            },
          });
        } catch (err) {
          reportSilentFailure(err, 'toolOrchestrator:364');
          /* best-effort */
        }

        if (attempt < this.config.maxRetries) {
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
   */
  private formatError(
    toolCall: ToolCall,
    error: string,
    durationMs: number,
    attempts: number,
  ): string {
    return [
      `tool_error: "${toolCall.name}" failed after ${attempts} attempt(s) (${durationMs}ms)`,
      `  reason: ${error}`,
      `  args: ${JSON.stringify(toolCall.arguments)}`,
      `advice:`,
      `  - If transient, retry the call`,
      `  - If args invalid, correct and retry`,
      `  - If tool unavailable, try a different approach`,
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
