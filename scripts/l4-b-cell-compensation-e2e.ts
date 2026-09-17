#!/usr/bin/env tsx
/**
 * L4-B cell compensation E2E — compose topology + adapter-ops consumer proof.
 *
 *   pnpm cell:compensation-e2e -- --mode mock
 *   pnpm cell:compensation-e2e -- --mode compose [--up]
 */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { KERNEL_COMPENSATION_TOPIC } from '@commander/kernel';
import { InMemoryKernelRepository } from '@commander/kernel/testing/inMemoryRepository';
// Root package.json does not declare @commander/action-adapters, so the bare
// specifier cannot resolve from scripts/; import the workspace source directly.
import {
  ActionAdapterRegistry,
  createGitHubPullRequestCreateAdapter,
} from '../packages/action-adapters/src/index.js';
import { CompensationDaemon } from '../packages/adapter-ops/src/compensationDaemon.js';
import { sealGovernedCompensationAuthorization } from '../packages/kernel/src/ops/compensationAuthority.js';
import {
  assertComposeCellHealth,
  CELL_COMPOSE_ENV,
  CELL_E2E_TENANT,
  tryComposeCellUp,
} from './l4-b-cell-compose.js';
import {
  loadControlledChangeProofArtifact,
  notReadyControlledChangeEvidence,
  validateControlledChangeEvidence,
  type ControlledChangeCellEvidence,
} from './l4-b-cell-smoke.js';

export { notReadyControlledChangeEvidence } from './l4-b-cell-smoke.js';

export type CompensationE2EMode = 'mock' | 'compose';

export interface CompensationE2EResult {
  mode: CompensationE2EMode;
  verdict: 'ENFORCED' | 'ENFORCED-script-only' | 'BLOCKED';
  passed: boolean;
  steps: Record<string, boolean | string>;
  controlledChange: ControlledChangeCellEvidence;
  dockerError?: string;
  elapsedMs: number;
}

export { assertComposeCellHealth, CELL_COMPOSE_ENV, CELL_E2E_TENANT, tryComposeCellUp };

async function httpJson(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      // Prefer x-api-key only — Authorization: Bearer is interpreted as JWT.
      'x-api-key': CELL_COMPOSE_ENV.COMMANDER_API_KEY,
      'x-tenant-id': CELL_E2E_TENANT,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

export interface AdapterOpsCompensationMockEvidence {
  consumed: number;
  succeeded: number;
  escalated: number;
  replayed: number;
  executions: number;
  genericClaimTopics: string[];
  remainingCompensationOutbox: number;
  compensationEffectId: string;
  compensationEffectState: string | null;
  compensationEffectResponse: Record<string, unknown> | null;
  compensationRunState: string | null;
}

/** Single source of truth for the mock-mode pass criterion (script + test). */
export function adapterOpsCompensationMockPassed(
  evidence: AdapterOpsCompensationMockEvidence,
): boolean {
  return (
    evidence.consumed === 1 &&
    evidence.succeeded === 1 &&
    evidence.escalated === 0 &&
    evidence.executions === 1 &&
    evidence.compensationEffectState === 'COMPLETED' &&
    evidence.remainingCompensationOutbox === 0
  );
}

export async function runAdapterOpsCompensationMock(): Promise<AdapterOpsCompensationMockEvidence> {
  const adapter = createGitHubPullRequestCreateAdapter({
    credentials: {
      async getGitHubToken() {
        return 'gh-mock';
      },
      async getServiceNowCredentials() {
        throw new Error('not used');
      },
    },
  });
  const registry = new ActionAdapterRegistry([adapter]);
  const kernel = new InMemoryKernelRepository();
  const tenantId = 'adapter-ops-mock-tenant';
  const workerId = 'adapter-ops-mock';
  const workerGeneration = 1;
  // In-memory compensation claims are fail-closed on the durable adapter-ops
  // identity: exactly one `effect.compensate` capability on `db:commander_adapter_ops`.
  const claimSecret = kernel.seedTestWorker(workerId, [tenantId], workerGeneration, {
    capabilities: ['effect.compensate'],
    identitySubject: 'db:commander_adapter_ops',
    registeredAt: new Date(Date.now() - 1_000),
    lastHeartbeatAt: new Date(),
  });

  // Sealed by the public fixture builder so the consumer's hash/digest checks run.
  const authorization = sealGovernedCompensationAuthorization({
    schema: 'commander.compensation/v1',
    authorizationId: 'authorization-adapter-ops-mock',
    requestId: 'request-adapter-ops-mock',
    tenantId,
    originalRunId: 'run-cmp-forward',
    originalEffectId: 'effect-forward',
    originalRunStateAtRequest: 'COMPENSATING',
    compensationRunId: 'run-cmp',
    compensationStepId: 'step-cmp',
    compensationEffectId: 'effect-cmp',
    compensationEffectType: adapter.descriptor.compensationEffectType,
    compensationRequest: {
      originalEffectId: 'effect-forward',
      destination: 'github://octo/repo/pulls',
      forwardResponse: { prNumber: 1 },
      compensationPatch: { state: 'closed' },
    },
    idempotencyKey: 'cmp:effect-forward:1.0.0',
    forwardReceipt: { prNumber: 1 },
    adapterVersion: adapter.descriptor.adapterVersion,
    policyDecisionId: 'decision-adapter-ops-mock',
    policySnapshotId: 'policy-adapter-ops-mock',
    decisionEffect: 'allow',
    authorizationExpiresAt: '2099-07-29T11:00:00.000Z',
    approvalBinding: null,
  });

  // The claim guard requires the compensation run/step to be PENDING and to
  // persist the exact authorization carried by the outbox payload.
  await kernel.createRun(
    {
      id: authorization.compensationRunId,
      tenantId,
      intentHash: 'intent-adapter-ops-mock',
      workGraphHash: 'graph-adapter-ops-mock',
      workGraphVersion: 'action-gateway-compensation/v2',
      policySnapshotId: authorization.policySnapshotId,
      metadata: { compensation: { authorization, disposition: 'PENDING' } },
      steps: [{ id: authorization.compensationStepId, kind: 'tool', input: { authorization } }],
    },
    workerId,
  );
  await kernel.createRun(
    {
      id: authorization.originalRunId,
      tenantId,
      intentHash: 'intent-adapter-ops-forward',
      workGraphHash: 'graph-adapter-ops-forward',
      workGraphVersion: 'v1',
      policySnapshotId: authorization.policySnapshotId,
      steps: [{ id: 'step-forward', kind: 'tool' }],
    },
    workerId,
  );

  kernel.seedOutboxMessage({
    topic: KERNEL_COMPENSATION_TOPIC,
    tenantId,
    key: `${tenantId}/${authorization.compensationRunId}/${authorization.originalEffectId}`,
    payload: authorization as unknown as Record<string, unknown>,
  });
  kernel.seedOutboxMessage({
    topic: 'commander.run.created',
    tenantId,
    key: `${tenantId}/generic`,
    payload: { tenantId, runId: 'run-generic' },
  });

  const genericClaims = await kernel.claimOutbox(10);
  const genericClaimTopics = genericClaims.map((message) => message.topic);
  assert.ok(
    genericClaimTopics.includes('commander.run.created') &&
      !genericClaimTopics.includes(KERNEL_COMPENSATION_TOPIC),
    'kernel-ops publisher must not steal compensation topic',
  );

  let executions = 0;
  let admittedLease: {
    workerId: string;
    workerGeneration?: number;
    token: string;
    fencingEpoch: number;
  } | null = null;

  const daemon = new CompensationDaemon({
    repository: kernel,
    registry,
    broker: {
      admit: async (input: {
        effectId: string;
        type: string;
        request: Record<string, unknown>;
        idempotencyKey: string;
        lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
      }) => {
        admittedLease = input.lease;
        const admission = await kernel.admitEffect({
          id: input.effectId,
          runId: authorization.compensationRunId,
          stepId: authorization.compensationStepId,
          tenantId,
          type: input.type,
          idempotencyKey: input.idempotencyKey,
          policyDecisionId: authorization.policyDecisionId,
          policySnapshotId: authorization.policySnapshotId,
          actionDigest: authorization.actionDigest,
          request: input.request,
          lease: {
            ...input.lease,
            workerGeneration: input.lease.workerGeneration ?? workerGeneration,
          },
          compensationBinding: {
            authorizationId: authorization.authorizationId,
            requestId: authorization.requestId,
            claimToken: input.lease.token,
          },
          actor: workerId,
        });
        return admission.admitted
          ? { admitted: true, effectId: admission.effect.id, replayed: admission.replayed }
          : {
              admitted: false,
              effectId: input.effectId,
              replayed: false,
              reason: admission.reason,
            };
      },
      executeAdmitted: async (input: { effectId: string }) => {
        if (!admittedLease) {
          throw new Error('compensation effect was not admitted before execution');
        }
        executions += 1;
        const completed = await kernel.completeEffect(
          input.effectId,
          tenantId,
          {
            workerId: admittedLease.workerId,
            workerGeneration: admittedLease.workerGeneration ?? workerGeneration,
            token: admittedLease.token,
            fencingEpoch: admittedLease.fencingEpoch,
          },
          { state: 'closed' },
          workerId,
        );
        if (!completed) throw new Error('compensation effect completion was rejected');
        return { effectId: completed.id, replayed: false, response: { state: 'closed' } };
      },
    },
    tokenProvider: async () => 'cmp-token',
    pollIntervalMs: 60_000,
    workerId,
    workerGeneration,
    claimSecret,
  });

  const tick = await daemon.tick();
  const effect = await kernel.getEffect(authorization.compensationEffectId, tenantId);
  const run = await kernel.getRun(authorization.compensationRunId, tenantId);
  const remaining = await kernel.claimOutboxByTopic(KERNEL_COMPENSATION_TOPIC, 10);
  return {
    consumed: tick.consumed,
    succeeded: tick.succeeded,
    escalated: tick.escalated,
    replayed: tick.replayed,
    executions,
    genericClaimTopics,
    remainingCompensationOutbox: remaining.length,
    compensationEffectId: authorization.compensationEffectId,
    compensationEffectState: effect?.state ?? null,
    compensationEffectResponse: effect?.response ?? null,
    compensationRunState: run?.state ?? null,
  };
}

async function pollActionTerminal(
  baseUrl: string,
  runId: string,
  timeoutMs = 90_000,
): Promise<string> {
  const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'COMPENSATED']);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { json } = await httpJson(baseUrl, 'GET', `/v1/actions/${runId}`);
    const action = json?.action as { state?: string } | undefined;
    if (action?.state && terminal.has(action.state)) return action.state;
    await sleep(500);
  }
  return 'TIMEOUT';
}

export async function runComposeDemoCompensationFlow(
  baseUrl = 'http://localhost:4000',
): Promise<Record<string, boolean>> {
  const idem = `cell-comp-${Date.now()}`;
  const proposed = await httpJson(
    baseUrl,
    'POST',
    '/v1/actions',
    {
      source: 'cell-e2e',
      package: 'cell-e2e',
      model: 'mock',
      tool: 'ticket.create',
      destination: 'demo://tickets/approval',
      effectType: 'demo.ticket.create',
      args: { title: 'Cell compensation E2E' },
      idempotencyKey: idem,
    },
    idem,
  );
  if (proposed.status !== 202)
    return { proposed: false, approved: false, forwardDone: false, compensated: false };
  const action = (proposed.json?.action ?? {}) as {
    runId: string;
    simulation: { actionDigest: string; simulationId: string; policySnapshotId: string };
  };
  const approved = await httpJson(
    baseUrl,
    'POST',
    `/v1/actions/${action.runId}/approve`,
    {
      actionDigest: action.simulation.actionDigest,
      simulationId: action.simulation.simulationId,
      policySnapshotId: action.simulation.policySnapshotId,
    },
    `approve-${idem}`,
  );
  if (approved.status !== 200)
    return { proposed: true, approved: false, forwardDone: false, compensated: false };
  const forwardState = await pollActionTerminal(baseUrl, action.runId);
  if (forwardState !== 'SUCCEEDED') {
    return { proposed: true, approved: true, forwardDone: false, compensated: false };
  }
  const compensationIdempotencyKey = `cmp-${idem}`;
  const compensate = await httpJson(
    baseUrl,
    'POST',
    '/v1/actions',
    {
      source: 'cell-e2e',
      package: 'cell-e2e',
      model: 'mock',
      tool: 'ticket.compensate',
      destination: 'demo://tickets',
      effectType: 'compensate.demo.ticket.create',
      args: { targetIdempotencyKey: idem },
      idempotencyKey: compensationIdempotencyKey,
    },
    compensationIdempotencyKey,
  );
  if (compensate.status !== 202) {
    return { proposed: true, approved: true, forwardDone: true, compensated: false };
  }
  const compAction = (compensate.json?.action ?? {}) as { runId: string };
  const compState = await pollActionTerminal(baseUrl, compAction.runId);
  return {
    proposed: true,
    approved: true,
    forwardDone: true,
    compensated: compState === 'SUCCEEDED',
  };
}

export async function runCellCompensationE2E(options: {
  mode?: CompensationE2EMode;
  baseUrl?: string;
  composeUp?: boolean;
  controlledChange?: ControlledChangeCellEvidence;
}): Promise<CompensationE2EResult> {
  const started = Date.now();
  const mode = options.mode ?? 'mock';
  const steps: Record<string, boolean | string> = {};
  const controlledChange = validateControlledChangeEvidence(
    options.controlledChange ?? notReadyControlledChangeEvidence(),
  );

  if (mode === 'mock') {
    try {
      steps.S_mock_adapter_ops = adapterOpsCompensationMockPassed(
        await runAdapterOpsCompensationMock(),
      );
    } catch (err) {
      steps.S_mock_adapter_ops = false;
      steps.mockError = err instanceof Error ? err.message : String(err);
    }
    const passed = steps.S_mock_adapter_ops === true;
    return {
      mode,
      verdict: passed ? 'ENFORCED-script-only' : 'BLOCKED',
      passed,
      steps,
      controlledChange,
      elapsedMs: Date.now() - started,
    };
  }

  let dockerError: string | undefined;
  if (options.composeUp) {
    const up = tryComposeCellUp();
    steps.composeUp = up.ok;
    if (!up.ok) {
      return {
        mode,
        verdict: 'BLOCKED',
        passed: false,
        steps,
        controlledChange,
        dockerError: up.error,
        elapsedMs: Date.now() - started,
      };
    }
  }

  const health = await assertComposeCellHealth(options.baseUrl);
  Object.assign(steps, health);

  if (Object.values(health).some((v) => !v)) {
    return {
      mode,
      verdict: 'BLOCKED',
      passed: false,
      steps,
      controlledChange,
      dockerError,
      elapsedMs: Date.now() - started,
    };
  }

  const flow = await runComposeDemoCompensationFlow(options.baseUrl);
  Object.assign(steps, flow);

  // Host InMemory CompensationDaemon is informational only and does not raise compose evidence.
  // (specialized audit: S_adapter_ops_mock was greenwashing "adapter-ops consumed outbox").
  const mockOk = await runAdapterOpsCompensationMock()
    .then(adapterOpsCompensationMockPassed)
    .catch(() => false);
  steps.S_adapter_ops_mock_host = mockOk;

  const passed =
    flow.proposed === true &&
    flow.approved === true &&
    flow.forwardDone === true &&
    flow.compensated === true &&
    (options.composeUp ? steps.composeUp === true : true);

  return {
    mode,
    verdict: passed ? 'ENFORCED' : 'BLOCKED',
    passed,
    steps,
    controlledChange,
    dockerError,
    elapsedMs: Date.now() - started,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modeIdx = args.indexOf('--mode');
  const baseIdx = args.indexOf('--base-url');
  const mode = (modeIdx >= 0 ? args[modeIdx + 1] : 'compose') as CompensationE2EMode;
  const baseUrl = baseIdx >= 0 ? args[baseIdx + 1] : 'http://localhost:4000';
  const composeUp = args.includes('--up');
  const proofIdx = args.indexOf('--controlled-change-proof');
  const controlledChange = await loadControlledChangeProofArtifact(
    (proofIdx >= 0 ? args[proofIdx + 1] : undefined) ??
      process.env.COMMANDER_KUBERNETES_PROOF_ARTIFACT,
  );

  const result = await runCellCompensationE2E({ mode, baseUrl, composeUp, controlledChange });
  const outDir = join(process.cwd(), 'artifacts');
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `l4-b-cell-compensation-e2e-${Date.now()}.json`);
  await writeFile(outPath, JSON.stringify(result, null, 2));
  console.log(`Cell compensation E2E steps: ${JSON.stringify(result.steps)}`);
  console.log(
    `Cell compensation E2E ${result.verdict} ${result.passed ? 'PASS' : 'FAIL'} → ${outPath}`,
  );
  if (!result.passed) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
