/**
 * ToolStepExecutor — executes tool steps that don't require an agent.
 *
 * Tool steps are direct function calls to registered tools (e.g., http.get,
 * git.push, file.write). They differ from agent steps in that no LLM reasoning
 * is involved — the tool is called with the step's input arguments directly.
 *
 * The executor uses the EffectBroker for external side effects and the
 * plugin sandbox for untrusted tool code.
 */

import type { StepExecutor, ClaimedStep, WorkerRecord } from './types.js';
import { WorkerExecutionError } from './types.js';
import type { CapabilityTokenIssuer, WorkloadBinding } from '@commander/effect-broker';
import {
  assertEffectBrokerForProduction,
  mustRouteExternalEffectThroughBroker,
} from './effectGate.js';
import type { ToolEffectCatalog } from './toolEffectCatalog.js';
import { DENY_ALL_TOOL_EFFECT_CATALOG } from './toolEffectCatalog.js';
import {
  getStepWorkloadBinding,
  mintStepCapabilityToken,
  requireStepWorkloadBinding,
} from './stepWorkloadIdentity.js';

export interface ToolStepInput {
  /** Tool name (e.g., "http.get", "git.push"). */
  toolName: string;
  /** Tool arguments. */
  args: Record<string, unknown>;
  /** Whether this tool produces external side effects. */
  hasExternalEffects?: boolean;
  /** Pure-local tool (no external IO). Required in production to bypass the broker. */
  localOnly?: boolean;
  /** Effect Broker fields. External tools must not execute without them. */
  effectId?: string;
  idempotencyKey?: string;
  capabilityToken?: string;
  /** Optional timeout override in milliseconds. */
  timeoutMs?: number;
}

export interface ToolStepOutput {
  result: unknown;
  durationMs: number;
  toolName: string;
}

export interface ToolRegistry {
  /** Look up a tool by name. Returns null if not found. */
  get(toolName: string): ToolHandler | null;
}

export interface ExternalEffectBroker {
  execute(input: {
    effectId: string;
    token: string;
    type: string;
    request: Record<string, unknown>;
    idempotencyKey: string;
    lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
    actor: string;
    timeoutMs?: number;
    workloadBinding?: WorkloadBinding;
  }): Promise<{ effectId: string; replayed: boolean; response?: Record<string, unknown> }>;
}

export interface ToolHandler {
  /** Execute the tool with the given arguments. */
  execute(args: Record<string, unknown>, ctx: { signal: AbortSignal; tenantId: string; runId: string; stepId: string }): Promise<unknown>;
}

export class ToolStepExecutor implements StepExecutor {
  private readonly toolRegistry: ToolRegistry;
  private readonly effectBroker?: ExternalEffectBroker;
  private readonly capabilityIssuer?: CapabilityTokenIssuer;
  private readonly catalog: ToolEffectCatalog;

  constructor(
    toolRegistry?: ToolRegistry,
    effectBroker?: ExternalEffectBroker,
    capabilityIssuer?: CapabilityTokenIssuer,
    catalog?: ToolEffectCatalog,
  ) {
    assertEffectBrokerForProduction('tool step executor', effectBroker);
    // If no registry provided, use an empty one — tools must be registered
    this.toolRegistry = toolRegistry ?? { get: () => null };
    this.effectBroker = effectBroker;
    this.capabilityIssuer = capabilityIssuer;
    this.catalog = catalog ?? DENY_ALL_TOOL_EFFECT_CATALOG;
  }

  async execute(
    step: ClaimedStep,
    context: { signal: AbortSignal; worker: WorkerRecord },
  ): Promise<Record<string, unknown> | undefined> {
    const input = step.input as unknown as ToolStepInput;

    if (!input.toolName || typeof input.toolName !== 'string') {
      throw new WorkerExecutionError(
        `Step ${step.id} missing required field: toolName`,
        { code: 'INVALID_INPUT', retryable: false },
      );
    }

    if (
      mustRouteExternalEffectThroughBroker(input, {
        brokerPresent: this.effectBroker != null,
        toolName: input.toolName,
        catalog: this.catalog,
      })
    ) {
      if (!this.effectBroker) {
        throw new WorkerExecutionError('External tool execution requires an Effect Broker', {
          code: 'EFFECT_BROKER_UNAVAILABLE',
          retryable: false,
        });
      }
      if (!step.lease || !input.effectId || !input.idempotencyKey) {
        throw new WorkerExecutionError('External tool execution requires effectId, idempotencyKey, and a live step lease', { code: 'EFFECT_AUTHORIZATION_REQUIRED', retryable: false });
      }
      const request = input.args ?? {};
      let capabilityToken = input.capabilityToken;
      const production =
        process.env.NODE_ENV === 'production' ||
        process.env.COMMANDER_PROFILE === 'enterprise' ||
        process.env.COMMANDER_REQUIRE_WORKLOAD_BINDING === '1';
      let workloadBinding = getStepWorkloadBinding();
      if (this.capabilityIssuer) {
        workloadBinding = requireStepWorkloadBinding();
        capabilityToken = mintStepCapabilityToken({
          issuer: this.capabilityIssuer,
          effectType: input.toolName,
          request,
        });
      } else if (production) {
        throw new WorkerExecutionError(
          'External tool execution requires CapabilityTokenIssuer for step-bound mint in production',
          { code: 'EFFECT_CAPABILITY_ISSUER_REQUIRED', retryable: false },
        );
      }
      if (!capabilityToken) {
        throw new WorkerExecutionError('External tool execution requires capabilityToken or capabilityIssuer', { code: 'EFFECT_AUTHORIZATION_REQUIRED', retryable: false });
      }
      try {
        const result = await this.effectBroker.execute({
          effectId: input.effectId,
          token: capabilityToken,
          type: input.toolName,
          request,
          idempotencyKey: input.idempotencyKey,
          lease: step.lease,
          actor: context.worker.id,
          timeoutMs: input.timeoutMs,
          workloadBinding,
        });
        return { result: result.response, effectId: result.effectId, replayed: result.replayed, toolName: input.toolName };
      } catch (error) {
        if (error instanceof WorkerExecutionError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new WorkerExecutionError(message, { code: 'EFFECT_EXECUTION_FAILED', retryable: false, details: { toolName: input.toolName, stepId: step.id } });
      }
    }

    const handler = this.toolRegistry.get(input.toolName);
    if (!handler) {
      throw new WorkerExecutionError(
        `Tool '${input.toolName}' not found in registry`,
        { code: 'TOOL_NOT_FOUND', retryable: false },
      );
    }

    const started = Date.now();
    const timeoutMs = input.timeoutMs ?? 30_000;
    // Linked controller so timeout actually cancels cooperative handlers (Promise.race alone does not).
    const local = new AbortController();
    const onParentAbort = () => {
      if (!local.signal.aborted) local.abort(context.signal.reason ?? new Error('aborted'));
    };
    if (context.signal.aborted) onParentAbort();
    else context.signal.addEventListener('abort', onParentAbort, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!local.signal.aborted) local.abort(new Error(`Tool '${input.toolName}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      const result = await handler.execute(input.args ?? {}, {
        signal: local.signal,
        tenantId: step.tenantId,
        runId: step.runId,
        stepId: step.id,
      });

      const output: ToolStepOutput = {
        result,
        durationMs: Date.now() - started,
        toolName: input.toolName,
      };
      return output as unknown as Record<string, unknown>;
    } catch (error) {
      if (timedOut) {
        throw new WorkerExecutionError(
          `Tool '${input.toolName}' timed out after ${timeoutMs}ms`,
          { code: 'TIMEOUT', retryable: true, retryDelayMs: 10_000, details: { toolName: input.toolName, stepId: step.id } },
        );
      }
      if (context.signal.aborted || local.signal.aborted) {
        throw new WorkerExecutionError('Tool execution aborted', {
          code: 'ABORTED',
          retryable: true,
          retryDelayMs: 1000,
          details: { toolName: input.toolName, stepId: step.id },
        });
      }
      if (error instanceof WorkerExecutionError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new WorkerExecutionError(message, {
        code: 'TOOL_EXECUTION_FAILED',
        retryable: this.isRetryable(error),
        retryDelayMs: 5_000,
        details: { toolName: input.toolName, stepId: step.id },
      });
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', onParentAbort);
    }
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('econnreset')) return true;
      if (msg.includes('rate limit') || msg.includes('429') || msg.includes('503')) return true;
    }
    return false;
  }
}
