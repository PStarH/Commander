/**
 * Commander Execution Kernel (Architecture V2).
 *
 * This package owns durable run and step lifecycle semantics. It intentionally
 * contains no provider, tool, HTTP, plugin, or CLI implementation. Those are
 * worker/control-plane concerns and must talk to the kernel through this
 * boundary.
 */

export {
  KERNEL_CLAIM_SQL,
  KERNEL_CLAIM_RECONCILE_SQL,
  KERNEL_CLAIM_SECRET_SQL,
  KERNEL_RLS_SQL,
  KERNEL_ROLES_SQL,
  KERNEL_SCHEMA_SQL,
  KERNEL_SCHEMA_VERSION,
} from './schema.js';
export { KERNEL_MIGRATIONS, runKernelMigrations } from './migrations.js';
export {
  generateWorkerClaimSecret,
  hashWorkerClaimSecret,
  verifyWorkerClaimSecret,
} from './claimSecret.js';
export { seedWorkerClaimSecret, seedWorkerAllowedTenants } from './seedWorkerClaimSecret.js';
export type { ClaimSecretSeedClient } from './seedWorkerClaimSecret.js';
export { PostgresKernelRepository } from './postgres.js';
export { SqliteKernelRepository } from './sqlite.js';
export {
  createKernelRepository,
  resolveKernelBackend,
  KernelBackendRefusedError,
  KernelBackendMissingError,
} from './repositoryFactory.js';
export type {
  KernelBackend,
  KernelRepositoryFactoryOptions,
  KernelRepositoryHandle,
} from './repositoryFactory.js';
export { SQLITE_KERNEL_SCHEMA_SQL, SQLITE_KERNEL_SCHEMA_VERSION, SQLITE_KERNEL_TABLES } from './sqliteSchema.js';
export { assertRunTransition, assertStepTransition } from './transitionValidation.js';
export { InMemoryOutboxDeliveryPort } from './ops/outbox/inMemoryOutboxDeliveryPort.js';
export { PostgresOutboxDeliveryPort } from './ops/outbox/postgresOutboxDeliveryPort.js';
export { KernelOutboxPublisher } from './ops/outbox/kernelOutboxPublisher.js';
export type { KernelOutboxPublishResult } from './ops/outbox/kernelOutboxPublisher.js';
export { OutboxPublisher } from './ops/outbox/compatibilityPublisher.js';
export type { EventPublisher } from './ops/outbox/compatibilityPublisher.js';
export { ReclaimDaemon } from './ops/reclaimDaemon.js';
export {
  consumeCompensationBatch,
  KERNEL_COMPENSATION_TOPIC,
} from './ops/compensationConsumer.js';
export type {
  CompensationConsumeResult,
  CompensationConsumerOptions,
  CompensationEffectBroker,
  CompensationOutboxPort,
  CompensationTokenProvider,
} from './ops/compensationConsumer.js';
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
export type {
  PostgresKernelRepositoryOptions,
  SqlClient,
  SqlPool,
  SqlQueryResult,
} from './postgres.js';
export type { KernelRepository } from './repository.js';
export {
  KernelCapabilityReplayStore,
  KernelCapabilityRevocationStore,
  createDurableCapabilityReplayConsume,
} from './capabilityStores.js';
export type {
  CapabilityReplayRepository,
  CapabilityRevocationRepository,
} from './capabilityStores.js';
export {
  CAPABILITY_AUTHORITY_REQUIRED,
  CAPABILITY_AUDIENCE_ENV,
  CAPABILITY_ISSUER_ENV,
  CAPABILITY_JWKS_JSON_ENV,
  CAPABILITY_KEY_ID_ENV,
  CAPABILITY_PRIVATE_KEY_PEM_ENV,
  createCapabilityAuthority,
} from './capabilityAuthority.js';
export type {
  CapabilityAuthority,
  CapabilityAuthorityEnv,
  CreateCapabilityAuthorityOptions,
} from './capabilityAuthority.js';
export { KERNEL_API_VERSION, KernelInvariantError } from './types.js';
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
  ReconcileEffectRequest,
  RequestReconcileInput,
  ClaimReconcileEffectsInput,
  ClaimedReconcileEffect,
  RescheduleReconcileInput,
  EscalateReconcileInput,
  FailEffectRequest,
  RequestCompensationInput,
  RequestCompensationResult,
  InteractionStatus,
  TimerState,
  TimerType,
  TenantExecutionControl,
  KillSwitch,
  KillSwitchMatchDims,
  KillSwitchScope,
  PutKillSwitchInput,
  RemoveKillSwitchInput,
} from './types.js';

// Object storage (interface only — implementations are in testing/)
export type { ObjectStorage, ObjectStorageRef } from './testing/objectStorage.js';
// InMemoryKernelRepository: import from `@commander/kernel/testing/inMemoryRepository`
// — not re-exported from the main barrel (tests/harnesses only).
