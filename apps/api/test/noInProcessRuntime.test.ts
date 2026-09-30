import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createChatRouter } from '../src/chatEndpoints.js';
import { createOrchestratorRouter } from '../src/orchestratorEndpoints.js';
import { createPauseRouter, type RunControlGateway } from '../src/pauseEndpoints.js';
import { createSagaRouter } from '../src/sagaEndpoints.js';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const authorityFiles = [
  'orchestratorEndpoints.ts',
  'chatEndpoints.ts',
  'sequentialExecutor.ts',
  'webhookEndpoints.ts',
  'pauseEndpoints.ts',
];

async function withApp(
  app: express.Express,
  action: (baseUrl: string) => Promise<void>,
): Promise<void> {
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

describe('API has no in-process runtime authority', () => {
  const previousEnv = {
    nodeEnv: process.env.NODE_ENV,
    profile: process.env.COMMANDER_PROFILE,
    legacy: process.env.COMMANDER_LEGACY_EXECUTION,
    v2: process.env.COMMANDER_V2_MODE,
  };

  afterEach(() => {
    if (previousEnv.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv.nodeEnv;
    if (previousEnv.profile === undefined) delete process.env.COMMANDER_PROFILE;
    else process.env.COMMANDER_PROFILE = previousEnv.profile;
    if (previousEnv.legacy === undefined) delete process.env.COMMANDER_LEGACY_EXECUTION;
    else process.env.COMMANDER_LEGACY_EXECUTION = previousEnv.legacy;
    if (previousEnv.v2 === undefined) delete process.env.COMMANDER_V2_MODE;
    else process.env.COMMANDER_V2_MODE = previousEnv.v2;
  });

  it('contains no runtime constructor, runtime execution, or shared singleton', () => {
    for (const file of authorityFiles) {
      const source = readFileSync(path.join(srcDir, file), 'utf8');
      assert.doesNotMatch(source, /\bAgentRuntime\b/, file);
      assert.doesNotMatch(source, /getSharedRuntime|runtime\.execute\s*\(/, file);
    }
    assert.equal(existsSync(path.join(srcDir, 'sharedRuntime.ts')), false);
    assert.equal(existsSync(path.join(srcDir, 'agentRuntimeRegistry.ts')), false);
  });

  it('routes pause and resume through the canonical run-control gateway', async () => {
    const calls: Array<{ operation: string; runId: string; tenantId: string; actor: string }> = [];
    const gateway: RunControlGateway = {
      pauseRun: async (runId, tenantId, actor) => {
        calls.push({ operation: 'pause', runId, tenantId, actor });
        return { id: runId, state: 'PAUSED' };
      },
      resumeRun: async (runId, tenantId, actor) => {
        calls.push({ operation: 'resume', runId, tenantId, actor });
        return { id: runId, state: 'RUNNING' };
      },
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.tenantId = 'tenant-a';
      req.apiKeyId = 'api-operator';
      next();
    });
    app.use(createPauseRouter(() => gateway));

    await withApp(app, async (baseUrl) => {
      for (const operation of ['pause', 'resume']) {
        const response = await fetch(`${baseUrl}/runtime/${operation}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runId: 'run-42' }),
        });
        assert.equal(response.status, 200);
      }
    });

    assert.deepEqual(calls, [
      { operation: 'pause', runId: 'run-42', tenantId: 'tenant-a', actor: 'api-operator' },
      { operation: 'resume', runId: 'run-42', tenantId: 'tenant-a', actor: 'api-operator' },
    ]);
  });

  it('disables legacy orchestrator and chat execution with canonical replacement', async () => {
    process.env.NODE_ENV = 'development';
    process.env.COMMANDER_PROFILE = 'standard';
    process.env.COMMANDER_LEGACY_EXECUTION = '1';
    process.env.COMMANDER_V2_MODE = '0';

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'admin-1', username: 'admin', role: 'admin' };
      next();
    });
    app.use('/api', createOrchestratorRouter());
    app.use(createChatRouter());

    await withApp(app, async (baseUrl) => {
      const requests = [
        fetch(`${baseUrl}/api/orchestrator/execute`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ goal: 'execute work' }),
        }),
        fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'execute work' }),
        }),
      ];
      for (const response of await Promise.all(requests)) {
        assert.equal(response.status, 410);
        const body = (await response.json()) as {
          error: { code: string; replacement: string };
        };
        assert.equal(body.error.code, 'LEGACY_EXECUTION_DISABLED');
        assert.equal(body.error.replacement, 'POST /v1/runs');
      }
    });
  });

  it('disables legacy saga resume and fork even when the router is mounted directly', async () => {
    const app = express();
    app.use(express.json());
    app.use(createSagaRouter());

    await withApp(app, async (baseUrl) => {
      for (const request of [
        { path: '/api/saga/runs/run-1/resume', body: {} },
        { path: '/api/saga/runs/run-1/fork', body: { nodeId: 'step-1' } },
      ]) {
        const response = await fetch(`${baseUrl}${request.path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request.body),
        });
        const body = (await response.json()) as {
          error?: { code?: string; replacement?: string };
        };
        assert.equal(response.status, 410, request.path);
        assert.equal(body.error?.code, 'LEGACY_EXECUTION_DISABLED');
        assert.equal(body.error?.replacement, 'POST /v1/runs');
      }
    });
  });
});
