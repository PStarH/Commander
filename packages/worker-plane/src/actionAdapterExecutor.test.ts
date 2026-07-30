import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ActionAdapterRegistry,
  KUBERNETES_DEPLOYMENT_ROLLBACK_DESCRIPTOR,
  type ActionAdapter,
  type AdapterExecuteInput,
} from '@commander/action-adapters';
import {
  createActionAdapterEffectExecutor,
  createProductionAdapterRegistry,
} from './actionAdapterExecutor.js';
import { createWorkerEffectExecutor } from './bootstrap.js';

describe('worker action adapter execution', () => {
  it('fails closed when Kubernetes credential registration is only partially configured', () => {
    assert.throws(
      () =>
        createProductionAdapterRegistry(undefined, {
          COMMANDER_CELL_TENANT_ID: 'tenant-a',
          COMMANDER_KUBERNETES_CLUSTER: 'kind',
        }),
      /must be configured together/,
    );
  });

  it('delegates a registered Kubernetes effect with its authorization bindings intact', async () => {
    let received: AdapterExecuteInput | undefined;
    const adapter: ActionAdapter = {
      descriptor: KUBERNETES_DEPLOYMENT_ROLLBACK_DESCRIPTOR,
      async execute(input) {
        received = input;
        return { status: 'rolled-back' };
      },
      async queryOutcome() {
        return {
          status: 'UNKNOWN',
          error: { code: 'NOT_QUERIED', message: 'not queried in this test' },
        };
      },
      async compensate() {
        return {};
      },
      async queryCompensationOutcome() {
        return {
          status: 'UNKNOWN',
          error: { code: 'NOT_QUERIED', message: 'not queried in this test' },
        };
      },
    };
    const registry = new ActionAdapterRegistry([adapter]);
    const signal = new AbortController().signal;
    const request = {
      destination: 'k8s://kind/commander/deployments/api',
      idempotencyKey: 'rollback-0001',
      args: { targetRevision: '41', reason: 'campaign-4 test' },
    };

    const result = await createWorkerEffectExecutor(
      undefined,
      createActionAdapterEffectExecutor(registry),
    ).execute({
      type: KUBERNETES_DEPLOYMENT_ROLLBACK_DESCRIPTOR.effectType,
      request,
      signal,
      executionContext: {
        tenantId: 'tenant-a',
        workerId: 'worker-a',
        fencingEpoch: 7,
        leaseToken: 'lease-a',
        effectId: 'effect-a',
      },
    });

    assert.deepEqual(result, { status: 'rolled-back' });
    assert.deepEqual(received, {
      tenantId: 'tenant-a',
      effectId: 'effect-a',
      idempotencyKey: 'rollback-0001',
      destination: 'k8s://kind/commander/deployments/api',
      args: { targetRevision: '41', reason: 'campaign-4 test' },
      signal,
    });
  });
});
