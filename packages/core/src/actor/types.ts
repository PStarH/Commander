/**
 * Actor Model Types for Commander
 *
 * Implements the Actor Model pattern for concurrent agent execution.
 * Each actor is an independent unit of computation that:
 * - Has its own state and mailbox
 * - Communicates only via async messages
 * - Is supervised by a parent actor for fault tolerance
 *
 * Reference: DomoActors (Vaughn Vernon), Erlang/OTP, Akka Typed
 */

import type { AgentExecutionContext, AgentExecutionResult } from '../runtime/types';
import type { TaskTreeNode } from '../ultimate/types';

// ============================================================================
// Actor Core Interfaces
// ============================================================================

/**
 * Unique identifier for an actor instance.
 */
export type ActorId = string;

/**
 * Actor lifecycle states.
 */
export type ActorState = 
  | 'created'    // Actor initialized but not started
  | 'running'    // Actor is processing messages
  | 'suspended'  // Actor is temporarily paused
  | 'stopping'   // Graceful shutdown in progress
  | 'stopped'    // Actor has terminated
  | 'failed'     // Actor failed and awaiting supervision
  | 'restarting' // Actor is being restarted by supervisor

/**
 * Base interface for all actor messages.
 * Messages are the ONLY way actors communicate.
 */
export interface ActorMessage {
  /** Unique message ID for correlation */
  readonly id: string;
  /** Message type discriminator */
  readonly type: string;
  /** Timestamp when message was created */
  readonly timestamp: number;
  /** Sender actor ID (undefined for system messages) */
  readonly sender?: ActorId;
  /** Correlation ID for request/response patterns */
  readonly correlationId?: string;
}

// ============================================================================
// Actor Message Types
// ============================================================================

/**
 * Message to start an actor.
 */
export interface StartMessage extends ActorMessage {
  type: 'start';
}

/**
 * Message to stop an actor gracefully.
 */
export interface StopMessage extends ActorMessage {
  type: 'stop';
  /** Optional reason for stopping */
  reason?: string;
}

/**
 * Message to suspend an actor (pause processing).
 */
export interface SuspendMessage extends ActorMessage {
  type: 'suspend';
  reason?: string;
}

/**
 * Message to resume a suspended actor.
 */
export interface ResumeMessage extends ActorMessage {
  type: 'resume';
}

/**
 * Message to restart an actor (supervisor action).
 */
export interface RestartMessage extends ActorMessage {
  type: 'restart';
  /** Error that caused the restart */
  error?: Error;
  /** Restart strategy to use */
  strategy: RestartStrategy;
}

/**
 * Message to query actor status.
 */
export interface StatusQueryMessage extends ActorMessage {
  type: 'status_query';
}

/**
 * Response to a status query.
 */
export interface StatusResponseMessage extends ActorMessage {
  type: 'status_response';
  state: ActorState;
  actorId: ActorId;
  mailboxSize: number;
  uptimeMs: number;
  processedCount: number;
  failedCount: number;
}

// ============================================================================
// Sub-Agent Execution Messages
// ============================================================================

/**
 * Message to execute a subtask.
 */
export interface ExecuteSubtaskMessage extends ActorMessage {
  type: 'execute_subtask';
  /** The task node to execute */
  taskNode: TaskTreeNode;
  /** Project context */
  projectId: string;
  /** Base context for execution */
  baseContext: Record<string, unknown>;
}

/**
 * Response after subtask execution completes.
 */
export interface SubtaskResultMessage extends ActorMessage {
  type: 'subtask_result';
  /** Task node ID that was executed */
  taskId: string;
  /** Execution result */
  result: AgentExecutionResult;
  /** Whether execution succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Message to coordinate parallel execution.
 */
export interface ParallelCoordinationMessage extends ActorMessage {
  type: 'parallel_coordination';
  /** Batch of tasks to execute */
  tasks: TaskTreeNode[];
  /** Maximum parallel executions */
  maxParallel: number;
  /** Shared context */
  projectId: string;
  baseContext: Record<string, unknown>;
}

// ============================================================================
// Actor Context
// ============================================================================

/**
 * Context provided to an actor for message processing.
 * Gives actors access to system resources without tight coupling.
 */
export interface ActorContext {
  /** Unique actor ID */
  readonly actorId: ActorId;
  /** Parent actor ID (undefined for root actors) */
  readonly parentId?: ActorId;
  /** Send a message to another actor */
  send(targetId: ActorId, message: ActorMessage): void;
  /** Send a message and wait for response (ask pattern) */
  ask<T extends ActorMessage>(targetId: ActorId, message: ActorMessage, timeoutMs?: number): Promise<T>;
  /** Send message to self (for deferred processing) */
  sendSelf(message: ActorMessage): void;
  /** Get reference to this actor */
  readonly self: ActorRef;
  /** Get reference to parent actor */
  readonly parent?: ActorRef;
  /** Actor system logger */
  readonly logger: ActorLogger;
  /** Cancellation signal for current message processing */
  readonly cancellationToken?: AbortSignal;
}

/**
 * Reference to an actor for sending messages.
 * Actors interact only through ActorRef, never directly.
 */
export interface ActorRef {
  /** Actor unique identifier */
  readonly id: ActorId;
  /** Actor current state */
  readonly state: ActorState;
  /** Send a message (fire-and-forget) */
  send(message: ActorMessage): void;
  /** Ask pattern: send and wait for response */
  ask<T extends ActorMessage>(message: ActorMessage, timeoutMs?: number): Promise<T>;
  /** Check if actor is alive (state is running or suspended) */
  isAlive(): boolean;
}

// ============================================================================
// Mailbox Configuration
// ============================================================================

/**
 * Mailbox configuration for an actor.
 */
export interface MailboxConfig {
  /** Maximum mailbox capacity (0 = unlimited) */
  capacity: number;
  /** Default message priority (higher = processed first) */
  defaultPriority: number;
  /** Message types that bypass capacity limits */
  overflowProtectionTypes: string[];
  /** Enable message deduplication by correlationId */
  deduplication: boolean;
  /** Maximum message age in ms before dropping (0 = no expiry) */
  maxMessageAgeMs: number;
}

/**
 * Default mailbox configuration.
 */
export const DEFAULT_MAILBOX_CONFIG: MailboxConfig = {
  capacity: 1000,
  defaultPriority: 0,
  overflowProtectionTypes: ['start', 'stop', 'restart', 'status_query'],
  deduplication: true,
  maxMessageAgeMs: 300000, // 5 minutes
};

/**
 * Internal mailbox entry with metadata.
 */
export interface MailboxEntry {
  message: ActorMessage;
  priority: number;
  enqueuedAt: number;
  attempts: number;
}

// ============================================================================
// Supervisor Configuration
// ============================================================================

/**
 * Restart strategy for handling actor failures.
 */
export type RestartStrategy = 
  | 'one_for_one'   // Only restart the failed actor
  | 'one_for_all'   // Restart all actors in the group
  | 'rest_for_one'  // Restart the failed actor and all actors started after it

/**
 * Supervisor configuration.
 */
export interface SupervisorConfig {
  /** Maximum restart attempts before permanent failure */
  maxRestarts: number;
  /** Time window for restart counting (ms) */
  restartWindowMs: number;
  /** Strategy for handling child actor failures */
  strategy: RestartStrategy;
  /** Maximum seconds to wait for graceful shutdown before force-killing */
  shutdownTimeoutMs: number;
  /** Whether to propagate failures to parent */
  propagateFailure: boolean;
  /** Backoff configuration for restarts */
  backoff: RestartBackoffConfig;
}

/**
 * Restart backoff configuration.
 */
export interface RestartBackoffConfig {
  /** Initial delay in ms */
  initialDelayMs: number;
  /** Maximum delay in ms */
  maxDelayMs: number;
  /** Backoff multiplier */
  multiplier: number;
  /** Add random jitter (±percentage) to prevent thundering herd */
  jitterPercent: number;
}

/**
 * Default supervisor configuration.
 */
export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  maxRestarts: 5,
  restartWindowMs: 60000, // 1 minute
  strategy: 'one_for_one',
  shutdownTimeoutMs: 5000,
  propagateFailure: false,
  backoff: {
    initialDelayMs: 100,
    maxDelayMs: 30000,
    multiplier: 2,
    jitterPercent: 10,
  },
};

/**
 * Record of a restart attempt.
 */
export interface RestartRecord {
  actorId: ActorId;
  timestamp: number;
  error?: Error;
  strategy: RestartStrategy;
}

// ============================================================================
// Actor System Configuration
// ============================================================================

/**
 * Actor system configuration.
 */
export interface ActorSystemConfig {
  /** System name for logging/metrics */
  name: string;
  /** Default mailbox configuration for new actors */
  defaultMailboxConfig: MailboxConfig;
  /** Default supervisor configuration */
  defaultSupervisorConfig: SupervisorConfig;
  /** Enable metrics collection */
  enableMetrics: boolean;
  /** Enable message tracing for debugging */
  enableTracing: boolean;
  /** Global message timeout in ms */
  defaultMessageTimeoutMs: number;
}

/**
 * Default actor system configuration.
 */
export const DEFAULT_ACTOR_SYSTEM_CONFIG: ActorSystemConfig = {
  name: 'commander-actor-system',
  defaultMailboxConfig: DEFAULT_MAILBOX_CONFIG,
  defaultSupervisorConfig: DEFAULT_SUPERVISOR_CONFIG,
  enableMetrics: true,
  enableTracing: false,
  defaultMessageTimeoutMs: 30000,
};

// ============================================================================
// Actor Definition
// ============================================================================

/**
 * Actor behavior definition.
 * Defines how an actor processes messages and manages state.
 */
export interface ActorBehavior<State = unknown> {
  /** Initial state when actor starts */
  initialState: State;
  /** Handle incoming messages */
  receive(context: ActorContext, state: State, message: ActorMessage): Promise<State | void>;
  /** Called when actor starts (optional) */
  onStarted?(context: ActorContext, state: State): Promise<void>;
  /** Called when actor stops (optional) */
  onStopped?(context: ActorContext, state: State): Promise<void>;
  /** Called when actor is restarted (optional) */
  onRestarted?(context: ActorContext, state: State, error?: Error): Promise<void>;
}

/**
 * Complete actor definition including behavior and configuration.
 */
export interface ActorDefinition<State = unknown> {
  /** Unique actor type name */
  typeName: string;
  /** Actor behavior */
  behavior: ActorBehavior<State>;
  /** Mailbox configuration (overrides system default) */
  mailboxConfig?: Partial<MailboxConfig>;
  /** Supervisor configuration (overrides parent default) */
  supervisorConfig?: Partial<SupervisorConfig>;
}

// ============================================================================
// Actor Logger
// ============================================================================

/**
 * Structured logger interface for actors.
 */
export interface ActorLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, error?: Error, data?: Record<string, unknown>): void;
}

// ============================================================================
// Actor Metrics
// ============================================================================

/**
 * Metrics for an actor instance.
 */
export interface ActorMetrics {
  actorId: ActorId;
  actorType: string;
  state: ActorState;
  uptimeMs: number;
  messagesProcessed: number;
  messagesFailed: number;
  messagesDropped: number;
  currentMailboxSize: number;
  averageProcessingTimeMs: number;
  lastMessageProcessedAt?: number;
  restartCount: number;
}

/**
 * System-wide actor metrics.
 */
export interface ActorSystemMetrics {
  systemName: string;
  totalActors: number;
  runningActors: number;
  failedActors: number;
  totalMessagesProcessed: number;
  totalMessagesFailed: number;
  uptimeMs: number;
  actorMetrics: ActorMetrics[];
}

// ============================================================================
// Execution-Specific Types
// ============================================================================

/**
 * Configuration for the WorkerAgent actor.
 */
export interface WorkerAgentConfig {
  /** Agent runtime for executing tasks */
  agentRuntime: unknown; // AgentRuntime - using unknown to avoid circular deps
  /** Maximum concurrent tasks this worker can handle */
  maxConcurrentTasks: number;
  /** Task timeout in ms */
  taskTimeoutMs: number;
  /** Whether to enable detailed execution tracing */
  enableTracing: boolean;
}

/**
 * State maintained by a WorkerAgent actor.
 */
export interface WorkerAgentState {
  /** Currently executing task (undefined if idle) */
  currentTask?: TaskTreeNode;
  /** Project ID for current execution */
  projectId?: string;
  /** Base context for current execution */
  baseContext?: Record<string, unknown>;
  /** Execution start time */
  startedAt?: number;
  /** Total tasks completed */
  completedTasks: number;
  /** Total tasks failed */
  failedTasks: number;
  /** Total execution time */
  totalExecutionTimeMs: number;
}

/**
 * Message types specific to WorkerAgent.
 */
export type WorkerAgentMessage = 
  | ExecuteSubtaskMessage
  | SubtaskResultMessage
  | StatusQueryMessage
  | StatusResponseMessage
  | StopMessage;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a message is a system message (always processed regardless of mailbox state).
 */
export function isSystemMessage(message: ActorMessage): boolean {
  return ['start', 'stop', 'suspend', 'resume', 'restart', 'status_query'].includes(message.type);
}

/**
 * Check if a message requires a response.
 */
export function isRequestMessage(message: ActorMessage): boolean {
  return message.correlationId !== undefined;
}

/**
 * Create a status query message.
 */
export function createStatusQuery(sender?: ActorId): StatusQueryMessage {
  return {
    id: `status_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'status_query',
    timestamp: Date.now(),
    sender,
  };
}

/**
 * Create a stop message.
 */
export function createStopMessage(sender?: ActorId, reason?: string): StopMessage {
  return {
    id: `stop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'stop',
    timestamp: Date.now(),
    sender,
    reason,
  };
}
