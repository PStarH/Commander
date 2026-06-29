/**
 * ToolExecutionHandler — extracted from AgentRuntime.execute().
 *
 * Owns the per-response tool-execution phase that previously lived inline in
 * the ~3,000-line `execute()` method. The phase begins at the `onStepStart`
 * hook and runs the full tool-execution loop:
 *   1. onStepStart hook invocation + reasoning/output delta publishing.
 *   2. Entropy-gating / early-exit decision + structured-output extraction.
 *   3. Tool-call parsing (`response.toolCalls`) + cache lookup.
 *   4. Dependency-aware planning + batch-safe vs sequential dispatch.
 *   5. Pre-tool-call safety gates (hook, sibling-abort, retry, cycle) and
 *      SecurityOrchestrator approval (AdaptiveHITL) before each execution.
 *   6. Concurrent-safe parallel execution + serial execution with interrupt /
 *      error handling per tool.
 *   7. Result collection, observation masking, injection scanning, sensitive
 *      content redaction (sanitization), and governor-driven truncation.
 *   8. Step-result construction (StepRecord with toolCall / toolResult /
 *      observation) + onStepComplete hook + CrossAgentCorrelator feed.
 *   9. Sliding-window management, memory solidification, context compaction,
 *      and the follow-up LLM call that drives the next loop iteration.
 *
 * Boundary note: the literal `// ── Hook: onStepStart ──` → `// ── Hook:
 * onStepComplete ──` span bisects the inner `for (const masked …)` loop and
 * the enclosing `while` tool-execution loop (the loop condition depends on the
 * follow-up LLM response assigned at the bottom of the loop body). To keep the
 * loop intact and the extraction behaviour-preserving, `executeStep` owns the
 * complete phase — from `onStepStart` through loop exit — and returns the
 * control signals the caller needs for the post-loop interrupt check,
 * goal-completion verification, and early-exit handling.
 */
import type {
  LLMRequest,
  LLMResponse,
  AgentExecutionContext,
  AgentExecutionStep,
  AgentRuntimeConfig,
  Tool,
  ToolCall,
  ToolResult,
  RoutingDecision,
  TokenUsage,
} from './types';
import { getMessageBus, type MessageBus } from './messageBus';
import { getHookManager } from '../pluginManager';
import { getGlobalLogger } from '../logging';
import { getAnomalyDetector } from '../observability/anomalyDetector';
import { getMetricsCollector } from './metricsCollector';
import { isConfidentResponse } from './entropyGater';
import { parseStructuredOutput } from './structuredOutput';
import {
  descendingToolOrder,
  applyObservationMask,
  isMutationTool,
  generateId,
  now,
} from './runtimeHelpers';
import { scanToolOutputForInjection } from '../contentScanner';
import { sanitizeIfNeeded } from '../security/outputSanitizer';
import { reportSilentFailure } from '../silentFailureReporter';
import { getHallucinationDetector } from '../hallucinationDetector';
import { detectTaskType } from './unifiedVerification';
import type { CrossAgentEvent } from '../security/crossAgentCorrelator';
import type { PlannedToolCall } from '../compensation/rollbackPlanner';
import { InterruptError } from './interruptError';
import {
  type SyntheticErrorRow,
  toolErrorRow,
  type PreToolCallGateResult,
} from './toolResultShape';
import type { CompactTaskType, ContextCompactor } from './contextCompactor';
import type { TokenGovernor } from './tokenGovernor';
import type { CacheManager } from './cacheManager';
import type { ToolPlanner } from './toolPlanner';
import type { ToolOrchestrator } from './toolOrchestrator';
import type { ToolOutputManager } from './toolOutputManager';
import type { CycleDetector } from './cycleDetector';
import type { SecurityOrchestrator, SecurityOrchestratorDecision } from './securityOrchestrator';
import type { SlidingWindowOrchestrator } from './slidingWindowOrchestrator';
import type { ThreeLayerMemory } from '../threeLayerMemory';

/**
 * Result shape returned by `AgentRuntime.applyBeforeToolCallSecurity`. Kept as
 * a standalone interface so the handler's dependency surface is explicit and
 * decoupled from the runtime's private method signatures.
 */
export interface BeforeToolCallSecurityResult {
  decision: SecurityOrchestratorDecision;
  allowed: boolean;
  /** Synthetic raw-result row for the concurrent parallel-results array. */
  blockedRawResult?: SyntheticErrorRow;
  /** Synthetic ToolResult for the serial execution path. */
  blockedToolResult?: ToolResult;
}

/**
 * Getter-callback dependencies wired by `AgentRuntime` at construction time.
 * Getters are used (rather than captured values) so the handler always observes
 * the runtime's current — possibly per-run / per-tenant — instance fields.
 */
export interface ToolExecutionHandlerDeps {
  getConfig: () => AgentRuntimeConfig;
  getTools: () => Map<string, Tool>;
  getGovernor: () => TokenGovernor;
  getCacheManager: () => CacheManager;
  getPlanner: () => ToolPlanner;
  getOrchestrator: () => ToolOrchestrator;
  getOutputManager: () => ToolOutputManager;
  getCycleDetector: () => CycleDetector;
  getSecurityOrch: () => SecurityOrchestrator;
  getSlidingWindow: () => SlidingWindowOrchestrator;
  getMemory: () => ThreeLayerMemory | null;
  getCompactor: () => ContextCompactor;

  /** Runtime method callbacks (bound to the AgentRuntime instance). */
  normalizeToolCall: (
    tc: ToolCall & { function?: { name?: string; arguments?: string } },
  ) => ToolCall;
  applyPreToolCallGates: (
    tc: ToolCall,
    agentId: string,
    runId: string,
    tenantId: string | undefined,
    recentToolPatterns: string[],
    toolLoopCount: number,
    siblingAbortSignal?: AbortSignal,
  ) => Promise<PreToolCallGateResult>;
  applyBeforeToolCallSecurity: (
    tc: ToolCall,
    agentId: string,
    runId: string,
  ) => Promise<BeforeToolCallSecurityResult>;
  executeTool: (
    runId: string,
    toolCall: ToolCall,
    agentId: string,
    tenantId?: string,
    allowedTools?: string[],
    agentCtx?: AgentExecutionContext,
  ) => Promise<ToolResult>;
  invalidateMutationCache: (toolName: string) => void;
  callWithTimeout: (
    request: LLMRequest,
    routing: RoutingDecision,
    attemptNumber?: number,
    taskId?: string,
  ) => Promise<LLMResponse | null>;

  /** Re-assigns the runtime's `executedMutations` field (rollback planner feed). */
  setExecutedMutations: (mutations: PlannedToolCall[]) => void;
  /** Re-assigns the runtime's `lastHallucinationDetected` flag. */
  setLastHallucinationDetected: (value: boolean) => void;
}

/** Context passed into `executeStep` for one LLM response's tool phase. */
export interface ToolExecutionStepParams {
  ctx: AgentExecutionContext;
  runId: string;
  /** Current LLM response (carrying `toolCalls`); reassigned as follow-ups arrive. */
  response: LLMResponse;
  /** LLM request whose `messages` array is mutated in place with tool results. */
  request: LLMRequest;
  /** Accumulating step history; tool-result steps are pushed here. */
  steps: AgentExecutionStep[];
  /** Running token totals; mutated in place with follow-up usage. */
  totalTokens: TokenUsage;
  bus: MessageBus;
  tenantId: string | undefined;
  routing: RoutingDecision;
  /** The response step already built by the caller (pushed + mutated here). */
  step: AgentExecutionStep;
  stepNumber: number;
  /** Whether model degeneration was detected before this step. */
  degenerationDetected: boolean;
  /** Largest `file_write` content seen so far (artifact propagation). */
  largestFileWriteContent: string;
}

/** Control signals + updated state returned to the caller after the phase. */
export interface ToolExecutionStepResult {
  /** Final LLM response (last follow-up, or the original if no tool calls). */
  response: LLMResponse;
  /** Skip goal-completion verification (confident / degenerated response). */
  earlyExit: boolean;
  /** Non-null when a tool requested a human-in-the-loop interrupt. */
  interruptData: { reason: string; value: unknown } | null;
  /** Updated largest `file_write` content (string is immutable → returned). */
  largestFileWriteContent: string;
}

export class ToolExecutionHandler {
  constructor(private readonly deps: ToolExecutionHandlerDeps) {}

  async executeStep(params: ToolExecutionStepParams): Promise<ToolExecutionStepResult> {
    const { ctx, runId, request, steps, totalTokens, bus, tenantId, routing } = params;
    let response = params.response;
    const { step, stepNumber } = params;
    const degenerationDetected = params.degenerationDetected;
    let largestFileWriteContent = params.largestFileWriteContent;
    // Local-only accumulator (consumed solely inside this phase).
    let cumulativeEvidence = 0;

    // ── Hook: onStepStart ──
    getHookManager()
      .fireOnStepStart({
        runId,
        agentId: ctx.agentId,
        stepNumber,
        type: 'response',
        content: response.content,
      })
      .catch((e) =>
        getGlobalLogger().debug('AgentRuntime', 'onStepStart hook failed', {
          error: (e as Error)?.message,
        }),
      );

    steps.push(step);

    // Publish reasoning and output deltas for real-time SSE streaming.
    // Previously SSEStream.emitReasoning()/emitOutput() existed but were
    // never called, so enterprise users could only see event-level
    // "started/completed" — not the agent's actual thinking process.
    // Publishing to the bus lets SSEStream forward these to connected clients.
    try {
      const reasoningContent = (response as { reasoning_content?: string }).reasoning_content;
      if (reasoningContent) {
        getMessageBus().publish('reasoning.delta', ctx.agentId, {
          runId,
          agentId: ctx.agentId,
          stepNumber,
          delta: reasoningContent.slice(0, 2000),
          timestamp: now(),
        });
      }
      if (response.content) {
        getMessageBus().publish('output.delta', ctx.agentId, {
          runId,
          agentId: ctx.agentId,
          stepNumber,
          delta: response.content.slice(0, 2000),
          timestamp: now(),
        });
      }
    } catch {
      /* best-effort — streaming is non-critical */
    }

    const anomalyDetector = getAnomalyDetector();
    anomalyDetector.recordUsage(ctx.agentId, response.usage.totalTokens);
    const anomaly = anomalyDetector.checkForAnomaly(
      ctx.agentId,
      runId,
      stepNumber,
      response.usage.totalTokens,
    );
    if (anomaly) {
      bus.publish('system.alert', 'runtime', {
        type: 'token_usage_anomaly',
        ...anomaly,
      });
    }

    // Degeneration check moved to PRE-STEP (before step creation).
    // `degenerationDetected` flag is set above; earlyExit logic below
    // uses it to skip goal-completion verification.

    // Entropy gating: if model is confident with no tool calls, skip verification
    // to save tokens. Evidence: arXiv 2602.02050 — high-quality tool calls reduce
    // model entropy; confident responses need no verification.
    let earlyExit = false;
    // Degeneration detected in text but model still issued tool calls.
    // Let the tool calls execute — they're often valid (e.g. update-dep,
    // backup-db) even when text is degenerate. Only force earlyExit if
    // there are truly no tool calls to execute.
    if (degenerationDetected && (!response.toolCalls || response.toolCalls.length === 0)) {
      earlyExit = true;
    } else if (!response.toolCalls || response.toolCalls.length === 0) {
      if (isConfidentResponse(response)) {
        bus.publish('system.alert', 'runtime', {
          type: 'entropy_gate',
          reason: 'confident_no_tool_calls',
        });
        // Skip verification when model is confident — saves ~500-2000 tokens per skip
        earlyExit = true;
        getMetricsCollector().incrementCounter(
          'early_exits_total',
          'Early exits due to confident responses',
          1,
          [{ name: 'reason', value: 'confident_no_tools' }],
        );
      }
      // Attempt structured output extraction for potential JSON answers.
      // Prefer provider-native parsed output, then fall back to content parsing.
      if (response.parsed) {
        step.content = JSON.stringify(response.parsed);
      } else {
        const structured = parseStructuredOutput(response.content);
        if (structured) {
          step.content = typeof structured === 'string' ? structured : JSON.stringify(structured);
        }
      }
    }

    // Process tool calls in a loop — with caching, planning, cycle detection, and output management
    const maxIterations = Math.max(ctx.maxSteps || 10, 20);
    let toolLoopCount = 0;
    this.deps.getCycleDetector().reset();
    const executedMutations: PlannedToolCall[] = [];
    this.deps.setExecutedMutations(executedMutations);
    // Track recent tool call patterns for retry-loop detection.
    // A retry loop is when the same tool is called with identical
    // arguments >= 3 times within a short window (last 20 calls).
    const recentToolPatterns: string[] = [];
    let retryLoopDetected = false;
    void 0;
    let cycleDetected = false;
    let interruptData: { reason: string; value: unknown } | null = null;
    while (
      response.toolCalls &&
      response.toolCalls.length > 0 &&
      toolLoopCount < maxIterations &&
      !cycleDetected &&
      !retryLoopDetected &&
      this.deps.getGovernor().getState().phase !== 'critical'
    ) {
      console.warn(
        `[TOOL LOOP] iteration ${toolLoopCount + 1} calls=${response.toolCalls?.length} phase=${this.deps.getGovernor().getState().phase}`,
      );
      toolLoopCount++;

      // Reset output manager turn budget (governor-aware: shrink under pressure)
      this.deps.getOutputManager().resetTurn();
      this.deps
        .getOutputManager()
        .adjustBudgetForPressure(this.deps.getGovernor().getState().pressure);

      // Check cache for all tool calls first (zero-cost on hit)
      const calls = (response.toolCalls ?? []).map((tc) => this.deps.normalizeToolCall(tc));
      const uncachedCalls: typeof calls = [];
      const cachedResults: Array<{
        toolCallId: string;
        name: string;
        output: string;
        error?: string;
        durationMs: number;
      }> = [];

      for (const tc of calls) {
        const cached = this.deps.getCacheManager().getToolCache().get(tc, tenantId);
        if (cached) {
          cachedResults.push({
            toolCallId: tc.id,
            name: tc.name,
            output: cached.output,
            error: cached.error,
            durationMs: 0,
          });
        } else {
          uncachedCalls.push(tc);
        }
      }

      // Plan execution for uncached calls using dependency-aware planner
      const executionPlan = this.deps.getPlanner().plan(uncachedCalls, this.deps.getTools());
      const rawResults: Array<{
        toolCallId: string;
        name: string;
        output: string;
        error?: string;
        durationMs: number;
      }> = [];

      // Execute each stage (parallel within stage, sequential across stages)
      for (const stage of executionPlan.stages) {
        if (stage.toolCalls.length === 0) continue;

        // Apply descending scheduler if enabled (broad exploration first)
        const stageCalls = this.deps.getConfig().enableDescendingScheduler
          ? descendingToolOrder(stage.toolCalls)
          : stage.toolCalls;

        // Check orchestration plan (circuit breakers, approvals)
        const planResult = await this.deps
          .getOrchestrator()
          .planExecution(stageCalls, this.deps.getTools());
        const approvedCalls = [...planResult.concurrent, ...planResult.serial];

        // Log skipped/circuit-broken tools
        for (const s of planResult.skipped) {
          bus.publish('tool.blocked', ctx.agentId, {
            runId,
            toolName: s.toolCall.name,
            reason: 'orchestrator_skipped',
            detail: s.reason,
          });
          rawResults.push({
            toolCallId: s.toolCall.id,
            name: s.toolCall.name,
            output: '',
            error: s.reason,
            durationMs: 0,
          });
        }
        for (const cb of planResult.circuitBroken) {
          bus.publish('tool.blocked', ctx.agentId, {
            runId,
            toolName: cb.toolCall.name,
            reason: 'circuit_broken',
            detail: cb.toolName,
          });
          rawResults.push({
            toolCallId: cb.toolCall.id,
            name: cb.toolCall.name,
            output: '',
            error: `CIRCUIT_OPEN: ${cb.toolName}`,
            durationMs: 0,
          });
        }

        // Partition approved calls: concurrent-safe first, then serial
        const concurrencyMap = approvedCalls.map((tc) => {
          const tool = this.deps.getTools().get(tc.name);
          return { tc, isSafe: tool?.isConcurrencySafe === true };
        });
        const safeCalls = concurrencyMap.filter((c) => c.isSafe).map((c) => c.tc);
        const serialCalls = concurrencyMap.filter((c) => !c.isSafe).map((c) => c.tc);

        // Run concurrent-safe tools in parallel with sibling abort
        if (safeCalls.length > 0) {
          const siblingAbort = new AbortController();
          const concurrentResults = await Promise.allSettled(
            safeCalls.map(async (tc) => {
              // Pre-tool-call safety gates (hook, sibling-abort, retry, cycle)
              const gate = await this.deps.applyPreToolCallGates(
                tc,
                ctx.agentId,
                runId,
                ctx.tenantId,
                recentToolPatterns,
                toolLoopCount,
                siblingAbort.signal,
              );
              if (gate.kind !== 'allowed') {
                console.warn(`[SERIAL] GATE BLOCKED ${tc.name} kind=${gate.kind}`);
                if (gate.kind === 'retry') {
                  retryLoopDetected = true;
                  return toolErrorRow(tc, `Retry loop detected: ${tc.name}`);
                }
                if (gate.kind === 'cycle') {
                  cycleDetected = true;
                  // Publishes live at the call site (no double-fire).
                  // `runId` propagates so Phase 2 Hub Glue
                  // CycleCorrelator can dedup by run instead of
                  // collapsing concurrent runs that hit the same
                  // tool/args within the 5s TTL window.
                  bus.publish('system.alert', 'runtime', {
                    type: 'cycle_detected',
                    toolName: tc.name,
                    description: gate.description,
                    runId,
                  });
                  bus.publish('tool.blocked', ctx.agentId, {
                    runId,
                    toolName: tc.name,
                    reason: 'cycle_detected',
                    detail: gate.description,
                  });
                  return toolErrorRow(tc, `Cycle detected: ${gate.description}`);
                }
                if (gate.kind === 'hooked') {
                  bus.publish('tool.blocked', ctx.agentId, {
                    runId,
                    toolName: tc.name,
                    reason: 'hook_denied',
                    detail: gate.errorMsg,
                  });
                  // Cross-agent correlator: record the attempt that
                  // the HookManager denied (the applyBeforeToolCallSecurity
                  // correlator fire only runs on the allowed-path branch,
                  // so this denial path would otherwise leave the
                  // correlator empty). Fires once per hook-denial.
                  try {
                    this.deps.getSecurityOrch().onAgentEvent({
                      id: generateId(),
                      agentId: ctx.agentId,
                      runId,
                      type: 'tool_call',
                      summary: `Tool ${tc.name} (denied by hook)`,
                      metadata: {
                        toolName: tc.name,
                        allowed: false,
                        hookReason: gate.errorMsg,
                      },
                      timestamp: Date.now(),
                      severity: 'high',
                    } as CrossAgentEvent);
                  } catch (err) {
                    reportSilentFailure(err, 'agentRuntime:2430');
                    /* best-effort */
                  }
                  return toolErrorRow(tc, `Hook blocked: ${gate.errorMsg || 'denied'}`);
                }
                // gate.kind === 'siblingAbort'
                return gate.row;
              }

              // SecurityOrchestrator: unify ToolApproval + AdaptiveHITL before execution
              const sec = await this.deps.applyBeforeToolCallSecurity(tc, ctx.agentId, runId);
              if (!sec.allowed && sec.blockedRawResult) {
                return sec.blockedRawResult;
              }
              // Catch InterruptError before StepErrorBoundary — it's a signal, not an error
              let toolResult: ToolResult;
              try {
                toolResult = await this.deps.executeTool(
                  runId,
                  tc,
                  ctx.agentId,
                  tenantId,
                  ctx.availableTools,
                  ctx,
                );
              } catch (err) {
                if (err instanceof InterruptError) {
                  // Signal interrupt — the tool loop will break after this iteration
                  interruptData = { reason: err.reason, value: err.value };
                  bus.publish('agent.interrupted', ctx.agentId, {
                    runId,
                    reason: err.reason,
                  });
                  return {
                    toolCallId: tc.id,
                    name: tc.name,
                    output: `Interrupted: ${err.reason}`,
                    error: undefined,
                    durationMs: 0,
                  };
                }
                throw err; // Re-throw non-interrupt errors for StepErrorBoundary
              }

              toolResult = await getHookManager().fireAfterToolCall({
                toolName: tc.name,
                args: tc.arguments,
                result: toolResult,
                agentId: ctx.agentId,
                runId,
              });
              if (toolResult.error && (tc.name === 'shell_execute' || tc.name === 'bash')) {
                siblingAbort.abort();
              }
              if (!toolResult.error) {
                this.deps.getCacheManager().getToolCache().set(tc, toolResult, tenantId);
                this.deps.invalidateMutationCache(tc.name);
                if (isMutationTool(tc.name)) {
                  executedMutations.push({
                    toolName: tc.name,
                    args: tc.arguments as Record<string, unknown>,
                  });
                }
              }
              // Capture file_write content for artifact propagation
              if (tc.name === 'file_write' && !toolResult.error) {
                const writtenContent = String(tc.arguments?.content ?? '');
                if (writtenContent.length > largestFileWriteContent.length) {
                  largestFileWriteContent = writtenContent;
                }
              }
              return {
                toolCallId: tc.id,
                name: tc.name,
                output: toolResult.output,
                error: toolResult.error,
                durationMs: toolResult.durationMs,
              };
            }),
          );
          for (let i = 0; i < concurrentResults.length; i++) {
            const r = concurrentResults[i];
            if (r.status === 'fulfilled') {
              if (r.status === 'fulfilled' && !r.value.error) cumulativeEvidence++;
              rawResults.push(r.value);
            } else {
              rawResults.push({
                toolCallId: safeCalls[i].id,
                name: safeCalls[i].name,
                output: '',
                error: r.reason?.toString() || 'Execution failed',
                durationMs: 0,
              });
            }
          }
        }

        // Run serial tools in order
        for (const tc of serialCalls) {
          // Pre-tool-call safety gates (hook, retry, cycle).
          // Concurrent-only sibling-abort is irrelevant on the
          // serial path — no Promise.allSettled siblings.
          const gate = await this.deps.applyPreToolCallGates(
            tc,
            ctx.agentId,
            runId,
            ctx.tenantId,
            recentToolPatterns,
            toolLoopCount,
          );
          if (gate.kind !== 'allowed') {
            let blockingRow: SyntheticErrorRow | null = null;
            let shouldBreak = false;
            switch (gate.kind) {
              case 'hooked':
                bus.publish('tool.blocked', ctx.agentId, {
                  runId,
                  toolName: tc.name,
                  reason: 'hook_denied',
                  detail: gate.errorMsg,
                });
                blockingRow = toolErrorRow(tc, `Hook blocked: ${gate.errorMsg || 'denied'}`);
                break;
              case 'retry':
                retryLoopDetected = true;
                blockingRow = toolErrorRow(tc, `Retry loop detected: ${tc.name}`);
                shouldBreak = true;
                break;
              case 'cycle':
                // `runId` propagates so the Phase 2 Hub Glue
                // CycleCorrelator can dedup by run (key
                // `${runId}:${toolName}:${description}`) instead
                // of false-correlating concurrent runs that trigger the
                // same gate. Mirrors the concurrent-path edit in the
                // Promise.allSettled closure.
                bus.publish('system.alert', 'runtime', {
                  type: 'cycle_detected',
                  toolName: tc.name,
                  description: gate.description,
                  runId,
                });
                bus.publish('tool.blocked', ctx.agentId, {
                  runId,
                  toolName: tc.name,
                  reason: 'cycle_detected',
                  detail: gate.description,
                });
                cycleDetected = true;
                blockingRow = toolErrorRow(tc, `Cycle detected: ${gate.description}`);
                shouldBreak = true;
                break;
              case 'siblingAbort':
                // serial path does not consume siblingAbort — kept
                // defensive so a future regression that lets it fire
                // here still pushes the synthetic row instead of
                // silently dropping the cancellation.
                blockingRow = gate.row;
                break;
            }
            if (blockingRow) rawResults.push(blockingRow);
            if (shouldBreak) break;
          }
          // SecurityOrchestrator: unify ToolApproval + AdaptiveHITL before execution
          const sec = await this.deps.applyBeforeToolCallSecurity(tc, ctx.agentId, runId);
          if (!sec.allowed && sec.blockedToolResult) {
            console.warn(
              `[SERIAL] BLOCKED ${tc.name} by security: ${sec.decision.blockReason ?? 'unknown'}`,
            );
          }
          let toolResult: ToolResult;
          if (!sec.allowed && sec.blockedToolResult) {
            toolResult = sec.blockedToolResult;
          } else {
            console.warn(`[SERIAL] EXECUTING ${tc.name} toolLoopCount=${toolLoopCount}`);
            toolResult = await this.deps.executeTool(
              runId,
              tc,
              ctx.agentId,
              tenantId,
              ctx.availableTools,
              ctx,
            );
          }
          toolResult = await getHookManager().fireAfterToolCall({
            toolName: tc.name,
            args: tc.arguments,
            result: toolResult,
            agentId: ctx.agentId,
            runId,
          });
          if (!toolResult.error) {
            this.deps.getCacheManager().getToolCache().set(tc, toolResult, tenantId);
            this.deps.invalidateMutationCache(tc.name);
            if (isMutationTool(tc.name)) {
              executedMutations.push({
                toolName: tc.name,
                args: tc.arguments as Record<string, unknown>,
              });
            }
          }
          // Capture file_write content for artifact propagation
          if (tc.name === 'file_write' && !toolResult.error) {
            const writtenContent = String(tc.arguments?.content ?? '');
            if (writtenContent.length > largestFileWriteContent.length) {
              largestFileWriteContent = writtenContent;
            }
          }
          if (!toolResult.error) cumulativeEvidence++;
          rawResults.push({
            toolCallId: tc.id,
            name: tc.name,
            output: toolResult.output,
            error: toolResult.error,
            durationMs: toolResult.durationMs,
          });
        }
      }

      // Merge cached + raw results, reorder to match original request order
      const allResults = [...cachedResults, ...rawResults];
      const resultMap = new Map(allResults.map((r) => [r.toolCallId, r]));
      const orderedResults = calls.map((tc) => resultMap.get(tc.id)!).filter(Boolean);

      // Output management: cap, truncate, persist per-turn budget
      const managedOutputs = this.deps.getOutputManager().manageBatch(
        orderedResults.map((r, i) => ({
          toolCall: calls[i],
          result: {
            toolCallId: r.toolCallId,
            name: r.name,
            output: r.output,
            error: r.error,
            durationMs: r.durationMs,
          },
        })),
      );

      // Governor-driven observation masking: adjust window based on budget pressure
      const maskDecision = this.deps.getGovernor().shouldApply('observation_mask');
      const effectiveWindow = maskDecision.apply
        ? Math.max(
            2,
            Math.floor(
              this.deps.getConfig().observationMaskWindow * (1 - maskDecision.intensity * 0.7),
            ),
          )
        : this.deps.getConfig().observationMaskWindow;
      const maskedResults = await applyObservationMask(
        orderedResults.map((r, i) => ({
          ...r,
          output: managedOutputs[i]?.output ?? r.output,
        })),
        effectiveWindow,
      );

      // Governor-driven tool output truncation: truncate verbose outputs under budget pressure
      const truncateDecision = this.deps.getGovernor().shouldApply('tool_output_truncate');
      const truncLimit = truncateDecision.apply
        ? Math.max(200, Math.floor(2000 * (1 - truncateDecision.intensity * 0.8)))
        : 0;

      for (const masked of maskedResults) {
        let finalOutput = masked.output;
        let injectionBlocked = false;
        // Defense-in-depth: scan tool outputs for injection patterns before they enter the LLM context.
        // Lightweight regex check — blocks known injection patterns without LLM cost.
        try {
          const injectionScan = scanToolOutputForInjection(finalOutput);
          if (injectionScan.blocked) {
            injectionBlocked = true;
            finalOutput = `[Tool output filtered: ${injectionScan.reason}] (Original output length: ${finalOutput.length} chars)`;
            bus.publish('system.alert', 'runtime', {
              type: 'tool_output_injection_blocked',
              toolCallId: masked.toolCallId,
              reason: injectionScan.reason,
            });
            try {
              getMetricsCollector().incrementCounter(
                'tool_output_injection_blocked_total',
                'Tool outputs blocked for injection patterns',
                1,
                [{ name: 'reason', value: injectionScan.reason ?? 'unknown' }],
              );
            } catch (err) {
              reportSilentFailure(err, 'agentRuntime:2712');
              /* best-effort */
            }
          }
        } catch (err) {
          reportSilentFailure(err, 'agentRuntime:2717');
          /* best-effort defense */
        }
        // Deep security scan: enforce tool output security based on trust tier
        // Disabled for now — the async full-scan causes timing issues in the
        // tool execution loop. The regex-based scanToolOutputForInjection
        // above already provides the primary defense.
        /*
        try {
          const deepScan = await enforceToolOutputSecurity(finalOutput, 'untrusted');
          if (deepScan.blocked && !injectionBlocked) {
            const reason = deepScan.blockedAt
              ? `deep-scan ${deepScan.blockedAt}`
              : 'untrusted output blocked';
            finalOutput = `[Tool output filtered: ${reason}] ...`;
          }
        } catch (err) {
          reportSilentFailure(err, 'agentRuntime:enforceToolOutputSecurity');
        }
        */
        // Output sanitization: redact credentials, API keys, PII before tool results
        // enter the LLM context. This prevents credential leakage via tool outputs.
        try {
          const sanitizeResult = sanitizeIfNeeded(finalOutput, {
            agentId: ctx.agentId,
            runId,
            source: `tool:${masked.name}`,
          });
          if (sanitizeResult.wasRedacted) {
            finalOutput = sanitizeResult.output;
            bus.publish('system.alert', 'runtime', {
              type: 'tool_output_sanitized',
              toolCallId: masked.toolCallId,
              categories: sanitizeResult.categories,
            });
          }
        } catch (err) {
          // Fail closed: if sanitization fails, suppress the output rather than
          // leaking potentially unsanitized credentials/PII into the LLM context.
          finalOutput = `[sanitization failed, output suppressed]`;
          bus.publish('system.alert', 'runtime', {
            type: 'tool_output_sanitization_failed',
            toolCallId: masked.toolCallId,
            error: (err as Error)?.message,
          });
        }
        // Apply truncation if governor says so and output is verbose
        if (truncLimit > 0 && finalOutput.length > truncLimit) {
          finalOutput =
            finalOutput.slice(0, truncLimit) +
            `\n...[truncated: ${masked.output.length - truncLimit} chars]`;
        }
        const tsNum = steps.length + 1;
        const toolStep: AgentExecutionStep = {
          stepNumber: tsNum,
          timestamp: now(),
          type: 'tool_result',
          content: finalOutput,
          durationMs: masked.durationMs,
        };

        // ── Hook: onStepComplete ──
        getHookManager()
          .fireOnStepComplete({
            runId,
            agentId: ctx.agentId,
            stepNumber: tsNum,
            type: 'tool_result',
            content: finalOutput,
          })
          .catch((e) =>
            getGlobalLogger().debug('AgentRuntime', 'onStepComplete hook failed', {
              error: (e as Error)?.message,
            }),
          );

        steps.push(toolStep);

        // SecurityOrchestrator: feed tool result into GuardianAgent + CrossAgentCorrelator
        try {
          const toolEvent: CrossAgentEvent = {
            id: generateId(),
            agentId: ctx.agentId,
            runId,
            type: 'tool_result',
            summary: `Tool ${masked.name}: ${finalOutput.slice(0, 80)}`,
            metadata: {
              toolName: masked.name,
              toolCallId: masked.toolCallId,
              outputLength: finalOutput.length,
              hasError: !!masked.error,
            },
            timestamp: Date.now(),
            severity: (masked.error ? 'high' : 'low') as CrossAgentEvent['severity'],
          };
          this.deps.getSecurityOrch().onAgentEvent(toolEvent);
        } catch (err) {
          reportSilentFailure(err, 'agentRuntime:2791');
          /* best-effort */
        }

        const assistantMsg: import('./types').LLMMessage = {
          role: 'assistant',
          content: response.content,
          ...(response.reasoning_content ? { reasoning_content: response.reasoning_content } : {}),
          ...(response.toolCalls
            ? {
                tool_calls: response.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                })),
              }
            : {}),
        };
        request.messages.push(assistantMsg, {
          role: 'tool',
          content: finalOutput,
          tool_call_id: masked.toolCallId,
        });
      }

      // ── Sliding Window + Memory Solidification ──
      // Before the follow-up LLM call, increment the turn counter,
      // solidify completed turns to episodic memory (if due),
      // enforce the window boundary, and retrieve relevant context.
      this.deps.getSlidingWindow().incrementTurn();

      const memory = this.deps.getMemory();
      if (memory) {
        // 1. Solidify completed turns to memory (every N turns)
        try {
          const solidifyResult = await this.deps
            .getSlidingWindow()
            .solidifyCompletedTurns(request.messages, memory, ctx.goal, runId);
          if (solidifyResult.turnsSolidified > 0) {
            bus.publish('system.alert', 'runtime', {
              type: 'sliding_window_solidify',
              turnsSolidified: solidifyResult.turnsSolidified,
              tokensFreed: solidifyResult.tokensFreed,
            });
          }
        } catch (e) {
          getGlobalLogger().debug('AgentRuntime', 'Sliding window solidify failed (best-effort)', {
            error: (e as Error)?.message,
          });
        }

        // 2. Apply sliding window (enforce max turns in context)
        // request.messages is mutated in-place, so the subsequent
        // followUpRequest will automatically reference the updated array.
        try {
          const windowResult = this.deps.getSlidingWindow().applyWindow(request.messages);
          if (windowResult.applied) {
            bus.publish('system.alert', 'runtime', {
              type: 'sliding_window_applied',
              turnsDropped: windowResult.turnsDropped,
              tokensFreed: windowResult.tokensFreed,
            });
          }
        } catch (e) {
          getGlobalLogger().debug('AgentRuntime', 'Sliding window apply failed (best-effort)', {
            error: (e as Error)?.message,
          });
        }

        // 3. Retrieve relevant context from memory and inject
        try {
          const retrievalResult = this.deps
            .getSlidingWindow()
            .retrieveContext(memory, ctx.goal, request.messages);
          if (retrievalResult.entriesRetrieved > 0 && retrievalResult.injectedContext.length > 0) {
            // Inject as a system message before the last user message
            // This keeps prompt-cache stability (injected before variable content)
            request.messages.splice(request.messages.length - 1, 0, {
              role: 'system' as const,
              content: retrievalResult.injectedContext,
            });

            bus.publish('system.alert', 'runtime', {
              type: 'sliding_window_retrieval',
              entriesRetrieved: retrievalResult.entriesRetrieved,
              injectedTokens: retrievalResult.injectedTokens,
            });
          }
        } catch (e) {
          getGlobalLogger().debug('AgentRuntime', 'Sliding window retrieval failed (best-effort)', {
            error: (e as Error)?.message,
          });
        }
      }

      // Resume the model with tool results
      // followUpRequest is created fresh from the mutated request object,
      // so it correctly sees the updated messages array.
      const followUpCtx = { request, agentId: ctx.agentId, runId };
      const followUpRequest = await getHookManager().fireBeforeLLMCall(followUpCtx);
      const followUp = await this.deps.callWithTimeout(followUpRequest, routing);
      await getHookManager().fireAfterLLMCall({
        request: followUpRequest,
        response: followUp,
        agentId: ctx.agentId,
        runId,
      });
      if (!followUp) break;
      totalTokens.promptTokens += followUp.usage.promptTokens;
      totalTokens.completionTokens += followUp.usage.completionTokens;
      totalTokens.totalTokens += followUp.usage.totalTokens;
      totalTokens.cacheReadTokens =
        (totalTokens.cacheReadTokens ?? 0) + (followUp.usage.cacheReadTokens ?? 0);
      this.deps.getGovernor().reportUsage(followUp.usage.totalTokens);
      ctx.guard?.recordTokens(followUp.usage.totalTokens);
      response = followUp;

      // Hallucination detection on the follow-up response.
      try {
        const userInput = followUpRequest.messages
          .filter((m) => m.role === 'user')
          .map((m) => m.content)
          .join('\n')
          .slice(0, 4000);
        const report = getHallucinationDetector().analyze(
          userInput,
          followUp.content?.slice(0, 4000) ?? '',
        );
        this.deps.setLastHallucinationDetected(
          report.recommendation === 'reject' || report.recommendation === 'flag_for_review',
        );
      } catch (err) {
        reportSilentFailure(err, 'agentRuntime:hallucination-detection-followup');
        this.deps.setLastHallucinationDetected(false);
      }

      // Enforce sub-agent step and progress limits at each tool loop iteration
      ctx.guard?.check(cumulativeEvidence);

      // Context compaction: check every iteration after the first.
      // The compactor's own layer thresholds (60%/70%/82%/92% full) decide whether to act.
      // This prevents context bloat before the LLM call that would waste tokens.
      if (toolLoopCount > 1) {
        const tokensBefore = this.deps.getCompactor().getUsage(request.messages).total;
        const tt = detectTaskType(ctx.goal);
        const taskType: CompactTaskType = tt === 'creative' ? 'general' : tt;

        // ── Hook: beforeContextCompaction ──
        getHookManager()
          .fireBeforeContextCompaction({
            messageCount: request.messages.length,
            totalTokens: tokensBefore,
            budgetTokens: this.deps.getConfig().budgetHardCapTokens || 128000,
            agentId: ctx.agentId,
            runId,
          })
          .catch((e) =>
            getGlobalLogger().debug('AgentRuntime', 'beforeContextCompaction hook failed', {
              error: (e as Error)?.message,
            }),
          );

        const compactResult = this.deps
          .getCompactor()
          .compact(request.messages, undefined, taskType);
        if (compactResult.action.droppedCount > 0) {
          request.messages = compactResult.messages;
          this.deps
            .getGovernor()
            .recordOutcome(
              'context_compaction',
              tokensBefore,
              this.deps.getCompactor().getUsage(request.messages).total,
            );
          bus.publish('system.alert', 'runtime', {
            type: 'context_compaction',
            layer: compactResult.action.layer,
            droppedCount: compactResult.action.droppedCount,
            tokensSaved: compactResult.action.tokensSaved,
          });

          // ── Hook: afterContextCompaction ──
          getHookManager()
            .fireAfterContextCompaction({
              messageCount: request.messages.length,
              totalTokens: this.deps.getCompactor().getUsage(request.messages).total,
              budgetTokens: this.deps.getConfig().budgetHardCapTokens || 128000,
              agentId: ctx.agentId,
              runId,
            })
            .catch((e) =>
              getGlobalLogger().debug('AgentRuntime', 'afterContextCompaction hook failed', {
                error: (e as Error)?.message,
              }),
            );
        }
      }
    }
    console.warn(
      `[TOOL LOOP] EXIT after ${toolLoopCount} iterations. calls=${response.toolCalls?.length} cycle=${cycleDetected} retry=${retryLoopDetected} phase=${this.deps.getGovernor().getState().phase}`,
    );

    return {
      response,
      earlyExit,
      interruptData,
      largestFileWriteContent,
    };
  }
}
