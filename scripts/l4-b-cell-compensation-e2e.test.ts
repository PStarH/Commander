import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { KERNEL_COMPENSATION_TOPIC } from '@commander/kernel';
import {
  adapterOpsCompensationMockPassed,
  notReadyControlledChangeEvidence,
  runAdapterOpsCompensationMock,
  runCellCompensationE2E,
  runComposeDemoCompensationFlow,
} from './l4-b-cell-compensation-e2e.js';

describe('l4-b-cell-compensation-e2e', () => {
  it('keeps Kubernetes controlled-change telemetry NOT_READY without a Kubernetes proof', () => {
    assert.equal(notReadyControlledChangeEvidence().proofVerdict, 'NOT_READY');
    assert.equal(notReadyControlledChangeEvidence().remoteOutcome, 'UNKNOWN');
  });

  it('mock mode proves adapter-ops compensation consumer (ENFORCED)', async () => {
    const evidence = await runAdapterOpsCompensationMock();
    assert.equal(evidence.consumed, 1, 'daemon must consume the governed compensation request');
    assert.equal(evidence.succeeded, 1, 'daemon must complete the governed compensation');
    assert.equal(evidence.escalated, 0, 'a valid authorization must not be escalated');
    assert.equal(evidence.executions, 1, 'compensation effect must execute exactly once');
    assert.equal(evidence.tamperRefused, true, 'a substituted claim token must be refused');
    assert.equal(evidence.replayTickConsumed, 0, 'a drained outbox must not be re-consumed');
    assert.equal(evidence.replayExecutions, 1, 'replay must not re-execute the compensation');
    assert.equal(evidence.compensationEffectState, 'COMPLETED');
    assert.deepEqual(evidence.compensationEffectResponse, { state: 'closed' });
    assert.equal(evidence.compensationRunState, 'SUCCEEDED');
    assert.equal(evidence.remainingCompensationOutbox, 0, 'compensation outbox must be drained');
    assert.ok(evidence.genericClaimTopics.includes('commander.run.created'));
    assert.ok(!evidence.genericClaimTopics.includes(KERNEL_COMPENSATION_TOPIC));
    assert.equal(adapterOpsCompensationMockPassed(evidence), true);
  });

  it('runCellCompensationE2E mock verdict is ENFORCED-script-only when passing', async () => {
    const result = await runCellCompensationE2E({ mode: 'mock' });
    assert.equal(result.steps.S_mock_adapter_ops, true);
    assert.equal(result.passed, true);
    assert.equal(result.verdict, 'ENFORCED-script-only');
  });

  it('sends a valid route-specific Idempotency-Key on every Action write', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{
      method: string;
      path: string;
      idempotencyKey: string | null;
      body: Record<string, unknown> | null;
    }> = [];
    let proposalCount = 0;

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      requests.push({
        method,
        path: url.pathname,
        idempotencyKey: new Headers(init?.headers).get('Idempotency-Key'),
        body,
      });

      if (method === 'POST' && url.pathname === '/v1/actions') {
        proposalCount += 1;
        return Response.json(
          proposalCount === 1
            ? {
                action: {
                  runId: 'forward-run',
                  simulation: {
                    actionDigest: 'forward-digest',
                    simulationId: 'forward-simulation',
                    policySnapshotId: 'forward-policy',
                  },
                },
              }
            : { action: { runId: 'compensation-run' } },
          { status: 202 },
        );
      }
      if (method === 'POST' && url.pathname === '/v1/actions/forward-run/approve') {
        return Response.json({}, { status: 200 });
      }
      if (method === 'GET' && url.pathname === '/v1/actions/forward-run') {
        return Response.json({ action: { state: 'SUCCEEDED' } });
      }
      if (method === 'GET' && url.pathname === '/v1/actions/compensation-run') {
        return Response.json({ action: { state: 'SUCCEEDED' } });
      }
      return Response.json({}, { status: 404 });
    }) as typeof fetch;

    try {
      const result = await runComposeDemoCompensationFlow('http://cell.test');
      assert.deepEqual(result, {
        proposed: true,
        approved: true,
        forwardDone: true,
        compensated: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const writes = requests.filter(({ method }) => method === 'POST');
    assert.equal(writes.length, 3);
    const [proposal, approval, compensation] = writes;
    assert.equal(proposal.path, '/v1/actions');
    assert.equal(proposal.idempotencyKey, proposal.body?.idempotencyKey);
    assert.equal(approval.path, '/v1/actions/forward-run/approve');
    assert.equal(approval.idempotencyKey, `approve-${proposal.idempotencyKey}`);
    assert.equal(compensation.path, '/v1/actions');
    assert.equal(compensation.idempotencyKey, compensation.body?.idempotencyKey);
    assert.equal(new Set(writes.map(({ idempotencyKey }) => idempotencyKey)).size, writes.length);
    for (const { idempotencyKey } of writes) {
      assert.match(idempotencyKey ?? '', /^[A-Za-z0-9._:-]{8,256}$/);
    }
  });

  it('does not claim PROVEN evidence for the compose harness', () => {
    const source = readFileSync(
      new URL('./l4-b-cell-compensation-e2e.ts', import.meta.url),
      'utf-8',
    );
    assert.doesNotMatch(source, /['"]PROVEN['"]/);
    assert.match(source, /verdict: passed \? 'ENFORCED' : 'BLOCKED'/);
  });
});
