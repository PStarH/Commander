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
 * Kernel Postgres DSN: COMMANDER_KERNEL_DATABASE_URL, else DATABASE_URL.
 * Empty string when neither is set.
 */
export function getKernelDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.COMMANDER_KERNEL_DATABASE_URL ?? env.DATABASE_URL ?? '').trim();
}

/**
 * Whether the shared durable execution kernel should be initialized.
 *
 * Default policy (Architecture V2 strangler — PRINCIPLES §2.3 / §4):
 * - Explicit `COMMANDER_KERNEL_ENABLED=0|false|off|no` → OFF
 *   (non-prod escape hatch for local UI without durable /v1; production refuse rejects this).
 * - Explicit `COMMANDER_KERNEL_ENABLED=1|true|on|yes` → ON.
 * - Otherwise ON when any of:
 *     - NODE_ENV=production (production never boots without durable /v1)
 *     - COMMANDER_V2_MODE=1
 *     - COMMANDER_KERNEL_DATABASE_URL or DATABASE_URL is non-empty
 * - Otherwise OFF (dev without a Postgres DSN keeps /v1 as KERNEL_UNAVAILABLE
 *   rather than crashing boot on a missing database).
 *
 * WarRoomStore remains a non-/v1 mission/log store; it is not the /v1 run authority.
 * Initializes when this returns true. Gateway has no local /v1 fallback;
 * missing shared persistence fails closed at init or as 503.
 */
export function isCommanderKernelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.COMMANDER_KERNEL_ENABLED ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true;
  if (env.NODE_ENV === 'production') return true;
  if (env.COMMANDER_V2_MODE === '1') return true;
  return getKernelDatabaseUrl(env).length > 0;
}

/** True when COMMANDER_KERNEL_ENABLED is an explicit off value. */
export function isCommanderKernelExplicitlyDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.COMMANDER_KERNEL_ENABLED ?? '').trim().toLowerCase();
  return raw === '0' || raw === 'false' || raw === 'off' || raw === 'no';
}

export async function initializeV1KernelGateway(): Promise<void> {
  if (!isCommanderKernelEnabled()) return;
  if (initializePromise) return initializePromise;
  const connectionString = getKernelDatabaseUrl();
  if (!connectionString)
    throw new Error(
      'Kernel enabled (COMMANDER_KERNEL_ENABLED default-on or =1) requires COMMANDER_KERNEL_DATABASE_URL or DATABASE_URL',
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
