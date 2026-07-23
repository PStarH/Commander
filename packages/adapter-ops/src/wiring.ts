import {
  createKernelRepository,
  createCapabilityAuthority,
  type CapabilityAuthority,
} from '@commander/kernel';
import {
  EffectBroker,
  canonicalRequestHash,
  isClassAEffectType,
  type AuditSink,
  type CapabilityTokenIssuer,
  type EffectBrokerOptions,
  type PolicyEvaluator,
} from '@commander/effect-broker';
import {
  ActionAdapterRegistry,
  EnvAdapterCredentialProvider,
  createGitHubPullRequestCreateAdapter,
  createServiceNowIncidentCreateAdapter,
  type AdapterCompensateInput,
  type AdapterExecuteInput,
} from '@commander/action-adapters';
import { randomUUID } from 'node:crypto';
import { createEgressGatedFetch, parseEgressAllowlist } from './egress.js';
import { ReconciliationDaemon } from './reconciliationDaemon.js';
import { CompensationDaemon } from './compensationDaemon.js';

const POLICY_SNAPSHOT_ID = 'adapter-ops-v1';

/** Durable reconcile claim / broker identity (must exist in commander_workers under PG). */
export const ADAPTER_OPS_RECONCILE_WORKER_ID = 'reconciliation-daemon';

/** Compensation admit lease / broker affinity / grant workloadId — single identity. */
export const ADAPTER_OPS_COMPENSATION_WORKER_ID = 'compensation-daemon';

/** Runtime DSN / session uses owner or migration LOGIN — refuse before egress. */
export const OWNER_DATABASE_ROLE_REJECTED = 'OWNER_DATABASE_ROLE_REJECTED';

/** Durable replay/revocation stores missing from authority or kernel repository. */
export const CAPABILITY_DURABLE_STORES_REQUIRED = 'CAPABILITY_DURABLE_STORES_REQUIRED';

/** Owner / migration LOGIN role — never accept for adapter-ops DSN. */
export const OWNER_MIGRATION_DATABASE_ROLES = new Set(['commander_owner']);

/** Scheduler LOGIN bypasses durable worker claim authz — forbidden for adapter-ops. */
export const SCHEDULER_DATABASE_ROLES = new Set(['commander_scheduler']);

export const ADAPTER_OPS_SCHEDULER_MODE_FORBIDDEN = 'ADAPTER_OPS_SCHEDULER_MODE_FORBIDDEN';

/** No silent "local" fallback — COMMANDER_CELL_TENANT_ID must be explicit for every tier. */
export const COMMANDER_CELL_TENANT_ID_REQUIRED = 'COMMANDER_CELL_TENANT_ID_REQUIRED';

export const WORKER_TENANT_SCOPE_REQUIRED = 'WORKER_TENANT_SCOPE_REQUIRED';

type AdapterOpsWorkerDefinition = {
  id: string;
  kind: 'tool';
  version: string;
  capabilities: string[];
  maxConcurrency: number;
  labels?: Record<string, string>;
};

type AdapterOpsWorkerRegistration = {
  id: string;
  generation: number;
  claimSecret?: string;
};

export interface AdapterOpsWorkerRegistry {
  initialize(): Promise<void>;
  register(
    definition: AdapterOpsWorkerDefinition,
    identitySubject: string,
    tenantIds: string[],
    previousClaimSecret?: string,
  ): Promise<AdapterOpsWorkerRegistration>;
}

type AdapterOpsRegistryPool = {
  connect(): Promise<{
    query<T = Record<string, unknown>>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<{ rows: T[] }>;
    release(): void;
  }>;
};

export function resolveAdapterOpsTenantScope(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const tenantIds = (env.COMMANDER_WORKER_TENANTS ?? '')
    .split(',')
    .map((tenantId) => tenantId.trim())
    .filter(Boolean);
  if (tenantIds.length === 0 || tenantIds.includes('*')) {
    throw new Error(
      `${WORKER_TENANT_SCOPE_REQUIRED}: COMMANDER_WORKER_TENANTS must be a non-empty, explicit tenant list`,
    );
  }
  return tenantIds;
}

class PostgresAdapterOpsWorkerRegistry implements AdapterOpsWorkerRegistry {
  constructor(private readonly pool: AdapterOpsRegistryPool) {}

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ ok: string | null }>(
        `SELECT to_regclass('public.commander_workers')::text AS ok`,
      );
      if (!result.rows[0]?.ok) {
        throw new Error('commander_workers table is missing; run kernel migrations before adapter-ops');
      }
    } finally {
      client.release();
    }
  }

  async register(
    definition: AdapterOpsWorkerDefinition,
    identitySubject: string,
    tenantIds: string[],
    previousClaimSecret?: string,
  ): Promise<AdapterOpsWorkerRegistration> {
    if (tenantIds.length === 0 || tenantIds.includes('*')) {
      throw new Error(`${WORKER_TENANT_SCOPE_REQUIRED}: daemon registration requires explicit tenantIds`);
    }
    const client = await this.pool.connect();
    try {
      const result = await client.query<{
        register_worker: { id: string; generation: number | string; claim_secret?: string } | null;
      }>(
        `SELECT register_worker(
           $1::text, $2::text, $3::text, $4::jsonb, $5::jsonb, $6::integer, $7::text, $8::jsonb, $9::text
         ) AS register_worker`,
        [
          definition.id,
          definition.kind,
          definition.version,
          JSON.stringify(definition.capabilities),
          JSON.stringify(definition.labels ?? {}),
          definition.maxConcurrency,
          identitySubject,
          JSON.stringify(tenantIds),
          previousClaimSecret ?? null,
        ],
      );
      const registered = result.rows[0]?.register_worker;
      if (!registered?.claim_secret) {
        throw new Error(`WORKER_CLAIM_SECRET_REGISTER_FAILED: id=${definition.id}`);
      }
      return {
        id: registered.id,
        generation: Number(registered.generation),
        claimSecret: registered.claim_secret,
      };
    } finally {
      client.release();
    }
  }
}

function isProductionOrEnterprise(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.COMMANDER_PROFILE === 'enterprise' ||
    process.env.COMMANDER_CELL_TIER === 'enterprise'
  );
}

/** Extract LOGIN username from a postgres DSN userinfo (null if not a postgres URL). */
export function databaseUrlLoginRole(dsn: string): string | null {
  const m = dsn.match(/^(?:postgres|postgresql):\/\/([^:/?@]+)(?::[^@]*)?@/i);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

/**
 * Reject owner/migration credentials in the connection URL userinfo.
 * Task 1 `worker-url` (`commander_worker`) must pass — no false positive.
 */
export function assertNonOwnerDatabaseUrl(dsn: string): void {
  const role = databaseUrlLoginRole(dsn);
  if (role === null) return;
  if (OWNER_MIGRATION_DATABASE_ROLES.has(role)) {
    throw new Error(
      `${OWNER_DATABASE_ROLE_REJECTED}: database URL userinfo role '${role}' is forbidden ` +
        '(owner/migration). Adapter-ops must use Task 1 worker-url (commander_worker).',
    );
  }
  if (SCHEDULER_DATABASE_ROLES.has(role)) {
    throw new Error(
      `${OWNER_DATABASE_ROLE_REJECTED}: database URL userinfo role '${role}' is forbidden ` +
        '(scheduler). Adapter-ops must use commander_worker LOGIN with durable claim authz.',
    );
  }
}

/** Reject post-connect `current_user` matching owner/migration/scheduler. */
export function assertNonOwnerDatabaseRole(currentUser: string): void {
  const role = currentUser.trim();
  if (OWNER_MIGRATION_DATABASE_ROLES.has(role) || SCHEDULER_DATABASE_ROLES.has(role)) {
    throw new Error(
      `${OWNER_DATABASE_ROLE_REJECTED}: session current_user '${role}' is forbidden ` +
        '(owner/migration/scheduler). Adapter-ops must authenticate as commander_worker.',
    );
  }
}

/**
 * Adapter-ops must never run kernel schedulerMode (BYPASSRLS / skip claim secret).
 * Fail-closed if COMMANDER_KERNEL_SCHEDULER_MODE=1 is present in the process env.
 */
export function assertAdapterOpsSchedulerModeForbidden(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.COMMANDER_KERNEL_SCHEDULER_MODE === '1') {
    throw new Error(
      `${ADAPTER_OPS_SCHEDULER_MODE_FORBIDDEN}: COMMANDER_KERNEL_SCHEDULER_MODE=1 is forbidden ` +
        'for adapter-ops (would bypass durable reconcile claim authz).',
    );
  }
}

type CapabilityStoreRepository = {
  consumeCapabilityReplay?: unknown;
  isCapabilityRevoked?: unknown;
  revokeCapability?: unknown;
};

/**
 * Production EffectBroker options require durable replay + revocations from the
 * Task 3 factory (non-optional). Also verifies kernel repository methods exist.
 */
export function assertDurableCapabilityStores(
  capability: Pick<CapabilityAuthority, 'revocations' | 'replayForTenant'>,
  repository: CapabilityStoreRepository,
): void {
  if (!capability.revocations) {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: createCapabilityAuthority did not provide revocations`,
    );
  }
  if (typeof capability.replayForTenant !== 'function') {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: createCapabilityAuthority did not provide replayForTenant`,
    );
  }
  if (
    typeof capability.revocations.isRevoked !== 'function' ||
    typeof capability.revocations.revoke !== 'function'
  ) {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: revocations must expose isRevoked/revoke`,
    );
  }
  const replay = capability.replayForTenant('__assert_durable_probe__');
  if (!replay || typeof replay.consume !== 'function') {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: replayForTenant() must return a store with consume()`,
    );
  }
  if (typeof repository.consumeCapabilityReplay !== 'function') {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: kernel repository missing consumeCapabilityReplay`,
    );
  }
  if (typeof repository.isCapabilityRevoked !== 'function') {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: kernel repository missing isCapabilityRevoked`,
    );
  }
  if (typeof repository.revokeCapability !== 'function') {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: kernel repository missing revokeCapability`,
    );
  }
}

/** Build EffectBroker options with durable replay + revocations (non-optional).
 * Replay is the authority factory (no fixed tenant) — durable consume stays on
 * capability.verifier via grant.tenantId; options only assert wiring presence.
 */
export function productionCapabilityBrokerOptions(
  capability: CapabilityAuthority,
  localWorkerId: string,
  localWorkerGeneration?: number,
): EffectBrokerOptions & {
  replay: CapabilityAuthority['replayForTenant'];
  revocations: CapabilityAuthority['revocations'];
  requireDurableCapabilityStores: true;
} {
  return {
    audience: capability.audience,
    requireRequestBinding: true,
    localWorkerId,
    ...(localWorkerGeneration !== undefined ? { localWorkerGeneration } : {}),
    requireDurableCapabilityStores: true,
    replay: (tenantId: string) => capability.replayForTenant(tenantId),
    revocations: capability.revocations,
  };
}

/**
 * Class A compensation digest: bind effect type + exact compensation patch.
 * requestHash remains canonicalRequestHash(patch) for admit request binding.
 */
export function compensationActionDigest(
  action: string,
  payload: Record<string, unknown>,
): string {
  return canonicalRequestHash({ type: action, ...payload });
}

/** Mint a short-lived compensation grant (Class A includes actionDigest). */
export function issueCompensationCapabilityToken(input: {
  issuer: CapabilityTokenIssuer;
  tenantId: string;
  runId: string;
  stepId: string;
  action: string;
  payload: Record<string, unknown>;
  workerId?: string;
  workerGeneration?: number;
  ttlMs?: number;
}): string {
  const workerId = input.workerId ?? ADAPTER_OPS_COMPENSATION_WORKER_ID;
  const workerGeneration = input.workerGeneration ?? 1;
  const request = input.payload ?? {};
  const requestHash = canonicalRequestHash(request);
  const ttlMs = input.ttlMs ?? 60_000;
  return input.issuer.issue({
    jti: randomUUID(),
    tenantId: input.tenantId,
    runId: input.runId,
    stepId: input.stepId,
    effectTypes: [input.action],
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    requestHash,
    ...(isClassAEffectType(input.action)
      ? { actionDigest: compensationActionDigest(input.action, request) }
      : {}),
    workloadId: workerId,
    workerId,
    workerGeneration,
    policySnapshotId: POLICY_SNAPSHOT_ID,
    nonce: randomUUID(),
  });
}

/**
 * Register reconcile + compensation daemon rows in commander_workers (no DDL).
 * The default adapter is a narrow client of the kernel-owned register_worker
 * SECURITY DEFINER RPC; adapter-ops does not depend on worker-plane runtime.
 */
export async function registerAdapterOpsDaemonWorkers(
  registry: AdapterOpsWorkerRegistry,
  tenantIds: string[],
  opts?: {
    reconcileWorkerId?: string;
    compensationWorkerId?: string;
    /** Prior claim secret when re-registering a still-fresh ACTIVE worker. */
    reconcilePreviousClaimSecret?: string;
    compensationPreviousClaimSecret?: string;
  },
): Promise<{
  reconcile: { id: string; generation: number; claimSecret: string };
  compensation: { id: string; generation: number; claimSecret: string };
}> {
  const reconcileWorkerId = opts?.reconcileWorkerId ?? ADAPTER_OPS_RECONCILE_WORKER_ID;
  const compensationWorkerId =
    opts?.compensationWorkerId ?? ADAPTER_OPS_COMPENSATION_WORKER_ID;
  await registry.initialize();
  const reconcile = await registry.register(
    {
      id: reconcileWorkerId,
      kind: 'tool',
      version: '1',
      capabilities: ['effect.reconcile'],
      maxConcurrency: 1,
      labels: { role: 'reconciliation-daemon' },
    },
    `ops:${reconcileWorkerId}`,
    tenantIds,
    opts?.reconcilePreviousClaimSecret,
  );
  const compensation = await registry.register(
    {
      id: compensationWorkerId,
      kind: 'tool',
      version: '1',
      capabilities: ['effect.compensate'],
      maxConcurrency: 1,
      labels: { role: 'compensation-daemon' },
    },
    `ops:${compensationWorkerId}`,
    tenantIds,
    opts?.compensationPreviousClaimSecret,
  );
  if (!reconcile.claimSecret || !compensation.claimSecret) {
    throw new Error('registerAdapterOpsDaemonWorkers: register must return claimSecret');
  }
  return {
    reconcile: {
      id: reconcile.id,
      generation: reconcile.generation,
      claimSecret: reconcile.claimSecret,
    },
    compensation: {
      id: compensation.id,
      generation: compensation.generation,
      claimSecret: compensation.claimSecret,
    },
  };
}

export interface AdapterOpsWiringOptions {
  /**
   * Test seam: inject the narrow worker-registration port. When set (or postgres pool is present),
   * both daemon identities are registered before daemons start.
   */
  workerRegistry?: AdapterOpsWorkerRegistry;
}

export interface AdapterOpsWorkerIdentities {
  reconcile: { id: string; generation: number; claimSecret?: string };
  compensation: { id: string; generation: number; claimSecret?: string };
}

/**
 * Demo-only hollow PEP：仅本地/demo 可设 COMMANDER_ADAPTER_OPS_DEMO_OPEN=1，
 * 切换为 permit-all PolicyEvaluator；生产/enterprise 一律拒绝该 flag。
 */
function assertDemoOpenGate(): boolean {
  const demoOpen = process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN === '1';
  if (demoOpen && isProductionOrEnterprise()) {
    throw new Error(
      'ADAPTER_OPS_DEMO_OPEN_FORBIDDEN_IN_PRODUCTION: unset COMMANDER_ADAPTER_OPS_DEMO_OPEN for enterprise/production',
    );
  }
  return demoOpen;
}

function createAdapterExecutor(registry: ActionAdapterRegistry) {
  return {
    execute: async (input: {
      type: string;
      request: Record<string, unknown>;
      signal: AbortSignal;
      executionContext?: {
        tenantId?: string;
        effectId?: string;
      };
    }) => {
      const adapter = registry.resolve(input.type);
      if (!adapter) throw new Error('UNREGISTERED_EFFECT_TYPE: ' + input.type);
      const ctx = input.executionContext;
      if (!ctx?.tenantId || !ctx.effectId) throw new Error('EFFECT_AUTHORIZATION_REQUIRED');
      const idempotencyKey = String(input.request.idempotencyKey ?? '');
      const destination = String(input.request.destination ?? '');
      if (input.type.startsWith('compensate.')) {
        const compensateInput: AdapterCompensateInput = {
          tenantId: ctx.tenantId,
          effectId: ctx.effectId,
          originalEffectId: String(input.request.originalEffectId ?? ''),
          idempotencyKey,
          destination,
          forwardResponse: (input.request.forwardResponse as Record<string, unknown>) ?? {},
          compensationPatch: (input.request.compensationPatch as Record<string, unknown>) ?? {},
          signal: input.signal,
        };
        return adapter.compensate(compensateInput);
      }
      const executeInput: AdapterExecuteInput = {
        tenantId: ctx.tenantId,
        effectId: ctx.effectId,
        idempotencyKey,
        destination,
        args: (input.request.args as Record<string, unknown>) ?? {},
        signal: input.signal,
      };
      return adapter.execute(executeInput);
    },
  };
}

/** Fail-closed: 仅 ActionAdapterRegistry 已注册的 effect type 可通过。 */
function createRegistryPolicy(registry: ActionAdapterRegistry): PolicyEvaluator {
  return {
    evaluate: async ({ type }) => {
      const adapter = registry.resolve(type);
      if (!adapter) {
        return {
          effect: 'deny' as const,
          decisionId: 'adapter-ops-deny-unregistered',
          policySnapshotId: POLICY_SNAPSHOT_ID,
          reason: 'unregistered effect type: ' + type,
        };
      }
      return {
        effect: 'allow' as const,
        decisionId: 'adapter-ops-allow:' + type,
        policySnapshotId: POLICY_SNAPSHOT_ID,
        reason: 'registered adapter ' + adapter.descriptor.adapterId,
      };
    },
  };
}

/** Demo hollow PEP：permit-all（仅 DEMO_OPEN=1 且非生产）。 */
function createHollowDemoPolicy(): PolicyEvaluator {
  return {
    evaluate: async ({ type }) => ({
      effect: 'allow' as const,
      decisionId: 'adapter-ops-demo-open:' + type,
      policySnapshotId: POLICY_SNAPSHOT_ID,
      reason: 'COMMANDER_ADAPTER_OPS_DEMO_OPEN hollow PEP',
    }),
  };
}

/** Structured audit sink — never a silent no-op. */
function createStdoutAuditSink(): AuditSink {
  return {
    append: async (event) => {
      console.error(
        JSON.stringify({
          channel: 'adapter-ops-audit',
          ...event,
        }),
      );
    },
  };
}

function createProductionRegistry(
  credentials: EnvAdapterCredentialProvider,
  egressAllowlist: readonly string[],
): ActionAdapterRegistry {
  const fetchImpl = createEgressGatedFetch(egressAllowlist);
  return new ActionAdapterRegistry([
    createGitHubPullRequestCreateAdapter({ credentials, fetch: fetchImpl }),
    createServiceNowIncidentCreateAdapter({ credentials, fetch: fetchImpl }),
  ]);
}

export async function createAdapterOpsWiring(
  options: AdapterOpsWiringOptions = {},
): Promise<{
  reconciliation: ReconciliationDaemon;
  compensation: CompensationDaemon;
  close: () => Promise<void>;
  /** 供测试断言：当前 PEP 是否为 demo hollow。 */
  demoOpenHollowPep: boolean;
  /** Registered (or sqlite fallback) daemon worker identities + generations. */
  workers: AdapterOpsWorkerIdentities;
  /** When true, /ready must see claimSecret on both daemons (postgres / injected registry). */
  requiresDurableClaim: boolean;
  /** Compensation EffectBroker localWorkerId — must equal compensation-daemon. */
  compensationLocalWorkerId: string;
}> {
  const demoOpen = assertDemoOpenGate();
  const egressAllowlist = parseEgressAllowlist();

  // Owner/scheduler DSN + schedulerMode gates BEFORE kernel connect.
  assertAdapterOpsSchedulerModeForbidden(process.env);
  const dsn =
    process.env.COMMANDER_KERNEL_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    '';
  if (dsn) assertNonOwnerDatabaseUrl(dsn);

  // Force schedulerMode off even if env was mutated after the assert above.
  const handle = await createKernelRepository({
    env: { ...process.env, COMMANDER_KERNEL_SCHEDULER_MODE: '0' },
  });
  const repository = handle.repository;

  // Post-connect owner-role gate before capability authority / egress registry.
  if (handle.postgresPool) {
    const client = await handle.postgresPool.connect();
    try {
      const identityRows = await client.query<{ role_name: string }>(
        'SELECT current_user::text AS role_name',
      );
      assertNonOwnerDatabaseRole(identityRows.rows[0]?.role_name ?? '');
    } finally {
      client.release();
    }
  }

  // Task 3 factory — never CapabilityTokenIssuer.generate() for production authority.
  const capability = createCapabilityAuthority(process.env, repository);
  assertDurableCapabilityStores(capability, repository);

  const cellTenantId = process.env.COMMANDER_CELL_TENANT_ID?.trim() ?? '';
  if (!cellTenantId) {
    throw new Error(
      `${COMMANDER_CELL_TENANT_ID_REQUIRED}: set COMMANDER_CELL_TENANT_ID (no silent "local" fallback)`,
    );
  }
  const credentials = new EnvAdapterCredentialProvider({ cellTenantId });
  const registry = createProductionRegistry(credentials, egressAllowlist);
  const issuer = capability.issuer;
  const tokens = capability.verifier;
  const policy = demoOpen ? createHollowDemoPolicy() : createRegistryPolicy(registry);
  const audit = createStdoutAuditSink();
  const kernelPort = {
    admitEffect: (input: Parameters<typeof repository.admitEffect>[0]) =>
      repository.admitEffect(input),
    completeEffect: (
      effectId: string,
      tenantId: string,
      lease: Parameters<typeof repository.completeEffect>[2],
      response: Record<string, unknown>,
      actor: string,
    ) => repository.completeEffect(effectId, tenantId, lease, response, actor),
    markEffectCompletionUnknown: (
      input: Parameters<typeof repository.markEffectCompletionUnknown>[0],
    ) => repository.markEffectCompletionUnknown(input),
    failEffect: (input: Parameters<typeof repository.failEffect>[0]) =>
      repository.failEffect(input),
    getEffect: (effectId: string, tenantId: string) => repository.getEffect(effectId, tenantId),
    reconcileEffect: (input: Parameters<typeof repository.reconcileEffect>[0]) =>
      repository.reconcileEffect(input),
    isActionAllowed: async (_tenantId: string, action: string) =>
      demoOpen || registry.resolve(action) !== null,
  };
  const executor = createAdapterExecutor(registry);

  const reconcileWorkerId =
    process.env.COMMANDER_RECONCILE_WORKER_ID?.trim() || ADAPTER_OPS_RECONCILE_WORKER_ID;
  const compensationWorkerId = ADAPTER_OPS_COMPENSATION_WORKER_ID;

  // P0: register BOTH daemon identities before claim/admit (postgres or injected registry).
  // Fail-closed tenant scope matches worker-plane (COMMANDER_WORKER_TENANTS).
  let reconcileGeneration = Number(process.env.COMMANDER_RECONCILE_WORKER_GENERATION ?? 1);
  let compensationGeneration = 1;
  let reconcileClaimSecret: string | undefined;
  let compensationClaimSecret: string | undefined;
  const mustRegister = Boolean(handle.postgresPool) || Boolean(options.workerRegistry);
  if (mustRegister) {
    const tenantIds = resolveAdapterOpsTenantScope(process.env);
    const workerRegistry =
      options.workerRegistry ?? new PostgresAdapterOpsWorkerRegistry(handle.postgresPool!);
    const registered = await registerAdapterOpsDaemonWorkers(workerRegistry, tenantIds, {
      reconcileWorkerId,
      compensationWorkerId,
      reconcilePreviousClaimSecret:
        process.env.COMMANDER_RECONCILE_CLAIM_SECRET?.trim() || undefined,
      compensationPreviousClaimSecret:
        process.env.COMMANDER_COMPENSATION_CLAIM_SECRET?.trim() || undefined,
    });
    reconcileGeneration = registered.reconcile.generation;
    compensationGeneration = registered.compensation.generation;
    reconcileClaimSecret = registered.reconcile.claimSecret;
    compensationClaimSecret = registered.compensation.claimSecret;
  }

  // Compensation path: broker affinity MUST match admit lease workerId (not adapter-ops-worker).
  const compensationBroker = new EffectBroker(
    tokens,
    policy,
    kernelPort,
    executor,
    audit,
    productionCapabilityBrokerOptions(
      capability,
      compensationWorkerId,
      compensationGeneration,
    ),
  );
  const reconciliation = new ReconciliationDaemon({
    repository,
    brokerFactory: () =>
      new EffectBroker(
        tokens,
        policy,
        kernelPort,
        {
          execute: async () => {
            throw new Error('reconcile must not execute writes');
          },
        },
        audit,
        productionCapabilityBrokerOptions(
          capability,
          reconcileWorkerId,
          reconcileGeneration,
        ),
      ),
    registry,
    pollIntervalMs: Number(process.env.COMMANDER_RECONCILE_INTERVAL_MS ?? 5_000),
    batchSize: Number(process.env.COMMANDER_RECONCILE_BATCH_SIZE ?? 50),
    actor: reconcileWorkerId,
    workerId: reconcileWorkerId,
    workerGeneration: reconcileGeneration,
    claimSecret: reconcileClaimSecret,
  });
  const compensation = new CompensationDaemon({
    repository,
    broker: compensationBroker,
    registry,
    tokenProvider: async ({ tenantId, runId, stepId, action, payload }) =>
      issueCompensationCapabilityToken({
        issuer,
        tenantId,
        runId,
        stepId,
        action,
        payload: payload ?? {},
        workerId: compensationWorkerId,
        workerGeneration: compensationGeneration,
      }),
    pollIntervalMs: Number(process.env.COMMANDER_COMPENSATION_INTERVAL_MS ?? 5_000),
    batchSize: Number(process.env.COMMANDER_COMPENSATION_BATCH_SIZE ?? 50),
    workerId: compensationWorkerId,
    workerGeneration: compensationGeneration,
    claimSecret: compensationClaimSecret,
    audit,
  });
  return {
    reconciliation,
    compensation,
    demoOpenHollowPep: demoOpen,
    requiresDurableClaim: mustRegister,
    workers: {
      reconcile: {
        id: reconcileWorkerId,
        generation: reconcileGeneration,
        ...(reconcileClaimSecret ? { claimSecret: reconcileClaimSecret } : {}),
      },
      compensation: {
        id: compensationWorkerId,
        generation: compensationGeneration,
        ...(compensationClaimSecret ? { claimSecret: compensationClaimSecret } : {}),
      },
    },
    compensationLocalWorkerId: compensationWorkerId,
    close: async () => {
      await handle.close();
    },
  };
}
