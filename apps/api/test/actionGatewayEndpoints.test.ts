import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import express from 'express';
import { verifyEvidenceBundle } from '@commander/effect-broker';
import { InMemoryKernelRepository } from '@commander/kernel/testing/inMemoryRepository';
import type { KillSwitchScope } from '@commander/kernel';
import type { V1KernelGateway } from '../src/v1GatewayKernel.js';
import { GatewayIdempotencyConflictError } from '../src/v1GatewayKernel.js';
import { createV1GatewayRouter } from '../src/v1GatewayEndpoints.js';

process.env.COMMANDER_ENABLE_DEMO_TICKET = '1';

class InMemoryGateway implements V1KernelGateway {
  readonly repository = new InMemoryKernelRepository();
  private readonly submissions = new Map<string, string>();
  killSwitchLookupError: Error | null = null;

  async submit(input: Parameters<V1KernelGateway['submit']>[0]) {
    const runId = `run_${createHash('sha256')
      .update(`${input.tenantId}:${input.idempotencyKey}`)
      .digest('hex')
      .slice(0, 40)}`;
    const submission = JSON.stringify(input);
    const existing = await this.repository.getRun(runId, input.tenantId);
    if (existing) {
      if (this.submissions.get(runId) !== submission) {
        throw new GatewayIdempotencyConflictError(
          'Idempotency-Key was already used with a different request',
        );
      }
      return { run: existing, created: false };
    }
    const run = await this.repository.createRun(
      {
        id: runId,
        tenantId: input.tenantId,
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: input.workGraphVersion,
        policySnapshotId: input.policySnapshotId,
        metadata: input.metadata,
        steps: input.steps,
      },
      input.actor,
    );
    this.submissions.set(runId, submission);
    return { run, created: true };
  }

  getRun(runId: string, tenantId: string) {
    return this.repository.getRun(runId, tenantId);
  }
  listRuns(tenantId: string, options?: { limit?: number }) {
    return this.repository.listRuns(tenantId, options);
  }
  getStep(stepId: string, tenantId: string) {
    return this.repository.getStep(stepId, tenantId);
  }
  listEvents(runId: string, tenantId: string) {
    return this.repository.listEvents(runId, tenantId);
  }
  listInteractions(runId: string, tenantId: string) {
    return this.repository.listInteractions(runId, tenantId);
  }
  answerInteraction(input: Parameters<InMemoryKernelRepository['answerInteraction']>[0]) {
    return this.repository.answerInteraction(input);
  }
  listEffects(runId: string, tenantId: string) {
    return this.repository.listEffectsForRun(runId, tenantId);
  }
  getEffect(effectId: string, tenantId: string) {
    return this.repository.getEffect(effectId, tenantId);
  }
  pauseRun(runId: string, tenantId: string, actor: string) {
    return this.repository.pauseRun(runId, tenantId, actor);
  }
  resumeRun(runId: string, tenantId: string, actor: string) {
    return this.repository.resumeRun(runId, tenantId, actor);
  }
  cancelRun(runId: string, tenantId: string, actor: string) {
    return this.repository.cancelRun(runId, tenantId, actor);
  }
  putKillSwitch(input: Parameters<InMemoryKernelRepository['putKillSwitch']>[0]) {
    return this.repository.putKillSwitch(input);
  }
  removeKillSwitch(input: Parameters<InMemoryKernelRepository['removeKillSwitch']>[0]) {
    return this.repository.removeKillSwitch(input);
  }
  listKillSwitches(tenantId: string) {
    return this.repository.listKillSwitches(tenantId);
  }
  findMatchingKillSwitch(
    tenantId: string,
    dims: Parameters<InMemoryKernelRepository['findMatchingKillSwitch']>[1],
  ) {
    if (this.killSwitchLookupError) throw this.killSwitchLookupError;
    return this.repository.findMatchingKillSwitch(tenantId, dims);
  }
  requestReconcile(input: Parameters<InMemoryKernelRepository['requestReconcile']>[0]) {
    return this.repository.requestReconcile(input);
  }
  requestCompensation(input: Parameters<InMemoryKernelRepository['requestCompensation']>[0]) {
    return this.repository.requestCompensation(input);
  }
}

const baseAction = {
  source: 'test-agent',
  package: 'test-package',
  model: 'test-model',
  tool: 'ticket.create',
  destination: 'demo://tickets',
  effectType: 'demo.ticket.create',
  args: { title: 'Reset a demo password' },
  idempotencyKey: 'action-key-0001',
};

async function withGateway(
  gateway: InMemoryGateway,
  action: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.header('x-test-no-tenant') !== '1') {
      req.tenantId = req.header('x-test-tenant') ?? 'tenant-a';
    }
    const principal = req.header('x-test-principal') ?? 'api-approver';
    if (principal === 'api-approver') {
      req.apiKeyId = 'test-key';
      req.apiScopes = ['actions:approve'];
    } else if (principal === 'api-read') {
      req.apiKeyId = 'read-key';
      req.apiScopes = ['read'];
    } else if (principal === 'api-admin') {
      req.apiKeyId = 'admin-key';
      req.apiScopes = ['admin'];
    } else if (principal === 'user-admin' || principal === 'user-operator') {
      req.user = {
        id: principal,
        username: principal,
        role: principal === 'user-admin' ? 'admin' : 'operator',
        tenantId: req.tenantId,
      };
    }
    next();
  });
  app.use('/v1', createV1GatewayRouter(() => gateway));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  tenant = 'tenant-a',
  principal = 'api-approver',
) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-tenant': tenant,
      'x-test-principal': principal,
    },
    body: JSON.stringify(body),
  });
}

function approvalBinding(action: any) {
  return {
    actionDigest: action.simulation.actionDigest,
    simulationId: action.simulation.simulationId,
    policySnapshotId: action.simulation.policySnapshotId,
  };
}

async function putKillSwitch(
  baseUrl: string,
  scope: KillSwitchScope,
  value: string,
  body: { enabled: boolean; reason?: string },
  tenant = 'tenant-a',
  principal = 'api-admin',
) {
  return fetch(`${baseUrl}/v1/actions/kill-switches/${scope}/${encodeURIComponent(value)}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-test-tenant': tenant,
      'x-test-principal': principal,
    },
    body: JSON.stringify(body),
  });
}

describe('L4-04 kill switch matrix', () => {
  const scopes: Array<{ scope: KillSwitchScope; value: string }> = [
    { scope: 'tenant', value: 'tenant-a' },
    { scope: 'package', value: 'test-package' },
    { scope: 'model', value: 'test-model' },
    { scope: 'tool', value: 'ticket.create' },
    { scope: 'destination', value: 'demo://tickets' },
    { scope: 'effect-type', value: 'demo.ticket.create' },
  ];

  for (const entry of scopes) {
    it(`blocks simulation when ${entry.scope} kill switch is active`, async () => {
      const gateway = new InMemoryGateway();
      await withGateway(gateway, async (baseUrl) => {
        const enabled = await putKillSwitch(baseUrl, entry.scope, entry.value, {
          enabled: true,
          reason: `block ${entry.scope}`,
        });
        assert.equal(enabled.status, 200);
        const response = await postJson(baseUrl, '/v1/actions/simulate', baseAction);
        assert.equal(response.status, 403);
        const payload = (await response.json()) as any;
        assert.equal(payload.error.code, 'KILL_SWITCH_ACTIVE');
        assert.deepEqual(payload.error.details, {
          scope: entry.scope,
          value: entry.value,
        });
      });
    });
  }

  it('lists, updates, and deletes kill switches for the authenticated tenant', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const denied = await fetch(`${baseUrl}/v1/actions/kill-switches`, {
        headers: { 'x-test-tenant': 'tenant-a', 'x-test-principal': 'api-read' },
      });
      assert.equal(denied.status, 403);

      const created = await putKillSwitch(baseUrl, 'tool', 'ticket.create', {
        enabled: true,
        reason: 'maintenance',
      });
      assert.equal(created.status, 200);

      const listed = await fetch(`${baseUrl}/v1/actions/kill-switches`, {
        headers: { 'x-test-tenant': 'tenant-a', 'x-test-principal': 'api-admin' },
      });
      assert.equal(listed.status, 200);
      const listPayload = (await listed.json()) as any;
      assert.equal(listPayload.killSwitches.length, 1);
      assert.equal(listPayload.killSwitches[0].scope, 'tool');

      const removed = await fetch(
        `${baseUrl}/v1/actions/kill-switches/tool/${encodeURIComponent('ticket.create')}`,
        {
          method: 'DELETE',
          headers: { 'x-test-tenant': 'tenant-a', 'x-test-principal': 'api-admin' },
        },
      );
      assert.equal(removed.status, 204);
      const after = await fetch(`${baseUrl}/v1/actions/kill-switches`, {
        headers: { 'x-test-tenant': 'tenant-a', 'x-test-principal': 'api-admin' },
      });
      assert.equal(((await after.json()) as any).killSwitches.length, 0);
    });
  });

  it('blocks propose and worker execution when kill switch is enabled after approval', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-kill-after-approval',
      });
      assert.equal(proposed.status, 202);
      const payload = (await proposed.json()) as any;
      const approved = await postJson(
        baseUrl,
        `/v1/actions/${payload.action.runId}/approve`,
        approvalBinding(payload.action),
      );
      assert.equal(approved.status, 200);

      const enabled = await putKillSwitch(baseUrl, 'tool', 'ticket.create', { enabled: true });
      assert.equal(enabled.status, 200);

      const blocked = await postJson(baseUrl, '/v1/actions/simulate', {
        ...baseAction,
        idempotencyKey: 'action-kill-after-approval-sim',
      });
      assert.equal(blocked.status, 403);
      assert.equal((await blocked.json() as any).error.code, 'KILL_SWITCH_ACTIVE');

      const { createWorkerPolicyEvaluator } = await import(
        '../../../packages/worker-plane/src/bootstrap.js'
      );
      const action = payload.action;
      const decision = await createWorkerPolicyEvaluator(gateway.repository).evaluate({
        tenantId: 'tenant-a',
        runId: action.runId,
        stepId: action.stepId,
        type: 'demo.ticket.create',
        request: {
          ...baseAction,
          tenantId: 'tenant-a',
        },
        token: {} as never,
      });
      assert.equal(decision.effect, 'deny');
      assert.equal(decision.reason, 'KILL_SWITCH_ACTIVE');
    });
  });
});

describe('L4-01 governed action HTTP API', () => {
  it('requires an authenticated principal on every action endpoint', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const cases = [
        { method: 'POST', path: '/v1/actions/simulate', body: baseAction },
        { method: 'POST', path: '/v1/actions', body: baseAction },
        { method: 'GET', path: '/v1/actions/run-unknown' },
        { method: 'POST', path: '/v1/actions/run-unknown/approve', body: {} },
        { method: 'POST', path: '/v1/actions/run-unknown/reject', body: {} },
        { method: 'POST', path: '/v1/actions/run-unknown/reconcile', body: {} },
        { method: 'GET', path: '/v1/actions/run-unknown/evidence' },
      ] as const;
      for (const request of cases) {
        const response = await fetch(`${baseUrl}${request.path}`, {
          method: request.method,
          headers: {
            'content-type': 'application/json',
            'x-test-tenant': 'tenant-a',
            'x-test-principal': 'none',
          },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
        });
        assert.equal(response.status, 401, `${request.method} ${request.path}`);
        assert.equal((await response.json() as any).error.code, 'AUTHENTICATION_REQUIRED');
      }
    });
  });

  it('does not accept authentication without req.tenantId', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/actions/simulate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-principal': 'api-approver',
          'x-test-no-tenant': '1',
        },
        body: JSON.stringify(baseAction),
      });
      assert.equal(response.status, 401);
      assert.equal((await response.json() as any).error.code, 'TENANT_IDENTITY_REQUIRED');
    });
  });

  it('limits approve and reject to admin users or approval-scoped API keys', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const first = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-auth-approve',
      });
      const firstAction = (await first.json() as any).action;
      const firstRunId = firstAction.runId;

      for (const principal of ['api-read', 'user-operator']) {
        const forbidden = await postJson(
          baseUrl,
          `/v1/actions/${firstRunId}/approve`,
          {},
          'tenant-a',
          principal,
        );
        assert.equal(forbidden.status, 403, principal);
        assert.equal((await forbidden.json() as any).error.code, 'ACTION_APPROVAL_FORBIDDEN');
      }
      const unauthenticated = await postJson(
        baseUrl,
        `/v1/actions/${firstRunId}/approve`,
        {},
        'tenant-a',
        'none',
      );
      assert.equal(unauthenticated.status, 401);

      const approved = await postJson(
        baseUrl,
        `/v1/actions/${firstRunId}/approve`,
        approvalBinding(firstAction),
        'tenant-a',
        'api-approver',
      );
      assert.equal(approved.status, 200);

      const second = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-auth-reject',
      });
      const secondRunId = (await second.json() as any).action.runId;
      const rejected = await postJson(
        baseUrl,
        `/v1/actions/${secondRunId}/reject`,
        { reason: 'admin rejection' },
        'tenant-a',
        'user-admin',
      );
      assert.equal(rejected.status, 200);
    });
  });

  it('simulates and durably proposes one allowed action as one tool step', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const simulated = await postJson(baseUrl, '/v1/actions/simulate', baseAction);
      assert.equal(simulated.status, 200);
      const simulation = (await simulated.json() as any).simulation;
      assert.deepEqual(Object.keys(simulation).sort(), [
        'actionDigest',
        'decisionId',
        'effect',
        'policySnapshotId',
        'reason',
        'simulationId',
      ]);
      assert.equal(simulation.effect, 'allow');
      const simulationRun = await gateway.repository.getRun(
        simulation.simulationId,
        'tenant-a',
      );
      assert.ok(simulationRun);
      assert.equal(simulationRun.state, 'CANCELLED');
      assert.ok(simulationRun.terminalAt);
      assert.deepEqual(
        simulationRun.metadata.actionGatewaySimulation,
        simulation,
      );
      assert.equal(
        (await gateway.repository.listEffectsForRun(simulation.simulationId, 'tenant-a')).length,
        0,
      );
      assert.equal(
        (await gateway.repository.listEvents(simulation.simulationId, 'tenant-a')).some(
          (event) => event.type === 'run.created',
        ),
        true,
      );
      assert.equal(
        (await gateway.repository.listEvents(simulation.simulationId, 'tenant-a')).some(
          (event) => event.type === 'run.cancelled',
        ),
        true,
      );

      const proposed = await postJson(baseUrl, '/v1/actions', baseAction);
      assert.equal(proposed.status, 202);
      const payload = await proposed.json() as any;
      assert.equal(payload.action.decision.effect, 'allow');
      assert.deepEqual(Object.keys(payload.action.decision).sort(), [
        'decisionId',
        'effect',
        'policySnapshotId',
        'reason',
      ]);

      const run = await gateway.repository.getRun(payload.action.runId, 'tenant-a');
      assert.ok(run);
      const actionMetadata = run.metadata.actionGateway as any;
      assert.equal(actionMetadata.authority, 'commander.action-gateway/v1');
      assert.deepEqual(actionMetadata.simulation, simulation);
      const step = await gateway.repository.getStep(actionMetadata.stepId, 'tenant-a');
      assert.equal(step?.kind, 'tool');
      assert.equal(step?.input.effectType, 'demo.ticket.create');
    });
  });

  it('rejects reserved idempotencyKey prefixes cmp: and simulation:', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const cmp = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'cmp:effect-1:1.0.0',
      });
      assert.equal(cmp.status, 400);
      const simulation = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'simulation:deadbeef',
      });
      assert.equal(simulation.status, 400);
    });
  });

  it('persists a denied proposal but never represents it as admitted', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const denied = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'https://untrusted.example/tickets',
        idempotencyKey: 'action-key-denied',
      });
      assert.equal(denied.status, 403);
      const payload = await denied.json() as any;
      assert.equal(payload.action.decision.effect, 'deny');
      const claimed = await gateway.repository.claimNextStep({
        workerId: 'deny-worker',
        workerGeneration: 1,
        tenantId: 'tenant-a',
        capabilities: ['tool'],
        leaseTtlMs: 30_000,
      });
      assert.equal(claimed, null, 'no claimable PENDING tool step on deny');
    });
  });

  it('proposes demo ticket compensation through the same Action Gateway authority', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        tool: 'ticket.compensate',
        effectType: 'compensate.demo.ticket.create',
        args: { targetIdempotencyKey: 'action-key-0001' },
        idempotencyKey: 'action-key-compensate',
      });
      assert.equal(proposed.status, 202);
      const payload = await proposed.json() as any;
      assert.equal(payload.action.decision.effect, 'allow');
      const step = await gateway.repository.getStep(payload.action.stepId, 'tenant-a');
      assert.equal(step?.input.effectType, 'compensate.demo.ticket.create');
    });
  });

  it('creates a durable approval interaction and releases only an approval', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-key-approval',
      });
      assert.equal(proposed.status, 202);
      const payload = await proposed.json() as any;
      assert.equal(payload.action.decision.effect, 'require_approval');
      assert.equal(payload.action.state, 'WAITING_FOR_APPROVAL');

      const approved = await postJson(
        baseUrl,
        `/v1/actions/${payload.action.runId}/approve`,
        {
          actionDigest: payload.action.simulation.actionDigest,
          simulationId: payload.action.simulation.simulationId,
          policySnapshotId: payload.action.simulation.policySnapshotId,
        },
      );
      assert.equal(approved.status, 200);
      assert.equal((await approved.json() as any).action.state, 'APPROVED');

      const run = await gateway.repository.getRun(payload.action.runId, 'tenant-a');
      const metadata = run!.metadata.actionGateway as any;
      assert.equal(
        (await gateway.repository.getStep(metadata.stepId, 'tenant-a'))?.state,
        'RETRY_WAIT',
      );
      assert.equal(
        (await gateway.repository.listInteractions(payload.action.runId, 'tenant-a'))[0]
          ?.response?.approved,
        true,
      );
      assert.deepEqual(
        (await gateway.repository.listInteractions(payload.action.runId, 'tenant-a'))[0]
          ?.response,
        {
          approved: true,
          actionDigest: payload.action.simulation.actionDigest,
          simulationId: payload.action.simulation.simulationId,
          policySnapshotId: payload.action.simulation.policySnapshotId,
          reviewer: 'test-key',
          runId: payload.action.runId,
          tenantId: 'tenant-a',
        },
      );
    });
  });

  it('rejects approval when its supplied action digest differs from the persisted simulation', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const actionInput = {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-approval-digest-mismatch',
      };
      const simulated = await postJson(baseUrl, '/v1/actions/simulate', actionInput);
      const simulation = (await simulated.json() as any).simulation;
      const proposed = await postJson(baseUrl, '/v1/actions', actionInput);
      const action = (await proposed.json() as any).action;

      const rejected = await postJson(
        baseUrl,
        `/v1/actions/${action.runId}/approve`,
        {
          actionDigest: '0'.repeat(64),
          simulationId: simulation.simulationId,
          policySnapshotId: simulation.policySnapshotId,
        },
      );
      assert.equal(rejected.status, 409);
      assert.equal((await rejected.json() as any).error.code, 'ACTION_DIGEST_MISMATCH');

      const interactions = await gateway.repository.listInteractions(
        action.runId,
        'tenant-a',
      );
      assert.equal(interactions[0]?.status, 'pending');
    });
  });

  it('projects completion-unknown and terminal execution states after approval', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposeApproval = async (idempotencyKey: string) => {
        const response = await postJson(baseUrl, '/v1/actions', {
          ...baseAction,
          destination: 'demo://tickets/approval',
          idempotencyKey,
        });
        const action = (await response.json() as any).action;
        const approved = await postJson(
          baseUrl,
          `/v1/actions/${action.runId}/approve`,
          approvalBinding(action),
        );
        assert.equal(approved.status, 200);
        const run = await gateway.repository.getRun(action.runId, 'tenant-a');
        return { action, metadata: run!.metadata.actionGateway as any };
      };
      const claim = () => gateway.repository.claimNextStep({
        workerId: 'status-worker',
        workerGeneration: 1,
        tenantId: 'tenant-a',
        capabilities: ['tool'],
        leaseTtlMs: 30_000,
      });

      const unknown = await proposeApproval('action-status-unknown');
      const unknownStep = await claim();
      assert.ok(unknownStep?.lease);
      await gateway.repository.admitEffect({
        id: unknown.metadata.effectId,
        runId: unknown.action.runId,
        stepId: unknownStep.id,
        tenantId: 'tenant-a',
        type: 'demo.ticket.create',
        idempotencyKey: 'action-status-unknown',
        policyDecisionId: 'action-gateway-allow-after-approval',
        request: unknown.metadata.envelope,
        lease: unknownStep.lease,
        actor: 'status-worker',
      });
      await gateway.repository.markEffectCompletionUnknown({
        effectId: unknown.metadata.effectId,
        tenantId: 'tenant-a',
        reason: 'remote completion uncertain',
        actor: 'status-worker',
      });
      const unknownGet = await fetch(`${baseUrl}/v1/actions/${unknown.action.runId}`, {
        headers: { 'x-test-tenant': 'tenant-a' },
      });
      assert.equal((await unknownGet.json() as any).action.state, 'COMPLETION_UNKNOWN');

      const terminal = await proposeApproval('action-status-terminal');
      const terminalStep = await claim();
      assert.ok(terminalStep?.lease);
      await gateway.repository.admitEffect({
        id: terminal.metadata.effectId,
        runId: terminal.action.runId,
        stepId: terminalStep.id,
        tenantId: 'tenant-a',
        type: 'demo.ticket.create',
        idempotencyKey: 'action-status-terminal',
        policyDecisionId: 'action-gateway-allow-after-approval',
        request: terminal.metadata.envelope,
        lease: terminalStep.lease,
        actor: 'status-worker',
      });
      await gateway.repository.completeEffect(
        terminal.metadata.effectId,
        'tenant-a',
        terminalStep.lease,
        { status: 'ok' },
        'status-worker',
      );
      await gateway.repository.completeStep({
        stepId: terminalStep.id,
        tenantId: 'tenant-a',
        lease: terminalStep.lease,
        expectedVersion: terminalStep.version,
        output: { status: 'ok' },
        actor: 'status-worker',
      });
      const terminalGet = await fetch(`${baseUrl}/v1/actions/${terminal.action.runId}`, {
        headers: { 'x-test-tenant': 'tenant-a' },
      });
      assert.equal((await terminalGet.json() as any).action.state, 'SUCCEEDED');
    });
  });

  it('rejects an approval-required action without authorizing its effect', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-key-reject',
      });
      const payload = await proposed.json() as any;
      const rejected = await postJson(
        baseUrl,
        `/v1/actions/${payload.action.runId}/reject`,
        { reason: 'not authorized' },
      );
      assert.equal(rejected.status, 200);
      assert.equal((await rejected.json() as any).action.state, 'REJECTED');
      const rejectedStep = await gateway.repository.getStep(
        payload.action.stepId,
        'tenant-a',
      );
      assert.equal(rejectedStep?.state, 'CANCELLED');
      assert.equal(
        (await gateway.repository.getRun(payload.action.runId, 'tenant-a'))?.state,
        'CANCELLED',
      );
    });
  });

  it('scopes get and approval to req.tenantId only', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-key-tenant',
      });
      const payload = await proposed.json() as any;

      const crossTenantGet = await fetch(`${baseUrl}/v1/actions/${payload.action.runId}`, {
        headers: { 'x-test-tenant': 'tenant-b' },
      });
      assert.equal(crossTenantGet.status, 404);
      const crossTenantApprove = await postJson(
        baseUrl,
        `/v1/actions/${payload.action.runId}/approve`,
        approvalBinding(payload.action),
        'tenant-b',
      );
      assert.equal(crossTenantApprove.status, 404);
    });
  });

  it('replays one idempotency key without creating a second run or step', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const first = await postJson(baseUrl, '/v1/actions', baseAction);
      const replay = await postJson(baseUrl, '/v1/actions', baseAction);
      assert.equal(first.status, 202);
      assert.equal(replay.status, 200);
      const firstPayload = await first.json() as any;
      const replayPayload = await replay.json() as any;
      assert.equal(replayPayload.idempotentReplay, true);
      assert.equal(replayPayload.action.runId, firstPayload.action.runId);
      assert.equal(
        (await gateway.repository.listEvents(firstPayload.action.runId, 'tenant-a')).filter(
          (event) => event.type === 'run.created',
        ).length,
        1,
      );
    });
  });

  it('exports verifiable L3-11 evidence without raw prompts, tool args, or secrets', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-key-evidence',
        args: {
          title: 'SENSITIVE_TOOL_ARGUMENT',
          Authorization: 'Bearer SENSITIVE_AUTH_TOKEN',
        },
      });
      const payload = await proposed.json() as any;
      const approved = await postJson(
        baseUrl,
        `/v1/actions/${payload.action.runId}/approve`,
        approvalBinding(payload.action),
      );
      assert.equal(approved.status, 200);
      const claimed = await gateway.repository.claimNextStep({
        workerId: 'evidence-worker',
        workerGeneration: 1,
        tenantId: 'tenant-a',
        capabilities: ['tool'],
        leaseTtlMs: 30_000,
      });
      assert.ok(claimed?.lease);
      const run = await gateway.repository.getRun(payload.action.runId, 'tenant-a');
      const metadata = run!.metadata.actionGateway as any;
      const admission = await gateway.repository.admitEffect({
        id: metadata.effectId,
        runId: run!.id,
        stepId: claimed.id,
        tenantId: 'tenant-a',
        type: 'demo.ticket.create',
        idempotencyKey: 'action-key-evidence',
        policyDecisionId: 'action-gateway-allow-after-approval',
        request: metadata.envelope,
        lease: claimed.lease,
        actor: 'evidence-worker',
      });
      assert.equal(admission.admitted, true);
      await gateway.repository.completeEffect(
        metadata.effectId,
        'tenant-a',
        claimed.lease,
        {
          status: 'ok',
          body: 'SENSITIVE_EFFECT_RESPONSE',
          access_token: 'SENSITIVE_RESPONSE_TOKEN',
        },
        'evidence-worker',
      );
      await gateway.repository.completeStep({
        stepId: claimed.id,
        tenantId: 'tenant-a',
        lease: claimed.lease,
        expectedVersion: claimed.version,
        output: { status: 'ok' },
        actor: 'evidence-worker',
      });
      const evidence = await fetch(
        `${baseUrl}/v1/actions/${payload.action.runId}/evidence`,
        { headers: { 'x-test-tenant': 'tenant-a' } },
      );
      assert.equal(evidence.status, 200);
      const evidenceText = await evidence.text();
      const evidencePayload = JSON.parse(evidenceText) as any;
      assert.equal(evidencePayload.bundle.schemaVersion, 'l3-11.v0');
      assert.equal(evidencePayload.bundle.scope.runId, payload.action.runId);
      assert.equal(evidencePayload.verification.ok, true);
      assert.equal(verifyEvidenceBundle(evidencePayload.bundle).ok, true);
      assert.equal(evidenceText.includes('SENSITIVE_TOOL_ARGUMENT'), false);
      assert.equal(evidenceText.includes('SENSITIVE_AUTH_TOKEN'), false);
      assert.equal(evidenceText.includes('SENSITIVE_EFFECT_RESPONSE'), false);
      assert.equal(evidenceText.includes('SENSITIVE_RESPONSE_TOKEN'), false);
      assert.equal(evidenceText.includes('Approve demo.ticket.create'), false);
      assert.equal(evidencePayload.bundle.effects[0].responseSummary.status, 'ok');

      const reconcile = await postJson(
        baseUrl,
        `/v1/actions/${payload.action.runId}/reconcile`,
        {},
      );
      assert.equal(reconcile.status, 409);
    });
  });

  it('drops free-text interaction fields from exported evidence audit details', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-key-reject-evidence',
      });
      const payload = await proposed.json() as any;
      const rejected = await postJson(
        baseUrl,
        `/v1/actions/${payload.action.runId}/reject`,
        {
          reason: 'Bearer USER_CONTROLLED_REJECT_SECRET',
        },
      );
      assert.equal(rejected.status, 200);

      const evidence = await fetch(
        `${baseUrl}/v1/actions/${payload.action.runId}/evidence`,
        { headers: { 'x-test-tenant': 'tenant-a' } },
      );
      assert.equal(evidence.status, 200);
      const evidenceText = await evidence.text();
      const evidencePayload = JSON.parse(evidenceText) as any;
      assert.equal(evidenceText.includes('USER_CONTROLLED_REJECT_SECRET'), false);
      assert.equal(evidenceText.includes('USER_CONTROLLED_REVIEWER_SECRET'), false);
      assert.equal(evidenceText.includes('Approve demo.ticket.create'), false);
      assert.equal(evidencePayload.verification.ok, true);
      assert.equal(verifyEvidenceBundle(evidencePayload.bundle).ok, true);

      const created = evidencePayload.bundle.auditEvents.find(
        (event: any) => event.type === 'interaction.created',
      );
      const answered = evidencePayload.bundle.auditEvents.find(
        (event: any) => event.type === 'interaction.answered',
      );
      assert.deepEqual(Object.keys(created.details).sort(), [
        'expiresAt',
        'interactionId',
        'status',
      ]);
      assert.deepEqual(answered.details, {
        interactionId: created.details.interactionId,
        status: 'answered',
        approved: false,
      });
    });
  });

  it('blocks generic run submissions from spoofing Action Gateway external work', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'spoof-key-0001',
          'x-test-tenant': 'tenant-a',
        },
        body: JSON.stringify({
          goal: 'bypass action gateway',
          policySnapshotId: 'action-gateway-mvp-v1',
          metadata: {
            actionGateway: {
              authority: 'commander.action-gateway/v1',
              decision: { effect: 'allow' },
            },
          },
          steps: [
            {
              kind: 'tool',
              input: {
                toolName: 'ticket.create',
                effectType: 'demo.ticket.create',
                args: { title: 'bypass' },
              },
            },
          ],
        }),
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json() as any).error.code, 'ACTION_GATEWAY_REQUIRED');
    });
  });

  it('rejects agent steps that declare external tools on POST /v1/runs', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'agent-tools-key-01',
          'x-test-tenant': 'tenant-a',
        },
        body: JSON.stringify({
          goal: 'agent with tools',
          policySnapshotId: 'action-gateway-mvp-v1',
          steps: [
            {
              kind: 'agent',
              input: {
                goal: 'do work',
                agentId: 'agent-1',
                definitionVersion: '1',
                providerSnapshot: { provider: 'openai', model: 'gpt-4' },
                tools: ['ticket.create'],
              },
            },
          ],
        }),
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json() as any).error.code, 'ACTION_GATEWAY_REQUIRED');
    });
  });

  it('returns 409 IDEMPOTENCY_KEY_CONFLICT when the same key is reused with different args', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const first = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-key-conflict',
        args: { title: 'first' },
      });
      assert.equal(first.status, 202);
      const conflict = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-key-conflict',
        args: { title: 'second' },
      });
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json() as any).error.code, 'IDEMPOTENCY_KEY_CONFLICT');
    });
  });

  it('returns 503 KILL_SWITCH_LOOKUP_FAILED when kill-switch lookup throws', async () => {
    const gateway = new InMemoryGateway();
    gateway.killSwitchLookupError = new Error('db unavailable');
    await withGateway(gateway, async (baseUrl) => {
      const response = await postJson(baseUrl, '/v1/actions/simulate', baseAction);
      assert.equal(response.status, 503);
      assert.equal((await response.json() as any).error.code, 'KILL_SWITCH_LOOKUP_FAILED');
    });
  });

  it('POST reconcile enqueues COMPLETION_UNKNOWN effects with 202', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const created = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-reconcile-202',
      });
      const payload = (await created.json()) as any;
      const action = payload.action;
      const run = await gateway.repository.getRun(action.runId, 'tenant-a');
      const gatewayMetadata = run!.metadata.actionGateway as any;
      const step = await gateway.repository.claimNextStep({
        workerId: 'reconcile-worker',
        workerGeneration: 1,
        tenantId: 'tenant-a',
        capabilities: ['tool'],
        leaseTtlMs: 60_000,
      });
      assert.ok(step?.lease);
      await gateway.repository.admitEffect({
        id: gatewayMetadata.effectId,
        runId: action.runId,
        stepId: gatewayMetadata.stepId,
        tenantId: 'tenant-a',
        type: 'demo.ticket.create',
        idempotencyKey: 'action-reconcile-202',
        policyDecisionId: 'action-gateway-allow',
        request: gatewayMetadata.envelope,
        lease: step.lease,
        actor: 'reconcile-worker',
      });
      await gateway.repository.markEffectCompletionUnknown({
        effectId: gatewayMetadata.effectId,
        tenantId: 'tenant-a',
        reason: 'timeout',
        actor: 'reconcile-worker',
      });
      const reconcile = await postJson(
        baseUrl,
        `/v1/actions/${action.runId}/reconcile`,
        {},
      );
      assert.equal(reconcile.status, 202);
      const body = (await reconcile.json()) as any;
      assert.equal(body.enqueued, true);
      assert.equal(body.effectId, gatewayMetadata.effectId);
      assert.ok(body.reconcileAfter);
    });
  });

  it('POST reconcile returns 404 for wrong tenant', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const created = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-reconcile-tenant',
      });
      const payload = (await created.json()) as any;
      const response = await fetch(
        `${baseUrl}/v1/actions/${payload.action.runId}/reconcile`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-test-tenant': 'tenant-b',
          },
          body: '{}',
        },
      );
      assert.equal(response.status, 404);
      assert.equal((await response.json() as any).error.code, 'ACTION_NOT_FOUND');
    });
  });

  it('limits compensate to admin users or approval-scoped API keys', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const forbidden = await postJson(
        baseUrl,
        '/v1/actions/run-auth-compensate/compensate',
        {},
        'tenant-a',
        'api-read',
      );
      assert.equal(forbidden.status, 403);
      assert.equal((await forbidden.json() as any).error.code, 'ACTION_APPROVAL_FORBIDDEN');
    });
  });

  it('POST compensate enqueues a new compensation run with 202', async () => {
    const gateway = new InMemoryGateway();
    const savedToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token-for-compensate';
    try {
    await withGateway(gateway, async (baseUrl) => {
      const created = await postJson(
        baseUrl,
        '/v1/actions',
        {
          source: 'test-agent',
          package: 'test-package',
          model: 'test-model',
          tool: 'github.pull-request.create',
          destination: 'github://acme/repo/pulls',
          effectType: 'connector.github.pull-request.create',
          args: { title: 'compensate me' },
          idempotencyKey: 'action-compensate-202',
        },
        'tenant-a',
        'api-approver',
      );
      const payload = (await created.json()) as any;
      assert.equal(payload.action.decision.effect, 'require_approval');
      const approved = await postJson(
        baseUrl,
        `/v1/actions/${payload.action.runId}/approve`,
        approvalBinding(payload.action),
      );
      assert.equal(approved.status, 200);
      const action = payload.action;
      const run = await gateway.repository.getRun(action.runId, 'tenant-a');
      const gatewayMetadata = run!.metadata.actionGateway as any;
      const step = await gateway.repository.claimNextStep({
        workerId: 'comp-worker',
        workerGeneration: 1,
        tenantId: 'tenant-a',
        capabilities: ['tool'],
        leaseTtlMs: 60_000,
      });
      assert.ok(step?.lease);
      await gateway.repository.admitEffect({
        id: gatewayMetadata.effectId,
        runId: action.runId,
        stepId: gatewayMetadata.stepId,
        tenantId: 'tenant-a',
        type: 'connector.github.pull-request.create',
        idempotencyKey: 'action-compensate-202',
        policyDecisionId: 'action-gateway-allow-after-approval',
        request: gatewayMetadata.envelope,
        lease: step.lease,
        actor: 'comp-worker',
      });
      await gateway.repository.completeEffect(
        gatewayMetadata.effectId,
        'tenant-a',
        step.lease,
        { prNumber: 42 },
        'comp-worker',
      );
      await gateway.repository.completeStep({
        stepId: step.id,
        tenantId: 'tenant-a',
        lease: step.lease,
        expectedVersion: step.version,
        output: { ok: true },
        actor: 'comp-worker',
      });
      const originalRun = await gateway.getRun(action.runId, 'tenant-a');
      assert.equal(originalRun?.state, 'SUCCEEDED');
      const compensate = await postJson(
        baseUrl,
        `/v1/actions/${action.runId}/compensate`,
        {},
      );
      assert.equal(compensate.status, 202);
      const body = (await compensate.json()) as any;
      assert.notEqual(body.compensationRunId, action.runId);
      assert.equal(body.originalRunId, action.runId);
      assert.equal(body.effectId, gatewayMetadata.effectId);
      assert.equal(body.idempotencyKey, `cmp:${gatewayMetadata.effectId}:1.0.0`);
      const originalAfter = await gateway.getRun(action.runId, 'tenant-a');
      assert.equal(originalAfter?.state, 'SUCCEEDED');
    });
    } finally {
      if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = savedToken;
    }
  });

  it('allows simulate without adapter creds but execute is fail-closed', async () => {
    const gateway = new InMemoryGateway();
    const adapterAction = {
      source: 'test-agent',
      package: 'test-package',
      model: 'test-model',
      tool: 'github.pull-request.create',
      destination: 'github://acme/repo/pulls',
      effectType: 'connector.github.pull-request.create',
      args: { title: 'no creds' },
      idempotencyKey: 'action-no-creds-01',
    };
    const saved = {
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GITHUB_PAT: process.env.GITHUB_PAT,
    };
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_PAT;
    try {
      await withGateway(gateway, async (baseUrl) => {
        const simulated = await postJson(baseUrl, '/v1/actions/simulate', adapterAction);
        assert.equal(simulated.status, 200);
        const executed = await postJson(baseUrl, '/v1/actions', adapterAction);
        assert.equal(executed.status, 403);
        assert.equal((await executed.json() as any).error.code, 'ADAPTER_CREDENTIALS_MISSING');
      });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
