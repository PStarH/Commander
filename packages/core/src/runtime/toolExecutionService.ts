/**
 * ToolExecutionService — owns the actual execution of a single tool call.
 *
 * Extracted from AgentRuntime to shrink the god object. The service receives
 * all runtime state it needs through a `ToolExecutionRuntime` interface, so
 * AgentRuntime can pass `this` without creating a circular module dependency.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import type {
  ToolCall,
  ToolResult,
  Tool,
  AgentExecutionContext,
  AgentRuntimeConfig,
} from './types';
import { getMessageBus } from './messageBus';
import { getTraceRecorder } from './executionTrace';
import { getGlobalLogger } from '../logging';
import { getMetricsCollector } from './metricsCollector';
import { getHookManager } from '../pluginManager';
import { checkToolGuardian } from '../security/securityGuardianFacade';
import {
  reviewToolCall as guardianReviewToolCall,
  isRuntimeGuardianAvailable,
} from './runtimeGuardianBridge';
import { getExecutionScheduler, type RunHandle } from '../atr/scheduler';
import { StepErrorBoundary } from './stepErrorBoundary';
import { ToolRegistry } from '../tools/toolRegistry';
import { repairToolCallArguments, suggestRepairsForValidationErrors } from './toolCallRepair';
import {
  validateToolCall,
  formatValidationErrors,
  formatValidationErrorsJson,
} from './toolCallValidator';
import { isMutationTool } from './runtimeHelpers';
import { getSideEffectGate, SideEffectGateError } from './sideEffectGate';
import { getCapabilityTokenVerifier } from '../security/capabilityToken';
import { createSandboxWorkloadContext, toRuntimeWorkloadMetadata } from '../sandbox/workload';
import {
  getGlobalBiscuitCapabilityAdapter,
  BiscuitCapabilityAdapter,
} from '../security/biscuitCapabilityAdapter';
import { ReflexionGenerator, type Reflexion, type ReflexionContext } from './reflexionGenerator';
import {
  getPatternTracker,
  planSpeculativeExecution,
  isSpeculativelySafe,
} from './speculativeExecutor';
import type { CompensationService } from './compensationService';
import type { CacheManager } from './cacheManager';
import type { DeadLetterQueue } from './deadLetterQueue';
import type { StepTimeoutManager } from './stepTimeoutManager';
import type { PlannedToolCall } from '../compensation/rollbackPlanner';
import type { CircuitBreakerRegistry } from './circuitBreakerRegistry';
import type { ReversibilityGate } from '../security/reversibilityGate';
import { UniversalSanitizer } from '../security/securityPrimitives';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface ToolExecutionRuntime {
  tools: Map<string, Tool>;
  compensationService: CompensationService;
  cacheManager: CacheManager;
  dlq: DeadLetterQueue;
  getRunHandle(): RunHandle | null;
  config: AgentRuntimeConfig;
  reflexionGenerator: ReflexionGenerator;
  stepTimeout: StepTimeoutManager;
  getPromotedTools(): Set<string>;
  generateActionId(): string;
  getBreakerRegistry(): CircuitBreakerRegistry;
  reversibilityGate?: ReversibilityGate | null;
}

export class ToolExecutionService {
  /** Sliding window of recent tool call names for speculative pattern tracking */
  private recentToolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  private static readonly MAX_RECENT_CALLS = 10;
  private sanitizer = new UniversalSanitizer();

  constructor(private runtime: ToolExecutionRuntime) {}

  async execute(
    runId: string,
    toolCall: ToolCall,
    agentId: string,
    tenantId?: string,
    allowedTools?: string[],
    agentCtx?: AgentExecutionContext,
    executedMutations?: PlannedToolCall[],
    capabilityToken?: string,
  ): Promise<ToolResult> {
    const tracer = getTraceRecorder();
    const bus = getMessageBus();
    const startTime = Date.now();
    try {
      // Capability-token verification: if a token is supplied, it must authorize
      // this exact tool and argument shape. Invalid tokens are rejected.
      //
      // Dual verification: Biscuit tokens (Ed25519, 'bsc_' prefix) are verified
      // via the BiscuitCapabilityAdapter; HMAC tokens are verified via the
      // existing CapabilityTokenIssuer. This allows incremental migration
      // to Ed25519 signatures without breaking existing token issuers.
      if (capabilityToken) {
        try {
          let verdict: { ok: boolean; reason?: string; detail?: string; jti?: string };

          if (BiscuitCapabilityAdapter.isBiscuitToken(capabilityToken)) {
            // Biscuit (Ed25519) verification
            const biscuitVerifier = getGlobalBiscuitCapabilityAdapter().createVerifier(
              tenantId ?? '*',
            );
            verdict = biscuitVerifier.verify(capabilityToken, {
              tool: toolCall.name,
              args: toolCall.arguments as Record<string, unknown>,
            });
          } else {
            // HMAC verification (legacy). Worker/runtime only holds the verifier,
            // never the issuer/signing key.
            // Run-scoped tokens are reused across N tools in one execute(); do not
            // consume (jti,nonce) or concurrent tool batches get replay_detected.
            const verifier = getCapabilityTokenVerifier();
            verdict = verifier.verify(capabilityToken, {
              tool: toolCall.name,
              args: toolCall.arguments as Record<string, unknown>,
              consumeReplay: false,
            });
          }
          if (!verdict.ok) {
            const errorMsg = `CAPABILITY_TOKEN_REJECTED: ${verdict.reason}${verdict.detail ? ` (${verdict.detail})` : ''}`;
            bus.publish('tool.blocked', agentId, {
              runId,
              toolName: toolCall.name,
              reason: 'capability_token_rejected',
              detail: errorMsg,
            });
            return {
              toolCallId: toolCall.id,
              name: toolCall.name,
              output: errorMsg,
              error: errorMsg,
              durationMs: 0,
            };
          }
        } catch (err) {
          const errorMsg = `CAPABILITY_TOKEN_ERROR: ${err instanceof Error ? err.message : String(err)}`;
          bus.publish('tool.blocked', agentId, {
            runId,
            toolName: toolCall.name,
            reason: 'capability_token_error',
            detail: errorMsg,
          });
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: errorMsg,
            error: errorMsg,
            durationMs: 0,
          };
        }
      }

      if (toolCall.name.startsWith('chaos_')) {
        console.warn(
          `[ToolExecSvc] ENTER ${toolCall.name} round=${String((toolCall.arguments as { payload?: { round?: number | string } }).payload?.round ?? '?')}`,
        );
      }
      // Sub-agent tool whitelist enforcement: if an allowlist is provided,
      // reject any tool call outside the allowed set.
      if (allowedTools && !allowedTools.includes(toolCall.name)) {
        const errorMsg = `TOOL_NOT_ALLOWED: "${toolCall.name}" is not in the allowed tools list for this agent. Allowed: ${allowedTools.join(', ')}`;
        bus.publish('tool.blocked', agentId, {
          runId,
          toolName: toolCall.name,
          reason: 'not_allowed',
          detail: errorMsg,
        });
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: errorMsg,
          error: errorMsg,
          durationMs: 0,
        };
      }

      const reversibility = this.runtime.compensationService
        .getRegistry()
        .assessReversibility(toolCall.name);
      if (reversibility === 'non_reversible') {
        bus.publish('system.alert', 'runtime', {
          type: 'non_reversible_tool',
          tool: toolCall.name,
          runId,
          agentId,
        });
      }

      // ── Layer 2 ReversibilityGate: block irreversible actions without approval ──
      if (this.runtime.reversibilityGate) {
        const gateDecision = await this.runtime.reversibilityGate.evaluate(
          toolCall.name,
          toolCall.arguments as Record<string, unknown>,
          { runId, agentId },
        );
        if (!gateDecision.allowed) {
          const errorMsg = `REVERSIBILITY_GATE_BLOCKED: ${gateDecision.reason}`;
          bus.publish('tool.blocked', agentId, {
            runId,
            toolName: toolCall.name,
            reason: 'reversibility_gate_blocked',
            detail: gateDecision.reason,
          });
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: errorMsg,
            error: errorMsg,
            durationMs: 0,
          };
        }
      }

      // ── Hook: beforeToolResolve (can block by returning ToolResult) ──
      const resolveBlock = await getHookManager().fireBeforeToolResolve({
        toolName: toolCall.name,
        args: toolCall.arguments,
        agentId,
        runId,
      });
      if (resolveBlock !== null) {
        bus.publish('tool.blocked', agentId, {
          runId,
          toolName: toolCall.name,
          reason: 'hook_blocked',
          detail: resolveBlock.error ?? '',
        });
        return resolveBlock;
      }

      const tool = this.runtime.tools.get(toolCall.name);
      const toolFound = !!tool;

      // ── Hook: afterToolResolve ──
      getHookManager()
        .fireAfterToolResolve({
          toolName: toolCall.name,
          args: toolCall.arguments,
          tool: tool
            ? { name: tool.definition.name, category: tool.definition.category }
            : undefined,
          notFound: !toolFound,
          agentId,
          runId,
        })
        .catch((e) =>
          getGlobalLogger().debug('ToolExecutionService', 'afterToolResolve hook failed', {
            error: (e as Error)?.message,
          }),
        );

      if (!tool) {
        const error = `TOOL_NOT_FOUND: "${toolCall.name}" is not registered. Available: ${Array.from(this.runtime.tools.keys()).join(', ')}`;
        tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, '', 0, error);
        // Record to DLQ for dead-letter analysis
        this.runtime.dlq.record({
          id: this.runtime.generateActionId(),
          category: 'tool',
          runId,
          agentId,
          timestamp: new Date().toISOString(),
          errorClass: 'permanent',
          errorMessage: error,
          retryable: false,
          attemptNumber: 0,
          operationName: toolCall.name,
          inputSnapshot: JSON.stringify(toolCall.arguments).slice(0, 500),
          compensated: false,
          recovered: false,
          tags: ['tool_not_found', 'mode:1'],
        });
        const errorMsg = `error: ${error}\nadvice: Check the tool name and try again with a registered tool.`;
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: errorMsg,
          error: errorMsg,
          durationMs: 0,
        };
      }

      // Hallucination rejection gate (arXiv:2604.21816):
      // If the tool was not promoted to Tier 1 (full schema), the model shouldn't call it directly.
      // Reject with guidance to use request_tool first. This prevents hallucinated tool calls.
      if (
        this.runtime.getPromotedTools().size > 0 &&
        !this.runtime.getPromotedTools().has(toolCall.name)
      ) {
        const available = Array.from(this.runtime.getPromotedTools())
          .filter((n) => n !== 'request_tool')
          .join(', ');
        const errorMsg = `TOOL_NOT_PROMOTED: "${toolCall.name}" was not in the active tool set for this turn. Use request_tool to load it first, or use one of: ${available}`;
        getGlobalLogger().debug(
          'ToolExecutionService',
          `Hallucination gate: rejected call to non-promoted tool "${toolCall.name}"`,
        );
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: errorMsg,
          error: errorMsg,
          durationMs: 0,
        };
      }

      // Record compensable action for mutation tools before execution
      const isMutation = isMutationTool(toolCall.name);
      const actionId = this.runtime.generateActionId();
      if (isMutation) {
        this.runtime.compensationService.getRegistry().recordAction({
          actionId,
          toolName: toolCall.name,
          args: toolCall.arguments as Record<string, unknown>,
          description: `${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 200)})`,
          tags: ['tool', toolCall.name],
          runId,
          agentId,
        });
        const filePath = toolCall.arguments.filePath ?? toolCall.arguments.path;
        if (typeof filePath === 'string' && toolCall.name !== 'file_delete') {
          try {
            const fsMod = await import('fs');
            if (fsMod.existsSync(filePath)) {
              fsMod.copyFileSync(filePath, `${filePath}.atr-snapshot.${actionId}`);
            }
          } catch (err) {
            getGlobalLogger().debug('ToolExecutionService', 'Snapshot pre-mutation failed', {
              filePath,
              actionId,
              error: (err as Error).message,
            });
          }
        }
      }

      const effectiveTimeout = tool.timeout ?? this.runtime.config.timeoutMs;

      // Validate and repair tool call arguments before execution
      const { args: repairedArgs, repairs } = repairToolCallArguments(
        toolCall.arguments,
        toolCall.name,
      );
      const schema = tool.compiledSchema ?? ToolRegistry.getCompiledSchema(toolCall.name);
      let validatedArgs = repairedArgs;
      if (schema) {
        const validation = validateToolCall(repairedArgs, schema);
        if (!validation.valid) {
          const errorFeedback = formatValidationErrors(validation.errors, toolCall.name, repairs);
          const structuredFeedback = formatValidationErrorsJson(
            validation.errors,
            toolCall.name,
            validation.repairs ?? repairs,
            validation.repairedArgs,
          );
          structuredFeedback.errors = structuredFeedback.errors.map((e, i) => ({
            ...e,
            suggestion:
              e.suggestion ??
              suggestRepairsForValidationErrors([validation.errors[i]])[0] ??
              `Adjust '${e.path}' to match the expected schema.`,
          }));
          tracer.recordToolExecution(
            runId,
            toolCall.name,
            toolCall.arguments,
            errorFeedback,
            0,
            errorFeedback,
          );
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: JSON.stringify(structuredFeedback),
            error: errorFeedback,
            durationMs: Date.now() - startTime,
          };
        }
        validatedArgs = validation.repairedArgs ?? repairedArgs;
      }

      // Architecture V2: SideEffectGate — mandatory policy PDP + ATR scheduleAction.
      // WS2 §9: compat bypass removed; the gate is fail-closed everywhere.
      let schedulerActionId: string | null = null;
      const runHandle = this.runtime.getRunHandle();
      try {
        const admission = await getSideEffectGate().admit({
          runHandle,
          toolName: toolCall.name,
          externalSystem: tool.externalSystem ?? toolCall.name,
          args: validatedArgs as Record<string, unknown>,
          stepId: toolCall.id ?? actionId,
          compensable: isMutation,
          tags: ['tool_execution', toolCall.name],
          description: `${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 200)})`,
          tenantId,
        });
        schedulerActionId = admission.actionId;
        if (admission.replayed) {
          const durationMs = Date.now() - startTime;
          const cachedOutput = admission.cachedResult;
          if (cachedOutput !== undefined) {
            tracer.recordToolExecution(
              runId,
              toolCall.name,
              toolCall.arguments,
              cachedOutput,
              durationMs,
            );
            getMetricsCollector().recordToolCall(toolCall.name, durationMs, undefined, tenantId);
            bus.publish('tool.completed', agentId, {
              runId,
              toolName: toolCall.name,
              durationMs,
            });
            return {
              toolCallId: toolCall.id,
              name: toolCall.name,
              output: cachedOutput,
              durationMs,
            };
          }
          const cachedError = admission.cachedError;
          if (cachedError) {
            tracer.recordToolExecution(
              runId,
              toolCall.name,
              toolCall.arguments,
              '',
              durationMs,
              cachedError,
            );
            getMetricsCollector().recordToolCall(toolCall.name, durationMs, cachedError, tenantId);
            return {
              toolCallId: toolCall.id,
              name: toolCall.name,
              output: '',
              error: cachedError,
              durationMs,
            };
          }
        }
      } catch (e) {
        if (e instanceof SideEffectGateError) {
          const durationMs = Date.now() - startTime;
          const errorMsg = `SIDE_EFFECT_GATE: ${e.code}: ${e.message}`;
          bus.publish('tool.blocked', agentId, {
            runId,
            toolName: toolCall.name,
            reason: e.code,
            detail: errorMsg,
          });
          tracer.recordToolExecution(
            runId,
            toolCall.name,
            toolCall.arguments,
            '',
            durationMs,
            errorMsg,
          );
          getMetricsCollector().recordToolCall(toolCall.name, durationMs, errorMsg, tenantId);
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: '',
            error: errorMsg,
            durationMs,
          };
        }
        getGlobalLogger().debug('ToolExecutionService', 'SideEffectGate unexpected error', {
          runId,
          toolName: toolCall.name,
          error: (e as Error).message,
        });
        throw e;
      }

      // ExecPolicy gate: evaluate shell/Python commands before execution
      // Research backing: Codex CLI command safety classification, Claude Code deny-first evaluation
      if (toolCall.name === 'shell_execute' || toolCall.name === 'python_execute') {
        const command = String(validatedArgs.command ?? validatedArgs.code ?? '');
        if (command) {
          try {
            const { ExecPolicyEngine } = await import('../sandbox/execPolicy');
            const policy = new ExecPolicyEngine();
            const decision = policy.evaluate(command);
            if (decision.decision === 'forbidden') {
              const errorMsg = `EXEC_POLICY_FORBIDDEN: Command blocked by security policy. Rule: ${decision.rule?.id ?? 'unknown'}. Justification: ${decision.rule?.justification ?? 'dangerous command'}`;
              bus.publish('tool.blocked', agentId, {
                runId,
                toolName: toolCall.name,
                reason: 'exec_policy_forbidden',
                detail: errorMsg,
              });
              return {
                toolCallId: toolCall.id,
                name: toolCall.name,
                output: errorMsg,
                error: errorMsg,
                durationMs: 0,
              };
            }
            if (decision.decision === 'prompt') {
              // Block execution for commands requiring approval.
              // Previously this only logged and allowed execution, which meant
              // destructive commands like `rm -rf` could execute without approval
              // when useApproval was false (the default). Now we fail-safe by
              // blocking the command and returning an error.
              const errorMsg = `EXEC_POLICY_REQUIRES_APPROVAL: Command blocked — requires explicit approval. Rule: ${decision.rule?.id ?? 'unknown'}. Justification: ${decision.rule?.justification ?? 'destructive command'}. Command: "${command.slice(0, 100)}"`;
              bus.publish('tool.blocked', agentId, {
                runId,
                toolName: toolCall.name,
                reason: 'exec_policy_requires_approval',
                detail: errorMsg,
              });
              return {
                toolCallId: toolCall.id,
                name: toolCall.name,
                output: errorMsg,
                error: errorMsg,
                durationMs: 0,
              };
            }
          } catch (e) {
            // Policy engine load failure — fail closed for shell/Python commands.
            const errorMsg = `EXEC_POLICY_ERROR: Security policy engine unavailable: ${(e as Error)?.message}`;
            bus.publish('tool.blocked', agentId, {
              runId,
              toolName: toolCall.name,
              reason: 'exec_policy_error',
              detail: errorMsg,
            });
            return {
              toolCallId: toolCall.id,
              name: toolCall.name,
              output: errorMsg,
              error: errorMsg,
              durationMs: 0,
            };
          }
        }
      }

      bus.publish('tool.started', agentId, {
        runId,
        toolName: toolCall.name,
        args: toolCall.arguments,
      });

      const boundary = new StepErrorBoundary(
        runId,
        agentId,
        this.runtime.dlq,
        undefined,
        {
          maxRetries: 1,
          retryDelayMs: this.runtime.config.retryDelayMs,
          onExhausted: 'skip',
          onPermanent: 'abort',
        },
        this.runtime.reflexionGenerator,
      );

      // Guardian security check (unified facade — gateway + GuardianAgent)
      if (this.runtime.config.securityMonitor?.enabled !== false) {
        const guardianResult = checkToolGuardian({
          agentId,
          runId,
          toolName: toolCall.name,
          arguments: toolCall.arguments,
          sessionId: runId,
          tenantId,
        });
        if (!guardianResult.allowed) {
          const errorMsg =
            guardianResult.kind === 'guardian_blocked'
              ? `GUARDIAN_BLOCKED: ${guardianResult.reason}`
              : guardianResult.kind === 'guardian_error'
                ? `GUARDIAN_ERROR: ${guardianResult.reason}`
                : `SECURITY_GATEWAY_BLOCKED: ${guardianResult.reason}`;
          const durationMs = Date.now() - startTime;
          bus.publish('tool.blocked', agentId, {
            runId,
            toolName: toolCall.name,
            reason:
              guardianResult.kind === 'guardian_blocked'
                ? 'guardian_blocked'
                : guardianResult.kind === 'guardian_error'
                  ? 'guardian_error'
                  : 'exec_policy_forbidden',
            detail: errorMsg,
          });
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: errorMsg,
            error: errorMsg,
            durationMs,
          };
        }
      }

      // Runtime Guardian LLM review — semantic tool call analysis.
      // This complements GuardianAgent's rule-based checks with LLM understanding,
      // catching dangerous commands that don't match regex patterns (e.g.,
      // "curl ... | bash", "python -c 'import os; os.system(...)'").
      // Only runs when a provider is available; fails open on errors.
      if (isRuntimeGuardianAvailable()) {
        try {
          const goal = (this.runtime as { config?: { goal?: string } }).config?.goal || 'unknown';
          const guardianDecision = await guardianReviewToolCall(toolCall, goal);
          if (!guardianDecision.approved) {
            const errorMsg = `RUNTIME_GUARDIAN_BLOCKED: ${guardianDecision.reason}`;
            const durationMs = Date.now() - startTime;
            bus.publish('tool.blocked', agentId, {
              runId,
              toolName: toolCall.name,
              reason: 'runtime_guardian_blocked',
              detail: errorMsg,
            });
            return {
              toolCallId: toolCall.id,
              name: toolCall.name,
              output: errorMsg,
              error: errorMsg,
              durationMs,
            };
          }
        } catch (err) {
          // Fail closed: if the runtime guardian LLM review errors, block the call.
          const errorMsg = `RUNTIME_GUARDIAN_ERROR: Semantic review unavailable for ${toolCall.name}: ${err instanceof Error ? err.message : String(err)}`;
          bus.publish('tool.blocked', agentId, {
            runId,
            toolName: toolCall.name,
            reason: 'runtime_guardian_error',
            detail: errorMsg,
          });
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: errorMsg,
            error: errorMsg,
            durationMs: Date.now() - startTime,
          };
        }
      }

      let latestReflexion: Reflexion | null = null;
      let lastReflexionAttempt = 0;

      // Sanitize string values inside tool arguments before execution. This
      // strips PII, control characters, and prompt-injection markers from
      // values that originated from an untrusted LLM.
      const sanitizedArgs = this.sanitizeArguments(validatedArgs);
      // WS7 §5: inject the workload identity under the runtime-metadata `_`
      // prefix (same namespace as _agentId/_runId used by lanes/hooks) so the
      // ExecutionRouter's getWorkloadContext() sees it and a hostile tool arg
      // named `tenantId` can never collide with the injected identity. Spread
      // AFTER sanitizedArgs so injected values always win.
      const workloadContext =
        (toolCall.name === 'shell_execute' || toolCall.name === 'python_execute') && tenantId
          ? createSandboxWorkloadContext({
              tenantId,
              runId,
              stepId: toolCall.id || toolCall.name,
            })
          : null;
      const executionArgs = workloadContext
        ? { ...sanitizedArgs, ...toRuntimeWorkloadMetadata(workloadContext) }
        : sanitizedArgs;

      const boundaryResult = await boundary.execute<string>(
        toolCall.name,
        'tool',
        async () => {
          return this.runtime.stepTimeout.wrap(tool.execute(executionArgs, agentCtx), {
            timeoutMs: effectiveTimeout,
            stepId: toolCall.id || toolCall.name,
          });
        },
        {
          tags: ['tool_execution', toolCall.name],
          inputSnapshot: JSON.stringify(toolCall.arguments).slice(0, 1000),
          onReflexion: (reflexion: Reflexion, ctx: ReflexionContext) => {
            latestReflexion = reflexion;
            lastReflexionAttempt = ctx.attemptNumber;
          },
        },
      );

      if (boundaryResult.recovered) {
        bus.publish('tool.retry', agentId, {
          runId,
          toolName: toolCall.name,
          attempts: boundaryResult.attempts,
        });
        getHookManager()
          .fireOnToolRetry({
            toolName: toolCall.name,
            args: toolCall.arguments,
            attempt: boundaryResult.attempts,
            maxRetries: 1,
            lastError: boundaryResult.error ?? 'Unknown error',
            agentId,
            runId,
          })
          .catch((e) =>
            getGlobalLogger().debug('ToolExecutionService', 'onToolRetry hook failed', {
              error: (e as Error)?.message,
            }),
          );
      }

      if (!boundaryResult.success) {
        const durationMs = Date.now() - startTime;
        const errorMsg = boundaryResult.error ?? 'Unknown tool error';

        tracer.recordToolExecution(
          runId,
          toolCall.name,
          toolCall.arguments,
          '',
          durationMs,
          errorMsg,
        );
        getMetricsCollector().recordToolCall(toolCall.name, durationMs, errorMsg, tenantId);
        getMetricsCollector().recordError(boundaryResult.errorClass, tenantId);

        // If configured, open the circuit breaker immediately on permanent tool
        // failure so the LLM does not have to fail the same tool N more times.
        // Transient errors (timeouts, 5xx, retries that may recover) are left to
        // the normal retry/circuit-breaker path so the agent can retry, unless
        // openOnTransientErrors is enabled (useful for chaos/benchmark modes).
        const shouldOpenOnTransient =
          this.runtime.config.circuitBreaker?.openOnTransientErrors === true &&
          boundaryResult.errorClass === 'transient';
        if (
          (boundaryResult.errorClass === 'permanent' || shouldOpenOnTransient) &&
          this.runtime.config.circuitBreaker?.openOnFailure !== false
        ) {
          try {
            this.runtime.getBreakerRegistry().forceOpen(toolCall.name);
          } catch {
            /* best-effort */
          }
        }

        // Detect timeout from both legacy format and StepTimeoutManager
        if (errorMsg.includes('TOOL_TIMEOUT') || errorMsg.includes('exceeded timeout')) {
          bus.publish('tool.timeout', agentId, {
            runId,
            toolName: toolCall.name,
            timeoutMs: effectiveTimeout,
            durationMs,
          });
          getHookManager()
            .fireOnToolTimeout({
              toolName: toolCall.name,
              args: toolCall.arguments,
              timeoutMs: effectiveTimeout,
              durationMs,
              agentId,
              runId,
            })
            .catch((e) =>
              getGlobalLogger().debug('ToolExecutionService', 'onToolTimeout hook failed', {
                error: (e as Error)?.message,
              }),
            );
        }

        // Fire handleMutationToolFailure for mutation tools (generates rollback plan, publishes event, auto-executes safe plans)
        if (isMutationTool(toolCall.name) && executedMutations) {
          try {
            await this.runtime.compensationService.handleMutationToolFailure(
              toolCall.name,
              toolCall.arguments as Record<string, unknown>,
              errorMsg,
              executedMutations,
            );
          } catch (innerErr) {
            getGlobalLogger().debug(
              'ToolExecutionService',
              'handleMutationToolFailure threw (best-effort)',
              { actionId, error: (innerErr as Error).message },
            );
          }
        }

        // Compensate side-effects from prior mutation tools in this run
        let compensateResult = await this.runtime.compensationService
          .getRegistry()
          .compensate(actionId);
        if (!compensateResult.success) {
          compensateResult = await this.runtime.compensationService
            .getRegistry()
            .compensate(actionId);
        }
        if (!compensateResult.success) {
          getGlobalLogger().debug('ToolExecutionService', 'Compensation failed after retry', {
            actionId,
            error: compensateResult.error,
          });
        }

        if (schedulerActionId) {
          const rh = this.runtime.getRunHandle();
          if (rh) {
            try {
              getExecutionScheduler().recordError({
                runId,
                leaseToken: rh.leaseToken,
                fencingEpoch: rh.fencingEpoch,
                actionId: schedulerActionId,
                error: errorMsg,
                tenantId,
              });
            } catch (e) {
              getGlobalLogger().debug('ToolExecutionService', 'Scheduler recordError failed', {
                runId,
                toolName: toolCall.name,
                error: (e as Error).message,
              });
            }
          }
        }

        const structuredError = [
          `tool_error: "${toolCall.name}" failed after ${durationMs}ms`,
          `  reason: ${errorMsg}`,
          `  errorClass: ${boundaryResult.errorClass}`,
          `  args: ${JSON.stringify(toolCall.arguments)}`,
          ...(latestReflexion
            ? [
                ReflexionGenerator.formatForContext(
                  {
                    goal: '',
                    attemptedAction: toolCall.name,
                    actionResult: '',
                    error: errorMsg,
                    errorClass: boundaryResult.errorClass,
                    attemptNumber: lastReflexionAttempt,
                  },
                  latestReflexion,
                ),
              ]
            : []),
          `advice: `,
          `  - If this is a transient error, retry the call`,
          `  - If the arguments are invalid, correct them and retry`,
          `  - If the tool is unavailable, try a different approach`,
        ].join('\n');

        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: '',
          error: structuredError,
          durationMs,
        };
      }

      let output = boundaryResult.value as string;
      const durationMs = Date.now() - startTime;

      // Result budgeting: persist large outputs to disk, return reference
      // Token-aware truncation: keep head (first ~60%) + tail (last ~40%) for maximum informational value.
      // The head preserves context/setup; the tail preserves results/errors.
      const maxSize = tool.maxOutputSize ?? this.runtime.config.observationMaskWindow * 1000;
      if (typeof output === 'string' && output.length > maxSize && maxSize > 0) {
        // Security: Use SHA-256 instead of MD5 for cryptographic safety.
        const hash = crypto.createHash('sha256').update(output).digest('hex').slice(0, 8);
        const resultDir = path.join(process.cwd(), '.commander_results');
        try {
          await fs.promises.mkdir(resultDir, { recursive: true });
          const resultFile = path.join(resultDir, `${toolCall.name}-${hash}.txt`);
          await fs.promises.writeFile(resultFile, output, 'utf-8');
          const headSize = Math.floor(maxSize * 0.6);
          const tailSize = maxSize - headSize;
          const head = output.slice(0, headSize);
          const tail = output.length > headSize ? output.slice(-tailSize) : '';
          output = `[Large output: ${output.length} chars. Saved to ${resultFile}.]\n${head}\n... [truncated, omitted ${output.length - maxSize} chars] ...\n${tail}\n[End. Full output at ${resultFile}]`;
        } catch (e) {
          getGlobalLogger().warn('ToolExecutionService', 'Failed to persist large output', {
            error: (e as Error)?.message,
          });
          // Fall through with truncated output
          const headSize = Math.floor(maxSize * 0.6);
          const head = output.slice(0, headSize);
          const tail = output.length > headSize ? output.slice(-(maxSize - headSize)) : '';
          output = `${head}\n... [truncated, omitted ${output.length - maxSize} chars] ...\n${tail}`;
        }
      }

      tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, output, durationMs);
      getMetricsCollector().recordToolCall(toolCall.name, durationMs, undefined, tenantId);
      bus.publish('tool.executed', agentId, { toolName: toolCall.name, durationMs });
      bus.publish('tool.completed', agentId, { runId, toolName: toolCall.name, durationMs });

      if (schedulerActionId) {
        const rh = this.runtime.getRunHandle();
        if (rh) {
          try {
            getExecutionScheduler().recordResult({
              runId,
              leaseToken: rh.leaseToken,
              fencingEpoch: rh.fencingEpoch,
              actionId: schedulerActionId,
              result: output,
              tenantId,
            });
          } catch (e) {
            getGlobalLogger().debug('ToolExecutionService', 'Scheduler recordResult failed', {
              runId,
              toolName: toolCall.name,
              error: (e as Error).message,
            });
          }
        }
      }

      // PASTE speculative execution: record tool call pattern after successful
      // execution. Only records on success so failed calls don't pollute the
      // pattern database. PatternTracker learns n-gram sequences across tasks.
      try {
        this.recentToolCalls.push({
          name: toolCall.name,
          arguments: toolCall.arguments as Record<string, unknown>,
        });
        if (this.recentToolCalls.length > ToolExecutionService.MAX_RECENT_CALLS) {
          this.recentToolCalls.shift();
        }
        getPatternTracker().recordSequence([toolCall.name]);
      } catch (err) {
        reportSilentFailure(err, 'toolExecutionService:recordPattern');
      }

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: typeof output === 'string' ? output : JSON.stringify(output),
        durationMs,
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: '',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    } finally {
      const durationMs = Date.now() - startTime;
      try {
        getMetricsCollector().recordStepLatency('tool_execution', durationMs, tenantId);
      } catch (err) {
        reportSilentFailure(err, 'toolExecutionService:733');
        /* best-effort */
      }
    }
  }

  /**
   * PASTE-style speculative execution: during LLM thinking time, pre-execute
   * predicted read-only tools and cache their results in ToolResultCache.
   * When the LLM returns the actual tool call, the cache hit is consumed
   * transparently (durationMs: 0) — achieving zero-wait for predicted calls.
   *
   * Safety constraints (following CPU speculative execution best practices):
   *   - Only read-only tools (isSpeculativelySafe whitelist)
   *   - Max 2 predictions per cycle (hard limit in planSpeculativeExecution)
   *   - Min confidence 0.3 (configurable)
   *   - Fire-and-forget: never blocks the main execution loop
   *   - Wrong predictions discarded at zero cost (cache key includes args)
   *
   * Config: speculativeExecution.enabled must be true (defaults to false).
   */
  async triggerSpeculativeExecution(tenantId?: string, capabilityToken?: string): Promise<void> {
    const specConfig = (
      this.runtime.config as AgentRuntimeConfig & {
        speculativeExecution?: { enabled?: boolean };
      }
    ).speculativeExecution;
    if (!specConfig?.enabled) return;

    try {
      const tracker = getPatternTracker();
      const recentCalls = this.recentToolCalls;
      const availableTools = Array.from(this.runtime.tools.keys());

      const plan = planSpeculativeExecution(tracker, recentCalls, availableTools);

      if (plan.length === 0) return;

      const toolCache = this.runtime.cacheManager.getToolCache();

      await Promise.allSettled(
        plan.map(async (pred) => {
          if (!isSpeculativelySafe(pred.name)) return;

          const tool = this.runtime.tools.get(pred.name);
          if (!tool) return;

          // Align with formal execute path: capability is mandatory for
          // speculative cache writes. Without a token, skip entirely so a later
          // formal call cannot hit an unauthorized cache entry.
          if (!capabilityToken) return;

          const sanitizedArgs = this.sanitizeArguments(pred.arguments);

          try {
            let verdict: { ok: boolean; reason?: string; detail?: string };
            if (BiscuitCapabilityAdapter.isBiscuitToken(capabilityToken)) {
              const biscuitVerifier = getGlobalBiscuitCapabilityAdapter().createVerifier(
                tenantId ?? '*',
              );
              verdict = biscuitVerifier.verify(capabilityToken, {
                tool: pred.name,
                args: sanitizedArgs as Record<string, unknown>,
              });
            } else {
              const verifier = getCapabilityTokenVerifier();
              verdict = verifier.verify(capabilityToken, {
                tool: pred.name,
                args: sanitizedArgs as Record<string, unknown>,
                consumeReplay: false,
              });
            }
            if (!verdict.ok) return;
          } catch {
            return;
          }

          if (this.runtime.reversibilityGate) {
            const gateDecision = await this.runtime.reversibilityGate.evaluate(
              pred.name,
              sanitizedArgs as Record<string, unknown>,
              { runId: `spec_${Date.now()}`, agentId: 'speculative' },
            );
            if (!gateDecision.allowed) return;
          }

          if (this.runtime.config.securityMonitor?.enabled !== false) {
            const guardianResult = checkToolGuardian({
              agentId: 'speculative',
              runId: `spec_${Date.now()}`,
              toolName: pred.name,
              arguments: sanitizedArgs,
              sessionId: `spec_${Date.now()}`,
              tenantId,
            });
            if (!guardianResult.allowed) return;
          }

          // Build a synthetic ToolCall for cache key compatibility
          const syntheticCall: ToolCall = {
            id: `spec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: pred.name,
            arguments: sanitizedArgs,
          };

          // Skip if already cached (idempotency)
          if (toolCache.get(syntheticCall, tenantId)) return;

          const result = await tool.execute(sanitizedArgs);
          const toolResult: ToolResult = {
            toolCallId: syntheticCall.id,
            name: pred.name,
            output: typeof result === 'string' ? result : JSON.stringify(result),
            durationMs: 0, // speculative — no wall-clock cost to consumer
          };

          if (!toolResult.error) {
            toolCache.set(syntheticCall, toolResult, tenantId);
          }
        }),
      );
    } catch (err) {
      reportSilentFailure(err, 'toolExecutionService:speculativeExec');
    }
  }

  /**
   * Recursively sanitize string values inside tool arguments.
   * Non-string primitives and nested objects/arrays are preserved.
   */
  private sanitizeArguments(args: Record<string, unknown>): Record<string, unknown> {
    const sanitizeValue = (value: unknown): unknown => {
      if (typeof value === 'string') {
        return this.sanitizer.sanitize(value, 'tool_args').sanitized;
      }
      if (Array.isArray(value)) {
        return value.map(sanitizeValue);
      }
      if (value !== null && typeof value === 'object') {
        const sanitized: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
          sanitized[key] = sanitizeValue(val);
        }
        return sanitized;
      }
      return value;
    };

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      result[key] = sanitizeValue(value);
    }
    return result;
  }
}
