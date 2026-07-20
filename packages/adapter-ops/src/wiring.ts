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
  type AdapterCompensateInput,
  type AdapterExecuteInput,
} from '@commander/action-adapters';
import { randomUUID } from 'node:crypto';
import { ReconciliationDaemon } from './reconciliationDaemon.js';
import { CompensationDaemon } from './compensationDaemon.js';

const POLICY_SNAPSHOT_ID = 'adapter-ops-v1';

function isProductionOrEnterprise(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.COMMANDER_PROFILE === 'enterprise';
}

/**
 * Demo-only hollow PEP is forbidden in production/enterprise.
 * Set COMMANDER_ADAPTER_OPS_DEMO_OPEN=1 only for local/demo cells.
 */
function assertDemoOpenGate(): void {
  const demoOpen = process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN === '1';
  if (demoOpen && isProductionOrEnterprise()) {
    throw new Error(
      'ADAPTER_OPS_DEMO_OPEN_FORBIDDEN_IN_PRODUCTION: unset COMMANDER_ADAPTER_OPS_DEMO_OPEN for enterprise/production',
    );
  }
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
      if (!adapter) throw new Error(`UNREGISTERED_EFFECT_TYPE: ${input.type}`);
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

/** Fail-closed: only effect types registered in ActionAdapterRegistry may be allowed. */
function createRegistryPolicy(registry: ActionAdapterRegistry): PolicyEvaluator {
  return {
    evaluate: async ({ type }) => {
      const adapter = registry.resolve(type);
      if (!adapter) {
        return {
          effect: 'deny' as const,
          decisionId: 'adapter-ops-deny-unregistered',
          policySnapshotId: POLICY_SNAPSHOT_ID,
          reason: `unregistered effect type: ${type}`,
        };
      }
      return {
        effect: 'allow' as const,
        decisionId: `adapter-ops-allow:${type}`,
        policySnapshotId: POLICY_SNAPSHOT_ID,
        reason: `registered adapter ${adapter.descriptor.adapterId}`,
      };
    },
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

export async function createAdapterOpsWiring(): Promise<{
  reconciliation: ReconciliationDaemon;
  compensation: CompensationDaemon;
  close: () => Promise<void>;
}> {
  assertDemoOpenGate();

  const handle = await createKernelRepository({ env: process.env });
  const repository = handle.repository;
  const cellTenantId = process.env.COMMANDER_CELL_TENANT_ID?.trim() || 'local';
  const credentials = new EnvAdapterCredentialProvider({ cellTenantId });
  const registry = ActionAdapterRegistry.production(credentials);
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
  const policy = createRegistryPolicy(registry);
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
    isActionAllowed: async (_tenantId: string, action: string) => registry.resolve(action) !== null,
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
        jti: `ops-${Date.now()}`,
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
    close: async () => {
      await handle.close();
    },
  };
}
