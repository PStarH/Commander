/**
 * Pillar I: Orchestration & State Fabric — Abstract Interface Contracts
 *
 * Per Commander Ultimate Architecture Blueprint Section 2.3.
 * All contracts are abstract interfaces with zero external dependencies.
 * TypeScript-first per constraint C-05.
 *
 * These interfaces define the formal boundary between orchestration
 * logic and its implementations. Existing concrete classes should
 * implement these interfaces to enable substitutability and testing.
 */

// ============================================================================
// Petri Net Engine (PrT Nets)
// ============================================================================

/**
 * A place in the Petri net that holds tokens (agents/resources).
 */
export interface IPlace {
  /** Unique identifier */
  id: string;
  /** Human-readable label */
  label: string;
  /** Current marking (number of tokens) */
  marking: number;
  /** Capacity constraint (Infinity if unbounded) */
  capacity: number;
}

/**
 * A transition that fires when guard conditions are met,
 * consuming tokens from input places and producing tokens in output places.
 */
export interface ITransition {
  /** Unique identifier */
  id: string;
  /** Human-readable label */
  label: string;
  /** Input place IDs with arc weights */
  inputs: Map<string, number>;
  /** Output place IDs with arc weights */
  outputs: Map<string, number>;
  /** Guard condition — returns true if transition can fire */
  guard?: (context: unknown) => boolean;
}

/**
 * Petri Net Engine interface for multi-agent concurrency scheduling.
 *
 * Formalism: Predicate/Transition Nets (PrT Nets)
 * N = (P, T, F, Σ, L, M₀, c)
 *   P = places, T = transitions, F = flow relation
 *   Σ = signature, L = labeling, M₀ = initial marking, c = capacity
 */
export interface IPetriNetEngine<TPlace extends IPlace = IPlace, TTransition extends ITransition = ITransition> {
  /** Register a place in the net */
  addPlace(place: TPlace): void;
  /** Register a transition in the net */
  addTransition(transition: TTransition): void;
  /** Check if a transition is enabled (guard satisfied + enough tokens) */
  isEnabled(transitionId: string, context?: unknown): boolean;
  /** Fire a transition, consuming/producing tokens */
  fire(transitionId: string, context?: unknown): boolean;
  /** Get the current marking of all places */
  getMarking(): Map<string, number>;
  /** Compute the reachability graph for deadlock detection */
  computeReachabilityGraph(): Map<string, Set<string>>;
  /** Reset to initial marking */
  reset(): void;
}

// ============================================================================
// Event Sourcing Engine
// ============================================================================

/**
 * Event types for the event sourcing engine.
 * Discriminated union per constraint IF-05.
 */
export interface IEvent {
  /** Unique event ID */
  id: string;
  /** Event type discriminator */
  type: string;
  /** Event payload */
  payload: unknown;
  /** Timestamp */
  timestamp: number;
  /** Hash of previous event (tamper-evidence chain) */
  previousHash?: string;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
}

/**
 * Event Sourcing Engine with WAL persistence.
 *
 * Provides deterministic event replay, hash-chain integrity verification,
 * and snapshot compaction for efficient state reconstruction.
 */
export interface IEventSourcingEngine {
  /** Atomic append to the WAL — returns the event with assigned ID and hash */
  append(event: Omit<IEvent, 'id' | 'timestamp' | 'previousHash'>): Promise<IEvent>;
  /** Streaming read from a given event ID (for replay) */
  readFrom(eventId?: string): AsyncIterable<IEvent>;
  /** Create a snapshot of current state for fast recovery */
  snapshot(): Promise<string>;
  /** Verify hash-chain integrity of the entire log */
  verifyIntegrity(): Promise<boolean>;
  /** Compact the log by applying events up to a snapshot */
  compact(snapshotId: string): Promise<number>;
}

// ============================================================================
// Saga Coordinator
// ============================================================================

/**
 * A single step in a saga with its compensation.
 */
export interface ISagaStep {
  /** Unique step ID */
  id: string;
  /** Step name */
  name: string;
  /** Execute the step */
  execute: () => Promise<unknown>;
  /** Compensating action (rollback) */
  compensate?: () => Promise<unknown>;
  /** Per-step timeout in ms */
  timeoutMs?: number;
}

/**
 * Saga Coordinator with strong consistency guarantees.
 *
 * Implements distributed saga coordination with compensating transactions
 * for rollback semantics. Per constraint NFR-CON-02, provides strong
 * consistency (not eventual).
 */
export interface ISagaCoordinator {
  /** Begin a new saga with the given steps */
  executeSaga(steps: ISagaStep[], options?: { timeoutMs?: number }): Promise<unknown>;
  /** Register a compensation action for a completed step */
  registerCompensation(stepId: string, compensation: () => Promise<unknown>): void;
  /** Get the status of a saga by ID */
  getStatus(sagaId: string): SagaStatus;
}

export type SagaStatus = 'PENDING' | 'EXECUTING' | 'COMPENSATING' | 'COMPLETED' | 'FAILED' | 'ABORTED';

// ============================================================================
// Backpressure Controller
// ============================================================================

/**
 * Backpressure Controller using token bucket + ring buffer pattern.
 *
 * Prevents overwhelming consumers by gating admission with a token bucket.
 * Spills excess to a ring buffer, then to persistent storage with circuit
 * breaker protection for graceful degradation.
 */
export interface IBackpressureController {
  /** Acquire a token (blocks if bucket empty, spills to buffer if full) */
  acquire(): Promise<boolean>;
  /** Release a token back to the bucket */
  release(): void;
  /** Get current backpressure metrics */
  getMetrics(): BackpressureMetrics;
  /** Set the consumer rate (tokens per second) */
  setConsumerRate(ratePerSecond: number): void;
}

export interface BackpressureMetrics {
  /** Current tokens available in bucket */
  availableTokens: number;
  /** Current buffer occupancy (0 to bufferSize) */
  bufferOccupancy: number;
  /** Total spilled events (overflow) */
  totalSpilled: number;
  /** Total dropped events (circuit breaker open) */
  totalDropped: number;
  /** Circuit breaker state */
  circuitBreakerState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
}

// ============================================================================
// Lock-Free State Evolution
// ============================================================================

/**
 * Lock-free state store using CAS (Compare-And-Swap) semantics.
 *
 * Per constraint NFR-PERF-05, concurrent reads must not block writes.
 * CAS provides linearizable updates without locks.
 */
export interface ILockFreeStateStore<T> {
  /** Read current value (never blocks) */
  read(): T;
  /** Atomic compare-and-set — returns true if updated */
  compareAndSet(expected: T, newValue: T): boolean;
  /** Update with a transform function (retry loop on conflict) */
  update(transform: (current: T) => T): T;
}
