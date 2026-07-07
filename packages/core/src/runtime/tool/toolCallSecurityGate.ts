/**
 * Tool-call security gate — extracted from `AgentRuntime.applyBeforeToolCallSecurity`
 * and `AgentRuntime.applyPreToolCallGates`.
 *
 * Centralizes SecurityOrchestrator pre-tool-call checks and the four pre-tool-call
 * safety gates (HookManager, sibling-abort, retry-loop detection, cycle detection)
 * that previously lived as duplicated logic inside `execute()`.
 */
import type { ToolCall, ToolResult } from '../types';
import { getHookManager } from '../../pluginManager';
import { generateId } from '../runtimeHelpers';
import { reportSilentFailure } from '../../silentFailureReporter';
import {
  toolErrorRow,
  type SyntheticErrorRow,
  type PreToolCallGateResult,
} from '../toolResultShape';
import type { SecurityOrchestrator, SecurityOrchestratorDecision } from '../securityOrchestrator';
import type { CrossAgentEvent } from '../../security/crossAgentCorrelator';
import { getMessageBus } from '../messageBus';
import type { CycleDetector } from '../cycleDetector';
import type { Tool } from '../types';
import { ToolCallRetryLoopDetector } from './toolCallRetryLoopDetector';

export interface BeforeToolCallSecurityResult {
  decision: SecurityOrchestratorDecision;
  allowed: boolean;
  /** Synthetic raw-result row for the concurrent parallel-results array. */
  blockedRawResult?: SyntheticErrorRow;
  /** Synthetic ToolResult for the serial execution path. */
  blockedToolResult?: ToolResult;
}

export interface ToolCallSecurityGateDeps {
  getSecurityOrch(): SecurityOrchestrator;
  getCycleDetector(): CycleDetector;
  getTool(name: string): Tool | undefined;
  getLastHallucinationDetected(): boolean;
  retryLoopDetector: ToolCallRetryLoopDetector;
}

export class ToolCallSecurityGate {
  constructor(private readonly deps: ToolCallSecurityGateDeps) {}

  /**
   * Apply SecurityOrchestrator pre-tool-call checks shared by both the
   * concurrent-safe and the serial execution paths in execute().
   */
  async applyBeforeToolCallSecurity(
    tc: ToolCall,
    agentId: string,
    runId: string,
  ): Promise<BeforeToolCallSecurityResult> {
    const decision = await this.deps
      .getSecurityOrch()
      .onBeforeToolCall(tc.name, tc.arguments as Record<string, unknown>, agentId, runId, {
        verification: {
          confidence: 0.95,
          gateFailures: [],
          hallucinationDetected: this.deps.getLastHallucinationDetected(),
        },
      });

    // Feed tool_call event to correlator (DoS detection, lateral movement,
    // collusion). Wrapped in try/catch — Guardian/Correlator sink failures
    // must NEVER block the underlying security decision.
    try {
      this.deps.getSecurityOrch().onAgentEvent({
        id: generateId(),
        agentId,
        runId,
        type: 'tool_call',
        summary: `Tool ${tc.name} (${decision.allowed ? 'allowed' : 'blocked'})`,
        metadata: {
          toolName: tc.name,
          allowed: decision.allowed,
          hitlStrategy: decision.hitlStrategy,
          hitlSources: decision.sources,
        },
        timestamp: Date.now(),
        severity: decision.allowed ? 'low' : 'high',
      } as CrossAgentEvent);
    } catch (err) {
      reportSilentFailure(err, 'agentRuntime:881');
      /* best-effort */
    }

    if (decision.allowed) {
      return { decision, allowed: true };
    }

    // Blocked: publish a tool.blocked bus event FIRST (matching the original
    // duplicated code byte-for-byte — original left this unprotected so a
    // throwing subscriber propagates), then synthesize both result shapes
    // the two callers each need.
    const blockReason = decision.blockReason ?? 'AdaptiveHITL blocked';
    getMessageBus().publish('tool.blocked', agentId, {
      runId,
      toolName: tc.name,
      reason: 'security_orchestrator_denied',
      detail: blockReason,
    });
    const reasonStr = `Security blocked: ${blockReason}`;
    const blockedRawResult = toolErrorRow(tc, reasonStr);
    const blockedToolResult: ToolResult = toolErrorRow(tc, reasonStr);

    return {
      decision,
      allowed: false,
      blockedRawResult,
      blockedToolResult,
    };
  }

  /**
   * Apply the pre-tool-call safety gates that previously ran as ~70 lines
   * of duplicated logic in both the concurrent-safe `Promise.allSettled`
   * path and the serial `for-of` path of execute().
   *
   * Four sequential gates:
   *   1. HookManager.fireBeforeToolCall: plugin deny → kind='hooked'.
   *   2. sibling-abort (concurrent-only): kind='siblingAbort'.
   *   3. retry-loop detection: kind='retry'.
   *   4. cycle detection: kind='cycle'.
   */
  async applyPreToolCallGates(
    tc: ToolCall,
    agentId: string,
    runId: string,
    tenantId: string | undefined,
    recentToolPatterns: string[],
    toolLoopCount: number,
    siblingAbortSignal?: AbortSignal,
  ): Promise<PreToolCallGateResult> {
    // Gate 1: HookManager plugin denial.
    // Resolve the Tool object for the hook context (G2: taint tracking reads riskMetadata)
    const resolvedTool = this.deps.getTool(tc.name);
    const hookCtx = {
      toolName: tc.name,
      args: tc.arguments,
      agentId,
      runId,
      tool: resolvedTool,
    };
    const hookResult = await getHookManager().fireBeforeToolCall(hookCtx);
    if (hookResult !== null) {
      return { kind: 'hooked', errorMsg: hookResult.error ?? '' };
    }

    // Gate 2: sibling-abort cancellation (concurrent-only).
    // The serial path passes `undefined` for `siblingAbortSignal`, so this
    // branch only fires inside the Promise.allSettled closure.
    if (siblingAbortSignal?.aborted) {
      return {
        kind: 'siblingAbort',
        row: toolErrorRow(tc, 'Cancelled: sibling tool error'),
      };
    }

    // Gate 3: retry-loop detection.
    const rlCheck = this.deps.retryLoopDetector.checkRetryLoop(
      tc.name,
      tc.arguments as Record<string, unknown>,
      recentToolPatterns,
      runId,
      tenantId,
      toolLoopCount,
    );
    if (rlCheck.detected) {
      // The caller will set retryLoopDetected=true and assign retryLoopCount
      // from this count; we surface a count that matches the value the
      // previous helper wired in (which was `toolLoopCount`).
      return { kind: 'retry', count: toolLoopCount };
    }

    // Gate 4: cycle detection.
    const cycleCheck = this.deps.getCycleDetector().check(tc.name, tc.arguments, toolLoopCount);
    if (cycleCheck.detected) {
      return { kind: 'cycle', description: cycleCheck.description ?? '' };
    }

    return { kind: 'allowed' };
  }
}
