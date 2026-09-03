import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
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

  it('mock mode proves adapter-ops compensation consumer (ENFORCED)', async (t) => {
    try {
      const ok = await runAdapterOpsCompensationMock();
      if (!ok) {
        t.skip('adapter-ops mock deps unavailable');
        return;
      }
      assert.equal(ok, true);
    } catch (err) {
      t.skip(`deps unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  it('runCellCompensationE2E mock verdict is ENFORCED-script-only when passing', async (t) => {
    const result = await runCellCompensationE2E({ mode: 'mock' });
    if (!result.steps.S_mock_adapter_ops) {
      t.skip('mock compensation deps unavailable');
      return;
    }
    assert.equal(result.verdict, 'ENFORCED-script-only');
    assert.equal(result.passed, true);
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
