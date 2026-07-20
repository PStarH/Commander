/** Public contracts for the isolated Commander worker plane. */

export type WorkerKind = 'agent' | 'tool' | 'evaluator' | 'connector' | 'sandbox';
export type WorkerStatus = 'ACTIVE' | 'DRAINING' | 'OFFLINE';

export interface WorkerIdentity {
  /** SPIFFE/JWT/OIDC subject. Verification is delegated to WorkerAuthenticator. */
  subject: string;
  token: string;
  expiresAt: string;
}

export interface WorkerDefinition {
  id: string;
  kind: WorkerKind;
  version: string;
  capabilities: string[];
  maxConcurrency: number;
  labels?: Record<string, string>;
}

export interface WorkerAuthorization {
  /** Empty or ['*'] permits every tenant. */
  tenantIds: string[];
  /** Empty or ['*'] permits every capability. */
  capabilities: string[];
}

export interface WorkerRecord extends WorkerDefinition {
  status: WorkerStatus;
  generation: number;
  activeSteps: number;
  identitySubject: string;
  tenantIds: string[];
  registeredAt: string;
  lastHeartbeatAt: string;
}

export interface WorkerRegistry {
  initialize(): Promise<void>;
  register(
    definition: WorkerDefinition,
    identitySubject: string,
    tenantIds: string[],
  ): Promise<WorkerRecord>;
  heartbeat(
    workerId: string,
    generation: number,
    activeSteps: number,
  ): Promise<WorkerRecord | null>;
  drain(workerId: string, generation: number): Promise<boolean>;
  markStale(before: Date): Promise<number>;
  get(workerId: string): Promise<WorkerRecord | null>;
}

export interface WorkerAuthenticator {
  authenticate(
    identity: WorkerIdentity,
    definition: WorkerDefinition,
  ): Promise<WorkerAuthorization>;
}

export interface WorkerLease {
  workerId: string;
  /** Durable registry generation used by kernel fencing. */
  workerGeneration?: number;
  token: string;
  fencingEpoch: number;
  expiresAt: string;
}

export interface ClaimedStep {
  id: string;
  runId: string;
  tenantId: string;
  kind: string;
  version: number;
  attempt: number;
  input: Record<string, unknown>;
  lease: WorkerLease;
}

/** Structural boundary implemented by @commander/kernel; no legacy runtime imports allowed. */
export interface KernelWorkerPort {
  claimNextStep(request: {
    workerId: string;
    workerGeneration?: number;
    leaseTtlMs: number;
    tenantIds: string[];
    capabilities: string[];
  }): Promise<ClaimedStep | null>;
  heartbeatStep(
    stepId: string,
    tenantId: string,
    lease: WorkerLease,
    leaseTtlMs: number,
  ): Promise<unknown | null>;
  completeStep(request: {
    stepId: string;
    tenantId: string;
    lease: WorkerLease;
    expectedVersion: number;
    output?: Record<string, unknown>;
    actor: string;
  }): Promise<unknown | null>;
  failStep(request: {
    stepId: string;
    tenantId: string;
    lease: WorkerLease;
    expectedVersion: number;
    error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
    retryAt?: Date;
    actor: string;
    /** See FailStepRequest.refundAttempt — stop-during-claim must not burn the only attempt. */
    refundAttempt?: boolean;
  }): Promise<unknown | null>;
}

export interface StepExecutor {
  execute(
    step: ClaimedStep,
    context: { signal: AbortSignal; worker: WorkerRecord },
  ): Promise<Record<string, unknown> | undefined>;
}

export class WorkerExecutionError extends Error {
  constructor(
    message: string,
    readonly options: {
      code?: string;
      retryable?: boolean;
      retryDelayMs?: number;
      details?: Record<string, unknown>;
    } = {},
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'WorkerExecutionError';
  }
}

export interface WorkerServiceConfig {
  leaseTtlMs?: number;
  workerHeartbeatMs?: number;
  pollIntervalMs?: number;
  sandboxReadiness?: WorkerSandboxReadiness;
  /** Called after registry.register so callers can bind worker generation (e.g. EffectBroker). */
  onRegistered?: (worker: WorkerRecord) => void;
}

export interface WorkerSandboxReadiness {
  assertReady(): Promise<void>;
}
