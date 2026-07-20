import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from '@commander/kernel/testing/inMemoryRepository';
import {
  createWorkerPolicyEvaluator,
  createWorkerService,
  withDefaultLlmAllowlist,
} from './bootstrap.js';
import { createProductionAdapterRegistry } from './actionAdapterExecutor.js';

describe('enterprise adapter registry gate (T1.2)', () => {
  it('createProductionAdapterRegistry is empty without COMMANDER_CELL_TENANT_ID', () => {
    const savedCellTenant = process.env.COMMANDER_CELL_TENANT_ID;
    delete process.env.COMMANDER_CELL_TENANT_ID;
    try {
      const registry = createProductionAdapterRegistry();
      assert.equal(registry.listDescriptors().length, 0);
    } finally {
      if (savedCellTenant === undefined) delete process.env.COMMANDER_CELL_TENANT_ID;
      else process.env.COMMANDER_CELL_TENANT_ID = savedCellTenant;
    }
  });

  it('createWorkerService rejects enterprise profile with empty adapter registry', async () => {
    const saved = {
      COMMANDER_PROFILE: process.env.COMMANDER_PROFILE,
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      DATABASE_URL: process.env.DATABASE_URL,
      COMMANDER_WORKER_AUTH_TOKEN: process.env.COMMANDER_WORKER_AUTH_TOKEN,
      NODE_ENV: process.env.NODE_ENV,
    };
    process.env.COMMANDER_PROFILE = 'enterprise';
    delete process.env.COMMANDER_CELL_TENANT_ID;
    process.env.DATABASE_URL = 'postgres://unused:5432/unused';
    process.env.COMMANDER_WORKER_AUTH_TOKEN = 'test-auth-token';
    process.env.NODE_ENV = 'test';
    try {
      await assert.rejects(
        () => createWorkerService(),
        /ENTERPRISE_WORKER_REQUIRES_ACTION_ADAPTERS/,
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('sqlite worker bootstrap', () => {
  it('createWorkerService does not require DATABASE_URL when sqlite backend is set', async () => {
    const saved = {
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      DATABASE_URL: process.env.DATABASE_URL,
      COMMANDER_WORKER_AUTH_TOKEN: process.env.COMMANDER_WORKER_AUTH_TOKEN,
      NODE_ENV: process.env.NODE_ENV,
    };
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'worker-bootstrap-sqlite-'));
    const dbPath = join(dir, 'kernel.sqlite');
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    delete process.env.DATABASE_URL;
    process.env.COMMANDER_WORKER_AUTH_TOKEN = 'test-auth-token';
    process.env.NODE_ENV = 'test';
    try {
      const service = await createWorkerService();
      assert.ok(service);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('createWorkerPolicyEvaluator', () => {
  it('allows llm.* model calls by default (agent can invoke providers)', async () => {
    const policy = createWorkerPolicyEvaluator({});
    const decision = await policy.evaluate({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      type: 'llm.openai',
      request: { effectId: 'e1', contentHash: 'h' },
      token: {} as never,
    });
    assert.equal(decision.effect, 'allow');
    assert.equal(decision.decisionId, 'llm-model-default');
    assert.equal(decision.policySnapshotId, 'worker-llm-v1');
  });

  it('denies non-llm external effects by default (fail-closed)', async () => {
    const policy = createWorkerPolicyEvaluator({});
    const decision = await policy.evaluate({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      type: 'crm.write',
      request: {},
      token: {} as never,
    });
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.decisionId, 'deny-default');
  });

  it('never enables permit-all via COMMANDER_WORKER_EFFECT_POLICY=permit', async () => {
    // WS2 §4: the permit-all bypass is DELETED. Even with the legacy env var
    // set, non-llm tools stay denied.
    const policy = createWorkerPolicyEvaluator({
      COMMANDER_WORKER_EFFECT_POLICY: 'permit',
    } as NodeJS.ProcessEnv);
    const tool = await policy.evaluate({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      type: 'crm.write',
      request: {},
      token: {} as never,
    });
    assert.equal(tool.effect, 'deny');
    assert.notEqual(tool.decisionId, 'permit-default');

    const llm = await policy.evaluate({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      type: 'llm.anthropic',
      request: {},
      token: {} as never,
    });
    assert.equal(llm.effect, 'allow');
  });

  it('denies http.* in production without an explicit allowlist path', async () => {
    const policy = createWorkerPolicyEvaluator({
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv);
    const decision = await policy.evaluate({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      type: 'http.post',
      request: { url: 'https://example.com' },
      token: {} as never,
    });
    assert.equal(decision.effect, 'deny');
  });
});

describe('withDefaultLlmAllowlist', () => {
  it('seeds llm.* so model actions pass isActionAllowed', async () => {
    const kernel = new InMemoryKernelRepository();
    const port = withDefaultLlmAllowlist(kernel);
    assert.equal(await port.isActionAllowed!('tenant-a', 'llm.openai'), true);
    assert.equal(await port.isActionAllowed!('tenant-a', 'crm.write'), false);
  });

  it('does not overwrite an explicit llm.* deny', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.setAllowlistEntry('tenant-a', 'llm.*', false);
    const port = withDefaultLlmAllowlist(kernel);
    assert.equal(await port.isActionAllowed!('tenant-a', 'llm.openai'), false);
  });
});