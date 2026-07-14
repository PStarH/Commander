import { describe, it } from 'node:test';
import assert from 'node:assert';

void describe('@commander/sdk — types', () => {
  void it('types are valid — CommanderClientConfig', () => {
    const config: import('../src/types').CommanderClientConfig = {
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      tokenBudget: 32000,
      baseUrl: 'https://api.openai.com',
    };
    assert.equal(config.provider, 'openai');
    assert.equal(config.tokenBudget, 32000);
  });

  void it('types are valid — ExecutionResult', () => {
    const result: import('../src/types').ExecutionResult = {
      status: 'SUCCESS',
      summary: 'Test run completed',
      steps: [],
      totalTokenUsage: 1000,
      totalDurationMs: 5000,
      error: undefined,
    };
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.totalTokenUsage, 1000);
  });

  void it('types are valid — ExecutionEvent', () => {
    const event: import('../src/types').ExecutionEvent = {
      type: 'agent.started',
      timestamp: new Date().toISOString(),
      data: { agentId: 'test' },
    };
    assert.equal(event.type, 'agent.started');
  });

  void it('types are valid — SystemStatus', () => {
    const status: import('../src/types').SystemStatus = {
      provider: 'openai',
      model: 'gpt-4o',
      uptime: '120s',
      totalRuns: 5,
      activeSessions: 1,
      memoryUsage: 123456789,
    };
    assert.equal(status.totalRuns, 5);
  });

  void it('types are valid — ExecutionStepSummary', () => {
    const step: import('../src/types').ExecutionStepSummary = {
      stepNumber: 1,
      action: 'test step',
      status: 'completed',
      tokenUsage: 500,
      durationMs: 1000,
    };
    assert.equal(step.stepNumber, 1);
    assert.equal(step.tokenUsage, 500);
  });
});

void describe('@commander/sdk — CommanderClient', () => {
  void it('can be instantiated with default config', () => {
    const { CommanderClient } = require('../src/commanderClient');
    const client = new CommanderClient();
    assert.ok(client);
    assert.equal(client.isConnected, false);
  });

  void it('throws on run before connect', async () => {
    const { CommanderClient } = require('../src/commanderClient');
    const client = new CommanderClient();
    await assert.rejects(() => client.run('test task'), /not connected/);
  });

  void it('throws on plan before connect', async () => {
    const { CommanderClient } = require('../src/commanderClient');
    const client = new CommanderClient();
    await assert.rejects(() => client.plan('test task'), /not connected/);
  });

  void it('returns empty session list before any runs', () => {
    const { CommanderClient } = require('../src/commanderClient');
    const client = new CommanderClient();
    const sessions = client.listSessions();
    assert.deepEqual(sessions, []);
  });

  void it('detects no provider from empty env', () => {
    const { CommanderClient } = require('../src/commanderClient');
    const client = new CommanderClient();
    // Private method — just verify the constructor works without env keys
    assert.equal(client.isConnected, false);
  });

  void describe('memory (best-effort)', () => {
    void it('queryMemory returns an array without throwing when not connected', () => {
      const { CommanderClient } = require('../src/commanderClient');
      const client = new CommanderClient();
      const results = client.queryMemory({ keywords: ['test'], limit: 5 });
      assert.ok(Array.isArray(results));
    });

    void it('getMemoryStats returns zeroed stats when not connected', async () => {
      const { CommanderClient } = require('../src/commanderClient');
      const client = new CommanderClient();
      const stats = await client.getMemoryStats();
      assert.equal(stats.workingCount, 0);
      assert.equal(stats.episodicCount, 0);
      assert.equal(stats.longTermCount, 0);
      assert.equal(stats.totalCount, 0);
    });

    void it('getStats is a live alias for getMemoryStats', async () => {
      const { CommanderClient } = require('../src/commanderClient');
      const client = new CommanderClient();
      const stats = await client.getStats();
      assert.equal(stats.totalCount, 0);
      assert.equal(stats.workingCount, 0);
    });
  });
});

void describe('@commander/sdk — Gateway V1 client', () => {
  void it('submits a durable run with idempotency and preserves 202 semantics', async () => {
    const { CommanderGatewayClient } = require('../src/v1/client');
    let captured: RequestInit | undefined;
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example/',
      apiKey: 'key',
      fetch: async (_url: string, init?: RequestInit) => {
        captured = init;
        return new Response(JSON.stringify({
          run: { id: 'run-1', status: 'pending', tenantId: 'tenant-a', createdAt: 'now', updatedAt: 'now', intentHash: 'i', workGraphHash: 'g', workGraphVersion: 'v1', policySnapshotId: 'p1' },
          idempotentReplay: false,
        }), { status: 202, headers: { 'content-type': 'application/json' } });
      },
    });
    const result = await client.submitRun({ goal: 'reconcile invoices', policySnapshotId: 'p1', idempotencyKey: 'idem-key-0001' });
    assert.equal(result.accepted, true);
    assert.equal(result.run.id, 'run-1');
    assert.equal(new Headers(captured?.headers).get('idempotency-key'), 'idem-key-0001');
  });
});
