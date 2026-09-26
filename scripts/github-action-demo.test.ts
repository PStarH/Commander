import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR } from '../packages/contracts/src/actionAdapters.js';
import { runGitHubActionDemo } from './github-action-demo.js';

const digest = 'a'.repeat(64);
const receiptHash = 'b'.repeat(64);
const simulation = {
  actionDigest: digest,
  simulationId: 'simulation-1',
  policySnapshotId: 'policy-1',
};
const pending = { runId: 'run-1', effectId: 'effect-1', state: 'AWAITING_APPROVAL', simulation };
const proposal = [
  'propose',
  '--operation-id',
  'pilot-001',
  '--destination',
  'github://octo/repo/pulls',
  '--head',
  'pilot',
  '--base',
  'main',
  '--title',
  'Pilot',
  '--body',
  '',
];
const approval = [
  'approve',
  '--run-id',
  'run-1',
  '--action-digest',
  digest,
  '--simulation-id',
  'simulation-1',
  '--policy-snapshot-id',
  'policy-1',
];
type Call = {
  path: string;
  method: string;
  token: string | undefined;
  key: string | undefined;
  body: Record<string, unknown>;
};

async function withGateway(
  handler: (call: Call, response: ServerResponse) => void,
  run: (env: NodeJS.ProcessEnv, calls: Call[]) => Promise<void>,
) {
  const calls: Call[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const call: Call = {
      path: req.url ?? '',
      method: req.method ?? 'GET',
      token: typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined,
      key:
        typeof req.headers['idempotency-key'] === 'string'
          ? req.headers['idempotency-key']
          : undefined,
      body: raw ? JSON.parse(raw) : {},
    };
    calls.push(call);
    res.setHeader('content-type', 'application/json');
    handler(call, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(
      {
        COMMANDER_GITHUB_DEMO_GATEWAY_URL: `http://127.0.0.1:${address.port}`,
        COMMANDER_GITHUB_DEMO_TENANT_ID: 'tenant-1',
        COMMANDER_GITHUB_DEMO_AGENT_TOKEN: 'agent-secret',
        COMMANDER_GITHUB_DEMO_APPROVER_TOKEN: 'approver-secret',
      },
      calls,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function respond(res: ServerResponse, value: unknown, status = 200) {
  res.statusCode = status;
  res.end(JSON.stringify(value));
}

test('propose reuses a stable operation key and never approves or prints private fields', async () => {
  await withGateway(
    (_call, res) =>
      respond(
        res,
        {
          action: {
            ...pending,
            body: 'private-body',
            token: 'agent-secret',
            forwardResponse: { secret: 'receipt-secret' },
          },
        },
        202,
      ),
    async (env, calls) => {
      Object.defineProperty(env, 'COMMANDER_GITHUB_DEMO_APPROVER_TOKEN', {
        get() {
          throw new Error('agent read approver credential');
        },
      });
      const first = await runGitHubActionDemo(proposal, env);
      const second = await runGitHubActionDemo(proposal, env);
      assert.equal(first.runId, 'run-1');
      assert.equal(second.runId, first.runId);
      assert.equal(calls.length, 2);
      assert.ok(
        calls.every((call) => call.path === '/v1/actions' && call.token === 'agent-secret'),
      );
      assert.equal(calls[0].body.idempotencyKey, calls[1].body.idempotencyKey);
      assert.equal(calls[0].key, calls[0].body.idempotencyKey);
      assert.deepEqual(calls[0].body.args, {
        title: 'Pilot',
        body: '',
        head: 'pilot',
        base: 'main',
      });
      assert.equal(calls[0].body.effectType, GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR.effectType);
      assert.doesNotMatch(JSON.stringify(first), /private-body|agent-secret|receipt-secret/);
    },
  );
});

test('approve uses only approver credential and exact persisted simulation binding', async () => {
  await withGateway(
    (call, res) =>
      respond(res, { action: call.method === 'GET' ? pending : { ...pending, state: 'ADMITTED' } }),
    async (env, calls) => {
      Object.defineProperty(env, 'COMMANDER_GITHUB_DEMO_AGENT_TOKEN', {
        get() {
          throw new Error('approver read agent credential');
        },
      });
      const result = await runGitHubActionDemo(approval, env);
      assert.equal(result.state, 'ADMITTED');
      assert.ok(calls.every((call) => call.token === 'approver-secret'));
      assert.deepEqual(calls[1].body, simulation);
    },
  );
});

test('approve refuses a changed simulation without sending approval', async () => {
  await withGateway(
    (_call, res) =>
      respond(res, {
        action: { ...pending, simulation: { ...simulation, actionDigest: 'c'.repeat(64) } },
      }),
    async (env, calls) => {
      await assert.rejects(runGitHubActionDemo(approval, env), /APPROVAL_BINDING_MISMATCH/);
      assert.equal(calls.length, 1);
    },
  );
});

test('agent boundary probe requires the actual approval-forbidden response', async () => {
  await withGateway(
    (call, res) =>
      call.method === 'GET'
        ? respond(res, { action: pending })
        : respond(
            res,
            { error: { code: 'ACTION_APPROVAL_FORBIDDEN', message: 'private-body' } },
            403,
          ),
    async (env, calls) => {
      assert.equal(
        (await runGitHubActionDemo(['verify-agent-boundary', '--run-id', 'run-1'], env)).boundary,
        'DENIED',
      );
      assert.ok(calls.every((call) => call.token === 'agent-secret'));
      assert.deepEqual(calls[1].body, simulation);
    },
  );
});

for (const status of [401, 200, 403]) {
  test(`boundary probe rejects status ${status} without the expected forbidden code`, async () => {
    await withGateway(
      (call, res) =>
        call.method === 'GET'
          ? respond(res, { action: pending })
          : respond(res, { error: { code: 'OTHER', message: 'agent-secret' } }, status),
      async (env) => {
        await assert.rejects(
          runGitHubActionDemo(['verify-agent-boundary', '--run-id', 'run-1'], env),
          /AGENT_BOUNDARY_NOT_VERIFIED/,
        );
      },
    );
  });
}

test('close request uses persisted receipt hash and descriptor version, without approval', async () => {
  await withGateway(
    (call, res) =>
      call.method === 'GET'
        ? respond(res, {
            action: { ...pending, state: 'SUCCEEDED', forwardReceiptHash: receiptHash },
          })
        : respond(
            res,
            {
              state: 'AWAITING_APPROVAL',
              authorization: {
                id: 'authorization-1',
                actionDigest: digest,
                policySnapshotId: 'policy-1',
                forwardResponse: { secret: 'private-receipt' },
              },
            },
            202,
          ),
    async (env, calls) => {
      const result = await runGitHubActionDemo(['request-close', '--run-id', 'run-1'], env);
      assert.equal(result.authorizationId, 'authorization-1');
      assert.deepEqual(calls[1].body, {
        originalEffectId: 'effect-1',
        adapterVersion: GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR.adapterVersion,
        compensationEffectType: GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR.compensationEffectType,
        compensationPatch: {},
        forwardReceiptHash: receiptHash,
      });
      assert.equal(calls.length, 2);
      assert.doesNotMatch(JSON.stringify(result), /private-receipt/);
    },
  );
});

test('close request fails before POST without persisted receipt hash', async () => {
  await withGateway(
    (_call, res) => respond(res, { action: { ...pending, state: 'SUCCEEDED' } }),
    async (env, calls) => {
      await assert.rejects(
        runGitHubActionDemo(['request-close', '--run-id', 'run-1'], env),
        /FORWARD_RECEIPT_UNAVAILABLE/,
      );
      assert.equal(calls.length, 1);
    },
  );
});

test('close approval is an explicit separate approver invocation', async () => {
  await withGateway(
    (_call, res) =>
      respond(
        res,
        {
          accepted: true,
          request: {
            id: 'request-1',
            compensationRunId: 'close-run-1',
            compensationEffectId: 'close-effect-1',
            private: 'private-body',
          },
        },
        202,
      ),
    async (env, calls) => {
      delete env.COMMANDER_GITHUB_DEMO_AGENT_TOKEN;
      const result = await runGitHubActionDemo(
        [
          'approve-close',
          '--run-id',
          'run-1',
          '--authorization-id',
          'authorization-1',
          '--action-digest',
          digest,
          '--policy-snapshot-id',
          'policy-1',
        ],
        env,
      );
      assert.equal(result.compensationRunId, 'close-run-1');
      assert.equal(calls[0].path, '/v1/actions/run-1/compensations/authorization-1/approve');
      assert.equal(calls[0].token, 'approver-secret');
      assert.deepEqual(calls[0].body, { actionDigest: digest, policySnapshotId: 'policy-1' });
      assert.doesNotMatch(JSON.stringify(result), /private-body/);
    },
  );
});

test('status reads compensation status only when explicitly selected', async () => {
  await withGateway(
    (_call, res) =>
      respond(res, { runId: 'close-run-1', state: 'SUCCEEDED', tenantId: 'private-tenant' }),
    async (env, calls) => {
      const result = await runGitHubActionDemo(
        ['status', '--run-id', 'close-run-1', '--compensation'],
        env,
      );
      assert.equal(result.state, 'SUCCEEDED');
      assert.equal(calls[0].path, '/v1/runs/close-run-1/status');
      assert.doesNotMatch(JSON.stringify(result), /private-tenant/);
    },
  );
});

test('redirects never forward a credential', async () => {
  await withGateway(
    (_call, res) => {
      res.writeHead(302, { location: '/leak' });
      res.end();
    },
    async (env, calls) => {
      await assert.rejects(
        runGitHubActionDemo(['status', '--run-id', 'run-1'], env),
        /GATEWAY_REDIRECT_REJECTED/,
      );
      assert.equal(calls.length, 1);
    },
  );
});

test('missing credentials, invalid destination and insecure remote Gateway fail before I/O', async () => {
  await assert.rejects(runGitHubActionDemo(proposal, {}), /COMMANDER_GITHUB_DEMO_GATEWAY_URL/);
  await withGateway(
    (_call, res) => respond(res, {}),
    async (env, calls) => {
      const missing = { ...env };
      delete missing.COMMANDER_GITHUB_DEMO_AGENT_TOKEN;
      await assert.rejects(
        runGitHubActionDemo(proposal, missing),
        /COMMANDER_GITHUB_DEMO_AGENT_TOKEN/,
      );
      await assert.rejects(
        runGitHubActionDemo(proposal, {
          ...env,
          COMMANDER_GITHUB_DEMO_GATEWAY_URL: 'http://example.com',
        }),
        /GATEWAY_URL_INVALID/,
      );
      await assert.rejects(
        runGitHubActionDemo(
          proposal.map((value) => (value === 'pilot' ? 'fork:pilot' : value)),
          env,
        ),
        /INVALID_BRANCH/,
      );
      await assert.rejects(
        runGitHubActionDemo(
          proposal.filter((value) => value !== '--operation-id' && value !== 'pilot-001'),
          env,
        ),
        /operation-id/,
      );
      assert.equal(calls.length, 0);
    },
  );
});

test('Gateway errors expose only safe status and code', async () => {
  await withGateway(
    (_call, res) =>
      respond(
        res,
        { error: { code: 'OPERATIONS_NOT_READY', message: 'agent-secret private-body' } },
        503,
      ),
    async (env) => {
      await assert.rejects(
        runGitHubActionDemo(proposal, env),
        (error) =>
          error instanceof Error &&
          /503 OPERATIONS_NOT_READY/.test(error.message) &&
          !/agent-secret|private-body/.test(error.message),
      );
    },
  );
});

test('evidence prints only identifiers and allowed Gateway response metadata', async () => {
  await withGateway(
    (_call, res) =>
      respond(res, {
        receipt: {
          bundleId: 'evidence-1',
          scope: { runId: 'run-1', tenantId: 'private-tenant' },
          signature: 'private-signature',
          effects: [
            {
              effectId: 'effect-1',
              responseSummary: {
                status: 'closed',
                httpStatus: 200,
                errorCode: 'NONE',
                body: 'private-body',
                token: 'agent-secret',
              },
            },
          ],
        },
        verification: { ok: true },
      }),
    async (env, calls) => {
      const result = await runGitHubActionDemo(['evidence', '--run-id', 'run-1'], env);
      assert.equal(result.evidenceId, 'evidence-1');
      assert.deepEqual(result.effects, [
        {
          effectId: 'effect-1',
          status: 'closed',
          httpStatus: 200,
          errorCode: 'NONE',
        },
      ]);
      assert.equal(calls[0].path, '/v1/actions/run-1/evidence');
      assert.doesNotMatch(
        JSON.stringify(result),
        /private-|agent-secret|signature|tenantId|receipt/,
      );
    },
  );
});

test('invalid evidence fails closed without printing raw receipt', async () => {
  await withGateway(
    (_call, res) =>
      respond(res, {
        receipt: { bundleId: 'evidence-1', scope: { runId: 'other-run' }, effects: [] },
        verification: { ok: true },
      }),
    async (env) => {
      await assert.rejects(
        runGitHubActionDemo(['evidence', '--run-id', 'run-1'], env),
        /EVIDENCE_BINDING_MISMATCH/,
      );
    },
  );
});

test(
  'a real stalled HTTP response is aborted without further calls',
  { timeout: 15_000 },
  async () => {
    await withGateway(
      (_call, res) => {
        res.writeHead(200);
        res.write('{');
      },
      async (env, calls) => {
        const started = Date.now();
        await assert.rejects(
          runGitHubActionDemo(['status', '--run-id', 'run-1'], env),
          /GATEWAY_IO_FAILED/,
        );
        assert.ok(Date.now() - started < 12_000);
        assert.equal(calls.length, 1);
      },
    );
  },
);

test('status wait expires with bounded polling instead of reporting success', async () => {
  await withGateway(
    (_call, res) => respond(res, { action: { ...pending, state: 'RUNNING' } }),
    async (env, calls) => {
      await assert.rejects(
        runGitHubActionDemo(['status', '--run-id', 'run-1', '--wait-seconds', '1'], env),
        /STATUS_WAIT_EXPIRED/,
      );
      assert.ok(calls.length <= 3);
    },
  );
});

test('--help succeeds in a separate process without Gateway credentials', async () => {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  delete env.NODE_TEST_CONTEXT;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', 'scripts/github-action-demo.ts', '--help'],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), env },
  );
  assert.match(stdout, /Usage:/);
  for (const name of [
    'propose',
    'status',
    'evidence',
    'approve',
    'request-close',
    'approve-close',
    'verify-agent-boundary',
    '--operation-id',
    'COMMANDER_GITHUB_DEMO_GATEWAY_URL',
    'COMMANDER_GITHUB_DEMO_AGENT_TOKEN',
    'COMMANDER_GITHUB_DEMO_APPROVER_TOKEN',
  ]) {
    assert.ok(stdout.includes(name), `help must explain ${name}`);
  }
  assert.equal(stderr, '');
});

for (const compensation of [false, true]) {
  test(`status rejects a different run ID (compensation=${compensation})`, async () => {
    const other = { ...pending, runId: 'other-run', state: 'SUCCEEDED' };
    await withGateway(
      (_call, res) => respond(res, compensation ? other : { action: other }),
      async (env) => {
        await assert.rejects(
          runGitHubActionDemo(
            ['status', '--run-id', 'run-1', ...(compensation ? ['--compensation'] : [])],
            env,
          ),
          /RUN_BINDING_MISMATCH/,
        );
      },
    );
  });
}

test('approve rejects a response bound to a different run ID', async () => {
  await withGateway(
    (call, res) =>
      respond(res, {
        action:
          call.method === 'GET' ? pending : { ...pending, runId: 'other-run', state: 'ADMITTED' },
      }),
    async (env) => {
      await assert.rejects(runGitHubActionDemo(approval, env), /RUN_BINDING_MISMATCH/);
    },
  );
});
