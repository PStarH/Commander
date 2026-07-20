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
import { KERNEL_COMPENSATION_TOPIC } from '@commander/kernel';
import { InMemoryKernelRepository } from '@commander/kernel/testing/inMemoryRepository';
import { CompensationDaemon } from '../packages/operations/src/compensationDaemon.js';
import { createChaosMockFetch } from './l4-b-adapter-chaos.js';
import {
  assertComposeCellHealth,
  CELL_COMPOSE_ENV,
  CELL_E2E_TENANT,
  tryComposeCellUp,
} from './l4-b-cell-compose.js';

export type CompensationE2EMode = 'mock' | 'compose';

export interface CompensationE2EResult {
  mode: CompensationE2EMode;
  verdict: 'PROVEN' | 'ENFORCED-script-only' | 'BLOCKED';
  passed: boolean;
  steps: Record<string, boolean | string>;
  dockerError?: string;
  elapsedMs: number;
}

export {
  assertComposeCellHealth,
  CELL_COMPOSE_ENV,
  CELL_E2E_TENANT,
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
  const kernel = new InMemoryKernelRepository();
  const tenantId = 'adapter-ops-mock-tenant';

  kernel.seedOutboxMessage({
    topic: KERNEL_COMPENSATION_TOPIC,
    tenantId,
    key: `${tenantId}/run-cmp/effect-forward`,
    payload: {
      type: 'kernel.compensation.requested',
      tenantId,
      runId: 'run-cmp',
      stepId: 'step-cmp',
      compensationAction: 'compensate.github.pull-request.create',
      compensationPayload: {
        originalEffectId: 'effect-forward',
        forwardResponse: { prNumber: 1 },
        destination: 'github://octo/repo/pulls',
      },
      idempotencyKey: 'cmp:effect-forward:1.0.0',
    },
  });

  const genericClaims = await kernel.claimOutbox(10);
  assert.ok(
    genericClaims.every((m) => m.topic !== KERNEL_COMPENSATION_TOPIC),
    'kernel-ops publisher must not steal compensation topic',
  );

  let compensated = false;
  const daemon = new CompensationDaemon({
    repository: kernel,
    registry,
    broker: {
      admit: async () => ({ admitted: true, effectId: 'eff-comp', replayed: false }),
      executeAdmitted: async () => {
        compensated = true;
        return { effectId: 'eff-comp', replayed: false, response: { state: 'closed' } };
      },
    },
    tokenProvider: async () => 'cmp-token',
    pollIntervalMs: 60_000,
    workerId: 'adapter-ops-mock',
  });

  const tick = await daemon.tick();
  assert.equal(tick.consumed, 1);
  assert.equal(tick.succeeded, 1);
  assert.equal((await kernel.claimOutboxByTopic(KERNEL_COMPENSATION_TOPIC, 10)).length, 0);
  return compensated && tick.succeeded === 1;
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
  if (proposed.status !== 202) return { proposed: false, approved: false, forwardDone: false, compensated: false };
  const action = (proposed.json?.action ?? {}) as {
    runId: string;
    simulation: { actionDigest: string; simulationId: string; policySnapshotId: string };
  };
  const approved = await httpJson(baseUrl, 'POST', `/v1/actions/${action.runId}/approve`, {
    actionDigest: action.simulation.actionDigest,
    simulationId: action.simulation.simulationId,
    policySnapshotId: action.simulation.policySnapshotId,
  });
  if (approved.status !== 200) return { proposed: true, approved: false, forwardDone: false, compensated: false };
  const forwardState = await pollActionTerminal(baseUrl, action.runId);
  if (forwardState !== 'SUCCEEDED') {
    return { proposed: true, approved: true, forwardDone: false, compensated: false };
  }
  const compensate = await httpJson(baseUrl, 'POST', '/v1/actions', {
    source: 'cell-e2e',
    package: 'cell-e2e',
    model: 'mock',
    tool: 'ticket.compensate',
    destination: 'demo://tickets',
    effectType: 'compensate.demo.ticket.create',
    args: { targetIdempotencyKey: idem },
    idempotencyKey: `cmp-${idem}`,
  });
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
}): Promise<CompensationE2EResult> {
  const started = Date.now();
  const mode = options.mode ?? 'mock';
  const steps: Record<string, boolean | string> = {};

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
      dockerError,
      elapsedMs: Date.now() - started,
    };
  }

  const flow = await runComposeDemoCompensationFlow(options.baseUrl);
  Object.assign(steps, flow);

  // Host InMemory CompensationDaemon is informational only — must NOT gate compose PROVEN
  // (specialized audit: S_adapter_ops_mock was greenwashing "adapter-ops consumed outbox").
  const mockOk = await runAdapterOpsCompensationMock().catch(() => false);
  steps.S_adapter_ops_mock_host = mockOk;

  const passed =
    flow.proposed === true &&
    flow.approved === true &&
    flow.forwardDone === true &&
    flow.compensated === true &&
    (options.composeUp ? steps.composeUp === true : true);

  return {
    mode,
    verdict: passed ? 'PROVEN' : 'BLOCKED',
    passed,
    steps,
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

  const result = await runCellCompensationE2E({ mode, baseUrl, composeUp });
  const outDir = join(process.cwd(), 'artifacts');
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `l4-b-cell-compensation-e2e-${Date.now()}.json`);
  await writeFile(outPath, JSON.stringify(result, null, 2));
  console.log(`Cell compensation E2E ${result.verdict} ${result.passed ? 'PASS' : 'FAIL'} → ${outPath}`);
  if (!result.passed) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
