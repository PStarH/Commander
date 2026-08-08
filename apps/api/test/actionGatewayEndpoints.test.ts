import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import express from 'express';
import { ACTION_STATES_V1, type ActionStateV1 } from '@commander/contracts';
import {
  buildRunEvidenceBundle,
  canonicalEvidenceBody,
  createEvidenceSigner,
  verifyEvidenceBundle,
} from '@commander/effect-broker';
import {
  InMemoryKernelRepository,
  seedFreshOperationsDrains,
} from '@commander/kernel/testing/inMemoryRepository';
import type { CompleteActionRequestInput, KillSwitchScope } from '@commander/kernel';
import type {
  ActionReconcileRequestResult,
  GatewayEvidenceRecord,
  V1KernelGateway,
} from '../src/v1GatewayKernel.js';
import { canonicalValueHash, GatewayIdempotencyConflictError } from '../src/v1GatewayKernel.js';
import { projectCanonicalActionState } from '../src/actionGatewayEndpoints.js';
import { createV1GatewayRouter } from '../src/v1GatewayEndpoints.js';

class InMemoryGateway implements V1KernelGateway {
  readonly repository = new InMemoryKernelRepository();
  private readonly submissions = new Map<string, string>();
  readonly evidence = new Map<string, GatewayEvidenceRecord>();
  killSwitchLookupError: Error | null = null;
  operationsReady = true;
  evidenceReady = true;
  actionRequestNow = new Date('2026-08-07T00:00:00.000Z');
  failNextActionRequestCompletion = false;
  failedActionRequestCompletion: CompleteActionRequestInput | null = null;
  readonly actionCalls = {
    submit: 0,
    getRun: 0,
    listInteractions: 0,
    answerInteraction: 0,
    cancelRun: 0,
    putKillSwitch: 0,
    removeKillSwitch: 0,
    listKillSwitches: 0,
  };

  beginActionRequest(input: Parameters<InMemoryKernelRepository['beginActionRequest']>[0]) {
    return this.repository.beginActionRequest({ ...input, now: this.actionRequestNow });
  }

  async completeActionRequest(
    input: Parameters<InMemoryKernelRepository['completeActionRequest']>[0],
  ) {
    if (this.failNextActionRequestCompletion) {
      this.failNextActionRequestCompletion = false;
      this.failedActionRequestCompletion = structuredClone(input);
      throw new Error('SIMULATED_PROCESS_CRASH_BEFORE_ACTION_REQUEST_COMPLETION');
    }
    await this.repository.completeActionRequest({ ...input, now: this.actionRequestNow });
  }

  advanceActionRequestClock(ms: number) {
    this.actionRequestNow = new Date(this.actionRequestNow.getTime() + ms);
  }

  getOperationsReadiness(_tenantId: string, now = new Date()) {
    return Promise.resolve({
      ready: this.operationsReady,
      ...(this.operationsReady ? {} : { reason: 'RECONCILIATION_DRAIN_UNAVAILABLE' as const }),
      reconciliationWorkers: this.operationsReady ? 1 : 0,
      compensationWorkers: this.operationsReady ? 1 : 0,
      checkedAt: now.toISOString(),
    });
  }

  getEvidenceRepositoryAvailability() {
    return Promise.resolve({ ready: this.evidenceReady });
  }

  async submit(input: Parameters<V1KernelGateway['submit']>[0]) {
    this.actionCalls.submit++;
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
    this.actionCalls.getRun++;
    return this.repository.getRun(runId, tenantId);
  }
  getStep(stepId: string, tenantId: string) {
    return this.repository.getStep(stepId, tenantId);
  }
  listEvents(runId: string, tenantId: string) {
    return this.repository.listEvents(runId, tenantId);
  }
  listInteractions(runId: string, tenantId: string) {
    this.actionCalls.listInteractions++;
    return this.repository.listInteractions(runId, tenantId);
  }
  createInteraction(
    input: Parameters<InMemoryKernelRepository['createInteraction']>[0],
    actor: string,
  ) {
    return this.repository.createInteraction(input, actor);
  }
  answerInteraction(input: Parameters<InMemoryKernelRepository['answerInteraction']>[0]) {
    this.actionCalls.answerInteraction++;
    return this.repository.answerInteraction(input);
  }
  listEffects(runId: string, tenantId: string) {
    return this.repository.listEffectsForRun(runId, tenantId);
  }
  getEffect(effectId: string, tenantId: string) {
    return this.repository.getEffect(effectId, tenantId);
  }
  createCompensationAuthorization(
    input: Parameters<InMemoryKernelRepository['createCompensationAuthorization']>[0],
  ) {
    return this.repository.createCompensationAuthorization(input);
  }
  getCompensationAuthorization(authorizationId: string, tenantId: string) {
    return this.repository.getCompensationAuthorization(authorizationId, tenantId);
  }
  requestCompensation(input: Parameters<InMemoryKernelRepository['requestCompensation']>[0]) {
    return this.repository.requestCompensation(input);
  }
  getEvidence(runId: string, tenantId: string) {
    return Promise.resolve(this.evidence.get(`${tenantId}\u0000${runId}`) ?? null);
  }
  async requestReconcile(
    effectId: string,
    tenantId: string,
    actor: string,
  ): Promise<ActionReconcileRequestResult> {
    const current = await this.repository.getEffect(effectId, tenantId);
    if (!current) return { scheduled: false, reason: 'NOT_FOUND' };
    if (current.state !== 'COMPLETION_UNKNOWN' || !current.reconcilePolicy) {
      return { scheduled: false, reason: 'NOT_UNKNOWN' };
    }
    if (current.reconcileEscalatedAt) return { scheduled: false, reason: 'ESCALATED' };
    if (Date.parse(current.reconcilePolicy.deadlineAt) <= Date.now()) {
      return { scheduled: false, reason: 'DEADLINE_EXPIRED' };
    }
    const alreadyScheduled = Date.parse(current.reconcileAfter ?? '') <= Date.now();
    const expedited = await this.repository.requestReconcile({ effectId, tenantId, actor });
    if (!expedited?.reconcileAfter) return { scheduled: false, reason: 'NOT_UNKNOWN' };
    return {
      scheduled: true,
      effectId: expedited.id,
      state: 'COMPLETION_UNKNOWN',
      reconcileAfter: expedited.reconcileAfter,
      alreadyScheduled,
    };
  }
  pauseRun(runId: string, tenantId: string, actor: string) {
    return this.repository.pauseRun(runId, tenantId, actor);
  }
  resumeRun(runId: string, tenantId: string, actor: string) {
    return this.repository.resumeRun(runId, tenantId, actor);
  }
  cancelRun(runId: string, tenantId: string, actor: string) {
    this.actionCalls.cancelRun++;
    return this.repository.cancelRun(runId, tenantId, actor);
  }
  putKillSwitch(input: Parameters<InMemoryKernelRepository['putKillSwitch']>[0]) {
    this.actionCalls.putKillSwitch++;
    return this.repository.putKillSwitch(input);
  }
  removeKillSwitch(input: Parameters<InMemoryKernelRepository['removeKillSwitch']>[0]) {
    this.actionCalls.removeKillSwitch++;
    return this.repository.removeKillSwitch(input);
  }
  listKillSwitches(tenantId: string) {
    this.actionCalls.listKillSwitches++;
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
      req.principalRef = 'test-key';
      req.apiScopes = ['actions:approve'];
    } else if (principal === 'api-approver-2') {
      req.apiKeyId = 'test-key-2';
      req.principalRef = 'test-key-2';
      req.apiScopes = ['actions:approve'];
    } else if (principal === 'api-reconcile') {
      req.apiKeyId = 'reconcile-key';
      req.principalRef = 'reconcile-key';
      req.apiScopes = ['actions:reconcile'];
    } else if (principal === 'api-read') {
      req.apiKeyId = 'read-key';
      req.principalRef = 'read-key';
      req.apiScopes = ['read'];
    } else if (principal === 'api-admin') {
      req.apiKeyId = 'admin-key';
      req.principalRef = 'admin-key';
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
  }
}

async function withEvidenceJwks(jwks: unknown, action: () => Promise<void>): Promise<void> {
  const previous = process.env.COMMANDER_EVIDENCE_JWKS_JSON;
  process.env.COMMANDER_EVIDENCE_JWKS_JSON = JSON.stringify(jwks);
  try {
    await action();
  } finally {
    if (previous === undefined) delete process.env.COMMANDER_EVIDENCE_JWKS_JSON;
    else process.env.COMMANDER_EVIDENCE_JWKS_JSON = previous;
  }
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  tenant = 'tenant-a',
  principal = 'api-approver',
  idempotencyKey?: string,
) {
  const bodyKey = (body as { idempotencyKey?: string }).idempotencyKey;
  const derivedKey = `test-${createHash('sha256')
    .update(JSON.stringify({ path, body, principal }))
    .digest('hex')
    .slice(0, 24)}`;
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-tenant': tenant,
      'x-test-principal': principal,
      'Idempotency-Key': idempotencyKey ?? bodyKey ?? derivedKey,
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

async function retryAfterSimulatedActionRequestCrash(
  gateway: InMemoryGateway,
  request: () => Promise<Response>,
): Promise<Response> {
  gateway.failNextActionRequestCompletion = true;
  const crashed = await request();
  assert.equal(crashed.status, 500);
  await crashed.text();

  const activeRetry = await request();
  assert.equal(activeRetry.status, 409);
  assert.equal(((await activeRetry.json()) as any).error.code, 'IDEMPOTENCY_REQUEST_IN_PROGRESS');

  gateway.advanceActionRequestClock(30_000);
  return request();
}

type CapturedHttpResponse = { status: number; body: unknown };

async function captureHttpResponse(response: Response): Promise<CapturedHttpResponse> {
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}

function isActionRequestBindingFenced(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && error.code === 'ACTION_REQUEST_BINDING_FENCED'
  );
}

async function recoverExactResponseAfterSimulatedActionRequestCrash(
  gateway: InMemoryGateway,
  request: () => Promise<Response>,
): Promise<{
  original: CapturedHttpResponse;
  recovered: CapturedHttpResponse;
  replay: CapturedHttpResponse;
}> {
  gateway.failedActionRequestCompletion = null;
  gateway.failNextActionRequestCompletion = true;
  const crashed = await request();
  assert.equal(crashed.status, 500);
  await crashed.text();

  const failedCompletion = gateway.failedActionRequestCompletion;
  assert.ok(failedCompletion);
  const original = {
    status: failedCompletion.responseStatus,
    body: failedCompletion.responseBody,
  };

  const activeRetry = await request();
  assert.equal(activeRetry.status, 409);
  assert.equal(((await activeRetry.json()) as any).error.code, 'IDEMPOTENCY_REQUEST_IN_PROGRESS');

  gateway.advanceActionRequestClock(30_000);
  const recovered = await captureHttpResponse(await request());
  assert.deepEqual(recovered, original);

  await assert.rejects(
    gateway.repository.completeActionRequest(failedCompletion),
    isActionRequestBindingFenced,
  );

  const replay = await captureHttpResponse(await request());
  assert.deepEqual(replay, original);
  return { original, recovered, replay };
}

async function createCompletedForwardAction(
  gateway: InMemoryGateway,
  baseUrl: string,
  idempotencyKey: string,
  requireApproval: boolean,
) {
  const proposed = await postJson(baseUrl, '/v1/actions', {
    ...baseAction,
    destination: requireApproval ? 'demo://tickets/approval' : 'demo://tickets',
    idempotencyKey,
  });
  assert.equal(proposed.status, 202);
  const action = ((await proposed.json()) as any).action;
  if (requireApproval) {
    const approved = await postJson(
      baseUrl,
      `/v1/actions/${action.runId}/approve`,
      approvalBinding(action),
    );
    assert.equal(approved.status, 200);
    await approved.json();
  }

  const step = await gateway.repository.claimNextStep({
    workerId: `worker-${idempotencyKey}`,
    workerGeneration: 1,
    tenantId: 'tenant-a',
    capabilities: ['tool'],
    leaseTtlMs: 30_000,
  });
  assert.ok(step?.lease);
  const run = await gateway.repository.getRun(action.runId, 'tenant-a');
  const metadata = run!.metadata.actionGateway as any;
  const response = { ticketId: `ticket-${idempotencyKey}` };
  seedFreshOperationsDrains(gateway.repository, 'tenant-a');
  const admitted = await gateway.repository.admitEffect({
    id: metadata.effectId,
    runId: action.runId,
    stepId: step.id,
    tenantId: 'tenant-a',
    type: metadata.envelope.effectType,
    idempotencyKey,
    policyDecisionId: metadata.decision.decisionId,
    policySnapshotId: metadata.policySnapshotId,
    actionDigest: metadata.actionDigest,
    request: metadata.envelope,
    lease: step.lease,
    actor: `worker-${idempotencyKey}`,
  });
  assert.equal(admitted.admitted, true);
  await gateway.repository.completeEffect(
    metadata.effectId,
    'tenant-a',
    step.lease,
    response,
    `worker-${idempotencyKey}`,
  );
  await gateway.repository.completeStep({
    stepId: step.id,
    tenantId: 'tenant-a',
    lease: step.lease,
    expectedVersion: step.version,
    output: response,
    actor: `worker-${idempotencyKey}`,
  });
  return { action, metadata, forwardReceiptHash: canonicalValueHash(response) };
}

async function putKillSwitch(
  baseUrl: string,
  scope: KillSwitchScope,
  value: string,
  body: { enabled: boolean; reason?: string },
  tenant = 'tenant-a',
  principal = 'api-admin',
) {
  const key = `kill-${createHash('sha256')
    .update(JSON.stringify({ scope, value, body, principal }))
    .digest('hex')
    .slice(0, 24)}`;
  return fetch(`${baseUrl}/v1/actions/kill-switches/${scope}/${encodeURIComponent(value)}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-test-tenant': tenant,
      'x-test-principal': principal,
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
  });
}

describe('Action Gateway HTTP Idempotency-Key contract', () => {
  type ActionWriteCase = {
    name: string;
    method: 'POST' | 'PUT' | 'DELETE';
    path: string;
    principal?: string;
    body?: unknown;
  };

  const writes: ActionWriteCase[] = [
    {
      name: 'simulation',
      method: 'POST',
      path: '/v1/actions/simulate',
      body: baseAction,
    },
    {
      name: 'proposal',
      method: 'POST',
      path: '/v1/actions',
      body: baseAction,
    },
    {
      name: 'approval',
      method: 'POST',
      path: '/v1/actions/run-missing/approve',
      body: {
        actionDigest: 'a'.repeat(64),
        simulationId: 'simulation-missing',
        policySnapshotId: 'policy-missing',
      },
    },
    {
      name: 'rejection',
      method: 'POST',
      path: '/v1/actions/run-missing/reject',
      body: { reason: 'contract test' },
    },
    {
      name: 'compensation request',
      method: 'POST',
      path: '/v1/actions/run-missing/compensations',
      body: {
        originalEffectId: 'effect-missing',
        adapterVersion: 'adapter-v1',
        compensationEffectType: 'compensate.demo.ticket.create',
        compensationPatch: { state: 'closed' },
        forwardReceiptHash: 'b'.repeat(64),
      },
    },
    {
      name: 'compensation approval',
      method: 'POST',
      path: '/v1/actions/run-missing/compensations/authorization-missing/approve',
      body: {
        actionDigest: 'c'.repeat(64),
        policySnapshotId: 'policy-missing',
      },
    },
    {
      name: 'reconciliation',
      method: 'POST',
      path: '/v1/actions/run-missing/reconcile',
      principal: 'api-reconcile',
    },
    {
      name: 'kill-switch update',
      method: 'PUT',
      path: '/v1/actions/kill-switches/tool/ticket.create',
      principal: 'api-admin',
      body: { enabled: true, reason: 'contract test' },
    },
    {
      name: 'kill-switch delete',
      method: 'DELETE',
      path: '/v1/actions/kill-switches/tool/ticket.create',
      principal: 'api-admin',
    },
  ];

  async function requestWrite(
    baseUrl: string,
    request: ActionWriteCase,
    idempotencyKey?: string,
  ): Promise<Response> {
    const headers = new Headers({
      'x-test-tenant': 'tenant-a',
      'x-test-principal': request.principal ?? 'api-approver',
    });
    if (request.body !== undefined) headers.set('content-type', 'application/json');
    if (idempotencyKey !== undefined) headers.set('Idempotency-Key', idempotencyKey);
    return fetch(`${baseUrl}${request.path}`, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
  }

  for (const header of [
    { name: 'missing', value: undefined },
    { name: 'malformed', value: 'short' },
  ] as const) {
    for (const write of writes) {
      it(`rejects a ${header.name} Idempotency-Key on ${write.name}`, async () => {
        await withGateway(new InMemoryGateway(), async (baseUrl) => {
          const response = await requestWrite(baseUrl, write, header.value);
          assert.equal(response.status, 400);
          const payload = (await response.json()) as { error?: { code?: string } };
          assert.equal(payload.error?.code, 'IDEMPOTENCY_KEY_REQUIRED');
        });
      });
    }
  }

  for (const write of writes.slice(0, 2)) {
    it(`rejects an Idempotency-Key header/body mismatch on ${write.name}`, async () => {
      await withGateway(new InMemoryGateway(), async (baseUrl) => {
        const response = await requestWrite(
          baseUrl,
          {
            ...write,
            body: { ...baseAction, idempotencyKey: 'body-key-0001' },
          },
          'header-key-0001',
        );
        const payload = (await response.json()) as { error?: { code?: string } };
        assert.equal(response.status, 409);
        assert.equal(payload.error?.code, 'IDEMPOTENCY_KEY_CONFLICT');
      });
    });
  }

  it('replays the original kill-switch response for the same tenant, key, and request', async () => {
    await withGateway(new InMemoryGateway(), async (baseUrl) => {
      const request = () =>
        requestWrite(
          baseUrl,
          {
            name: 'kill-switch update',
            method: 'PUT',
            path: '/v1/actions/kill-switches/tool/ticket.create',
            principal: 'api-admin',
            body: { enabled: true, reason: 'maintenance' },
          },
          'kill-switch-key-0001',
        );
      const first = await request();
      const firstPayload = await first.json();
      const replay = await request();
      const replayPayload = await replay.json();

      assert.equal(first.status, 200);
      assert.equal(replay.status, 200);
      assert.deepEqual(replayPayload, firstPayload);
    });
  });

  it('rejects a changed kill-switch request that reuses the same tenant and key', async () => {
    await withGateway(new InMemoryGateway(), async (baseUrl) => {
      const first = await requestWrite(
        baseUrl,
        {
          name: 'kill-switch update',
          method: 'PUT',
          path: '/v1/actions/kill-switches/tool/ticket.create',
          principal: 'api-admin',
          body: { enabled: true, reason: 'maintenance' },
        },
        'kill-switch-key-0002',
      );
      assert.equal(first.status, 200);

      const conflict = await requestWrite(
        baseUrl,
        {
          name: 'kill-switch update',
          method: 'PUT',
          path: '/v1/actions/kill-switches/tool/ticket.create',
          principal: 'api-admin',
          body: { enabled: false, reason: 'changed request' },
        },
        'kill-switch-key-0002',
      );
      assert.equal(conflict.status, 409);
      const payload = (await conflict.json()) as { error?: { code?: string } };
      assert.equal(payload.error?.code, 'IDEMPOTENCY_KEY_CONFLICT');
    });
  });

  it('does not replay a privileged response across authenticated principals', async () => {
    await withGateway(new InMemoryGateway(), async (baseUrl) => {
      const request = (principal: string) =>
        requestWrite(
          baseUrl,
          {
            name: 'kill-switch update',
            method: 'PUT',
            path: '/v1/actions/kill-switches/tool/ticket.create',
            principal,
            body: { enabled: true, reason: 'principal binding' },
          },
          'kill-switch-principal-key',
        );

      const first = await request('api-admin');
      assert.equal(first.status, 200);
      await first.json();

      const otherPrincipal = await request('user-admin');
      assert.equal(otherPrincipal.status, 409);
      assert.equal(((await otherPrincipal.json()) as any).error.code, 'IDEMPOTENCY_KEY_CONFLICT');
    });
  });
});

describe('Action Gateway stale request recovery', () => {
  it('recovers an exact simulation response without persisting a second audit run', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const body = { ...baseAction, idempotencyKey: 'action-crash-simulation' };
      const request = () => postJson(baseUrl, '/v1/actions/simulate', body);
      const callsBefore = { ...gateway.actionCalls };

      const { original } = await recoverExactResponseAfterSimulatedActionRequestCrash(
        gateway,
        request,
      );

      assert.equal(original.status, 200);
      const simulation = (original.body as any).simulation;
      const durableRun = await gateway.repository.getRun(simulation.simulationId, 'tenant-a');
      assert.equal(durableRun?.state, 'CANCELLED');
      assert.deepEqual(durableRun?.metadata.actionGatewaySimulation, simulation);
      assert.equal(gateway.actionCalls.submit, callsBefore.submit + 1);
      assert.equal(gateway.actionCalls.cancelRun, callsBefore.cancelRun + 1);
      assert.ok(gateway.actionCalls.getRun > callsBefore.getRun);
      assert.equal(
        (await gateway.repository.listEvents(simulation.simulationId, 'tenant-a')).filter(
          (event) => event.type === 'run.created',
        ).length,
        1,
      );
    });
  });

  it('does not rerun simulation policy when no durable simulation proves the response', async () => {
    const gateway = new InMemoryGateway();
    await gateway.repository.putKillSwitch({
      tenantId: 'tenant-a',
      scope: 'tool',
      value: 'ticket.create',
      enabled: true,
      reason: 'force a response without a simulation run',
      actor: 'api-admin',
    });
    await withGateway(gateway, async (baseUrl) => {
      const body = { ...baseAction, idempotencyKey: 'simulation-no-durable-fact' };
      const request = () => postJson(baseUrl, '/v1/actions/simulate', body);
      gateway.failNextActionRequestCompletion = true;
      const crashed = await request();
      assert.equal(crashed.status, 403);
      await crashed.text();
      const failedCompletion = gateway.failedActionRequestCompletion;
      assert.ok(failedCompletion);
      assert.equal(failedCompletion.responseStatus, 403);
      assert.equal(gateway.actionCalls.submit, 0);

      await gateway.repository.removeKillSwitch({
        tenantId: 'tenant-a',
        scope: 'tool',
        value: 'ticket.create',
      });
      gateway.advanceActionRequestClock(30_000);
      const unprovable = await captureHttpResponse(await request());
      assert.equal(unprovable.status, 409);
      assert.equal((unprovable.body as any).error.code, 'ACTION_REQUEST_RECOVERY_UNPROVABLE');
      assert.equal(gateway.actionCalls.submit, 0);
      await assert.rejects(
        gateway.repository.completeActionRequest(failedCompletion),
        isActionRequestBindingFenced,
      );
      const stillLeased = await captureHttpResponse(await request());
      assert.equal(
        (stillLeased.body as { error: { code: string } }).error.code,
        'IDEMPOTENCY_REQUEST_IN_PROGRESS',
      );
      gateway.advanceActionRequestClock(30_000);
      assert.deepEqual(await captureHttpResponse(await request()), unprovable);
    });
  });

  it('does not create an action when stale proposal recovery has no durable action run', async () => {
    const gateway = new InMemoryGateway();
    await gateway.repository.putKillSwitch({
      tenantId: 'tenant-a',
      scope: 'tool',
      value: 'ticket.create',
      enabled: true,
      reason: 'force a response without an action run',
      actor: 'api-admin',
    });
    await withGateway(gateway, async (baseUrl) => {
      const body = { ...baseAction, idempotencyKey: 'proposal-no-durable-fact' };
      const request = () => postJson(baseUrl, '/v1/actions', body);
      gateway.failNextActionRequestCompletion = true;
      const crashed = await request();
      assert.equal(crashed.status, 403);
      await crashed.text();
      const failedCompletion = gateway.failedActionRequestCompletion;
      assert.ok(failedCompletion);
      assert.equal(failedCompletion.responseStatus, 403);
      assert.equal(gateway.actionCalls.submit, 0);

      await gateway.repository.removeKillSwitch({
        tenantId: 'tenant-a',
        scope: 'tool',
        value: 'ticket.create',
      });
      gateway.advanceActionRequestClock(30_000);
      const unprovable = await captureHttpResponse(await request());
      assert.equal(unprovable.status, 409);
      assert.equal((unprovable.body as any).error.code, 'ACTION_REQUEST_RECOVERY_UNPROVABLE');
      assert.equal(gateway.actionCalls.submit, 0);
      await assert.rejects(
        gateway.repository.completeActionRequest(failedCompletion),
        isActionRequestBindingFenced,
      );
      const stillLeased = await captureHttpResponse(await request());
      assert.equal(
        (stillLeased.body as { error: { code: string } }).error.code,
        'IDEMPOTENCY_REQUEST_IN_PROGRESS',
      );
      gateway.advanceActionRequestClock(30_000);
      assert.deepEqual(await captureHttpResponse(await request()), unprovable);
    });
  });

  it('does not poison recovery when the superseded proposal finishes after an unprovable query', async () => {
    const gateway = new InMemoryGateway();
    const originalFindMatchingKillSwitch = gateway.findMatchingKillSwitch.bind(gateway);
    let releaseOriginal: (() => void) | undefined;
    let reportOriginalPaused: (() => void) | undefined;
    const originalPaused = new Promise<void>((resolve) => {
      reportOriginalPaused = resolve;
    });
    const resumeOriginal = new Promise<void>((resolve) => {
      releaseOriginal = resolve;
    });
    let pauseFirstLookup = true;
    gateway.findMatchingKillSwitch = async (...args) => {
      if (pauseFirstLookup) {
        pauseFirstLookup = false;
        reportOriginalPaused?.();
        await resumeOriginal;
      }
      return originalFindMatchingKillSwitch(...args);
    };

    await withGateway(gateway, async (baseUrl) => {
      const body = { ...baseAction, idempotencyKey: 'proposal-live-predecessor-race' };
      const request = () => postJson(baseUrl, '/v1/actions', body);
      const originalResponse = request();
      await originalPaused;

      gateway.advanceActionRequestClock(30_000);
      const unprovable = await captureHttpResponse(await request());
      assert.equal(unprovable.status, 409);
      assert.equal(
        (unprovable.body as { error: { code: string } }).error.code,
        'ACTION_REQUEST_RECOVERY_UNPROVABLE',
      );
      assert.equal(gateway.actionCalls.submit, 0);

      assert.ok(releaseOriginal);
      releaseOriginal();
      const superseded = await originalResponse;
      assert.equal(superseded.status, 500);
      await superseded.text();
      const submissionsAfterOriginal = gateway.actionCalls.submit;
      assert.ok(submissionsAfterOriginal >= 1);

      gateway.advanceActionRequestClock(30_000);
      const recovered = await request();
      assert.equal(recovered.status, 200);
      const payload = (await recovered.json()) as { idempotentReplay: boolean };
      assert.equal(payload.idempotentReplay, true);
      assert.equal(gateway.actionCalls.submit, submissionsAfterOriginal);
    });
  });

  it('terminates stale kill-switch PUT recovery as unprovable without rewriting the row', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const request = () =>
        fetch(`${baseUrl}/v1/actions/kill-switches/tool/ticket.create`, {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            'x-test-tenant': 'tenant-a',
            'x-test-principal': 'api-admin',
            'Idempotency-Key': 'kill-switch-crash-put',
          },
          body: JSON.stringify({ enabled: true, reason: 'crash recovery proof' }),
        });

      gateway.failNextActionRequestCompletion = true;
      const crashed = await request();
      assert.equal(crashed.status, 500);
      await crashed.text();
      const failedCompletion = gateway.failedActionRequestCompletion;
      assert.ok(failedCompletion);
      assert.equal(gateway.actionCalls.putKillSwitch, 1);
      assert.equal((await gateway.repository.listKillSwitches('tenant-a')).length, 1);

      const activeRetry = await request();
      assert.equal(activeRetry.status, 409);
      assert.equal(
        ((await activeRetry.json()) as any).error.code,
        'IDEMPOTENCY_REQUEST_IN_PROGRESS',
      );

      const readsBeforeTakeover = gateway.actionCalls.listKillSwitches;
      gateway.advanceActionRequestClock(30_000);
      const unprovable = await captureHttpResponse(await request());
      assert.equal(unprovable.status, 409);
      assert.equal((unprovable.body as any).error.code, 'ACTION_REQUEST_RECOVERY_UNPROVABLE');
      assert.ok(gateway.actionCalls.listKillSwitches > readsBeforeTakeover);
      assert.equal(gateway.actionCalls.putKillSwitch, 1);

      await assert.rejects(
        gateway.repository.completeActionRequest(failedCompletion),
        isActionRequestBindingFenced,
      );
      const readsBeforeReplay = gateway.actionCalls.listKillSwitches;
      const stillLeased = await captureHttpResponse(await request());
      assert.equal(
        (stillLeased.body as { error: { code: string } }).error.code,
        'IDEMPOTENCY_REQUEST_IN_PROGRESS',
      );
      assert.equal(gateway.actionCalls.listKillSwitches, readsBeforeReplay);
      gateway.advanceActionRequestClock(30_000);
      assert.deepEqual(await captureHttpResponse(await request()), unprovable);
      assert.equal(gateway.actionCalls.putKillSwitch, 1);
    });
  });

  it('terminates stale kill-switch DELETE recovery as unprovable without deleting again', async () => {
    const gateway = new InMemoryGateway();
    await gateway.repository.putKillSwitch({
      tenantId: 'tenant-a',
      scope: 'tool',
      value: 'ticket.create',
      enabled: true,
      reason: 'delete crash proof',
      actor: 'api-admin',
    });
    await withGateway(gateway, async (baseUrl) => {
      const request = () =>
        fetch(`${baseUrl}/v1/actions/kill-switches/tool/ticket.create`, {
          method: 'DELETE',
          headers: {
            'x-test-tenant': 'tenant-a',
            'x-test-principal': 'api-admin',
            'Idempotency-Key': 'kill-switch-crash-delete',
          },
        });

      gateway.failNextActionRequestCompletion = true;
      const crashed = await request();
      assert.equal(crashed.status, 500);
      await crashed.text();
      const failedCompletion = gateway.failedActionRequestCompletion;
      assert.ok(failedCompletion);
      assert.equal(gateway.actionCalls.removeKillSwitch, 1);
      assert.equal((await gateway.repository.listKillSwitches('tenant-a')).length, 0);

      const activeRetry = await request();
      assert.equal(activeRetry.status, 409);
      assert.equal(
        ((await activeRetry.json()) as any).error.code,
        'IDEMPOTENCY_REQUEST_IN_PROGRESS',
      );

      const readsBeforeTakeover = gateway.actionCalls.listKillSwitches;
      gateway.advanceActionRequestClock(30_000);
      const unprovable = await captureHttpResponse(await request());
      assert.equal(unprovable.status, 409);
      assert.equal((unprovable.body as any).error.code, 'ACTION_REQUEST_RECOVERY_UNPROVABLE');
      assert.ok(gateway.actionCalls.listKillSwitches > readsBeforeTakeover);
      assert.equal(gateway.actionCalls.removeKillSwitch, 1);

      await assert.rejects(
        gateway.repository.completeActionRequest(failedCompletion),
        isActionRequestBindingFenced,
      );
      const readsBeforeReplay = gateway.actionCalls.listKillSwitches;
      const stillLeased = await captureHttpResponse(await request());
      assert.equal(
        (stillLeased.body as { error: { code: string } }).error.code,
        'IDEMPOTENCY_REQUEST_IN_PROGRESS',
      );
      assert.equal(gateway.actionCalls.listKillSwitches, readsBeforeReplay);
      gateway.advanceActionRequestClock(30_000);
      assert.deepEqual(await captureHttpResponse(await request()), unprovable);
      assert.equal(gateway.actionCalls.removeKillSwitch, 1);
    });
  });

  it('recovers a proposed action from its deterministic durable run', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const body = { ...baseAction, idempotencyKey: 'action-crash-proposal' };
      const recovered = await retryAfterSimulatedActionRequestCrash(gateway, () =>
        postJson(baseUrl, '/v1/actions', body),
      );

      assert.equal(recovered.status, 200);
      const payload = (await recovered.json()) as any;
      assert.equal(payload.idempotentReplay, true);
      assert.equal(
        (await gateway.repository.listEvents(payload.action.runId, 'tenant-a')).filter(
          (event) => event.type === 'run.created',
        ).length,
        1,
      );
    });
  });

  it('recovers compensation authorization and approval from durable facts', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const forward = await createCompletedForwardAction(
        gateway,
        baseUrl,
        'action-crash-compensation',
        true,
      );
      const compensationBody = {
        originalEffectId: forward.action.effectId,
        adapterVersion: '1.0.0',
        compensationEffectType: 'compensate.demo.ticket.create',
        compensationPatch: { reason: 'crash recovery proof' },
        forwardReceiptHash: forward.forwardReceiptHash,
      };
      const compensationRequest = () =>
        postJson(
          baseUrl,
          `/v1/actions/${forward.action.runId}/compensations`,
          compensationBody,
          'tenant-a',
          'api-approver',
          'compensation-crash-request',
        );
      const recoveredRequest = await retryAfterSimulatedActionRequestCrash(
        gateway,
        compensationRequest,
      );
      assert.equal(recoveredRequest.status, 202);
      const requestPayload = (await recoveredRequest.json()) as any;
      assert.equal(requestPayload.state, 'AWAITING_APPROVAL');
      assert.equal(requestPayload.replayed, true);

      const approvalBody = {
        actionDigest: requestPayload.authorization.actionDigest,
        policySnapshotId: requestPayload.authorization.policySnapshotId,
      };
      const compensationApproval = () =>
        postJson(
          baseUrl,
          `/v1/actions/${forward.action.runId}/compensations/${requestPayload.authorization.id}/approve`,
          approvalBody,
          'tenant-a',
          'api-approver',
          'compensation-crash-approval',
        );
      const recoveredApproval = await retryAfterSimulatedActionRequestCrash(
        gateway,
        compensationApproval,
      );
      assert.equal(recoveredApproval.status, 202);
      const approvalPayload = (await recoveredApproval.json()) as any;
      assert.equal(approvalPayload.accepted, true);
      assert.equal(approvalPayload.replayed, true);
      assert.equal(approvalPayload.interaction.status, 'answered');
    });
  });

  it('recovers the existing reconciliation schedule', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-crash-reconcile',
      });
      const action = ((await proposed.json()) as any).action;
      const calls: string[] = [];
      gateway.requestReconcile = async (effectId) => {
        calls.push(effectId);
        return {
          scheduled: true,
          effectId,
          state: 'COMPLETION_UNKNOWN',
          reconcileAfter: '2026-08-07T00:00:00.000Z',
          alreadyScheduled: calls.length > 1,
        };
      };
      const request = () =>
        postJson(
          baseUrl,
          `/v1/actions/${action.runId}/reconcile`,
          {},
          'tenant-a',
          'api-reconcile',
          'reconcile-crash-request',
        );
      const recovered = await retryAfterSimulatedActionRequestCrash(gateway, request);

      assert.equal(recovered.status, 202);
      assert.equal(((await recovered.json()) as any).alreadyScheduled, true);
      assert.deepEqual(calls, [action.effectId, action.effectId]);
    });
  });

  it('recovers an exact ordinary approval response from the durable review fact', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-crash-ordinary-approval',
      });
      const action = ((await proposed.json()) as any).action;
      const request = () =>
        postJson(
          baseUrl,
          `/v1/actions/${action.runId}/approve`,
          approvalBinding(action),
          'tenant-a',
          'api-approver',
          'ordinary-approval-crash-request',
        );
      const callsBefore = { ...gateway.actionCalls };

      const { original } = await recoverExactResponseAfterSimulatedActionRequestCrash(
        gateway,
        request,
      );

      assert.equal(original.status, 200);
      assert.equal((original.body as any).action.state, 'ADMITTED');
      const interactions = await gateway.repository.listInteractions(action.runId, 'tenant-a');
      assert.equal(interactions[0]?.status, 'answered');
      assert.equal(gateway.actionCalls.answerInteraction, callsBefore.answerInteraction + 1);
      assert.ok(gateway.actionCalls.listInteractions > callsBefore.listInteractions);
      assert.equal(
        (await gateway.repository.listEvents(action.runId, 'tenant-a')).filter(
          (event) => event.type === 'interaction.answered',
        ).length,
        1,
      );
    });
  });

  it('checks approval authority before stale takeover and does not poison authorized recovery', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-crash-approval-authority',
      });
      const action = ((await proposed.json()) as any).action;
      const authorizedRequest = () =>
        postJson(
          baseUrl,
          `/v1/actions/${action.runId}/approve`,
          approvalBinding(action),
          'tenant-a',
          'api-approver',
          'approval-authority-crash-request',
        );
      const unauthorizedRequest = () =>
        postJson(
          baseUrl,
          `/v1/actions/${action.runId}/approve`,
          approvalBinding(action),
          'tenant-a',
          'api-read',
          'approval-authority-crash-request',
        );

      gateway.failNextActionRequestCompletion = true;
      const crashed = await authorizedRequest();
      assert.equal(crashed.status, 500);
      await crashed.text();
      const failedCompletion = gateway.failedActionRequestCompletion;
      assert.ok(failedCompletion);

      const unauthorizedActive = await unauthorizedRequest();
      assert.equal(unauthorizedActive.status, 403);
      await unauthorizedActive.text();
      gateway.advanceActionRequestClock(30_000);
      const unauthorizedStale = await unauthorizedRequest();
      assert.equal(unauthorizedStale.status, 403);
      await unauthorizedStale.text();

      const recovered = await captureHttpResponse(await authorizedRequest());
      assert.deepEqual(recovered, {
        status: failedCompletion.responseStatus,
        body: failedCompletion.responseBody,
      });
      await assert.rejects(
        gateway.repository.completeActionRequest(failedCompletion),
        isActionRequestBindingFenced,
      );
      assert.deepEqual(await captureHttpResponse(await authorizedRequest()), recovered);
      assert.equal(
        (await gateway.repository.listEvents(action.runId, 'tenant-a')).filter(
          (event) => event.type === 'interaction.answered',
        ).length,
        1,
      );
    });
  });

  it('recovers an exact ordinary rejection response from the durable review fact', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-crash-ordinary-rejection',
      });
      const action = ((await proposed.json()) as any).action;
      const request = () =>
        postJson(
          baseUrl,
          `/v1/actions/${action.runId}/reject`,
          { reason: 'crash recovery must not repeat this decision' },
          'tenant-a',
          'api-approver',
          'ordinary-rejection-crash-request',
        );
      const callsBefore = { ...gateway.actionCalls };

      const { original } = await recoverExactResponseAfterSimulatedActionRequestCrash(
        gateway,
        request,
      );

      assert.equal(original.status, 200);
      assert.equal((original.body as any).action.state, 'FAILED');
      assert.equal((await gateway.repository.getRun(action.runId, 'tenant-a'))?.state, 'CANCELLED');
      assert.equal(gateway.actionCalls.answerInteraction, callsBefore.answerInteraction + 1);
      assert.equal(gateway.actionCalls.cancelRun, callsBefore.cancelRun + 1);
      assert.ok(gateway.actionCalls.listInteractions > callsBefore.listInteractions);
      assert.equal(
        (await gateway.repository.listEvents(action.runId, 'tenant-a')).filter(
          (event) => event.type === 'interaction.answered',
        ).length,
        1,
      );
    });
  });
});

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
          headers: {
            'x-test-tenant': 'tenant-a',
            'x-test-principal': 'api-admin',
            'Idempotency-Key': 'kill-delete-key-0001',
          },
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

describe('L4-01 governed action HTTP API', () => {
  it('projects every internal lifecycle state onto the canonical action enum', () => {
    type ProjectionInput = Parameters<typeof projectCanonicalActionState>[0];
    const baseline: ProjectionInput = {
      decisionEffect: 'allow',
      runState: 'PENDING',
    };
    const cases: Array<{
      name: string;
      input: ProjectionInput;
      expected: ActionStateV1;
    }> = [
      { name: 'policy deny', input: { ...baseline, decisionEffect: 'deny' }, expected: 'FAILED' },
      {
        name: 'approval pending',
        input: { ...baseline, decisionEffect: 'require_approval' },
        expected: 'AWAITING_APPROVAL',
      },
      {
        name: 'approval rejected',
        input: { ...baseline, decisionEffect: 'require_approval', approval: false },
        expected: 'FAILED',
      },
      {
        name: 'approval admitted',
        input: {
          ...baseline,
          decisionEffect: 'require_approval',
          approval: true,
          stepState: 'RETRY_WAIT',
        },
        expected: 'ADMITTED',
      },
      { name: 'run pending', input: baseline, expected: 'ADMITTED' },
      {
        name: 'run running',
        input: { ...baseline, runState: 'RUNNING' },
        expected: 'RUNNING',
      },
      {
        name: 'run paused',
        input: { ...baseline, runState: 'PAUSED' },
        expected: 'ADMITTED',
      },
      {
        name: 'run succeeded',
        input: { ...baseline, runState: 'SUCCEEDED' },
        expected: 'SUCCEEDED',
      },
      { name: 'run failed', input: { ...baseline, runState: 'FAILED' }, expected: 'FAILED' },
      {
        name: 'run cancelled',
        input: { ...baseline, runState: 'CANCELLED' },
        expected: 'FAILED',
      },
      {
        name: 'run compensating',
        input: { ...baseline, runState: 'COMPENSATING' },
        expected: 'RUNNING',
      },
      {
        name: 'run compensated',
        input: { ...baseline, runState: 'COMPENSATED' },
        expected: 'SUCCEEDED',
      },
      {
        name: 'step pending',
        input: { ...baseline, stepState: 'PENDING' },
        expected: 'ADMITTED',
      },
      {
        name: 'step running',
        input: { ...baseline, stepState: 'RUNNING' },
        expected: 'RUNNING',
      },
      {
        name: 'step waiting for human',
        input: { ...baseline, stepState: 'WAITING_FOR_HUMAN' },
        expected: 'ADMITTED',
      },
      {
        name: 'step waiting for reconciliation',
        input: { ...baseline, stepState: 'WAITING_FOR_RECONCILIATION' },
        expected: 'COMPLETION_UNKNOWN',
      },
      {
        name: 'step retry wait',
        input: { ...baseline, stepState: 'RETRY_WAIT' },
        expected: 'ADMITTED',
      },
      {
        name: 'step succeeded',
        input: { ...baseline, stepState: 'SUCCEEDED' },
        expected: 'SUCCEEDED',
      },
      {
        name: 'step failed',
        input: { ...baseline, stepState: 'FAILED' },
        expected: 'FAILED',
      },
      {
        name: 'step cancelled',
        input: { ...baseline, stepState: 'CANCELLED' },
        expected: 'FAILED',
      },
      {
        name: 'step skipped',
        input: { ...baseline, stepState: 'SKIPPED' },
        expected: 'FAILED',
      },
      {
        name: 'effect admitted',
        input: { ...baseline, effectState: 'ADMITTED' },
        expected: 'ADMITTED',
      },
      {
        name: 'effect completion unknown',
        input: { ...baseline, effectState: 'COMPLETION_UNKNOWN' },
        expected: 'COMPLETION_UNKNOWN',
      },
      {
        name: 'effect confirmed not applied',
        input: { ...baseline, effectState: 'CONFIRMED_NOT_APPLIED' },
        expected: 'FAILED',
      },
      {
        name: 'effect completed',
        input: { ...baseline, effectState: 'COMPLETED' },
        expected: 'SUCCEEDED',
      },
      {
        name: 'effect failed',
        input: { ...baseline, effectState: 'FAILED' },
        expected: 'FAILED',
      },
      {
        name: 'effect escalation timestamp',
        input: { ...baseline, effectState: 'COMPLETION_UNKNOWN', reconcileEscalatedAt: 'now' },
        expected: 'ESCALATED',
      },
      {
        name: 'effect escalation disposition',
        input: {
          ...baseline,
          effectState: 'COMPLETION_UNKNOWN',
          reconcileDisposition: 'ESCALATED',
        },
        expected: 'ESCALATED',
      },
    ];

    for (const entry of cases) {
      const actual = projectCanonicalActionState(entry.input);
      assert.equal(actual, entry.expected, entry.name);
      assert.ok(ACTION_STATES_V1.includes(actual), `${entry.name}: ${actual}`);
    }
  });

  it('rejects Class A with 503 before creating any run when operations are not ready', async () => {
    const gateway = new InMemoryGateway();
    gateway.operationsReady = false;
    await withGateway(gateway, async (baseUrl) => {
      const response = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'operations-not-ready',
      });
      assert.equal(response.status, 503);
      assert.equal(((await response.json()) as any).error.code, 'OPERATIONS_NOT_READY');
      assert.deepEqual(await gateway.repository.listRuns('tenant-a'), []);
    });
  });

  it('rejects Class A with 503 when the evidence repository is unavailable', async () => {
    const gateway = new InMemoryGateway();
    gateway.evidenceReady = false;
    await withGateway(gateway, async (baseUrl) => {
      const response = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'evidence-not-ready',
      });
      const payload = (await response.json()) as {
        error: {
          code: string;
          details?: { evidenceRepository?: { ready: boolean } };
        };
      };
      assert.equal(response.status, 503);
      assert.equal(payload.error.code, 'OPERATIONS_NOT_READY');
      assert.deepEqual(payload.error.details.evidenceRepository, { ready: false });
      assert.deepEqual(await gateway.repository.listRuns('tenant-a'), []);
    });
  });

  it('admits Class A when operations and the evidence repository are ready', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const response = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'evidence-ready',
      });
      assert.equal(response.status, 202);
    });
  });
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

  it('authorizes reconciliation before any action or effect lookup', async () => {
    const gateway = new InMemoryGateway();
    let getRunCalls = 0;
    let requestReconcileCalls = 0;
    const getRun = gateway.getRun.bind(gateway);
    gateway.getRun = async (...args) => {
      getRunCalls += 1;
      return getRun(...args);
    };
    gateway.requestReconcile = async () => {
      requestReconcileCalls += 1;
      return { scheduled: false, reason: 'NOT_FOUND' };
    };

    await withGateway(gateway, async (baseUrl) => {
      for (const principal of ['api-read', 'api-approver', 'user-operator']) {
        const response = await postJson(
          baseUrl,
          '/v1/actions/not-visible/reconcile',
          {},
          'tenant-a',
          principal,
        );
        assert.equal(response.status, 403, principal);
        assert.equal(((await response.json()) as any).error.code, 'ACTION_RECONCILE_FORBIDDEN');
      }
      assert.equal(getRunCalls, 0);
      assert.equal(requestReconcileCalls, 0);
    });
  });

  it('returns 202 for both a new expedite and its idempotent replay using only owner calls', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-reconcile-idempotent',
      });
      const action = ((await proposed.json()) as any).action;
      const reconcileAfter = '2026-07-29T10:00:00.000Z';
      const results = [
        {
          scheduled: true,
          effectId: action.effectId,
          state: 'COMPLETION_UNKNOWN',
          reconcileAfter,
          alreadyScheduled: false,
        },
        {
          scheduled: true,
          effectId: action.effectId,
          state: 'COMPLETION_UNKNOWN',
          reconcileAfter,
          alreadyScheduled: true,
        },
      ] as const;
      const calls: Array<{ effectId: string; tenantId: string; actor: string }> = [];
      gateway.requestReconcile = async (effectId, tenantId, actor) => {
        calls.push({ effectId, tenantId, actor });
        const result = results[calls.length - 1];
        assert.ok(result);
        return result;
      };
      gateway.listEffects = async () => {
        assert.fail('the API expedite path must not inspect effects or invoke an adapter query');
      };
      gateway.getEffect = async () => {
        assert.fail('the API expedite path must not read the effect directly');
      };

      for (const [index, expected] of results.entries()) {
        const response = await postJson(
          baseUrl,
          `/v1/actions/${action.runId}/reconcile`,
          {},
          'tenant-a',
          index === 0 ? 'api-reconcile' : 'user-admin',
        );
        assert.equal(response.status, 202);
        assert.deepEqual(await response.json(), expected);
      }
      assert.deepEqual(calls, [
        { effectId: action.effectId, tenantId: 'tenant-a', actor: 'reconcile-key' },
        { effectId: action.effectId, tenantId: 'tenant-a', actor: 'user-admin' },
      ]);
    });
  });

  it('maps owner reconciliation dispositions without calling an in-process adapter', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-reconcile-mappings',
      });
      const action = ((await proposed.json()) as any).action;
      const cases = [
        { reason: 'NOT_FOUND', status: 404, code: 'ACTION_NOT_FOUND' },
        { reason: 'NOT_UNKNOWN', status: 409, code: 'NO_RECONCILABLE_EFFECT' },
        { reason: 'ESCALATED', status: 409, code: 'RECONCILIATION_ESCALATED' },
        { reason: 'DEADLINE_EXPIRED', status: 410, code: 'RECONCILIATION_DEADLINE_EXPIRED' },
      ] as const;
      let resultIndex = 0;
      gateway.requestReconcile = async () => {
        const result = cases[resultIndex++];
        assert.ok(result);
        return { scheduled: false, reason: result.reason };
      };
      gateway.listEffects = async () => {
        assert.fail('the owner result is the only reconciliation state authority');
      };
      gateway.getEffect = async () => {
        assert.fail('the API must not query effects or adapters after loading the action binding');
      };

      for (const expected of cases) {
        const response = await postJson(
          baseUrl,
          `/v1/actions/${action.runId}/reconcile`,
          {},
          'tenant-a',
          'api-reconcile',
          `reconcile-case-${expected.reason.toLowerCase()}`,
        );
        assert.equal(response.status, expected.status, expected.reason);
        assert.equal(((await response.json()) as any).error.code, expected.code);
      }
    });
  });

  it('conceals a cross-tenant reconciliation target before requesting an expedite', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-reconcile-cross-tenant',
      });
      const action = ((await proposed.json()) as any).action;
      let requestReconcileCalls = 0;
      gateway.requestReconcile = async () => {
        requestReconcileCalls += 1;
        return { scheduled: false, reason: 'NOT_FOUND' };
      };

      const response = await postJson(
        baseUrl,
        `/v1/actions/${action.runId}/reconcile`,
        {},
        'tenant-b',
        'api-reconcile',
      );
      assert.equal(response.status, 404);
      assert.equal(((await response.json()) as any).error.code, 'ACTION_NOT_FOUND');
      assert.equal(requestReconcileCalls, 0);
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
      const simulated = await postJson(baseUrl, '/v1/actions/simulate', {
        ...baseAction,
        idempotencyKey: 'simulation-key-0001',
      });
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
      assert.equal(payload.action.state, 'ADMITTED');
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
      assert.deepEqual(
        {
          effect: actionMetadata.simulation.effect,
          decisionId: actionMetadata.simulation.decisionId,
          reason: actionMetadata.simulation.reason,
          policySnapshotId: actionMetadata.simulation.policySnapshotId,
        },
        {
          effect: simulation.effect,
          decisionId: simulation.decisionId,
          reason: simulation.reason,
          policySnapshotId: simulation.policySnapshotId,
        },
      );
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
      assert.equal(payload.action.state, 'FAILED');
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

  it('admits the registered Kubernetes rollback only behind exact approval', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        tool: 'kubernetes.deployment.rollback',
        destination: 'k8s://kind/commander/deployments/api',
        effectType: 'connector.kubernetes.deployment.rollback',
        args: { targetRevision: '7', reason: 'controlled rollback proof' },
        idempotencyKey: 'kubernetes-rollback-approval',
      });

      assert.equal(proposed.status, 202);
      const payload = (await proposed.json()) as any;
      assert.equal(payload.action.decision.effect, 'require_approval');
      assert.equal(payload.action.state, 'AWAITING_APPROVAL');
      const step = await gateway.repository.getStep(payload.action.stepId, 'tenant-a');
      assert.equal(step?.input.effectType, 'connector.kubernetes.deployment.rollback');
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
      assert.equal(payload.action.state, 'AWAITING_APPROVAL');

      const approved = await postJson(baseUrl, `/v1/actions/${payload.action.runId}/approve`, {
        actionDigest: payload.action.simulation.actionDigest,
        simulationId: payload.action.simulation.simulationId,
        policySnapshotId: payload.action.simulation.policySnapshotId,
      });
      assert.equal(approved.status, 200);
      assert.equal(((await approved.json()) as any).action.state, 'ADMITTED');

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
      const proposed = await postJson(baseUrl, '/v1/actions', actionInput);
      const action = ((await proposed.json()) as any).action;

      const rejected = await postJson(baseUrl, `/v1/actions/${action.runId}/approve`, {
        actionDigest: '0'.repeat(64),
        simulationId: action.simulation.simulationId,
        policySnapshotId: action.simulation.policySnapshotId,
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
      const unknownEffectRequest = {
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
      };
      assert.deepEqual(
        await gateway.repository.admitEffect(unknownEffectRequest),
        { admitted: false, reason: 'OPERATIONS_NOT_READY' },
        'the old fixture must not bypass Class A admission readiness',
      );
      seedFreshOperationsDrains(gateway.repository, 'tenant-a');
      assert.equal((await gateway.repository.admitEffect(unknownEffectRequest)).admitted, true);
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
      const terminalEffectRequest = {
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
      };
      seedFreshOperationsDrains(gateway.repository, 'tenant-a');
      assert.equal((await gateway.repository.admitEffect(terminalEffectRequest)).admitted, true);
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
      const terminalAction = ((await terminalGet.json()) as any).action;
      assert.equal(terminalAction.state, 'SUCCEEDED');
      assert.equal(terminalAction.forwardReceiptHash, canonicalValueHash({ status: 'ok' }));
      assert.equal('response' in terminalAction, false, 'raw effect response must stay private');
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
      assert.equal(((await rejected.json()) as any).action.state, 'FAILED');
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
      assert.equal(replay.status, 202);
      const firstPayload = (await first.json()) as any;
      const replayPayload = (await replay.json()) as any;
      assert.deepEqual(replayPayload, firstPayload);
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
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = createEvidenceSigner({
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId: 'cell-test-1',
    });
    await withEvidenceJwks(signer.jwks, () =>
      withGateway(gateway, async (baseUrl) => {
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
        const effectRequest = {
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
        };
        assert.deepEqual(
          await gateway.repository.admitEffect(effectRequest),
          { admitted: false, reason: 'OPERATIONS_NOT_READY' },
          'the old fixture must not bypass Class A admission readiness',
        );
        seedFreshOperationsDrains(gateway.repository, 'tenant-a');
        const admission = await gateway.repository.admitEffect(effectRequest);
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
        const body = buildRunEvidenceBundle({
          tenantId: 'tenant-a',
          runId: run!.id,
          actionDigest: metadata.actionDigest,
          intentHash: run!.intentHash,
          workGraphHash: run!.workGraphHash,
          workGraphVersion: run!.workGraphVersion,
          policySnapshotId: run!.policySnapshotId,
          kernelApiVersion: 'v1',
          effects: await gateway.repository.listEffectsForRun(run!.id, 'tenant-a'),
          exportedAt: '2026-07-17T06:00:02.000Z',
          bundleId: 'bundle-persisted-evidence',
        });
        const signature = await signer.sign(canonicalEvidenceBody(body));
        gateway.evidence.set(`tenant-a\u0000${run!.id}`, {
          tenantId: 'tenant-a',
          runId: run!.id,
          bundleId: body.bundleId,
          actionDigest: body.actionDigest,
          body,
          contentHash: body.contentHash,
          signature,
          createdAt: body.exportedAt,
          anchoredAt: '2026-07-17T06:00:04.000Z',
          retentionUntil: '2027-07-17T06:00:04.000Z',
        });
        const evidence = await fetch(`${baseUrl}/v1/actions/${payload.action.runId}/evidence`, {
          headers: { 'x-test-tenant': 'tenant-a' },
        });
        assert.equal(evidence.status, 200);
        const evidenceText = await evidence.text();
        const evidencePayload = JSON.parse(evidenceText) as any;
        assert.equal(evidencePayload.receipt.schemaVersion, 'l3-11.v0');
        assert.equal(evidencePayload.receipt.scope.runId, payload.action.runId);
        assert.equal(evidencePayload.receipt.signature.keyId, 'cell-test-1');
        assert.equal(evidencePayload.verification.ok, true);
        assert.equal(verifyEvidenceBundle(evidencePayload.receipt).ok, true);
        assert.equal(evidenceText.includes('SENSITIVE_TOOL_ARGUMENT'), false);
        assert.equal(evidenceText.includes('SENSITIVE_AUTH_TOKEN'), false);
        assert.equal(evidenceText.includes('SENSITIVE_EFFECT_RESPONSE'), false);
        assert.equal(evidenceText.includes('SENSITIVE_RESPONSE_TOKEN'), false);
        assert.equal(evidenceText.includes('Approve demo.ticket.create'), false);
        assert.equal(evidencePayload.receipt.effects[0].responseSummary.status, 'ok');

        gateway.evidence.set(`tenant-a\u0000${run!.id}`, {
          ...gateway.evidence.get(`tenant-a\u0000${run!.id}`)!,
          signature: { ...signature, value: 'forged-signature' },
        });
        const forged = await fetch(`${baseUrl}/v1/actions/${payload.action.runId}/evidence`, {
          headers: { 'x-test-tenant': 'tenant-a' },
        });
        assert.equal(forged.status, 503);
        assert.equal(
          ((await forged.json()) as { error: { code: string } }).error.code,
          'EVIDENCE_INVALID',
        );

        const reconcile = await postJson(
          baseUrl,
          `/v1/actions/${payload.action.runId}/reconcile`,
          {},
          'tenant-a',
          'api-admin',
        );
        assert.equal(reconcile.status, 409);
      }),
    );
  });

  it('does not reconstruct evidence from transient interaction events', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
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
      assert.equal(evidence.status, 503);
      const evidenceText = await evidence.text();
      const evidencePayload = JSON.parse(evidenceText) as any;
      assert.equal(evidenceText.includes('USER_CONTROLLED_REJECT_SECRET'), false);
      assert.equal(evidencePayload.error.code, 'EVIDENCE_NOT_READY');
    });
  });

  it('rejects persisted evidence whose body scope is not bound to the requested tenant', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-key-cross-scope-evidence',
      });
      const payload = (await proposed.json()) as { action: { runId: string } };
      const body = buildRunEvidenceBundle({
        tenantId: 'tenant-b',
        runId: payload.action.runId,
        actionDigest: 'a'.repeat(64),
        policySnapshotId: 'action-gateway-mvp-v1',
        effects: [],
        exportedAt: '2026-07-17T06:00:02.000Z',
        bundleId: 'bundle-cross-scope-evidence',
      });
      gateway.evidence.set(`tenant-a\u0000${payload.action.runId}`, {
        tenantId: 'tenant-a',
        runId: payload.action.runId,
        bundleId: body.bundleId,
        actionDigest: body.actionDigest,
        body,
        contentHash: body.contentHash,
        signature: {
          algorithm: 'Ed25519',
          keyId: 'cell-test-1',
          signedAt: '2026-07-17T06:00:03.000Z',
          value: 'persisted-signature',
        },
        createdAt: body.exportedAt,
        anchoredAt: '2026-07-17T06:00:04.000Z',
        retentionUntil: '2027-07-17T06:00:04.000Z',
      });

      const evidence = await fetch(`${baseUrl}/v1/actions/${payload.action.runId}/evidence`, {
        headers: { 'x-test-tenant': 'tenant-a' },
      });
      assert.equal(evidence.status, 503);
      assert.equal(
        ((await evidence.json()) as { error: { code: string } }).error.code,
        'EVIDENCE_INVALID',
      );
    });
  });

  it('returns EVIDENCE_INVALID for a malformed persisted evidence body', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-key-malformed-evidence',
      });
      const payload = (await proposed.json()) as { action: { runId: string } };
      const body = buildRunEvidenceBundle({
        tenantId: 'tenant-a',
        runId: payload.action.runId,
        actionDigest: 'b'.repeat(64),
        policySnapshotId: 'action-gateway-mvp-v1',
        effects: [],
        exportedAt: '2026-07-17T06:00:02.000Z',
        bundleId: 'bundle-malformed-evidence',
      });
      gateway.evidence.set(`tenant-a\u0000${payload.action.runId}`, {
        tenantId: 'tenant-a',
        runId: payload.action.runId,
        bundleId: body.bundleId,
        actionDigest: body.actionDigest,
        body: { ...body, effects: null } as unknown as GatewayEvidenceRecord['body'],
        contentHash: body.contentHash,
        signature: {
          algorithm: 'Ed25519',
          keyId: 'cell-test-1',
          signedAt: '2026-07-17T06:00:03.000Z',
          value: 'persisted-signature',
        },
        createdAt: body.exportedAt,
        anchoredAt: '2026-07-17T06:00:04.000Z',
        retentionUntil: '2027-07-17T06:00:04.000Z',
      });

      const evidence = await fetch(`${baseUrl}/v1/actions/${payload.action.runId}/evidence`, {
        headers: { 'x-test-tenant': 'tenant-a' },
      });
      assert.equal(evidence.status, 503);
      assert.equal(
        ((await evidence.json()) as { error: { code: string } }).error.code,
        'EVIDENCE_INVALID',
      );
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
