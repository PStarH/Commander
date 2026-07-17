/**
 * Commander Execution Kernel (Architecture V2).
 *
 * This package owns durable run and step lifecycle semantics. It intentionally
 * contains no provider, tool, HTTP, plugin, or CLI implementation. Those are
 * worker/control-plane concerns and must talk to the kernel through this
 * boundary.
 */

export { KERNEL_RLS_SQL, KERNEL_ROLES_SQL, KERNEL_SCHEMA_SQL, KERNEL_SCHEMA_VERSION } from './schema.js';
export { KERNEL_MIGRATIONS, runKernelMigrations } from './migrations.js';
export { PostgresKernelRepository } from './postgres.js';
export { assertRunTransition, assertStepTransition } from './transitionValidation.js';
export { InMemoryOutboxDeliveryPort } from './ops/outbox/inMemoryOutboxDeliveryPort.js';
export { PostgresOutboxDeliveryPort } from './ops/outbox/postgresOutboxDeliveryPort.js';
export { KernelOutboxPublisher } from './ops/outbox/kernelOutboxPublisher.js';
export type { KernelOutboxPublishResult } from './ops/outbox/kernelOutboxPublisher.js';
export { OutboxPublisher } from './ops/outbox/compatibilityPublisher.js';
export type { EventPublisher } from './ops/outbox/compatibilityPublisher.js';
export { ReclaimDaemon } from './ops/reclaimDaemon.js';
export type { ReclaimDaemonConfig, ReclaimStats } from './ops/reclaimDaemon.js';
export { KernelOpsRuntime } from './ops/opsRuntime.js';
export type { KernelOpsRuntimeDependencies, OpsLoopHealth } from './ops/opsRuntime.js';
export { InteractionExpiryWorker, TimerWakeupWorker } from './ops/timerWakeupWorker.js';
export type { TimerWakeupWorkerConfig } from './ops/timerWakeupWorker.js';
export type {
  ClaimedOutboxDelivery,
  OutboxDeliveryError,
  OutboxDeliveryOptions,
  OutboxDeliveryPort,
  OutboxEnvelope,
} from './ops/outbox/types.js';
export type { PostgresKernelRepositoryOptions, SqlClient, SqlPool, SqlQueryResult } from './postgres.js';
export type { KernelRepository } from './repository.js';
export {
  KERNEL_API_VERSION,
  KernelInvariantError,
} from './types.js';
export type {
  AdmitEffectRequest,
  AdmitEffectResult,
  AnswerInteractionRequest,
  ClaimStepRequest,
  CompleteStepRequest,
  CreateInteractionRequest,
  CreateKernelRun,
  CreateTimerRequest,
  FailStepRequest,
  KernelDlqEntry,
  KernelEffect,
  KernelErrorDetails,
  KernelEvent,
  KernelInteraction,
  KernelLease,
  KernelOutboxMessage,
  KernelRun,
  KernelRunHandle,
  KernelRunState,
  KernelStep,
  KernelStepState,
  KernelTimer,
  MarkEffectCompletionUnknownRequest,
  NewKernelStep,
  InteractionStatus,
  TimerState,
  TimerType,
  TenantExecutionControl,
} from './types.js';

// Object storage (interface only — implementations are in testing/)
export type { ObjectStorage, ObjectStorageRef } from './testing/objectStorage.js';
