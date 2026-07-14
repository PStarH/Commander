import { createHash } from 'node:crypto';
import { getRequire } from './esmCompat';
const require = getRequire(import.meta.url);

import {
  KernelInvariantError,
  PostgresKernelRepository,
  type KernelEvent,
  type KernelRun,
  type NewKernelStep,
} from '@commander/kernel';

export interface V1KernelGateway {
  submit(input: {
    tenantId: string;
    idempotencyKey: string;
    goal: string;
    steps: NewKernelStep[];
    workGraphVersion: string;
    policySnapshotId: string;
    metadata?: Record<string, unknown>;
    actor: string;
  }): Promise<{ run: KernelRun; created: boolean }>;
  getRun(runId: string, tenantId: string): Promise<KernelRun | null>;
  listEvents(runId: string, tenantId: string): Promise<KernelEvent[]>;
  /**
   * Pause a run, releasing any active worker leases but keeping scheduled work.
   * Returns null when the run was not found or is not in a pausable state.
   */
  pauseRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null>;
  /**
   * Resume a paused run so that pending steps become claimable again.
   * Returns null when the run was not found or is not currently paused.
   */
  resumeRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null>;
  /**
   * Cancel a run and mark all non-terminal steps CANCELLED.
   * Returns null when the run was not found or has already reached a terminal state.
   */
  cancelRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null>;
}

export type { KernelRun } from '@commander/kernel';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`)
    .join(',')}}`;
}

function canonicalWorkGraphHash(steps: NewKernelStep[]): string {
  const canonicalSteps = steps
    .map((s) => ({
      id: s.id,
      kind: s.kind,
      dependencies: [...(s.dependencies ?? [])].sort(),
      input: s.input ?? {},
      maxAttempts: s.maxAttempts ?? 1,
      priority: s.priority ?? 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return sha256(canonicalStringify(canonicalSteps));
}

class PostgresV1KernelGateway implements V1KernelGateway {
  constructor(private readonly repository: PostgresKernelRepository) {}

  async submit(
    input: Parameters<V1KernelGateway['submit']>[0],
  ): Promise<{ run: KernelRun; created: boolean }> {
    const submission = JSON.stringify({
      goal: input.goal,
      steps: input.steps,
      workGraphVersion: input.workGraphVersion,
      policySnapshotId: input.policySnapshotId,
      metadata: input.metadata ?? {},
    });
    const submissionHash = sha256(submission);
    const runId = `run_${sha256(`${input.tenantId}:${input.idempotencyKey}`).slice(0, 40)}`;
    try {
      const run = await this.repository.createRun(
        {
          id: runId,
          tenantId: input.tenantId,
          intentHash: sha256(input.goal),
          workGraphHash: canonicalWorkGraphHash(input.steps),
          workGraphVersion: input.workGraphVersion,
          policySnapshotId: input.policySnapshotId,
          metadata: {
            ...input.metadata,
            goal: input.goal,
            submissionHash,
            idempotencyKey: input.idempotencyKey,
          },
          steps: input.steps,
        },
        input.actor,
      );
      return { run, created: true };
    } catch (error) {
      if (error instanceof KernelInvariantError && error.code === 'DUPLICATE_STEP') {
        // A step id collided with an already-persisted step (e.g. caller-supplied
        // ids reused across runs, or duplicate ids within one submission). Surface
        // a clean 409 instead of letting the invariant error escape as an HTTP 500.
        throw new GatewayStepIdConflictError(
          'One or more step ids collide with an existing run; supply run-unique step ids.',
        );
      }
      if (!(error instanceof KernelInvariantError) || error.code !== 'DUPLICATE_RUN') throw error;
      const existing = await this.repository.getRun(runId, input.tenantId);
      if (!existing || existing.metadata.submissionHash !== submissionHash) {
        throw new GatewayIdempotencyConflictError(
          'Idempotency-Key was already used with a different request',
        );
      }
      return { run: existing, created: false };
    }
  }

  getRun(runId: string, tenantId: string): Promise<KernelRun | null> {
    return this.repository.getRun(runId, tenantId);
  }
  listEvents(runId: string, tenantId: string): Promise<KernelEvent[]> {
    return this.repository.listEvents(runId, tenantId);
  }
  pauseRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null> {
    return this.repository.pauseRun(runId, tenantId, actor);
  }
  resumeRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null> {
    return this.repository.resumeRun(runId, tenantId, actor);
  }
  cancelRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null> {
    return this.repository.cancelRun(runId, tenantId, actor);
  }
}

export class GatewayIdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayIdempotencyConflictError';
  }
}

export class GatewayStepIdConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayStepIdConflictError';
  }
}

let gateway: V1KernelGateway | null = null;
let initializePromise: Promise<void> | null = null;

/**
 * Initializes only when explicitly enabled. Gateway production has no local
 * fallback; missing shared persistence is surfaced as 503 by V1 routes.
 */
export async function initializeV1KernelGateway(): Promise<void> {
  if (process.env.COMMANDER_KERNEL_ENABLED !== '1') return;
  if (initializePromise) return initializePromise;
  const connectionString = process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error(
      'COMMANDER_KERNEL_ENABLED=1 requires COMMANDER_KERNEL_DATABASE_URL or DATABASE_URL',
    );
  initializePromise = (async () => {
    const pg = require('pg') as {
      Pool: new (options: { connectionString: string }) => { connect(): Promise<unknown> };
    };
    const pool = new pg.Pool({ connectionString });
    const repository = new PostgresKernelRepository(pool as never);
    await repository.initialize();
    gateway = new PostgresV1KernelGateway(repository);
  })();
  return initializePromise;
}

export function getV1KernelGateway(): V1KernelGateway | null {
  return gateway;
}

/** Test-only wiring hook; never call from production bootstrap. */
export function setV1KernelGatewayForTest(value: V1KernelGateway | null): void {
  gateway = value;
}
