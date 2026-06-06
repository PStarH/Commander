/**
 * ATR (Agent Transaction Runtime) — public exports.
 *
 * The kernel that gives agent external actions settlement guarantees:
 *   - Idempotency: retries do not duplicate side effects
 *   - Recoverability: failures can be compensated
 *   - Leasing: only one process owns a run at a time
 *   - Fencing: zombie processes cannot corrupt in-flight runs
 *
 * Product positioning: "Settlement Layer" (external) — ATR is the kernel.
 */

export * from './types';
export * from './canonicalJson';
export { IdempotencyStore, getIdempotencyStore, resetIdempotencyStore, newLeaseToken } from './idempotencyStore';
export type { IdempotencyStoreConfig } from './idempotencyStore';
export { LeaseManager } from './leaseManager';
export type { LeaseManagerConfig, AcquireResult } from './leaseManager';
export { RunLedger } from './runLedger';
export type {
  RunLedgerConfig,
  StartRunInput,
  RecordActionInput,
  CompensationOutcome,
  CompensationHandler,
} from './runLedger';
export { getRunLedgerBundle, resetRunLedgerBundle } from './runLedger';
export {
  defaultCompensationHandlers,
  registerCompensationHandler,
  resolveMutationFlag,
  takeSnapshot,
} from './defaultCompensation';
export type { MutationDetectionResult } from './defaultCompensation';
export {
  startATRRun,
  resumeATRRun,
  wrapToolExecutionWithATR,
  finalizeATRRun,
} from './runtimeIntegration';
export type { ATRContext, ATRWrapResult } from './runtimeIntegration';
export {
  CompensationBridge,
  getCompensationBridge,
  resetCompensationBridge,
} from './compensationBridge';
export type { BridgeSagaContext } from './compensationBridge';
export { ExecutionScheduler, getExecutionScheduler, resetExecutionScheduler } from './scheduler';
export type {
  BeginRunInput,
  RunHandle,
  ScheduleActionInput,
  ScheduleActionResult,
  CommitResult,
  AbortResult,
  KillResult,
  SchedulerCheckpointInput,
  ExecutionSchedulerOptions,
} from './scheduler';
export {
  createGitHubTools,
  defaultGitHubClient,
  getGitHubCompensationHandlers,
  GitHubClientError,
  GITHUB_TOOL_NAMES,
} from './adapters/github';
export type {
  GitHubClient,
  CreatePrArgs,
  CreatePrResult,
  MergePrArgs,
  MergePrResult,
  RevertPrArgs,
  RevertPrResult,
  ClosePrArgs,
  GitHubToolName,
} from './adapters/github';
export {
  handleAtrHttpRequest,
  ATR_HTTP_ROUTES,
} from './atrHttp';
export type { AtrHttpDeps, AtrHttpResult } from './atrHttp';
export * as Policy from './policy';
