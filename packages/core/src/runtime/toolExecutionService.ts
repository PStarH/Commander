/**
 * ToolExecutionService — owns the actual execution of a single tool call.
 *
 * Extracted from AgentRuntime to shrink the god object. The service receives
 * all runtime state it needs through a `ToolExecutionRuntime` interface, so
 * AgentRuntime can pass `this` without creating a circular module dependency.
 */

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
import { getGuardianAgent } from '../security/guardianAgent';
import { getExecutionScheduler, type RunHandle } from '../atr/scheduler';
import { generateIdempotencyKey } from '../atr/canonicalJson';
import { StepErrorBoundary } from './stepErrorBoundary';
import { ToolRegistry } from '../tools/toolRegistry';
import { repairToolCallArguments, suggestRepairsForValidationErrors } from './toolCallRepair';
import {
  validateToolCall,
  formatValidationErrors,
  formatValidationErrorsJson,
} from './toolCallValidator';
import { isMutationTool } from './runtimeHelpers';
import { ReflexionGenerator, type Reflexion, type ReflexionContext } from './reflexionGenerator';
import type { CompensationService } from './compensationService';
import type { CacheManager } from './cacheManager';
import type { DeadLetterQueue } from './deadLetterQueue';
import type { StepTimeoutManager } from './stepTimeoutManager';
import type { PlannedToolCall } from '../compensation/rollbackPlanner';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

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
}

export class ToolExecutionService {
  constructor(private runtime: ToolExecutionRuntime) {}

  async execute(
    runId: string,
    toolCall: ToolCall,
    agentId: string,
    tenantId?: string,
    allowedTools?: string[],
    agentCtx?: AgentExecutionContext,
    executedMutations?: PlannedToolCall[],
  ): Promise<ToolResult> {
    const tracer = getTraceRecorder();
    const bus = getMessageBus();
    const startTime = Date.now();
    try {
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

      // C2/Phase 3: Schedule tool call through ExecutionScheduler for idempotency + replay
      let schedulerActionId: string | null = null;
      const runHandle = this.runtime.getRunHandle();
      if (runHandle) {
        try {
          const idempotencyKey = generateIdempotencyKey({
            externalSystem: tool.externalSystem ?? toolCall.name,
            toolName: toolCall.name,
            args: validatedArgs as Record<string, unknown>,
            intentHash: runHandle.intentHash,
            runId,
            stepId: toolCall.id ?? actionId,
          });
          const scheduleResult = getExecutionScheduler().scheduleAction({
            runId,
            leaseToken: runHandle.leaseToken,
            fencingEpoch: runHandle.fencingEpoch,
            toolName: toolCall.name,
            externalSystem: tool.externalSystem ?? toolCall.name,
            args: validatedArgs as Record<string, unknown>,
            idempotencyKey,
            compensable: isMutation,
            tags: ['tool_execution', toolCall.name],
            description: `${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 200)})`,
            tenantId,
          });
          if (scheduleResult) {
            schedulerActionId = scheduleResult.actionId;
            if (scheduleResult.replayed) {
              const durationMs = Date.now() - startTime;
              const cachedOutput = scheduleResult.cachedResult;
              if (cachedOutput !== undefined) {
                tracer.recordToolExecution(
                  runId,
                  toolCall.name,
                  toolCall.arguments,
                  cachedOutput,
                  durationMs,
                );
                getMetricsCollector().recordToolCall(
                  toolCall.name,
                  durationMs,
                  undefined,
                  tenantId,
                );
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
              const cachedError = scheduleResult.cachedError;
              if (cachedError) {
                tracer.recordToolExecution(
                  runId,
                  toolCall.name,
                  toolCall.arguments,
                  '',
                  durationMs,
                  cachedError,
                );
                getMetricsCollector().recordToolCall(
                  toolCall.name,
                  durationMs,
                  cachedError,
                  tenantId,
                );
                return {
                  toolCallId: toolCall.id,
                  name: toolCall.name,
                  output: '',
                  error: cachedError,
                  durationMs,
                };
              }
            }
          }
        } catch (e) {
          getGlobalLogger().debug(
            'ToolExecutionService',
            'Scheduler scheduleAction failed; running without ATR ledger',
            { runId, toolName: toolCall.name, error: (e as Error).message },
          );
        }
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
              // Log the policy decision but allow execution (approval system handles prompting)
              getGlobalLogger().debug(
                'ToolExecutionService',
                `ExecPolicy: "${command.slice(0, 80)}..." requires approval (rule: ${decision.rule?.id})`,
              );
            }
          } catch (e) {
            // Policy engine load failure — proceed without gating (fail-open for availability)
            getGlobalLogger().warn(
              'ToolExecutionService',
              'ExecPolicy load failed, proceeding without gate',
              { error: (e as Error)?.message },
            );
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

      // Guardian security check
      try {
        const intervention = getGuardianAgent().monitor({
          agentId,
          runId,
          timestamp: Date.now(),
          type: 'tool_call',
          content: `${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 200)})`,
          metadata: { args: toolCall.arguments },
        });
        if (intervention) {
          const errorMsg = `GUARDIAN_BLOCKED: ${intervention} by security guardian for ${toolCall.name}`;
          const durationMs = Date.now() - startTime;
          bus.publish('tool.blocked', agentId, {
            runId,
            toolName: toolCall.name,
            reason: 'guardian_blocked',
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
      } catch {
        /* best-effort */
      }

      let latestReflexion: Reflexion | null = null;
      let lastReflexionAttempt = 0;

      const boundaryResult = await boundary.execute<string>(
        toolCall.name,
        'tool',
        async () => {
          return this.runtime.stepTimeout.wrap(tool.execute(validatedArgs, agentCtx), {
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
        const hash = crypto.createHash('md5').update(output).digest('hex').slice(0, 8);
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
      } catch {
        /* best-effort */
      }
    }
  }
}
