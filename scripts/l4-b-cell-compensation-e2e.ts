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
import {
  ActionAdapterRegistry,
  createGitHubPullRequestCreateAdapter,
} from '@commander/action-adapters';
import type { CompensationOutboxPort } from '@commander/kernel';
import { CompensationDaemon } from '../packages/adapter-ops/src/compensationDaemon.js';
import { sealGovernedCompensationAuthorization } from '../packages/kernel/src/ops/compensationAuthority.js';
import { createChaosMockFetch } from './l4-b-adapter-chaos.js';
import {
  assertComposeCellHealth,
  CELL_COMPOSE_ENV,
  CELL_E2E_TENANT,
  createCellComposeEnv,
  tryComposeCellDown,
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

export interface CompensationRunEvent {
  type: string;
}

export interface CompensationFlowResult {
  proposed: boolean;
  approved: boolean;
  forwardDone: boolean;
  compensated: boolean;
  compensationRunEvents?: CompensationRunEvent[];
  escalationReason?: string;
  [key: string]: boolean | string | CompensationRunEvent[] | undefined;
}

export interface CompensationE2EResult {
  mode: CompensationE2EMode;
  verdict: 'ENFORCED' | 'ENFORCED-script-only' | 'BLOCKED';
  passed: boolean;
  steps: Record<string, boolean | string>;
  controlledChange: ControlledChangeCellEvidence;
  compensationRunEvents?: CompensationRunEvent[];
  escalationReason?: string;
  dockerError?: string;
  teardownError?: string;
  elapsedMs: number;
}

export {
  assertComposeCellHealth,
  CELL_COMPOSE_ENV,
  CELL_E2E_TENANT,
  createCellComposeEnv,
  tryComposeCellDown,
  tryComposeCellUp,
};

async function httpJson(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      // Prefer x-api-key only — Authorization: Bearer is interpreted as JWT.
      'x-api-key': CELL_COMPOSE_ENV.COMMANDER_API_KEY,
      'x-tenant-id': CELL_E2E_TENANT,
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

function extractEscalationReason(json: Record<string, unknown> | null): string | undefined {
  const error = json?.error;
  const errorRecord =
    typeof error === 'object' && error !== null && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : undefined;
  for (const candidate of [errorRecord?.reason, errorRecord?.code, json?.reason, json?.code]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

export async function runAdapterOpsCompensationMock(): Promise<boolean> {
  const counters = { createCount: 0, writeCount: 0 };
  const adapter = createGitHubPullRequestCreateAdapter({
    credentials: {
      async getGitHubToken() {
        return 'gh-mock';
      },
      async getServiceNowCredentials() {
        throw new Error('not used');
      },
    },
    fetch: createChaosMockFetch(counters),
  });
  const registry = new ActionAdapterRegistry([adapter]);
  const tenantId = 'adapter-ops-mock-tenant';
  const workerId = 'adapter-ops-mock';
  const workerGeneration = 1;
  const claimSecret = 'adapter-ops-mock-claim-secret';
  const authorization = sealGovernedCompensationAuthorization({
    schema: 'commander.compensation/v1',
    authorizationId: 'authorization-cmp',
    requestId: 'request-cmp',
    tenantId,
    originalRunId: 'run-forward',
    originalEffectId: 'effect-forward',
    originalRunStateAtRequest: 'COMPENSATING',
    compensationRunId: 'run-cmp',
    compensationStepId: 'step-cmp',
    compensationEffectId: 'effect-cmp',
    compensationEffectType: 'compensate.github.pull-request.create',
    compensationRequest: {
      originalEffectId: 'effect-forward',
      forwardResponse: { prNumber: 1 },
      destination: 'github://octo/repo/pulls',
      compensationPatch: {},
    },
    idempotencyKey: 'cmp:effect-forward:1.0.0',
    forwardReceipt: { prNumber: 1 },
    adapterVersion: adapter.descriptor.adapterVersion,
    policyDecisionId: 'policy-compensation',
    policySnapshotId: 'policy-cell-v1',
    decisionEffect: 'allow',
    authorizationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    approvalBinding: null,
  });
  let claimed = false;
  let finalized = false;
  const repository: CompensationOutboxPort = {
    async claimCompensationWork(input) {
      assert.equal(input.workerId, workerId);
      assert.equal(input.workerGeneration, workerGeneration);
      assert.equal(input.claimSecret, claimSecret);
      if (claimed) return [];
      claimed = true;
      return [
        {
          messageId: 'outbox-cmp',
          tenantId,
          claimToken: 'outbox-claim-cmp',
          authorization,
          lease: {
            workerId,
            workerGeneration,
            token: 'outbox-claim-cmp',
            fencingEpoch: 1,
          },
        },
      ];
    },
    async completeCompensationWork(input) {
      assert.equal(input.workerId, workerId);
      assert.equal(input.workerGeneration, workerGeneration);
      assert.equal(input.claimSecret, claimSecret);
      assert.equal(input.compensationEffectId, authorization.compensationEffectId);
      finalized = true;
      return { applied: true, disposition: 'COMPLETED' };
    },
    async handoffCompensationUnknown() {
      assert.fail('mock compensation must not hand off an unknown result');
    },
    async escalateCompensationWork(input) {
      assert.fail(`valid mock compensation must not escalate: ${input.reason}`);
    },
    async parkCompensationUnknown() {
      assert.fail('legacy sealed work must not use the durable unknown path');
    },
    async finalizeCompensation() {
      assert.fail('legacy sealed work must not use the durable finalization path');
    },
  };

  let compensated = false;
  const daemon = new CompensationDaemon({
    repository,
    registry,
    broker: {
      admit: async (input) => ({ admitted: true, effectId: input.effectId, replayed: false }),
      executeAdmitted: async (input) => {
        compensated = true;
        return { effectId: input.effectId, replayed: false, response: { state: 'closed' } };
      },
    },
    tokenProvider: async () => 'cmp-token',
    pollIntervalMs: 60_000,
    workerId,
    workerGeneration,
    claimSecret,
  });

  const tick = await daemon.tick();
  assert.equal(tick.consumed, 1);
  assert.equal(tick.succeeded, 1);
  return compensated && finalized && tick.succeeded === 1;
}

async function pollAction(
  baseUrl: string,
  runId: string,
  expectedStates: ReadonlySet<string>,
  timeoutMs = 90_000,
): Promise<{ state: string; action?: Record<string, unknown> }> {
  const failed = new Set(['FAILED', 'CANCELLED']);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { json } = await httpJson(baseUrl, 'GET', `/v1/actions/${runId}`);
    const action = json?.action as Record<string, unknown> | undefined;
    const state = typeof action?.state === 'string' ? action.state : undefined;
    if (state && (expectedStates.has(state) || failed.has(state))) return { state, action };
    await sleep(500);
  }
  return { state: 'TIMEOUT' };
}

async function pollRunState(
  baseUrl: string,
  runId: string,
  expectedState: string,
  timeoutMs = 90_000,
): Promise<string> {
  const failed = new Set(['FAILED', 'CANCELLED']);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { json } = await httpJson(baseUrl, 'GET', `/v1/runs/${runId}/status`);
    const state = typeof json?.state === 'string' ? json.state : undefined;
    if (state === expectedState || (state && failed.has(state))) return state;
    await sleep(500);
  }
  return 'TIMEOUT';
}

async function getRunEvents(baseUrl: string, runId: string): Promise<CompensationRunEvent[]> {
  const { status, json } = await httpJson(baseUrl, 'GET', `/v1/runs/${runId}/events`);
  if (status !== 200 || !Array.isArray(json?.events)) return [];
  return json.events.flatMap((event) => {
    if (typeof event !== 'object' || event === null || Array.isArray(event)) return [];
    const type = (event as Record<string, unknown>).type;
    return typeof type === 'string' && type.length > 0 ? [{ type }] : [];
  });
}

export async function runComposeDemoCompensationFlow(
  baseUrl = 'http://localhost:4000',
): Promise<CompensationFlowResult> {
  const idem = `cell-comp-${Date.now()}`;
  const proposed = await httpJson(baseUrl, 'POST', '/v1/actions', {
    source: 'cell-e2e',
    package: 'cell-e2e',
    model: 'mock',
    tool: 'ticket.create',
    destination: 'demo://tickets/approval',
    effectType: 'demo.ticket.create',
    args: { title: 'Cell compensation E2E' },
    idempotencyKey: idem,
  });
  if (proposed.status !== 202) {
    const error = proposed.json?.error as { code?: unknown } | undefined;
    return {
      proposed: false,
      approved: false,
      forwardDone: false,
      compensated: false,
      proposalHttpStatus: String(proposed.status),
      escalationReason: extractEscalationReason(proposed.json) ?? 'ACTION_PROPOSAL_REJECTED',
      ...(typeof error?.code === 'string' ? { proposalErrorCode: error.code } : {}),
    };
  }
  const action = (proposed.json?.action ?? {}) as {
    runId: string;
    effectId: string;
    simulation: { actionDigest: string; simulationId: string; policySnapshotId: string };
  };
  const approved = await httpJson(baseUrl, 'POST', `/v1/actions/${action.runId}/approve`, {
    actionDigest: action.simulation.actionDigest,
    simulationId: action.simulation.simulationId,
    policySnapshotId: action.simulation.policySnapshotId,
  });
  if (approved.status !== 200) {
    const error = approved.json?.error as { code?: unknown } | undefined;
    return {
      proposed: true,
      approved: false,
      forwardDone: false,
      compensated: false,
      approvalHttpStatus: String(approved.status),
      escalationReason: extractEscalationReason(approved.json) ?? 'ACTION_APPROVAL_REJECTED',
      ...(typeof error?.code === 'string' ? { approvalErrorCode: error.code } : {}),
    };
  }
  const forward = await pollAction(baseUrl, action.runId, new Set(['SUCCEEDED']));
  if (forward.state !== 'SUCCEEDED') {
    return {
      proposed: true,
      approved: true,
      forwardDone: false,
      compensated: false,
      forwardState: forward.state,
      escalationReason: `FORWARD_RUN_${forward.state}`,
    };
  }
  const forwardReceiptHash = forward.action?.forwardReceiptHash;
  if (typeof forwardReceiptHash !== 'string') {
    return {
      proposed: true,
      approved: true,
      forwardDone: true,
      compensationRequested: false,
      compensated: false,
      compensationErrorCode: 'FORWARD_RECEIPT_HASH_MISSING',
      escalationReason: 'FORWARD_RECEIPT_HASH_MISSING',
    };
  }
  const rawForwardResponseAbsent =
    !('response' in (forward.action ?? {})) && !('forwardResponse' in (forward.action ?? {}));
  if (!rawForwardResponseAbsent) {
    return {
      proposed: true,
      approved: true,
      forwardDone: true,
      forwardReceiptHash,
      rawForwardResponseAbsent,
      compensationRequested: false,
      compensated: false,
      compensationErrorCode: 'RAW_FORWARD_RESPONSE_EXPOSED',
      escalationReason: 'RAW_FORWARD_RESPONSE_EXPOSED',
    };
  }
  const compensate = await httpJson(baseUrl, 'POST', `/v1/actions/${action.runId}/compensations`, {
    originalEffectId: action.effectId,
    adapterVersion: 'demo-ticket/v1',
    compensationEffectType: 'compensate.demo.ticket.create',
    compensationPatch: { targetIdempotencyKey: idem },
    forwardReceiptHash,
  });
  if (compensate.status !== 202) {
    const error = compensate.json?.error as { code?: unknown } | undefined;
    return {
      proposed: true,
      approved: true,
      forwardDone: true,
      compensationRequested: false,
      compensated: false,
      compensationHttpStatus: String(compensate.status),
      escalationReason: extractEscalationReason(compensate.json) ?? 'COMPENSATION_REQUEST_REJECTED',
      ...(typeof error?.code === 'string' ? { compensationErrorCode: error.code } : {}),
    };
  }
  const authorization = compensate.json?.authorization as
    { id?: unknown; actionDigest?: unknown; policySnapshotId?: unknown } | undefined;
  let compensationRequest = compensate.json?.request as { compensationRunId?: unknown } | undefined;
  let compensationApproved = compensate.json?.state !== 'AWAITING_APPROVAL';
  if (compensate.json?.state === 'AWAITING_APPROVAL') {
    if (
      typeof authorization?.id !== 'string' ||
      typeof authorization.actionDigest !== 'string' ||
      typeof authorization.policySnapshotId !== 'string'
    ) {
      return {
        proposed: true,
        approved: true,
        forwardDone: true,
        compensationRequested: true,
        compensationApproved: false,
        compensated: false,
        compensationErrorCode: 'COMPENSATION_AUTHORIZATION_INVALID',
        escalationReason: 'COMPENSATION_AUTHORIZATION_INVALID',
      };
    }
    const compensationApproval = await httpJson(
      baseUrl,
      'POST',
      `/v1/actions/${action.runId}/compensations/${encodeURIComponent(authorization.id)}/approve`,
      {
        actionDigest: authorization.actionDigest,
        policySnapshotId: authorization.policySnapshotId,
      },
    );
    compensationApproved = compensationApproval.status === 202;
    if (!compensationApproved) {
      const error = compensationApproval.json?.error as { code?: unknown } | undefined;
      return {
        proposed: true,
        approved: true,
        forwardDone: true,
        compensationRequested: true,
        compensationApproved: false,
        compensated: false,
        compensationApprovalHttpStatus: String(compensationApproval.status),
        escalationReason:
          extractEscalationReason(compensationApproval.json) ?? 'COMPENSATION_APPROVAL_REJECTED',
        ...(typeof error?.code === 'string' ? { compensationApprovalErrorCode: error.code } : {}),
      };
    }
    compensationRequest = compensationApproval.json?.request as
      { compensationRunId?: unknown } | undefined;
  }
  const compensationRunId = compensationRequest?.compensationRunId;
  if (typeof compensationRunId !== 'string') {
    return {
      proposed: true,
      approved: true,
      forwardDone: true,
      compensationRequested: true,
      compensationApproved,
      compensationRunDone: false,
      compensated: false,
      compensationErrorCode: 'COMPENSATION_RUN_ID_MISSING',
      escalationReason: 'COMPENSATION_RUN_ID_MISSING',
    };
  }
  const compensationRunState = await pollRunState(baseUrl, compensationRunId, 'SUCCEEDED');
  const compState =
    compensationRunState === 'SUCCEEDED'
      ? await pollRunState(baseUrl, action.runId, 'COMPENSATED')
      : 'NOT_RUN';
  const compensationRunEvents =
    compensationRunState === 'SUCCEEDED' ? await getRunEvents(baseUrl, compensationRunId) : [];
  const compensationEventRecorded = compensationRunEvents.some(
    (event) => event.type === 'compensation.completed',
  );
  const compensated = compState === 'COMPENSATED' && compensationEventRecorded;
  const escalationReason =
    compensationRunState !== 'SUCCEEDED'
      ? `COMPENSATION_RUN_${compensationRunState}`
      : compState !== 'COMPENSATED'
        ? `ORIGINAL_RUN_${compState}`
        : !compensationEventRecorded
          ? 'COMPENSATION_COMPLETED_EVENT_MISSING'
          : undefined;
  return {
    proposed: true,
    approved: true,
    forwardDone: true,
    forwardReceiptHash,
    rawForwardResponseAbsent,
    compensationRequested: true,
    compensationApproved,
    compensationRunDone: compensationRunState === 'SUCCEEDED',
    compensationEventRecorded,
    compensationRunEvents,
    compensated,
    compState,
    compensationRunState,
    ...(escalationReason ? { escalationReason } : {}),
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
      steps.S_mock_adapter_ops = await runAdapterOpsCompensationMock();
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
      ...(passed ? {} : { escalationReason: 'MOCK_ADAPTER_OPS_FAILED' }),
      elapsedMs: Date.now() - started,
    };
  }

  let result: CompensationE2EResult | undefined;
  try {
    let dockerError: string | undefined;
    if (options.composeUp) {
      const up = tryComposeCellUp();
      steps.composeUp = up.ok;
      if (!up.ok) {
        result = {
          mode,
          verdict: 'BLOCKED',
          passed: false,
          steps,
          controlledChange,
          dockerError: up.error,
          escalationReason: 'CELL_COMPOSE_UP_FAILED',
          elapsedMs: Date.now() - started,
        };
        return result;
      }
    }

    const health = await assertComposeCellHealth(options.baseUrl);
    Object.assign(steps, health);

    if (Object.values(health).some((v) => !v)) {
      result = {
        mode,
        verdict: 'BLOCKED',
        passed: false,
        steps,
        controlledChange,
        dockerError,
        escalationReason: 'CELL_HEALTH_CHECK_FAILED',
        elapsedMs: Date.now() - started,
      };
      return result;
    }

    const flow = await runComposeDemoCompensationFlow(options.baseUrl);
    const { compensationRunEvents, escalationReason, ...flowSteps } = flow;
    Object.assign(steps, flowSteps);
    if (escalationReason) steps.escalationReason = escalationReason;

    // Host InMemory CompensationDaemon is informational only and does not raise compose evidence.
    // (specialized audit: S_adapter_ops_mock was greenwashing "adapter-ops consumed outbox").
    const mockOk = await runAdapterOpsCompensationMock().catch(() => false);
    steps.S_adapter_ops_mock_host = mockOk;

    const passed =
      flow.proposed === true &&
      flow.approved === true &&
      flow.forwardDone === true &&
      typeof flow.forwardReceiptHash === 'string' &&
      flow.rawForwardResponseAbsent === true &&
      flow.compensated === true &&
      (options.composeUp ? steps.composeUp === true : true);

    result = {
      mode,
      verdict: passed ? 'ENFORCED' : 'BLOCKED',
      passed,
      steps,
      controlledChange,
      ...(compensationRunEvents ? { compensationRunEvents } : {}),
      ...(escalationReason ? { escalationReason } : {}),
      dockerError,
      elapsedMs: Date.now() - started,
    };
    return result;
  } finally {
    if (options.composeUp) {
      const down = tryComposeCellDown();
      steps.composeDown = down.ok;
      if (!down.ok && result) {
        result.verdict = 'BLOCKED';
        result.passed = false;
        result.teardownError = down.error;
        result.escalationReason ??= 'CELL_COMPOSE_TEARDOWN_FAILED';
      }
    }
  }
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
