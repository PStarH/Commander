/**
 * Saga runtime — shared types.
 *
 * The saga runtime is the user-facing orchestration layer on top of the
 * ATR kernel (RunLedger + IdempotencyStore + LeaseManager). Public API
 * for the saga module.
 */
import type { RunState, CompensableAction } from '../atr/types';
export type CompensationFn<T = unknown> = (result: T) => Promise<void>;
export interface RetryPolicy {
    maxAttempts: number;
    backoff: 'fixed' | 'linear' | 'exponential';
    initialDelayMs: number;
    maxDelayMs: number;
    jitter: 'none' | 'full' | 'equal';
    retryOn?: (err: Error) => boolean;
    circuitBreakerAfter?: number;
}
export interface SagaStepOptions {
    compensate?: CompensationFn;
    compensateOrder?: 'lifo' | 'fifo';
    timeoutMs?: number;
    retryPolicy?: Partial<RetryPolicy>;
    description?: string;
    tags?: string[];
}
export interface SagaStepNode {
    kind: 'step';
    id: string;
    name: string;
    fn: (ctx: SagaContext) => Promise<unknown>;
    compensate?: CompensationFn;
    compensateOrder: 'lifo' | 'fifo';
    timeoutMs?: number;
    retryPolicy?: RetryPolicy;
    compensable: boolean;
    description?: string;
    tags: string[];
}
export interface SagaParallelNode {
    kind: 'parallel';
    id: string;
    name: string;
    branches: SagaNode[];
    failFast: boolean;
}
export interface SagaNestedNode {
    kind: 'nested';
    id: string;
    name: string;
    child: SagaGraph;
    compensateOrder: 'lifo' | 'fifo';
}
export interface SagaApprovalNode {
    kind: 'approval';
    id: string;
    name: string;
    approver: string;
    timeoutMs?: number;
    onTimeout: 'reject' | 'fail';
}
export type SagaNode = SagaStepNode | SagaParallelNode | SagaNestedNode | SagaApprovalNode;
export interface SagaGraph {
    name: string;
    description?: string;
    nodes: SagaNode[];
    rootId: string;
    timeoutMs?: number;
    defaultRetryPolicy?: RetryPolicy;
    tenantId?: string;
    metadata?: Record<string, unknown>;
}
export interface SagaContext {
    runId: string;
    parentRunId?: string;
    input: Record<string, unknown>;
    results: Map<string, unknown>;
    attempts: Map<string, number>;
    metadata: Record<string, unknown>;
    tenantId?: string;
    signal: AbortSignal;
}
export type NodeState = 'pending' | 'scheduled' | 'running' | 'completed' | 'failed' | 'compensating' | 'compensated' | 'uncompensable' | 'paused' | 'cancelled';
export interface SagaStateSnapshot {
    runId: string;
    state: RunState;
    intentHash: string;
    fencingEpoch: number;
    nodeStates: Record<string, NodeState>;
    parentRunId?: string;
    childRunIds: string[];
    createdAt: string;
    updatedAt: string;
    checkpointVersion: number;
    error?: string;
    tenantId?: string;
}
interface SagaEventBase {
    runId: string;
    fencingEpoch: number;
    timestamp: string;
}
export type SagaEventKind = 'begin' | 'step.started' | 'step.completed' | 'step.failed' | 'retry.scheduled' | 'parallel.started' | 'parallel.joined' | 'nested.started' | 'nested.completed' | 'pause' | 'resume' | 'compensate.start' | 'compensate.done' | 'circuit.opened' | 'checkpoint' | 'commit' | 'abort';
export interface SagaEvent extends SagaEventBase {
    kind: SagaEventKind;
    [key: string]: unknown;
}
/** Compensation outcome for a single node. */
export interface CompensationOutcome {
    nodeId: string;
    success: boolean;
    error?: string;
    attempts: number;
}
export interface SagaResult {
    runId: string;
    status: 'committed' | 'aborted';
    results: Record<string, unknown>;
    error?: string;
    summary: string;
    durationMs: number;
}
/** Options for SagaCoordinator.begin(). */
export interface SagaRunOptions {
    runId?: string;
    tenantId?: string;
    metadata?: Record<string, unknown>;
    ttlSeconds?: number;
    holder?: string;
    includeResults?: boolean;
}
export interface SagaRunHandle {
    runId: string;
    state: RunState;
    cancel(): void;
    snapshot(): SagaStateSnapshot;
    getNodeState(id: string): NodeState | undefined;
    leaseToken?: string;
    fencingEpoch?: number;
    intentHash?: string;
    tenantId?: string;
    metadata?: Record<string, unknown>;
    createdAt?: string;
    resumed?: boolean;
    acquired?: boolean;
}
/** Default retry policy applied when a step doesn't override. */
export declare const DEFAULT_RETRY_POLICY: RetryPolicy;
/** Default step timeout. */
export declare const DEFAULT_STEP_TIMEOUT_MS = 30000;
/** Default lease TTL. */
export declare const DEFAULT_LEASE_TTL_SECONDS = 60;
/** Default idempotency TTL (7 days). */
export declare const DEFAULT_IDEMPOTENCY_TTL_SECONDS: number;
export type { RunState, CompensableAction };
//# sourceMappingURL=types.d.ts.map