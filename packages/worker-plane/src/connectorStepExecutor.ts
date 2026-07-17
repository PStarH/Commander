/**
 * ConnectorStepExecutor — executes connector steps for external system integration.
 *
 * Connector steps differ from tool steps in that they manage long-lived
 * connections to external systems (e.g., databases, message queues, APIs)
 * and may maintain connection pools, handle reconnection, and manage
 * authentication token refresh.
 *
 * Use cases:
 * - Database queries (read/write to customer databases)
 * - Message queue publish/consume (Kafka, RabbitMQ, SQS)
 * - External API calls with managed auth (OAuth token refresh)
 * - File transfer (SFTP, S3 upload/download)
 *
 * The executor delegates to registered ConnectorHandler implementations.
 */

import type { StepExecutor, ClaimedStep, WorkerRecord } from './types.js';
import { WorkerExecutionError } from './types.js';
import type { ExternalEffectBroker } from './toolStepExecutor.js';

export interface ConnectorStepInput {
  /** Connector name (e.g., "postgres", "kafka", "s3", "http"). */
  connectorName: string;
  /** Operation to perform. */
  operation: string;
  /** Operation arguments. */
  args: Record<string, unknown>;
  /** Connection configuration (resolved at execution time). */
  connection?: ConnectorConnectionConfig;
  hasExternalEffects?: boolean;
  effectId?: string;
  idempotencyKey?: string;
  capabilityToken?: string;
  /** Optional timeout override in milliseconds. */
  timeoutMs?: number;
}

export interface ConnectorConnectionConfig {
  /** Connection string or URI. */
  uri?: string;
  /** Authentication method. */
  authMethod?: 'api_key' | 'oauth' | 'basic' | 'none';
  /** Pre-shared key reference (resolved via SecretBroker). */
  secretRef?: string;
  /** Additional connection options. */
  options?: Record<string, unknown>;
}

export interface ConnectorStepOutput {
  result: unknown;
  durationMs: number;
  connectorName: string;
  operation: string;
  bytesTransferred?: number;
}

export interface ConnectorHandler {
  /** Initialize the connection (called once per worker). */
  initialize(config: ConnectorConnectionConfig): Promise<void>;
  /** Execute an operation. */
  execute(operation: string, args: Record<string, unknown>, ctx: { signal: AbortSignal; tenantId: string; runId: string; stepId: string }): Promise<unknown>;
  /** Close the connection (called on worker shutdown). */
  close(): Promise<void>;
}

export interface ConnectorRegistry {
  /** Get a connector handler by name. */
  get(name: string): ConnectorHandler | null;
  /** Register a connector handler. */
  register(name: string, handler: ConnectorHandler): void;
}

export class ConnectorStepExecutor implements StepExecutor {
  private readonly registry: ConnectorRegistry;
  private readonly effectBroker?: ExternalEffectBroker;

  constructor(registry?: ConnectorRegistry, effectBroker?: ExternalEffectBroker) {
    this.registry = registry ?? new DefaultConnectorRegistry();
    this.effectBroker = effectBroker;
  }

  async execute(
    step: ClaimedStep,
    context: { signal: AbortSignal; worker: WorkerRecord },
  ): Promise<Record<string, unknown> | undefined> {
    const input = step.input as unknown as ConnectorStepInput;

    if (!input.connectorName || typeof input.connectorName !== 'string') {
      throw new WorkerExecutionError(
        `Step ${step.id} missing required field: connectorName`,
        { code: 'INVALID_INPUT', retryable: false },
      );
    }

    if (!input.operation || typeof input.operation !== 'string') {
      throw new WorkerExecutionError(
        `Step ${step.id} missing required field: operation`,
        { code: 'INVALID_INPUT', retryable: false },
      );
    }

    // Fail-closed: broker present → mediation required; input flag cannot bypass.
    if (this.effectBroker) {
      if (!step.lease || !input.effectId || !input.idempotencyKey || !input.capabilityToken) throw new WorkerExecutionError('External connector execution requires effectId, idempotencyKey, capabilityToken, and a live step lease', { code: 'EFFECT_AUTHORIZATION_REQUIRED', retryable: false });
      try {
        const result = await this.effectBroker.execute({ effectId: input.effectId, token: input.capabilityToken, type: `${input.connectorName}.${input.operation}`, request: input.args ?? {}, idempotencyKey: input.idempotencyKey, lease: step.lease, actor: context.worker.id, timeoutMs: input.timeoutMs });
        return { result: result.response, effectId: result.effectId, replayed: result.replayed, connectorName: input.connectorName, operation: input.operation };
      } catch (error) {
        if (error instanceof WorkerExecutionError) throw error;
        throw new WorkerExecutionError(error instanceof Error ? error.message : String(error), { code: 'EFFECT_EXECUTION_FAILED', retryable: false, details: { connectorName: input.connectorName, operation: input.operation, stepId: step.id } });
      }
    }
    if (input.hasExternalEffects) {
      throw new WorkerExecutionError('External connector execution requires an Effect Broker', { code: 'EFFECT_BROKER_UNAVAILABLE', retryable: false });
    }

    const handler = this.registry.get(input.connectorName);
    if (!handler) {
      throw new WorkerExecutionError(
        `Connector '${input.connectorName}' not found in registry`,
        { code: 'CONNECTOR_NOT_FOUND', retryable: false },
      );
    }

    // Initialize connection if config is provided
    if (input.connection) {
      await handler.initialize(input.connection);
    }

    const started = Date.now();

    try {
      const result = await Promise.race([
        handler.execute(input.operation, input.args ?? {}, {
          signal: context.signal,
          tenantId: step.tenantId,
          runId: step.runId,
          stepId: step.id,
        }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(new WorkerExecutionError(
              `Connector '${input.connectorName}' operation '${input.operation}' timed out after ${input.timeoutMs ?? 60_000}ms`,
              { code: 'TIMEOUT', retryable: true, retryDelayMs: 30_000 },
            ));
          }, input.timeoutMs ?? 60_000);
          context.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new WorkerExecutionError('Connector execution aborted', { code: 'ABORTED', retryable: true, retryDelayMs: 5000 }));
          }, { once: true });
        }),
      ]);

      const output: ConnectorStepOutput = {
        result,
        durationMs: Date.now() - started,
        connectorName: input.connectorName,
        operation: input.operation,
      };
      return output as unknown as Record<string, unknown>;
    } catch (error) {
      if (error instanceof WorkerExecutionError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new WorkerExecutionError(message, {
        code: 'CONNECTOR_EXECUTION_FAILED',
        retryable: this.isRetryable(error),
        retryDelayMs: 10_000,
        details: { connectorName: input.connectorName, operation: input.operation, stepId: step.id },
      });
    }
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('econnreset')) return true;
      if (msg.includes('rate limit') || msg.includes('429') || msg.includes('503')) return true;
      if (msg.includes('connection') && (msg.includes('refused') || msg.includes('reset'))) return true;
    }
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Default registry implementation
// ──────────────────────────────────────────────────────────────────────────

class DefaultConnectorRegistry implements ConnectorRegistry {
  private readonly handlers: Record<string, ConnectorHandler> = {};

  get(name: string): ConnectorHandler | null {
    return this.handlers[name] ?? null;
  }

  register(name: string, handler: ConnectorHandler): void {
    this.handlers[name] = handler;
  }
}
