import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import express from 'express';
import {
  buildEffectScopedEvidenceRecord,
  createEvidenceSigner,
  EffectBroker,
  verifyEvidenceReceipt,
} from '@commander/effect-broker';
import { GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR } from '@commander/contracts';
import { InMemoryKernelRepository } from '@commander/kernel/testing/inMemoryRepository';
import type { KillSwitchScope } from '@commander/kernel';
import { ActionAdapterRegistry } from '../../../packages/action-adapters/src/registry.js';
import { ReconciliationDaemon } from '../../../packages/adapter-ops/src/reconciliationDaemon.js';
import type { V1KernelGateway } from '../src/v1GatewayKernel.js';
import { GatewayIdempotencyConflictError } from '../src/v1GatewayKernel.js';
import { createV1GatewayRouter } from '../src/v1GatewayEndpoints.js';

class InMemoryGateway implements V1KernelGateway {
  readonly repository = new InMemoryKernelRepository();
  private readonly submissions = new Map<string, string>();
  killSwitchLookupError: Error | null = null;
  reconcileError: Error | null = null;

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
  requestReconcile(input: { effectId: string; tenantId: string; actor: string }) {
    if (this.reconcileError) throw this.reconcileError;
    return this.repository.requestReconcile(input);
  }
  getEvidence(binding: Parameters<InMemoryKernelRepository['getEvidence']>[0]) {
    return this.repository.getEvidence(binding);
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
  evidenceJwks?: ReturnType<typeof evidenceSigner>['jwks'],
): Promise<void> {
  const previousEvidenceJwks = process.env.COMMANDER_EVIDENCE_JWKS_JSON;
  if (evidenceJwks) process.env.COMMANDER_EVIDENCE_JWKS_JSON = JSON.stringify(evidenceJwks);
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
  app.use(
    '/v1',
    createV1GatewayRouter(() => gateway),
  );
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
    if (previousEvidenceJwks === undefined) delete process.env.COMMANDER_EVIDENCE_JWKS_JSON;
    else process.env.COMMANDER_EVIDENCE_JWKS_JSON = previousEvidenceJwks;
  }
}

function evidenceSigner() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return createEvidenceSigner({
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyId: 'action-gateway-evidence-test',
  });
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
      assert.equal(((await blocked.json()) as any).error.code, 'KILL_SWITCH_ACTIVE');

      const { createWorkerPolicyEvaluator } =
        await import('../../../packages/worker-plane/src/bootstrap.js');
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

describe('Kubernetes rollback policy wiring', () => {
  it('requires approval for a registered Kubernetes rollback destination', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const response = await postJson(baseUrl, '/v1/actions/simulate', {
        ...baseAction,
        tool: 'kubernetes.deployment.rollback',
        destination: 'k8s://kind/commander/deployments/api',
        effectType: 'mutate.kubernetes.deployment.rollback',
        idempotencyKey: 'k8s-policy-red-1',
      });
      assert.equal(response.status, 200);
      const payload = (await response.json()) as {
        simulation: { effect: string; decisionId: string };
      };
      assert.equal(payload.simulation.effect, 'require_approval');
      assert.equal(payload.simulation.decisionId, 'action-gateway-require_approval');
    });
  });

  it('denies malformed Kubernetes rollback envelopes', async () => {
    const cases = [
      { effectType: 'connector.kubernetes.deployment.rollback' },
      { destination: 'k8s://kind/other%2Ftenant/deployments/api' },
      { destination: 'k8s://kind/commander/services/api' },
      { destination: 'k8s://kind/commander/deployments/api/extra' },
    ] as const;
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      for (const invalid of cases) {
        const response = await postJson(baseUrl, '/v1/actions/simulate', {
          ...baseAction,
          tool: 'kubernetes.deployment.rollback',
          destination: 'k8s://kind/commander/deployments/api',
          effectType: 'mutate.kubernetes.deployment.rollback',
          ...invalid,
        });
        assert.equal(response.status, 200);
        const payload = (await response.json()) as {
          simulation: { effect: string; decisionId: string };
        };
        assert.equal(payload.simulation.effect, 'deny');
        assert.equal(payload.simulation.decisionId, 'action-gateway-deny');
      }
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
        assert.equal(((await response.json()) as any).error.code, 'AUTHENTICATION_REQUIRED');
      }
    });
  });

  it('queues a tenant-bound unknown effect for the adapter reconciler without completing it in the API', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const created = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-reconcile-queue-0001',
      });
      assert.equal(created.status, 202);
      const action = ((await created.json()) as { action: { runId: string } }).action;

      const noUnknown = await postJson(baseUrl, `/v1/actions/${action.runId}/reconcile`, {});
      assert.equal(noUnknown.status, 409);
      assert.equal(
        ((await noUnknown.json()) as { error: { code: string } }).error.code,
        'NO_RECONCILABLE_EFFECT',
      );

      const claimed = await gateway.repository.claimNextStep({
        workerId: 'gateway-reconcile-worker',
        tenantId: 'tenant-a',
        leaseTtlMs: 60_000,
      });
      assert.ok(claimed?.lease);
      const run = await gateway.repository.getRun(action.runId, 'tenant-a');
      assert.ok(run);
      const metadata = run.metadata.actionGateway as {
        effectId: string;
        actionDigest: string;
        policySnapshotId: string;
        envelope: Record<string, unknown>;
      };
      const admitted = await gateway.repository.admitEffect({
        id: metadata.effectId,
        runId: action.runId,
        stepId: claimed.id,
        tenantId: 'tenant-a',
        type: 'demo.ticket.create',
        idempotencyKey: 'action-reconcile-queue-0001',
        policyDecisionId: 'action-gateway-allow',
        policySnapshotId: metadata.policySnapshotId,
        actionDigest: metadata.actionDigest,
        request: metadata.envelope,
        lease: claimed.lease,
        actor: 'gateway-reconcile-worker',
      });
      assert.equal(admitted.admitted, true);
      await gateway.repository.markEffectCompletionUnknown({
        effectId: metadata.effectId,
        tenantId: 'tenant-a',
        reason: 'remote outcome uncertain',
        actor: 'gateway-reconcile-worker',
      });
      const reconcileAfterBeforeCrossTenantRequest = (
        await gateway.repository.getEffect(metadata.effectId, 'tenant-a')
      )?.reconcileAfter;

      const crossTenant = await postJson(
        baseUrl,
        `/v1/actions/${action.runId}/reconcile`,
        {},
        'tenant-b',
      );
      assert.equal(crossTenant.status, 404);
      assert.equal(
        ((await crossTenant.json()) as { error: { code: string } }).error.code,
        'ACTION_NOT_FOUND',
      );
      assert.equal(
        (await gateway.repository.getEffect(metadata.effectId, 'tenant-a'))?.reconcileAfter,
        reconcileAfterBeforeCrossTenantRequest,
      );

      const queued = await postJson(baseUrl, `/v1/actions/${action.runId}/reconcile`, {});
      assert.equal(queued.status, 202);
      assert.deepEqual(await queued.json(), {
        effectId: metadata.effectId,
        state: 'RECONCILE_QUEUED',
      });
      assert.ok(
        (await gateway.repository.getEffect(metadata.effectId, 'tenant-a'))?.reconcileAfter,
      );

      const adapter = {
        descriptor: {
          ...GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR,
          effectType: 'demo.ticket.create',
        },
        async execute() {
          throw new Error('reconciliation must not execute writes');
        },
        async queryOutcome() {
          return { status: 'COMPLETED' as const, response: { ticketId: 'ticket-reconciled' } };
        },
        async compensate() {
          throw new Error('not used');
        },
        async queryCompensationOutcome() {
          return { status: 'UNKNOWN' as const };
        },
      };
      const daemon = new ReconciliationDaemon({
        repository: gateway.repository,
        registry: new ActionAdapterRegistry([adapter]),
        actor: 'reconciliation-daemon',
        pollIntervalMs: 60_000,
        batchSize: 1,
        brokerFactory: () =>
          new EffectBroker(
            { verify: async () => ({}) },
            {
              evaluate: async () => ({
                effect: 'allow' as const,
                decisionId: 'unused',
                policySnapshotId: 'unused',
              }),
            },
            {
              getEffect: (effectId, tenantId) => gateway.repository.getEffect(effectId, tenantId),
              reconcileEffect: (input) => gateway.repository.reconcileEffect(input),
            },
            {
              execute: async () => {
                throw new Error('reconciliation must not execute writes');
              },
            },
            { append: async () => {} },
            { requireRequestBinding: false },
          ),
      });
      const stats = await daemon.tick();
      assert.deepEqual(stats, { claimed: 1, completed: 1, escalated: 0, rescheduled: 0 });
      assert.equal(
        (await gateway.repository.getEffect(metadata.effectId, 'tenant-a'))?.state,
        'COMPLETED',
      );
    });
  });

  it('fails closed when durable reconciliation scheduling is unavailable', async () => {
    const gateway = new InMemoryGateway();
    gateway.reconcileError = new Error('reconciliation scheduler unavailable');
    await withGateway(gateway, async (baseUrl) => {
      const created = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-reconcile-unavailable-0001',
      });
      const action = ((await created.json()) as { action: { runId: string } }).action;
      const claimed = await gateway.repository.claimNextStep({
        workerId: 'gateway-reconcile-worker',
        tenantId: 'tenant-a',
        leaseTtlMs: 60_000,
      });
      assert.ok(claimed?.lease);
      const run = await gateway.repository.getRun(action.runId, 'tenant-a');
      assert.ok(run);
      const metadata = run.metadata.actionGateway as {
        effectId: string;
        actionDigest: string;
        policySnapshotId: string;
        envelope: Record<string, unknown>;
      };
      await gateway.repository.admitEffect({
        id: metadata.effectId,
        runId: action.runId,
        stepId: claimed.id,
        tenantId: 'tenant-a',
        type: 'demo.ticket.create',
        idempotencyKey: 'action-reconcile-unavailable-0001',
        policyDecisionId: 'action-gateway-allow',
        policySnapshotId: metadata.policySnapshotId,
        actionDigest: metadata.actionDigest,
        request: metadata.envelope,
        lease: claimed.lease,
        actor: 'gateway-reconcile-worker',
      });
      await gateway.repository.markEffectCompletionUnknown({
        effectId: metadata.effectId,
        tenantId: 'tenant-a',
        reason: 'remote outcome uncertain',
        actor: 'gateway-reconcile-worker',
      });
      const reconcileAfterBeforeUnavailableRequest = (
        await gateway.repository.getEffect(metadata.effectId, 'tenant-a')
      )?.reconcileAfter;

      const response = await postJson(baseUrl, `/v1/actions/${action.runId}/reconcile`, {});
      assert.equal(response.status, 503);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        'RECONCILER_UNAVAILABLE',
      );
      assert.equal(
        (await gateway.repository.getEffect(metadata.effectId, 'tenant-a'))?.reconcileAfter,
        reconcileAfterBeforeUnavailableRequest,
      );
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
      assert.equal(((await response.json()) as any).error.code, 'TENANT_IDENTITY_REQUIRED');
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
      const firstAction = ((await first.json()) as any).action;
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
        assert.equal(((await forbidden.json()) as any).error.code, 'ACTION_APPROVAL_FORBIDDEN');
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
      const secondRunId = ((await second.json()) as any).action.runId;
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
      const simulation = ((await simulated.json()) as any).simulation;
      assert.deepEqual(Object.keys(simulation).sort(), [
        'actionDigest',
        'decisionId',
        'effect',
        'policySnapshotId',
        'reason',
        'simulationId',
      ]);
      assert.equal(simulation.effect, 'allow');
      const simulationRun = await gateway.repository.getRun(simulation.simulationId, 'tenant-a');
      assert.ok(simulationRun);
      assert.equal(simulationRun.state, 'CANCELLED');
      assert.ok(simulationRun.terminalAt);
      assert.deepEqual(simulationRun.metadata.actionGatewaySimulation, simulation);
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
      const payload = (await proposed.json()) as any;
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

  it('persists a denied proposal but never represents it as admitted', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const denied = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'https://untrusted.example/tickets',
        idempotencyKey: 'action-key-denied',
      });
      assert.equal(denied.status, 403);
      const payload = (await denied.json()) as any;
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
      const payload = (await proposed.json()) as any;
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
      const payload = (await proposed.json()) as any;
      assert.equal(payload.action.decision.effect, 'require_approval');
      assert.equal(payload.action.state, 'WAITING_FOR_APPROVAL');

      const approved = await postJson(baseUrl, `/v1/actions/${payload.action.runId}/approve`, {
        actionDigest: payload.action.simulation.actionDigest,
        simulationId: payload.action.simulation.simulationId,
        policySnapshotId: payload.action.simulation.policySnapshotId,
      });
      assert.equal(approved.status, 200);
      assert.equal(((await approved.json()) as any).action.state, 'APPROVED');

      const run = await gateway.repository.getRun(payload.action.runId, 'tenant-a');
      const metadata = run!.metadata.actionGateway as any;
      assert.equal(
        (await gateway.repository.getStep(metadata.stepId, 'tenant-a'))?.state,
        'RETRY_WAIT',
      );
      assert.equal(
        (await gateway.repository.listInteractions(payload.action.runId, 'tenant-a'))[0]?.response
          ?.approved,
        true,
      );
      assert.deepEqual(
        (await gateway.repository.listInteractions(payload.action.runId, 'tenant-a'))[0]?.response,
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
      const simulation = ((await simulated.json()) as any).simulation;
      const proposed = await postJson(baseUrl, '/v1/actions', actionInput);
      const action = ((await proposed.json()) as any).action;

      const rejected = await postJson(baseUrl, `/v1/actions/${action.runId}/approve`, {
        actionDigest: '0'.repeat(64),
        simulationId: simulation.simulationId,
        policySnapshotId: simulation.policySnapshotId,
      });
      assert.equal(rejected.status, 409);
      assert.equal(((await rejected.json()) as any).error.code, 'ACTION_DIGEST_MISMATCH');

      const interactions = await gateway.repository.listInteractions(action.runId, 'tenant-a');
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
        const action = ((await response.json()) as any).action;
        const approved = await postJson(
          baseUrl,
          `/v1/actions/${action.runId}/approve`,
          approvalBinding(action),
        );
        assert.equal(approved.status, 200);
        const run = await gateway.repository.getRun(action.runId, 'tenant-a');
        return { action, metadata: run!.metadata.actionGateway as any };
      };
      const claim = () =>
        gateway.repository.claimNextStep({
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
        policySnapshotId: unknown.metadata.policySnapshotId,
        actionDigest: unknown.metadata.actionDigest,
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
      assert.equal(((await unknownGet.json()) as any).action.state, 'COMPLETION_UNKNOWN');

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
        policySnapshotId: terminal.metadata.policySnapshotId,
        actionDigest: terminal.metadata.actionDigest,
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
      assert.equal(((await terminalGet.json()) as any).action.state, 'SUCCEEDED');
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
      const payload = (await proposed.json()) as any;
      const rejected = await postJson(baseUrl, `/v1/actions/${payload.action.runId}/reject`, {
        reason: 'not authorized',
      });
      assert.equal(rejected.status, 200);
      assert.equal(((await rejected.json()) as any).action.state, 'REJECTED');
      const rejectedStep = await gateway.repository.getStep(payload.action.stepId, 'tenant-a');
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
      const payload = (await proposed.json()) as any;

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
      const firstPayload = (await first.json()) as any;
      const replayPayload = (await replay.json()) as any;
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

  it('returns the persisted signed receipt for a completed compensation effect', async () => {
    const gateway = new InMemoryGateway();
    const signer = evidenceSigner();
    await withGateway(
      gateway,
      async (baseUrl) => {
        const proposed = await postJson(baseUrl, '/v1/actions', {
          ...baseAction,
          tool: 'ticket.compensate',
          effectType: 'compensate.demo.ticket.create',
          args: { targetIdempotencyKey: 'action-key-0001' },
          idempotencyKey: 'action-evidence-completed-compensation',
        });
        assert.equal(proposed.status, 202);
        const action = ((await proposed.json()) as any).action;
        const run = await gateway.repository.getRun(action.runId, 'tenant-a');
        const metadata = run!.metadata.actionGateway as any;
        const claimed = await gateway.repository.claimNextStep({
          workerId: 'evidence-completion-worker',
          workerGeneration: 1,
          tenantId: 'tenant-a',
          capabilities: ['tool'],
          leaseTtlMs: 30_000,
        });
        assert.ok(claimed?.lease);
        const admitted = await gateway.repository.admitEffect({
          id: metadata.effectId,
          runId: action.runId,
          stepId: claimed.id,
          tenantId: 'tenant-a',
          type: metadata.envelope.effectType,
          idempotencyKey: metadata.envelope.idempotencyKey,
          policyDecisionId: metadata.decision.decisionId,
          policySnapshotId: metadata.policySnapshotId,
          actionDigest: metadata.actionDigest,
          request: metadata.envelope,
          lease: claimed.lease,
          actor: 'evidence-completion-worker',
        });
        assert.equal(admitted.admitted, true);
        if (!admitted.admitted) return;
        const record = await buildEffectScopedEvidenceRecord({
          effect: admitted.effect,
          projectedState: 'COMPLETED',
          response: { status: 'compensated' },
          auditEvents: [],
          terminalEvent: {
            type: 'compensation.completed',
            severity: 'low',
            details: { effectId: admitted.effect.id },
          },
          signer,
          recordedAt: '2026-08-11T00:00:01.000Z',
          retentionUntil: '2027-08-11T00:00:01.000Z',
        });
        await gateway.repository.completeEffectWithEvidence(
          admitted.effect.id,
          'tenant-a',
          claimed.lease,
          { status: 'compensated' },
          'evidence-completion-worker',
          record,
        );

        const response = await fetch(`${baseUrl}/v1/actions/${action.runId}/evidence`, {
          headers: { 'x-test-tenant': 'tenant-a' },
        });
        assert.equal(response.status, 200);
        const payload = (await response.json()) as any;
        assert.deepEqual(Object.keys(payload).sort(), ['receipt', 'verification']);
        assert.equal(payload.receipt.scope.effectId, metadata.effectId);
        assert.equal(payload.receipt.actionDigest, metadata.actionDigest);
        assert.equal(payload.receipt.terminalDisposition, 'SUCCEEDED');
        assert.deepEqual(verifyEvidenceReceipt(payload.receipt, signer.jwks), payload.verification);
      },
      signer.jwks,
    );
  });

  it('returns the persisted signed receipt for an escalated completion-unknown effect', async () => {
    const gateway = new InMemoryGateway();
    const signer = evidenceSigner();
    await withGateway(
      gateway,
      async (baseUrl) => {
        const proposed = await postJson(baseUrl, '/v1/actions', {
          ...baseAction,
          idempotencyKey: 'action-evidence-escalated-unknown',
        });
        assert.equal(proposed.status, 202);
        const action = ((await proposed.json()) as any).action;
        const run = await gateway.repository.getRun(action.runId, 'tenant-a');
        const metadata = run!.metadata.actionGateway as any;
        const claimedStep = await gateway.repository.claimNextStep({
          workerId: 'evidence-escalation-worker',
          workerGeneration: 1,
          tenantId: 'tenant-a',
          capabilities: ['tool'],
          leaseTtlMs: 30_000,
        });
        assert.ok(claimedStep?.lease);
        const admitted = await gateway.repository.admitEffect({
          id: metadata.effectId,
          runId: action.runId,
          stepId: claimedStep.id,
          tenantId: 'tenant-a',
          type: metadata.envelope.effectType,
          idempotencyKey: metadata.envelope.idempotencyKey,
          policyDecisionId: metadata.decision.decisionId,
          policySnapshotId: metadata.policySnapshotId,
          actionDigest: metadata.actionDigest,
          request: metadata.envelope,
          lease: claimedStep.lease,
          actor: 'evidence-escalation-worker',
        });
        assert.equal(admitted.admitted, true);
        if (!admitted.admitted) return;
        await gateway.repository.markEffectCompletionUnknown({
          effectId: admitted.effect.id,
          tenantId: 'tenant-a',
          reason: 'remote outcome unknown',
          actor: 'evidence-escalation-worker',
        });
        const [claimedEffect] = await gateway.repository.claimReconcileEffects({
          tenantId: 'tenant-a',
          limit: 1,
          now: new Date(Date.now() + 60_000),
          workerId: 'evidence-escalation-worker',
          workerGeneration: 1,
        });
        assert.ok(claimedEffect);
        const record = await buildEffectScopedEvidenceRecord({
          effect: claimedEffect.effect,
          projectedState: 'COMPLETION_UNKNOWN',
          response: { errorCode: 'REMOTE_OUTCOME_UNKNOWN' },
          auditEvents: [],
          terminalEvent: {
            type: 'effect.reconcile_escalated',
            severity: 'high',
            details: { reason: 'unregistered_adapter' },
          },
          signer,
          recordedAt: '2026-08-11T00:00:02.000Z',
          retentionUntil: '2027-08-11T00:00:02.000Z',
        });
        assert.equal(
          await gateway.repository.escalateReconcileWithEvidence(
            {
              effectId: admitted.effect.id,
              tenantId: 'tenant-a',
              claimToken: claimedEffect.claimToken,
              reason: 'unregistered_adapter',
            },
            record,
          ),
          true,
        );

        const response = await fetch(`${baseUrl}/v1/actions/${action.runId}/evidence`, {
          headers: { 'x-test-tenant': 'tenant-a' },
        });
        assert.equal(response.status, 200);
        const payload = (await response.json()) as any;
        assert.deepEqual(Object.keys(payload).sort(), ['receipt', 'verification']);
        assert.equal(payload.receipt.scope.effectId, metadata.effectId);
        assert.equal(payload.receipt.actionDigest, metadata.actionDigest);
        assert.equal(payload.receipt.terminalDisposition, 'ESCALATED');
        assert.deepEqual(verifyEvidenceReceipt(payload.receipt, signer.jwks), payload.verification);
      },
      signer.jwks,
    );
  });

  it('does not synthesize evidence when a completed effect has no persisted receipt', async () => {
    const gateway = new InMemoryGateway();
    const signer = evidenceSigner();
    await withGateway(
      gateway,
      async (baseUrl) => {
        const proposed = await postJson(baseUrl, '/v1/actions', {
          ...baseAction,
          destination: 'demo://tickets/approval',
          idempotencyKey: 'action-key-evidence',
          args: {
            title: 'SENSITIVE_TOOL_ARGUMENT',
            Authorization: 'Bearer SENSITIVE_AUTH_TOKEN',
          },
        });
        const payload = (await proposed.json()) as any;
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
          policySnapshotId: metadata.policySnapshotId,
          actionDigest: metadata.actionDigest,
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
        const evidence = await fetch(`${baseUrl}/v1/actions/${payload.action.runId}/evidence`, {
          headers: { 'x-test-tenant': 'tenant-a' },
        });
        assert.equal(evidence.status, 404);
        assert.equal(((await evidence.json()) as any).error.code, 'EVIDENCE_NOT_FOUND');

        const reconcile = await postJson(
          baseUrl,
          `/v1/actions/${payload.action.runId}/reconcile`,
          {},
        );
        assert.equal(reconcile.status, 409);
      },
      signer.jwks,
    );
  });

  it('does not synthesize evidence for a rejected action without an effect receipt', async () => {
    const gateway = new InMemoryGateway();
    const signer = evidenceSigner();
    await withGateway(
      gateway,
      async (baseUrl) => {
        const proposed = await postJson(baseUrl, '/v1/actions', {
          ...baseAction,
          destination: 'demo://tickets/approval',
          idempotencyKey: 'action-key-reject-evidence',
        });
        const payload = (await proposed.json()) as any;
        const rejected = await postJson(baseUrl, `/v1/actions/${payload.action.runId}/reject`, {
          reason: 'Bearer USER_CONTROLLED_REJECT_SECRET',
        });
        assert.equal(rejected.status, 200);

        const evidence = await fetch(`${baseUrl}/v1/actions/${payload.action.runId}/evidence`, {
          headers: { 'x-test-tenant': 'tenant-a' },
        });
        assert.equal(evidence.status, 404);
        assert.equal(((await evidence.json()) as any).error.code, 'EVIDENCE_NOT_FOUND');
      },
      signer.jwks,
    );
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
      assert.equal(((await response.json()) as any).error.code, 'ACTION_GATEWAY_REQUIRED');
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
      assert.equal(((await response.json()) as any).error.code, 'ACTION_GATEWAY_REQUIRED');
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
      assert.equal(((await conflict.json()) as any).error.code, 'IDEMPOTENCY_KEY_CONFLICT');
    });
  });

  it('returns 503 KILL_SWITCH_LOOKUP_FAILED when kill-switch lookup throws', async () => {
    const gateway = new InMemoryGateway();
    gateway.killSwitchLookupError = new Error('db unavailable');
    await withGateway(gateway, async (baseUrl) => {
      const response = await postJson(baseUrl, '/v1/actions/simulate', baseAction);
      assert.equal(response.status, 503);
      assert.equal(((await response.json()) as any).error.code, 'KILL_SWITCH_LOOKUP_FAILED');
    });
  });
});
