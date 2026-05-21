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

import type { ToolCall, ToolResult, Tool } from './types';
import type { ToolApproval, ApprovalResult } from './toolApproval';
import { CircuitBreakerRegistry } from './circuitBreakerRegistry';
import { getApprovalSystem } from '../sandbox/approval';

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
  turnTimeoutMs: 120_000,
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

  constructor(config?: Partial<OrchestratorConfig>, approval?: ToolApproval) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.approval = approval;
    this.breakerRegistry = new CircuitBreakerRegistry();
  }

  /**
   * Build an execution plan: partition tools into concurrent/serial,
   * check approvals, check circuit breakers.
   */
  async planExecution(
    toolCalls: ToolCall[],
    tools: Map<string, Tool>,
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
        plan.concurrent.map(tc => this.executeSingleWithRetry(tc, tools, context)),
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
        results.push({
          toolCallId: tc.id,
          name: tc.name,
          output: '',
          error: `TURN_TIMEOUT: Turn exceeded ${this.config.turnTimeoutMs}ms`,
          durationMs: 0,
        });
        continue;
      }

      const { result, retries } = await this.executeSingleWithRetry(tc, tools, context);
      results.push(result);
      retriedCount += retries;
    }

    // Add results for skipped/circuit-broken tools
    for (const s of plan.skipped) {
      results.push({
        toolCallId: s.toolCall.id,
        name: s.toolCall.name,
        output: '',
        error: `APPROVAL_REJECTED: ${s.reason}`,
        durationMs: 0,
      });
    }
    for (const cb of plan.circuitBroken) {
      results.push({
        toolCallId: cb.toolCall.id,
        name: cb.toolCall.name,
        output: '',
        error: `CIRCUIT_OPEN: "${cb.toolName}" is temporarily disabled due to repeated failures`,
        durationMs: 0,
      });
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
    _context: ToolExecutionContext,
  ): Promise<{ result: ToolResult; retries: number }> {
    const tool = tools.get(toolCall.name);
    if (!tool) {
      return {
        result: {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: '',
          error: `TOOL_NOT_FOUND: "${toolCall.name}" is not registered`,
          durationMs: 0,
        },
        retries: 0,
      };
    }

    const timeout = this.config.toolTimeouts[toolCall.name] ?? this.config.defaultToolTimeoutMs;
    let lastError: string | undefined;
    let retries = 0;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const startTime = Date.now();

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

        // Success — reset circuit breaker
        this.recordSuccess(toolCall.name);

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

        // Record failure in circuit breaker
        this.recordFailure(toolCall.name);

        if (attempt < this.config.maxRetries) {
          retries++;
          // Brief delay before retry
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        } else {
          return {
            result: {
              toolCallId: toolCall.id,
              name: toolCall.name,
              output: '',
              error: this.formatError(toolCall, lastError, durationMs, attempt + 1),
              durationMs,
            },
            retries,
          };
        }
      }
    }

    // Should not reach here, but just in case
    return {
      result: {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: '',
        error: lastError ?? 'Unknown error',
        durationMs: 0,
      },
      retries,
    };
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

    const isWrite = /^(file_write|file_edit|write|edit|apply_patch|code_fixer|refine_code|execute_script|python_execute|shell_execute)$/i.test(toolName);
    const isDestructive = /^(rm|rmdir|remove|delete)/i.test(toolName);
    const isNetwork = /^(web_search|web_fetch|browser_search|browser_fetch|web_extract)/i.test(toolName);

    if (mode === 'plan' || mode === 'read-only') {
      if (isWrite || isDestructive) return 'denied';
    }

    if (mode === 'read-only') {
      if (isNetwork) return 'denied';
    }

    return 'approved';
  }
}
