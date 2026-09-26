import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  runDemoProcess,
  runRecoveryScenario,
  type RecoveryDriver,
} from './github-cell-recovery.js';

function fixture() {
  const events: string[] = [];
  let recovered = false;
  let closed = false;
  let restarted = false;
  let approved = false;
  const effect = {
    id: 'effect-original',
    runId: 'run-original',
    idempotencyKey: 'key-original',
    requestHash: 'a'.repeat(64),
    state: 'COMPLETION_UNKNOWN',
    prNumber: null,
  };
  const driver: RecoveryDriver = {
    async cli(role, args) {
      events.push(`${role}:${args[0]}`);
      switch (args[0]) {
        case 'propose':
          return {
            runId: effect.runId,
            effectId: effect.id,
            state: recovered ? 'SUCCEEDED' : 'AWAITING_APPROVAL',
            actionDigest: 'b'.repeat(64),
            simulationId: 'sim',
            policySnapshotId: 'policy',
          };
        case 'verify-agent-boundary':
          return { runId: effect.runId, boundary: 'DENIED' };
        case 'approve':
          approved = true;
          return { runId: effect.runId, state: 'RUNNING' };
        case 'status':
          return {
            runId: args[2],
            state: closed || recovered ? 'SUCCEEDED' : 'COMPLETION_UNKNOWN',
          };
        case 'evidence':
          return {
            runId: effect.runId,
            evidenceId: 'bundle-original',
            effects: [{ effectId: effect.id }],
          };
        case 'request-close':
          return {
            runId: effect.runId,
            state: 'AWAITING_APPROVAL',
            authorizationId: 'authorization-close',
            actionDigest: 'c'.repeat(64),
            policySnapshotId: 'policy-close',
          };
        case 'approve-close':
          closed = true;
          return { compensationRunId: 'run-close' };
        default:
          throw new Error('unexpected CLI phase');
      }
    },
    async pauseRecovery() {
      events.push('pause');
    },
    async resumeRecovery() {
      events.push('resume');
      recovered = true;
    },
    async workerStartedAt() {
      return restarted ? '2026-09-23T00:00:02Z' : '2026-09-23T00:00:01Z';
    },
    async restartWorker() {
      events.push('restart');
      restarted = true;
    },
    async effect() {
      return {
        ...effect,
        state: recovered ? 'COMPLETED' : effect.state,
        prNumber: recovered ? 1 : null,
      };
    },
    async provider() {
      return {
        createCalls: approved ? 1 : 0,
        closeCalls: closed ? 1 : 0,
        responseCutInjected: approved,
        committedCreateStatus: approved ? 201 : null,
        pulls: approved ? [{ number: 1, state: closed ? 'closed' : 'open' }] : [],
      };
    },
  };
  return { driver, events, effect };
}

test('runs the real demo CLI in a child with its selected credential', async (t) => {
  let calls = 0;
  let credential: string | undefined;
  const server = createServer((req, res) => {
    calls += 1;
    credential =
      typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        action: {
          runId: 'run-original',
          effectId: 'effect-original',
          state: 'AWAITING_APPROVAL',
          simulation: {
            actionDigest: 'a'.repeat(64),
            simulationId: 'sim',
            policySnapshotId: 'policy',
          },
        },
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const result = await runDemoProcess({
    role: 'agent',
    token: 'selected-agent-token',
    tenantId: 'tenant',
    baseUrl: `http://127.0.0.1:${address.port}`,
    args: [
      'propose',
      '--operation-id',
      'operation-test',
      '--destination',
      'github://octo/repo/pulls',
      '--head',
      'feature',
      '--base',
      'main',
      '--title',
      'Title',
      '--body',
      'Body',
    ],
  });
  assert.equal(result.runId, 'run-original');
  assert.equal(calls, 1);
  assert.equal(credential, 'selected-agent-token');
});

for (const role of ['agent', 'approver'] as const) {
  test(`${role} CLI child cannot inherit the other identity from its controller`, async (t) => {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls += 1;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          action: {
            runId: 'run-original',
            state: 'AWAITING_APPROVAL',
            simulation: {
              actionDigest: 'a'.repeat(64),
              simulationId: 'sim',
              policySnapshotId: 'policy',
            },
          },
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const otherKey =
      role === 'agent'
        ? 'COMMANDER_GITHUB_DEMO_APPROVER_TOKEN'
        : 'COMMANDER_GITHUB_DEMO_AGENT_TOKEN';
    const original = process.env[otherKey];
    process.env[otherKey] = 'controller-only-credential';
    t.after(() => {
      if (original === undefined) delete process.env[otherKey];
      else process.env[otherKey] = original;
    });
    const args =
      role === 'agent'
        ? [
            'approve',
            '--run-id',
            'run-original',
            '--action-digest',
            'a'.repeat(64),
            '--simulation-id',
            'sim',
            '--policy-snapshot-id',
            'policy',
          ]
        : [
            'propose',
            '--operation-id',
            'operation-test',
            '--destination',
            'github://octo/repo/pulls',
            '--head',
            'feature',
            '--base',
            'main',
            '--title',
            'Title',
            '--body',
            'Body',
          ];
    await assert.rejects(
      () =>
        runDemoProcess({
          role,
          token: 'own-credential',
          tenantId: 'tenant',
          baseUrl: `http://127.0.0.1:${address.port}`,
          args,
        }),
      /RECOVERY_CLI_FAILED/,
    );
    assert.equal(calls, 0, 'other-role operation must fail before HTTP');
  });
}

test('recovery proof requires separate approvals, persisted unknown, restart and one original effect', async () => {
  const { driver, events } = fixture();
  const result = await runRecoveryScenario(driver, 'operation-1');
  assert.equal(result.effectId, 'effect-original');
  assert.equal(result.createCalls, 1);
  assert.equal(result.closeCalls, 1);
  assert.equal(result.evidenceId, 'bundle-original');
  assert.deepEqual(
    events.filter((event) => ['pause', 'restart', 'resume'].includes(event)),
    ['pause', 'restart', 'resume'],
  );
  assert.ok(events.indexOf('agent:verify-agent-boundary') < events.indexOf('approver:approve'));
  assert.ok(events.indexOf('resume') < events.indexOf('agent:request-close'));
  assert.ok(events.includes('approver:approve-close'));
  assert.equal(events.filter((event) => event === 'agent:propose').length, 2);
});

for (const [name, change, code] of [
  [
    'agent can approve',
    (d: RecoveryDriver) => {
      const cli = d.cli;
      d.cli = async (role, args) =>
        args[0] === 'verify-agent-boundary' ? { boundary: 'ALLOWED' } : cli(role, args);
    },
    'AGENT_APPROVAL_BOUNDARY_FAILED',
  ],
  [
    'no confirmed response cut',
    (d: RecoveryDriver) => {
      const provider = d.provider;
      d.provider = async () => ({ ...(await provider()), responseCutInjected: false });
    },
    'REMOTE_CUT_NOT_PROVEN',
  ],
  [
    'worker never restarted',
    (d: RecoveryDriver) => {
      d.restartWorker = async () => {};
    },
    'WORKER_RESTART_NOT_PROVEN',
  ],
  [
    'effect replaced on recovery',
    (d: RecoveryDriver) => {
      const read = d.effect;
      d.effect = async (runId) => {
        const effect = await read(runId);
        return effect?.state === 'COMPLETED' ? { ...effect, id: 'replacement' } : effect;
      };
    },
    'RECOVERED_IDENTITY_CHANGED',
  ],
  [
    'request changed on recovery',
    (d: RecoveryDriver) => {
      const read = d.effect;
      d.effect = async (runId) => {
        const effect = await read(runId);
        return effect?.state === 'COMPLETED' ? { ...effect, requestHash: 'f'.repeat(64) } : effect;
      };
    },
    'RECOVERED_IDENTITY_CHANGED',
  ],
  [
    'duplicate remote create',
    (d: RecoveryDriver) => {
      const provider = d.provider;
      d.provider = async () => ({ ...(await provider()), createCalls: 2 });
    },
    'REMOTE_WRITE_COUNT_INVALID',
  ],
  [
    'wrong evidence effect',
    (d: RecoveryDriver) => {
      const cli = d.cli;
      d.cli = async (role, args) =>
        args[0] === 'evidence'
          ? {
              runId: 'run-original',
              evidenceId: 'bundle',
              effects: [{ effectId: 'another-effect' }],
            }
          : cli(role, args);
    },
    'EVIDENCE_EFFECT_MISMATCH',
  ],
  [
    'replay creates another remote PR',
    (d: RecoveryDriver) => {
      const provider = d.provider;
      let reads = 0;
      d.provider = async () => {
        const state = await provider();
        reads += 1;
        return reads >= 3 ? { ...state, createCalls: 2 } : state;
      };
    },
    'REMOTE_WRITE_COUNT_INVALID',
  ],
  [
    'close request writes before human approval',
    (d: RecoveryDriver) => {
      const cli = d.cli;
      const provider = d.provider;
      let closeRequested = false;
      d.cli = async (role, args) => {
        if (args[0] === 'request-close') closeRequested = true;
        return cli(role, args);
      };
      d.provider = async () => ({ ...(await provider()), closeCalls: closeRequested ? 1 : 0 });
    },
    'CLOSE_OCCURRED_BEFORE_APPROVAL',
  ],
] as const) {
  test(`refuses a passing proof when ${name}`, async () => {
    const { driver, events } = fixture();
    change(driver);
    await assert.rejects(() => runRecoveryScenario(driver, 'operation-1'), new RegExp(code));
    if (events.includes('pause'))
      assert.ok(events.includes('resume'), 'failure must unpause recovery');
    assert.equal(
      events.includes('approver:approve-close'),
      false,
      'failed proof must not implicitly clean up',
    );
  });
}
