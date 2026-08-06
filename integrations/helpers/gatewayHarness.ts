import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import {
  buildRunEvidenceBundle,
  canonicalEvidenceBody,
  createEvidenceSigner,
  verifyEvidenceBundle,
  type EvidenceBundle,
  type VerifyEvidenceBundleResult,
} from '@commander/effect-broker';
import { createFetchActionGatewayExecutor, MCPServer } from '@commander/core';
import type { Tool } from '@commander/core/runtime';
import { type ActionStateV1 } from '@commander/contracts';
import {
  InMemoryKernelRepository,
  seedFreshOperationsDrains,
} from '@commander/kernel/testing/inMemoryRepository';
import type { KillSwitchScope } from '@commander/kernel';
import type {
  ActionReconcileRequestResult,
  GatewayEvidenceRecord,
  V1KernelGateway,
} from '../../apps/api/src/v1GatewayKernel.js';
import type {
  ActionDecision,
  ActionEnvelope,
  ActionSimulation,
} from '../../apps/api/src/actionGatewayEndpoints.js';
import { GatewayIdempotencyConflictError } from '../../apps/api/src/v1GatewayKernel.js';
import { createV1GatewayRouter } from '../../apps/api/src/v1GatewayEndpoints.js';

/**
 * Rendered action resource served by the gateway (mirror of the unexported
 * `renderAction` return shape in actionGatewayEndpoints.ts).
 */
export interface GatewayActionView {
  runId: string;
  stepId: string;
  effectId: string;
  state: ActionStateV1;
  decision: ActionDecision;
  simulation: ActionSimulation;
  actionDigest: string;
  policySnapshotId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Action-gateway metadata stored on the kernel run (mirror of the unexported
 * `ActionGatewayMetadata` interface in actionGatewayEndpoints.ts).
 */
export interface GatewayActionMetadataView {
  authority: 'commander.action-gateway/v1';
  stepId: string;
  effectId: string;
  interactionId?: string;
  actionDigest: string;
  policySnapshotId: string;
  decision: ActionDecision;
  simulation: ActionSimulation;
  envelope: ActionEnvelope;
}

/** Response payload of the `/v1/actions/:runId/evidence` endpoint. */
export interface GatewayEvidencePayload {
  receipt: EvidenceBundle;
  verification: VerifyEvidenceBundleResult;
}

/** Response payload of the propose endpoint (`POST /v1/actions`). */
export interface ProposeActionResponse {
  action: GatewayActionView;
  idempotentReplay: boolean;
}

export class InMemoryGateway implements V1KernelGateway {
  readonly repository = new InMemoryKernelRepository();
  private readonly submissions = new Map<string, string>();
  readonly evidence = new Map<string, GatewayEvidenceRecord>();
  killSwitchLookupError: Error | null = null;
  operationsReady = true;

  getOperationsReadiness(_tenantId: string, now = new Date()) {
    return Promise.resolve({
      ready: this.operationsReady,
      ...(this.operationsReady ? {} : { reason: 'RECONCILIATION_DRAIN_UNAVAILABLE' as const }),
      reconciliationWorkers: this.operationsReady ? 1 : 0,
      compensationWorkers: this.operationsReady ? 1 : 0,
      checkedAt: now.toISOString(),
    });
  }

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
  createInteraction(
    input: Parameters<InMemoryKernelRepository['createInteraction']>[0],
    actor: string,
  ) {
    return this.repository.createInteraction(input, actor);
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

export const baseAction = {
  source: 'test-agent',
  package: 'test-package',
  model: 'test-model',
  tool: 'ticket.create',
  destination: 'demo://tickets',
  effectType: 'demo.ticket.create',
  args: { title: 'Reset a demo password' },
  idempotencyKey: 'action-key-0001',
};

export async function withGateway(
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
    } else if (principal === 'api-reconcile') {
      req.apiKeyId = 'reconcile-key';
      req.apiScopes = ['actions:reconcile'];
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
  }
}

export async function withEvidenceJwks(jwks: unknown, action: () => Promise<void>): Promise<void> {
  const previous = process.env.COMMANDER_EVIDENCE_JWKS_JSON;
  process.env.COMMANDER_EVIDENCE_JWKS_JSON = JSON.stringify(jwks);
  try {
    await action();
  } finally {
    if (previous === undefined) delete process.env.COMMANDER_EVIDENCE_JWKS_JSON;
    else process.env.COMMANDER_EVIDENCE_JWKS_JSON = previous;
  }
}

export async function postJson(
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

export function approvalBinding(action: { simulation: ActionSimulation }) {
  return {
    actionDigest: action.simulation.actionDigest,
    simulationId: action.simulation.simulationId,
    policySnapshotId: action.simulation.policySnapshotId,
  };
}

export async function putKillSwitch(
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

/**
 * Shared post-propose lifecycle (port of the L3-11 evidence flow in
 * apps/api/test/actionGatewayEndpoints.test.ts): reject with wrong digest (409),
 * approve, then claim/admit/complete the effect + step — seeding the Class-A
 * operations drains before admission — and persist a signed, anchored evidence
 * receipt so the gateway can serve it with signature verification. Asserts the
 * receipt shape, DLP redaction, and that terminal reconcile is 409.
 * Returns the evidence payload for extra checks.
 */
export async function completeGovernedAction(
  gateway: InMemoryGateway,
  baseUrl: string,
  action: GatewayActionView,
) {
  const runId = action.runId;

  const digestRejected = await postJson(
    baseUrl,
    `/v1/actions/${runId}/approve`,
    approvalBinding({ simulation: { ...action.simulation, actionDigest: '0'.repeat(64) } }),
  );
  assert.equal(digestRejected.status, 409);
  assert.equal(
    ((await digestRejected.json()) as { error: { code: string } }).error.code,
    'ACTION_DIGEST_MISMATCH',
  );

  const approved = await postJson(baseUrl, `/v1/actions/${runId}/approve`, approvalBinding(action));
  assert.equal(approved.status, 200);

  const claimed = await gateway.repository.claimNextStep({
    workerId: 'integration-worker',
    workerGeneration: 1,
    tenantId: 'tenant-a',
    capabilities: ['tool'],
    leaseTtlMs: 30_000,
  });
  assert.ok(claimed?.lease);
  const run = await gateway.repository.getRun(runId, 'tenant-a');
  const metadata = run!.metadata.actionGateway as GatewayActionMetadataView;
  const envelope = metadata.envelope;
  const effectRequest = {
    id: metadata.effectId,
    runId: run!.id,
    stepId: claimed.id,
    tenantId: 'tenant-a',
    type: 'demo.ticket.create',
    idempotencyKey: envelope.idempotencyKey,
    policyDecisionId: 'action-gateway-allow-after-approval',
    policySnapshotId: metadata.policySnapshotId,
    actionDigest: metadata.actionDigest,
    request: metadata.envelope,
    lease: claimed.lease,
    actor: 'integration-worker',
  };
  assert.deepEqual(
    await gateway.repository.admitEffect(effectRequest),
    { admitted: false, reason: 'OPERATIONS_NOT_READY' },
    'admission must not bypass Class A drains readiness',
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
    'integration-worker',
  );
  await gateway.repository.completeStep({
    stepId: claimed.id,
    tenantId: 'tenant-a',
    lease: claimed.lease,
    expectedVersion: claimed.version,
    output: { status: 'ok' },
    actor: 'integration-worker',
  });

  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = createEvidenceSigner({
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyId: 'integration-signer-1',
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
    bundleId: 'bundle-integration-evidence',
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

  let evidencePayload: GatewayEvidencePayload;
  await withEvidenceJwks(signer.jwks, async () => {
    const evidence = await fetch(`${baseUrl}/v1/actions/${runId}/evidence`, {
      headers: { 'x-test-tenant': 'tenant-a' },
    });
    assert.equal(evidence.status, 200);
    const evidenceText = await evidence.text();
    evidencePayload = JSON.parse(evidenceText) as GatewayEvidencePayload;
    const receipt = evidencePayload.receipt;
    assert.equal(receipt.schemaVersion, 'l3-11.v0');
    assert.equal(receipt.scope.runId, runId);
    assert.equal(receipt.signature.keyId, 'integration-signer-1');
    assert.equal(evidencePayload.verification.ok, true);
    assert.equal(verifyEvidenceBundle(receipt).ok, true);
    assert.equal(evidenceText.includes('SENSITIVE_TOOL_ARGUMENT'), false);
    assert.equal(evidenceText.includes('SENSITIVE_AUTH_TOKEN'), false);
    assert.equal(evidenceText.includes('SENSITIVE_EFFECT_RESPONSE'), false);
    assert.equal(evidenceText.includes('SENSITIVE_RESPONSE_TOKEN'), false);
    assert.equal(evidenceText.includes('Approve demo.ticket.create'), false);
    assert.equal(receipt.effects[0].responseSummary.status, 'ok');

    gateway.evidence.set(`tenant-a\u0000${run!.id}`, {
      ...gateway.evidence.get(`tenant-a\u0000${run!.id}`)!,
      signature: { ...signature, value: 'forged-signature' },
    });
    const forged = await fetch(`${baseUrl}/v1/actions/${runId}/evidence`, {
      headers: { 'x-test-tenant': 'tenant-a' },
    });
    assert.equal(forged.status, 503);
    assert.equal(
      ((await forged.json()) as { error: { code: string } }).error.code,
      'EVIDENCE_INVALID',
    );
  });

  const reconcile = await postJson(
    baseUrl,
    `/v1/actions/${runId}/reconcile`,
    {},
    'tenant-a',
    'api-reconcile',
  );
  assert.equal(reconcile.status, 409);

  return evidencePayload;
}

/**
 * Port of the L3-11 lifecycle proposed via the gateway HTTP API directly.
 */
export async function proveGovernedFlow(gateway: InMemoryGateway, baseUrl: string) {
  const proposed = await postJson(baseUrl, '/v1/actions', {
    ...baseAction,
    destination: 'demo://tickets/approval',
    idempotencyKey: 'integration-key-governed',
    args: {
      title: 'SENSITIVE_TOOL_ARGUMENT',
      Authorization: 'Bearer SENSITIVE_AUTH_TOKEN',
    },
  });
  const payload = (await proposed.json()) as ProposeActionResponse;
  assert.equal(proposed.status, 202);
  assert.equal(payload.action.state, 'AWAITING_APPROVAL');
  return completeGovernedAction(gateway, baseUrl, payload.action);
}

/**
 * Drive the governed lifecycle *through the MCP server*: a client calls the
 * `ticket.create` tool with `requireApproval`, the server routes it to the
 * gateway executor (no local execute), and the human completes the flow.
 * `handleRequest` must be the registered server (already wired to the gateway).
 */
export async function proveMcpGovernedLifecycle(
  handleRequest: (
    request: Record<string, unknown>,
  ) => Promise<{ error?: unknown; result?: unknown }>,
  gateway: InMemoryGateway,
  baseUrl: string,
) {
  const response = await handleRequest({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'ticket.create',
      arguments: {
        title: 'SENSITIVE_TOOL_ARGUMENT',
        requireApproval: true,
      },
    },
  });
  assert.equal(response.error, undefined);
  const result = response.result as { content?: Array<{ text?: string }> } | undefined;
  const text = result?.content?.[0]?.text ?? '';
  const payload = JSON.parse(text) as ProposeActionResponse;
  assert.equal(payload.action.state, 'AWAITING_APPROVAL');
  assert.equal(payload.idempotentReplay, false);
  assert.ok(payload.action.runId);
  return completeGovernedAction(gateway, baseUrl, payload.action);
}

export function createGatewayRoutedMcpServer(baseUrl: string) {
  const localCalls: string[] = [];
  const ticketTool: Tool = {
    definition: {
      name: 'ticket.create',
      description: 'Create a demo support ticket',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    },
    isReadOnly: false,
    execute: async () => {
      localCalls.push('ticket.create.local');
      return 'local-create';
    },
  };
  const server = new MCPServer('commander-gateway-routing', '0.2.0');
  server.registerCommanderTools(new Map([['ticket.create', ticketTool]]), undefined, {
    actionGatewayExecutor: createFetchActionGatewayExecutor({ baseUrl }),
  });
  return {
    localCalls,
    handleRequest: (request: Record<string, unknown>) =>
      server.handleRequest(
        request as {
          jsonrpc: string;
          id: number;
          method: string;
          params?: Record<string, unknown>;
        },
      ),
  };
}
