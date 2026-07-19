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

const actionFixtures = {
  input: {
    source: 'sdk-test',
    package: 'demo.package',
    model: 'demo-model',
    tool: 'ticket.create',
    destination: 'demo://tickets',
    effectType: 'demo.ticket.create',
    args: { title: 'Reset password' },
    idempotencyKey: 'action-key-0001',
  },
  simulation: {
    simulationId: 'sim-1',
    decisionId: 'action-gateway-allow',
    effect: 'allow',
    reason: 'allowed',
    policySnapshotId: 'action-gateway-mvp-v1',
    actionDigest: 'a'.repeat(64),
  },
  action: {
    runId: 'run-action-1',
    stepId: 'step-1',
    effectId: 'effect-1',
    state: 'PENDING',
    decision: {
      effect: 'allow',
      decisionId: 'action-gateway-allow',
      reason: 'allowed',
      policySnapshotId: 'action-gateway-mvp-v1',
    },
    simulation: {
      simulationId: 'sim-1',
      decisionId: 'action-gateway-allow',
      effect: 'allow',
      reason: 'allowed',
      policySnapshotId: 'action-gateway-mvp-v1',
      actionDigest: 'a'.repeat(64),
    },
    actionDigest: 'a'.repeat(64),
    policySnapshotId: 'action-gateway-mvp-v1',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  },
};

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

  void it('simulateAction posts the governed action envelope', async () => {
    const { CommanderGatewayClient } = require('../src/v1/client');
    let url = '';
    let captured: RequestInit | undefined;
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example',
      apiKey: 'key',
      fetch: async (requestUrl: string, init?: RequestInit) => {
        url = requestUrl;
        captured = init;
        return new Response(JSON.stringify({ simulation: actionFixtures.simulation }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const result = await client.simulateAction(actionFixtures.input);
    assert.equal(url, 'https://commander.example/v1/actions/simulate');
    assert.equal(captured?.method, 'POST');
    assert.deepEqual(JSON.parse(String(captured?.body)), actionFixtures.input);
    assert.equal(result.simulation.simulationId, 'sim-1');
  });

  void it('proposeAction posts with Idempotency-Key header', async () => {
    const { CommanderGatewayClient } = require('../src/v1/client');
    let captured: RequestInit | undefined;
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example',
      apiKey: 'key',
      fetch: async (_url: string, init?: RequestInit) => {
        captured = init;
        return new Response(
          JSON.stringify({ action: actionFixtures.action, idempotentReplay: false }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const result = await client.proposeAction(actionFixtures.input);
    assert.equal(result.accepted, true);
    assert.equal(result.action.runId, 'run-action-1');
    assert.equal(new Headers(captured?.headers).get('idempotency-key'), 'action-key-0001');
    assert.deepEqual(JSON.parse(String(captured?.body)), actionFixtures.input);
  });

  void it('getAction loads a governed action by run id', async () => {
    const { CommanderGatewayClient } = require('../src/v1/client');
    let url = '';
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example',
      apiKey: 'key',
      fetch: async (requestUrl: string) => {
        url = requestUrl;
        return new Response(JSON.stringify({ action: actionFixtures.action }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const result = await client.getAction('run-action-1');
    assert.equal(url, 'https://commander.example/v1/actions/run-action-1');
    assert.equal(result.runId, 'run-action-1');
  });

  void it('approveAction posts approval bindings', async () => {
    const { CommanderGatewayClient } = require('../src/v1/client');
    let url = '';
    let captured: RequestInit | undefined;
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example',
      apiKey: 'key',
      fetch: async (requestUrl: string, init?: RequestInit) => {
        url = requestUrl;
        captured = init;
        return new Response(JSON.stringify({ action: actionFixtures.action }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const approval = {
      actionDigest: actionFixtures.action.actionDigest,
      simulationId: actionFixtures.action.simulation.simulationId,
      policySnapshotId: actionFixtures.action.policySnapshotId,
    };
    const result = await client.approveAction('run-action-1', approval);
    assert.equal(url, 'https://commander.example/v1/actions/run-action-1/approve');
    assert.deepEqual(JSON.parse(String(captured?.body)), approval);
    assert.equal(result.runId, 'run-action-1');
  });

  void it('rejectAction posts optional reason', async () => {
    const { CommanderGatewayClient } = require('../src/v1/client');
    let captured: RequestInit | undefined;
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example',
      apiKey: 'key',
      fetch: async (_url: string, init?: RequestInit) => {
        captured = init;
        return new Response(JSON.stringify({ action: { ...actionFixtures.action, state: 'REJECTED' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const result = await client.rejectAction('run-action-1', { reason: 'too risky' });
    assert.equal(result.state, 'REJECTED');
    assert.deepEqual(JSON.parse(String(captured?.body)), { reason: 'too risky' });
  });

  void it('reconcileAction posts to reconcile endpoint', async () => {
    const { CommanderGatewayClient } = require('../src/v1/client');
    let url = '';
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example',
      apiKey: 'key',
      fetch: async (requestUrl: string, init?: RequestInit) => {
        url = requestUrl;
        return new Response(
          JSON.stringify({ error: { code: 'RECONCILER_NOT_CONFIGURED' }, effectId: 'effect-1' }),
          { status: 501, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    await assert.rejects(
      () => client.reconcileAction('run-action-1'),
      (error: { status: number }) => error.status === 501,
    );
    assert.equal(url, 'https://commander.example/v1/actions/run-action-1/reconcile');
  });

  void it('getActionEvidence loads evidence bundle', async () => {
    const { CommanderGatewayClient } = require('../src/v1/client');
    let url = '';
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example',
      apiKey: 'key',
      fetch: async (requestUrl: string) => {
        url = requestUrl;
        return new Response(
          JSON.stringify({
            bundle: { bundleId: 'bundle-1', runId: 'run-action-1' },
            verification: { valid: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const result = await client.getActionEvidence('run-action-1');
    assert.equal(url, 'https://commander.example/v1/actions/run-action-1/evidence');
    assert.equal(result.bundle.bundleId, 'bundle-1');
    assert.equal(result.verification.valid, true);
  });
});
