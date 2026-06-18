/**
 * ReliabilityEngine — Unified resilience facade for Commander.
 *
 * Encapsulates the four core resilience subsystems into a single,
 * injectable engine so that AgentRuntime and other callers never
 * depend on low-level implementation classes directly.
 *
 * Subsystems:
 *   - CircuitBreaker     → failure-aware gating of LLM / tool calls
 *   - DeadLetterQueue    → persistent audit log of unrecoverable failures
 *   - CompensationRegistry → undo side-effects of failed mutation tools
 *   - StateCheckpointer  → crash-safe atomic execution snapshots
 *
 * @example
 * ```typescript
 * const engine = new ReliabilityEngine({ threshold: 5, recoveryTimeMs: 30_000 });
 * engine.registerCompensation('file_write', async (action) => {
 *   await fs.promises.unlink(action.args.path as string);
 *   return { success: true };
 * });
 *
 * if (!engine.isAvailable()) throw new Error('Circuit open');
 * engine.recordAction({ actionId: 'a1', toolName: 'file_write', ... });
 * engine.checkpoint({ runId, phase: 'started', ... });
 * ```
 */

import { CircuitBreaker, type CircuitStats } from './circuitBreaker';
import {
  DeadLetterQueue,
  type DeadLetterEntry,
  type DLQCategory,
  type FailureMode,
} from './deadLetterQueue';
import type { ErrorClass } from './llmRetry';
import type { CompensationHandler, CompensableAction } from './compensationRegistry';
import { CompensationRegistry } from './compensationRegistry';
import { StateCheckpointer, type CheckpointState } from './stateCheckpointer';
import { getMetricsCollector } from './metricsCollector';
import type { LeaseManager } from '../atr/leaseManager';
import type { CompensationQueue } from '../atr/compensationQueue';

// ============================================================================
// Configuration
// ============================================================================

export interface ReliabilityEngineConfig {
  /** Circuit breaker: failure threshold before opening. Default 5. */
  circuitThreshold?: number;
  /** Circuit breaker: cooldown before half-open probe (ms). Default 30_000. */
  circuitRecoveryMs?: number;
  /** Circuit breaker: max half-open probes before full close. Default 1. */
  circuitHalfOpenMaxTests?: number;
  /** Dead letter queue: base directory for .ndjson files. */
  dlqBaseDir?: string;
  /** State checkpointer: base directory for checkpoint files. */
  checkpointBaseDir?: string;
  /** Tenant ID for scoped storage isolation. */
  tenantId?: string;
  /** Lease manager for fenced checkpoint writes. */
  leaseManager?: LeaseManager;
  /** Durable compensation queue (requires better-sqlite3). */
  compensationQueue?: CompensationQueue;
}

// ============================================================================
// Stats
// ============================================================================

export interface ReliabilityStats {
  circuit: CircuitStats;
  dlq: Array<{ category: string; count: number }>;
  compensation: { pending: number; compensated: number };
  checkpointCount: number;
}

// ============================================================================
// ReliabilityEngine
// ============================================================================

export class ReliabilityEngine {
  private _circuitBreaker: CircuitBreaker;
  private _deadLetterQueue: DeadLetterQueue;
  private _compensationRegistry: CompensationRegistry;
  private _stateCheckpointer: StateCheckpointer;

  private disposed = false;

  constructor(config: ReliabilityEngineConfig = {}) {
    const threshold = config.circuitThreshold ?? 5;
    const recoveryMs = config.circuitRecoveryMs ?? 30_000;
    const halfOpenTests = config.circuitHalfOpenMaxTests ?? 1;

    this._circuitBreaker = new CircuitBreaker(threshold, recoveryMs, halfOpenTests);
    this._circuitBreaker.setProviderName('reliabilityEngine');

    this._deadLetterQueue = new DeadLetterQueue(config.dlqBaseDir);
    this._compensationRegistry = new CompensationRegistry();
    this._stateCheckpointer = new StateCheckpointer(config.checkpointBaseDir, config.tenantId, {
      leaseManager: config.leaseManager,
    });

    // Wire observability
    this._circuitBreaker.setObservability({
      onTransition: (from, to, provider) => {
        try {
          getMetricsCollector().recordCircuitTransition(from, to, provider ?? 'reliabilityEngine');
        } catch {
          /* best-effort */
        }
        try {
          this._deadLetterQueue.enqueue({
            category: 'circuit_breaker',
            operationName: 'circuit.transition',
            errorMessage: `${from}->${to}`,
            tags: [`from:${from}`, `to:${to}`],
            failureMode: 'circuit_open',
          });
        } catch {
          /* best-effort */
        }
      },
    });

    // Wire durable compensation queue for crash-safe retry
    if (config.compensationQueue) {
      try {
        this._compensationRegistry.setCompensationQueue(config.compensationQueue);
      } catch {
        /* queue requires better-sqlite3; skip durable retry */
      }
    }

    this._compensationRegistry.setObservability({
      onSuccess: (action) => {
        try {
          getMetricsCollector().recordCompensation(action.toolName, 'success');
        } catch {
          /* best-effort */
        }
      },
      onFailed: (action, err) => {
        try {
          getMetricsCollector().recordCompensation(action.toolName, 'failed');
        } catch {
          /* best-effort */
        }
      },
      onExhausted: (action, err) => {
        try {
          getMetricsCollector().recordCompensation(action.toolName, 'exhausted');
        } catch {
          /* best-effort */
        }
        try {
          this._deadLetterQueue.enqueue({
            category: 'compensation',
            operationName: 'compensation.exhausted',
            errorMessage: err,
            tags: [action.toolName],
            failureMode: 'compensation_exhausted',
          });
        } catch {
          /* best-effort */
        }
      },
    });
  }

  // ── Semantic Circuit Breaker Wiring ─────────────────────────────────────

  /** Set a handler for semantic trip events (verification degradation, etc.). */
  setSemanticTripHandler(handler: (consecutiveFailures: number, reason: string) => void): void {
    this._circuitBreaker.setSemanticTripHandler(handler);
  }

  // ── Circuit Breaker ──────────────────────────────────────────────────────

  /** Whether the circuit is currently closed (calls allowed). */
  isAvailable(): boolean {
    return this._circuitBreaker.isAvailable();
  }

  /** Report a successful operation to the circuit breaker. */
  recordSuccess(): void {
    this._circuitBreaker.onSuccess();
  }

  /** Report a failed operation to the circuit breaker. */
  recordFailure(): void {
    this._circuitBreaker.onFailure();
  }

  /** Record a semantic/quality failure (verification, hallucination, etc.). */
  recordSemanticFailure(reason: string): void {
    this._circuitBreaker.recordSemanticFailure(reason);
  }

  /** Reset semantic failure counter after recovery. */
  recordSemanticSuccess(): void {
    this._circuitBreaker.recordSemanticSuccess();
  }

  /** Get semantic health status. */
  getSemanticHealth(): { consecutiveFailures: number; tripped: boolean; lastFailureTime: number } {
    return this._circuitBreaker.getSemanticHealth();
  }

  /** Record a semantic drift event. */
  recordSemanticDrift(score: number): void {
    this._circuitBreaker.onSemanticDrift(score);
  }

  /** Record a security event (e.g. HIGH/CRITICAL threat detected). */
  recordSecurityEvent(severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'): void {
    this._circuitBreaker.onSecurityEvent(severity);
  }

  // ── Dead Letter Queue ────────────────────────────────────────────────────

  /** Record a failure entry to the persistent dead letter queue. */
  recordDLQ(entry: DeadLetterEntry): void {
    this._deadLetterQueue.record(entry);
  }

  /** Enqueue a failure entry from a partial spec (fills sensible defaults). */
  enqueueDLQ(spec: {
    category: DLQCategory;
    runId?: string;
    agentId?: string;
    missionId?: string;
    operationName: string;
    errorMessage: string;
    errorClass?: ErrorClass;
    retryable?: boolean;
    attemptNumber?: number;
    compensated?: boolean;
    recovered?: boolean;
    failureMode?: FailureMode;
    tags?: string[];
    payload?: Record<string, unknown>;
  }): void {
    this._deadLetterQueue.enqueue(spec);
  }

  /** Read recent entries from a dead letter category. */
  readDLQ(category: DLQCategory, limit?: number): DeadLetterEntry[] {
    return this._deadLetterQueue.readEntries(category, limit);
  }

  /** Get retryable DLQ entries that haven't been recovered. */
  getRetryableEntries(category: DLQCategory, limit?: number): DeadLetterEntry[] {
    return this._deadLetterQueue.getRetryableEntries(category, limit);
  }

  // ── Compensation Registry ────────────────────────────────────────────────

  /** Register a compensation handler for a mutation tool. */
  registerCompensation(toolName: string, handler: CompensationHandler): void {
    this._compensationRegistry.register(toolName, handler);
  }

  /** Record an action for potential compensation. */
  recordAction(action: CompensableAction): void {
    this._compensationRegistry.recordAction(action);
  }

  /** Compensate a single action by ID. */
  async compensate(actionId: string): Promise<{ success: boolean; error?: string }> {
    return this._compensationRegistry.compensate(actionId);
  }

  /** Compensate all pending actions (reverse order, max 3 attempts each). */
  async compensateAll(): Promise<{ succeeded: number; failed: number; errors: string[] }> {
    return this._compensationRegistry.compensateAll();
  }

  /** Process due items from the durable compensation queue. */
  async processCompensationQueue(): Promise<number> {
    return this._compensationRegistry.processQueue();
  }

  // ── State Checkpointer ───────────────────────────────────────────────────

  /** Write a crash-safe atomic checkpoint. */
  checkpoint(state: CheckpointState): void {
    this._stateCheckpointer.checkpoint(state);
  }

  /** Write a terminal checkpoint and clean up in-progress artifacts. */
  terminalCheckpoint(state: CheckpointState): void {
    this._stateCheckpointer.terminalCheckpoint(state);
  }

  /** Load the latest checkpoint for a run (validates lease if bound). */
  loadCheckpoint(runId: string): CheckpointState | null {
    return this._stateCheckpointer.loadCheckpoint(runId);
  }

  /** Resume from a completed checkpoint. */
  resume(runId: string): CheckpointState | null {
    return this._stateCheckpointer.resume(runId);
  }

  /** List all checkpoints. */
  listCheckpoints(): Array<{ runId: string; phase: string; timestamp: string }> {
    return this._stateCheckpointer.listCheckpoints();
  }

  /** Delete a checkpoint and all its artifacts. */
  deleteCheckpoint(runId: string): void {
    this._stateCheckpointer.deleteCheckpoint(runId);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Get a unified stats snapshot. */
  getStats(): ReliabilityStats {
    return {
      circuit: this._circuitBreaker.getStats(),
      dlq: this._deadLetterQueue.getStats(),
      compensation: {
        pending: this._compensationRegistry.getPendingCount(),
        compensated: this._compensationRegistry.getCompensatedCount(),
      },
      checkpointCount: this.listCheckpoints().length,
    };
  }

  /** Flush pending buffers and release any resources. */
  flush(): void {
    this._deadLetterQueue.flush();
  }

  /** Shut down the reliability engine, flushing all pending data. */
  shutdown(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.flush();
    this._stateCheckpointer.dispose();
    this._compensationRegistry.clear();
  }
}
