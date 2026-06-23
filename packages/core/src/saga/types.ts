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
  /** Circuit breaker dimension key.  Defaults to first segment of step name.
   *  All steps sharing the same key share circuit breaker state across
   *  ALL concurrent Saga instances.  Example: "stripe", "github". */
  breakerKey?: string;
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
  breakerKey?: string;
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

export type NodeState =
  | 'pending'
  | 'scheduled'
  | 'running'
  | 'completed'
  | 'failed'
  | 'compensating'
  | 'compensated'
  | 'uncompensable'
  | 'paused'
  | 'cancelled';

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
  /** Business-level idempotency key for cross-request dedup. */
  idempotencyKey?: string;
}

interface SagaEventBase {
  runId: string;
  fencingEpoch: number;
  timestamp: string;
}

export type SagaEventKind =
  | 'begin'
  | 'step.started'
  | 'step.completed'
  | 'step.failed'
  | 'retry.scheduled'
  | 'parallel.started'
  | 'parallel.joined'
  | 'nested.started'
  | 'nested.completed'
  | 'pause'
  | 'resume'
  | 'compensate.start'
  | 'compensate.done'
  | 'circuit.opened'
  | 'checkpoint'
  | 'commit'
  | 'abort';

export interface SagaEvent extends SagaEventBase {
  kind: SagaEventKind;
  [key: string]: unknown;
}

// ============================================================================
// Result types
// ============================================================================

/** Compensation outcome for a single Saga node. */
export interface SagaCompensationOutcome {
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

// ============================================================================
// Run options
// ============================================================================

/** Options for SagaCoordinator.begin(). */
export interface SagaRunOptions {
  runId?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
  ttlSeconds?: number;
  holder?: string;
  includeResults?: boolean;
  /** Business-level idempotency key.  When set, the saga engine checks
   *  if this key has already been processed BEFORE executing any step.
   *  If found, the previous result is returned directly (idempotent response).
   *  Use this to guard against upstream gateway / client retry floods. */
  idempotencyKey?: string;
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
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 1,
  backoff: 'exponential',
  initialDelayMs: 100,
  maxDelayMs: 30_000,
  jitter: 'equal',
};

/** Default step timeout. */
export const DEFAULT_STEP_TIMEOUT_MS = 30_000;

/** Default lease TTL. */
export const DEFAULT_LEASE_TTL_SECONDS = 60;

/** Default idempotency TTL (7 days). */
export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

// ============================================================================
// Re-exports
// ============================================================================

export type { RunState, CompensableAction };
