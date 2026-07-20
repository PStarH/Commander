import { createKernelRepository } from '@commander/kernel';
import {
  EffectBroker,
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  canonicalRequestHash,
  type AuditSink,
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

function isProductionOrEnterprise(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.COMMANDER_PROFILE === 'enterprise';
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

export async function createAdapterOpsWiring(): Promise<{
  reconciliation: ReconciliationDaemon;
  compensation: CompensationDaemon;
  close: () => Promise<void>;
  /** 供测试断言：当前 PEP 是否为 demo hollow。 */
  demoOpenHollowPep: boolean;
}> {
  const demoOpen = assertDemoOpenGate();
  const egressAllowlist = parseEgressAllowlist();

  const handle = await createKernelRepository({ env: process.env });
  const repository = handle.repository;
  const cellTenantId = process.env.COMMANDER_CELL_TENANT_ID?.trim() || 'local';
  const credentials = new EnvAdapterCredentialProvider({ cellTenantId });
  const registry = createProductionRegistry(credentials, egressAllowlist);
  const issuer = CapabilityTokenIssuer.generate({
    issuer: 'commander-adapter-ops',
    audience: 'commander.effect-broker',
    keyId: 'adapter-ops',
  });
  const tokens = new CapabilityTokenVerifier({
    issuer: 'commander-adapter-ops',
    audience: 'commander.effect-broker',
    publicKeys: { 'adapter-ops': issuer.publicKey },
  });
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
  const workerBroker = new EffectBroker(tokens, policy, kernelPort, executor, audit, {
    audience: 'commander.effect-broker',
    localWorkerId: 'adapter-ops-worker',
  });
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
        {
          audience: 'commander.effect-broker',
          localWorkerId: 'reconciliation-daemon',
        },
      ),
    registry,
    pollIntervalMs: Number(process.env.COMMANDER_RECONCILE_INTERVAL_MS ?? 5_000),
    batchSize: Number(process.env.COMMANDER_RECONCILE_BATCH_SIZE ?? 50),
    actor: 'reconciliation-daemon',
  });
  const compensation = new CompensationDaemon({
    repository,
    broker: workerBroker,
    registry,
    tokenProvider: async ({ tenantId, runId, stepId, action, payload }) => {
      const request = payload ?? {};
      return issuer.issue({
        jti: 'ops-' + Date.now(),
        tenantId,
        runId,
        stepId,
        effectTypes: [action],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requestHash: canonicalRequestHash(request),
        workloadId: 'compensation-daemon',
        policySnapshotId: POLICY_SNAPSHOT_ID,
        nonce: randomUUID(),
      });
    },
    pollIntervalMs: Number(process.env.COMMANDER_COMPENSATION_INTERVAL_MS ?? 5_000),
    batchSize: Number(process.env.COMMANDER_COMPENSATION_BATCH_SIZE ?? 50),
    workerId: 'compensation-daemon',
    audit,
  });
  return {
    reconciliation,
    compensation,
    demoOpenHollowPep: demoOpen,
    close: async () => {
      await handle.close();
    },
  };
}
