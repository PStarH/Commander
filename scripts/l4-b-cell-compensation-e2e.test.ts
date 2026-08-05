import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import {
  CELL_E2E_TENANT,
  createCellComposeEnv,
  notReadyControlledChangeEvidence,
  runAdapterOpsCompensationMock,
  runCellCompensationE2E,
  runComposeDemoCompensationFlow,
  tryComposeCellDown,
} from './l4-b-cell-compensation-e2e.js';

describe('l4-b-cell-compensation-e2e', () => {
  it('keeps Kubernetes controlled-change telemetry NOT_READY without a Kubernetes proof', () => {
    assert.equal(notReadyControlledChangeEvidence().proofVerdict, 'NOT_READY');
    assert.equal(notReadyControlledChangeEvidence().remoteOutcome, 'UNKNOWN');
  });

  it('mock mode proves adapter-ops compensation consumer (ENFORCED)', async () => {
    assert.equal(await runAdapterOpsCompensationMock(), true);
  });

  it('runCellCompensationE2E mock verdict is ENFORCED-script-only when passing', async () => {
    const result = await runCellCompensationE2E({ mode: 'mock' });
    assert.equal(result.verdict, 'ENFORCED-script-only');
    assert.equal(result.passed, true);
  });

  it('does not claim PROVEN evidence for the compose harness', () => {
    const source = readFileSync(
      new URL('./l4-b-cell-compensation-e2e.ts', import.meta.url),
      'utf-8',
    );
    assert.doesNotMatch(source, /['"]PROVEN['"]/);
    assert.match(source, /verdict: passed \? 'ENFORCED' : 'BLOCKED'/);
  });

  it('records the Action Gateway rejection that blocks the compose flow', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'OPERATIONS_NOT_READY' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    try {
      assert.deepEqual(await runComposeDemoCompensationFlow(`http://127.0.0.1:${address.port}`), {
        proposed: false,
        approved: false,
        forwardDone: false,
        compensated: false,
        proposalHttpStatus: '503',
        proposalErrorCode: 'OPERATIONS_NOT_READY',
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('requests and approves canonical compensation before waiting for COMPENSATED', async () => {
    const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    let actionReads = 0;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
        : {};
      requests.push({ method: req.method ?? '', path: req.url ?? '', body });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/v1/actions') {
        res.writeHead(202);
        res.end(
          JSON.stringify({
            action: {
              runId: 'run-forward',
              effectId: 'effect-forward',
              simulation: {
                actionDigest: 'a'.repeat(64),
                simulationId: 'simulation-forward',
                policySnapshotId: 'action-gateway-mvp-v1',
              },
            },
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/actions/run-forward/approve') {
        res.writeHead(200);
        res.end(JSON.stringify({ action: { state: 'ADMITTED' } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/actions/run-forward') {
        actionReads += 1;
        res.writeHead(200);
        res.end(
          JSON.stringify({
            action: {
              state: 'SUCCEEDED',
              effectId: 'effect-forward',
              forwardReceiptHash: 'b'.repeat(64),
            },
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/actions/run-forward/compensations') {
        res.writeHead(202);
        res.end(
          JSON.stringify({
            state: 'AWAITING_APPROVAL',
            authorization: {
              id: 'authorization-1',
              actionDigest: 'c'.repeat(64),
              policySnapshotId: 'action-gateway-mvp-v1',
            },
          }),
        );
        return;
      }
      if (
        req.method === 'POST' &&
        req.url === '/v1/actions/run-forward/compensations/authorization-1/approve'
      ) {
        res.writeHead(202);
        res.end(
          JSON.stringify({
            accepted: true,
            request: { compensationRunId: 'run-compensation' },
          }),
        );
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/runs/run-compensation/status') {
        res.writeHead(200);
        res.end(JSON.stringify({ state: 'SUCCEEDED', terminal: true }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/runs/run-forward/status') {
        res.writeHead(200);
        res.end(JSON.stringify({ state: 'COMPENSATED', terminal: true }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/runs/run-compensation/events') {
        res.writeHead(200);
        res.end(JSON.stringify({ events: [{ type: 'compensation.completed' }] }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    try {
      assert.deepEqual(await runComposeDemoCompensationFlow(`http://127.0.0.1:${address.port}`), {
        proposed: true,
        approved: true,
        forwardDone: true,
        compensationRequested: true,
        compensationApproved: true,
        compensationRunDone: true,
        compensationEventRecorded: true,
        compensated: true,
        compState: 'COMPENSATED',
        compensationRunState: 'SUCCEEDED',
      });
      assert.deepEqual(requests[3], {
        method: 'POST',
        path: '/v1/actions/run-forward/compensations',
        body: {
          originalEffectId: 'effect-forward',
          adapterVersion: 'demo-ticket/v1',
          compensationEffectType: 'compensate.demo.ticket.create',
          compensationPatch: { targetIdempotencyKey: requests[0]?.body.idempotencyKey },
          forwardReceiptHash: 'b'.repeat(64),
        },
      });
      assert.deepEqual(requests[4]?.body, {
        actionDigest: 'c'.repeat(64),
        policySnapshotId: 'action-gateway-mvp-v1',
      });
      assert.equal(actionReads, 1, 'compensation terminal state comes from raw run status');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('waits for adapter-ops readiness rather than process liveness', () => {
    const source = readFileSync(new URL('./l4-b-cell-compose.ts', import.meta.url), 'utf-8');
    assert.match(source, /127\.0\.0\.1:8082\/ready/);
  });

  it('tears compose down with the complete generated cell environment', () => {
    let command = '';
    let env: NodeJS.ProcessEnv = {};
    assert.deepEqual(
      tryComposeCellDown({
        execute(nextCommand, nextEnv) {
          command = nextCommand;
          env = nextEnv;
        },
      }),
      { ok: true },
    );
    assert.match(command, /down -v --remove-orphans$/);
    for (const name of [
      'COMMANDER_CAPABILITY_PRIVATE_KEY_PEM',
      'COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM',
      'COMMANDER_CELL_DATABASE_TLS_CA_HOST_FILE',
      'COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256',
    ]) {
      assert.equal(typeof env[name], 'string', `${name} must reach compose teardown`);
      assert.ok(env[name]);
    }
  });

  it('uses validated CI secrets for compose and every derived credential', () => {
    const injected = {
      POSTGRES_PASSWORD: 'postgres-runtime-secret',
      COMMANDER_API_KEY: 'api-runtime-secret',
      COMMANDER_MASTER_KEY: 'master-runtime-secret-32-characters',
      JWT_SECRET: 'jwt-runtime-secret',
      COMMANDER_CAPABILITY_TOKEN_KEY: 'capability-runtime-secret',
      COMMANDER_INTEGRITY_KEY: 'integrity-runtime-secret',
      COMMANDER_WORKER_AUTH_TOKEN: 'worker-runtime-secret',
      DOCKER_GID: '321',
    };
    const env = createCellComposeEnv(injected);

    for (const [name, value] of Object.entries(injected)) assert.equal(env[name], value);
    assert.match(env.DATABASE_URL, /postgres-runtime-secret@postgres:5432/);
    assert.equal(env.COMMANDER_KERNEL_DATABASE_URL, env.DATABASE_URL);
    assert.equal(env.API_KEYS, 'api-runtime-secret:cell-e2e:admin;actions:approve');
    assert.equal(env.TENANT_API_KEYS, `${CELL_E2E_TENANT}:api-runtime-secret`);
    assert.throws(
      () => createCellComposeEnv({ ...injected, COMMANDER_API_KEY: 'bad:runtime;secret' }),
      /INVALID_CELL_COMPOSE_SECRET:COMMANDER_API_KEY/,
    );
  });
});
