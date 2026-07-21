import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR } from '@commander/contracts';
import { ActionAdapterRegistry } from './registry.js';
import type { ActionAdapter } from './types.js';

function stubAdapter(effectType: string): ActionAdapter {
  return {
    descriptor: { ...GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR, effectType },
    async execute() {
      return {};
    },
    async queryOutcome() {
      return { status: 'UNKNOWN' };
    },
    async compensate() {
      return {};
    },
    async queryCompensationOutcome() {
      return { status: 'UNKNOWN' };
    },
  };
}

describe('ActionAdapterRegistry', () => {
  it('resolve returns adapter by effect type', () => {
    const adapter = stubAdapter('connector.github.pull-request.create');
    const registry = new ActionAdapterRegistry([adapter]);
    assert.equal(registry.resolve('connector.github.pull-request.create'), adapter);
  });

  it('resolve returns adapter by compensation effect type', () => {
    const adapter = stubAdapter('connector.github.pull-request.create');
    const registry = new ActionAdapterRegistry([adapter]);
    assert.equal(registry.resolve('compensate.github.pull-request.create'), adapter);
  });

  it('empty registry resolve returns null', () => {
    assert.equal(ActionAdapterRegistry.empty().resolve('connector.github.pull-request.create'), null);
  });

  it('outcomeQuerierFor bridges adapter queryOutcome', async () => {
    const adapter = stubAdapter('connector.github.pull-request.create');
    adapter.queryOutcome = async () => ({
      status: 'COMPLETED',
      response: { prNumber: 42 },
    });
    const registry = new ActionAdapterRegistry([adapter]);
    const querier = registry.outcomeQuerierFor('connector.github.pull-request.create');
    assert.ok(querier);
    const outcome = await querier!.queryOutcome({
      effectId: 'eff-1',
      idempotencyKey: 'idem-1',
      type: 'connector.github.pull-request.create',
      request: { destination: 'github://octo/repo/pulls' },
      tenantId: 'tenant-a',
    });
    assert.deepEqual(outcome, { status: 'COMPLETED', response: { prNumber: 42 } });
  });

  it('outcomeQuerierFor forwards abort signal to adapter', async () => {
    const controller = new AbortController();
    const adapter = stubAdapter('connector.github.pull-request.create');
    adapter.queryOutcome = async (input) => {
      assert.equal(input.signal, controller.signal);
      return { status: 'UNKNOWN' };
    };
    const registry = new ActionAdapterRegistry([adapter]);
    const querier = registry.outcomeQuerierFor('connector.github.pull-request.create');
    assert.ok(querier);
    await querier!.queryOutcome({
      effectId: 'eff-1',
      idempotencyKey: 'idem-1',
      type: 'connector.github.pull-request.create',
      request: { destination: 'github://octo/repo/pulls' },
      tenantId: 'tenant-a',
      signal: controller.signal,
    });
  });

  it('listDescriptors returns registered descriptor list', () => {
    const adapter = stubAdapter('connector.github.pull-request.create');
    const registry = new ActionAdapterRegistry([adapter]);
    assert.equal(registry.listDescriptors().length, 1);
    assert.equal(registry.listDescriptors()[0]?.effectType, 'connector.github.pull-request.create');
  });
});
