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
import { type CircuitStats } from './circuitBreaker';
import { type DeadLetterEntry, type DLQCategory, type FailureMode } from './deadLetterQueue';
import type { ErrorClass } from './llmRetry';
import type { CompensationHandler, CompensableAction } from './compensationRegistry';
import { type CheckpointState } from './stateCheckpointer';
import type { LeaseManager } from '../atr/leaseManager';
import type { CompensationQueue } from '../atr/compensationQueue';
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
export interface ReliabilityStats {
    circuit: CircuitStats;
    dlq: Array<{
        category: string;
        count: number;
    }>;
    compensation: {
        pending: number;
        compensated: number;
    };
    checkpointCount: number;
}
export declare class ReliabilityEngine {
    private _circuitBreaker;
    private _deadLetterQueue;
    private _compensationRegistry;
    private _stateCheckpointer;
    private disposed;
    constructor(config?: ReliabilityEngineConfig);
    /** Set a handler for semantic trip events (verification degradation, etc.). */
    setSemanticTripHandler(handler: (consecutiveFailures: number, reason: string) => void): void;
    /** Whether the circuit is currently closed (calls allowed). */
    isAvailable(): boolean;
    /** Report a successful operation to the circuit breaker. */
    recordSuccess(): void;
    /** Report a failed operation to the circuit breaker. */
    recordFailure(): void;
    /** Record a semantic/quality failure (verification, hallucination, etc.). */
    recordSemanticFailure(reason: string): void;
    /** Reset semantic failure counter after recovery. */
    recordSemanticSuccess(): void;
    /** Get semantic health status. */
    getSemanticHealth(): {
        consecutiveFailures: number;
        tripped: boolean;
        lastFailureTime: number;
    };
    /** Record a semantic drift event. */
    recordSemanticDrift(score: number): void;
    /** Record a security event (e.g. HIGH/CRITICAL threat detected). */
    recordSecurityEvent(severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'): void;
    /** Record a failure entry to the persistent dead letter queue. */
    recordDLQ(entry: DeadLetterEntry): void;
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
    }): void;
    /** Read recent entries from a dead letter category. */
    readDLQ(category: DLQCategory, limit?: number): DeadLetterEntry[];
    /** Get retryable DLQ entries that haven't been recovered. */
    getRetryableEntries(category: DLQCategory, limit?: number): DeadLetterEntry[];
    /** Register a compensation handler for a mutation tool. */
    registerCompensation(toolName: string, handler: CompensationHandler): void;
    /** Record an action for potential compensation. */
    recordAction(action: CompensableAction): void;
    /** Compensate a single action by ID. */
    compensate(actionId: string): Promise<{
        success: boolean;
        error?: string;
    }>;
    /** Compensate all pending actions (reverse order, max 3 attempts each). */
    compensateAll(): Promise<{
        succeeded: number;
        failed: number;
        errors: string[];
    }>;
    /** Process due items from the durable compensation queue. */
    processCompensationQueue(): Promise<number>;
    /** Write a crash-safe atomic checkpoint. */
    checkpoint(state: CheckpointState): void;
    /** Write a terminal checkpoint and clean up in-progress artifacts. */
    terminalCheckpoint(state: CheckpointState): void;
    /** Load the latest checkpoint for a run (validates lease if bound). */
    loadCheckpoint(runId: string): CheckpointState | null;
    /** Resume from a completed checkpoint. */
    resume(runId: string): CheckpointState | null;
    /** List all checkpoints. */
    listCheckpoints(): Array<{
        runId: string;
        phase: string;
        timestamp: string;
    }>;
    /** Delete a checkpoint and all its artifacts. */
    deleteCheckpoint(runId: string): void;
    /** Get a unified stats snapshot. */
    getStats(): ReliabilityStats;
    /** Flush pending buffers and release any resources. */
    flush(): void;
    /** Shut down the reliability engine, flushing all pending data. */
    shutdown(): void;
}
//# sourceMappingURL=reliabilityEngine.d.ts.map