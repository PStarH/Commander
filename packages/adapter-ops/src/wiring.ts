import { createKernelRepository } from '@commander/kernel';
import {
  EffectBroker,
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  canonicalRequestHash,
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

export async function createOperationsWiring(): Promise<{
  reconciliation: ReconciliationDaemon;
  compensation: CompensationDaemon;
  close: () => Promise<void>;
}> {
  const handle = await createKernelRepository({ env: process.env });
  const repository = handle.repository;
  const cellTenantId = process.env.COMMANDER_CELL_TENANT_ID?.trim() || 'local';
  const credentials = new EnvAdapterCredentialProvider({ cellTenantId });
  const registry = ActionAdapterRegistry.production(credentials);
  const issuer = CapabilityTokenIssuer.generate({
    issuer: 'commander-operations',
    audience: 'commander.effect-broker',
    keyId: 'operations',
  });
  const tokens = new CapabilityTokenVerifier({
    issuer: 'commander-operations',
    audience: 'commander.effect-broker',
    publicKeys: { operations: issuer.publicKey },
  });
  const policy = {
    evaluate: async () => ({
      effect: 'allow' as const,
      decisionId: 'operations-allow',
      policySnapshotId: 'operations-v1',
      reason: 'operations daemon allow',
    }),
  };
  const audit = { append: async () => {} };
  const kernelPort = {
    admitEffect: (input: Parameters<typeof repository.admitEffect>[0]) => repository.admitEffect(input),
    completeEffect: (
      effectId: string,
      tenantId: string,
      lease: Parameters<typeof repository.completeEffect>[2],
      response: Record<string, unknown>,
      actor: string,
    ) => repository.completeEffect(effectId, tenantId, lease, response, actor),
    markEffectCompletionUnknown: (input: Parameters<typeof repository.markEffectCompletionUnknown>[0]) =>
      repository.markEffectCompletionUnknown(input),
    failEffect: (input: Parameters<typeof repository.failEffect>[0]) => repository.failEffect(input),
    getEffect: (effectId: string, tenantId: string) => repository.getEffect(effectId, tenantId),
    reconcileEffect: (input: Parameters<typeof repository.reconcileEffect>[0]) =>
      repository.reconcileEffect(input),
    isActionAllowed: async () => true,
  };
  const executor = createAdapterExecutor(registry);
  const workerBroker = new EffectBroker(tokens, policy, kernelPort, executor, audit, {
    audience: 'commander.effect-broker',
    localWorkerId: 'operations-worker',
  });
  const reconciliation = new ReconciliationDaemon({
    repository,
    brokerFactory: () =>
      new EffectBroker(tokens, policy, kernelPort, {
        execute: async () => {
          throw new Error('reconcile must not execute writes');
        },
      }, audit, {
        audience: 'commander.effect-broker',
        localWorkerId: 'reconciliation-daemon',
      }),
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
        policySnapshotId: 'operations-v1',
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
