import { describe, it, expect, afterEach } from 'vitest';
import * as selfsigned from 'selfsigned';
import * as https from 'node:https';
import { MtlsRuntimeServer } from '../../src/runtime/mtlsRuntimeServer';
import { MtlsRuntimeProxy } from '../../src/runtime/mtlsRuntimeProxy';
import type { AgentRuntimeInterface } from '../../src/runtime/agentRuntimeInterface';
import type {
  AgentExecutionContext,
  AgentExecutionResult,
} from '../../src/runtime/types/execution';

// Server port races under concurrent execution; force sequential.
export const config = { sequence: { concurrent: false } };

async function generateTestCerts() {
  const ca = await selfsigned.generate([{ name: 'commonName', value: 'test-ca' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ],
  });

  const server = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
    ca: { key: ca.private, cert: ca.cert },
  });

  const client = await selfsigned.generate([{ name: 'commonName', value: 'commander-frontend' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', clientAuth: true },
    ],
    ca: { key: ca.private, cert: ca.cert },
  });

  return {
    ca: ca.cert,
    serverCert: server.cert,
    serverKey: server.private,
    clientCert: client.cert,
    clientKey: client.private,
  };
}

function makeStubRuntime(result: AgentExecutionResult): AgentRuntimeInterface {
  return {
    execute: async (_ctx: AgentExecutionContext) => result,
    registerProvider: () => {},
    registerTool: () => {},
    getProvider: () => undefined,
    getSmartRouter: () => null,
    getTool: () => undefined,
    getConfig: () =>
      ({
        defaultModelTier: 'balanced',
        maxStepsPerRun: 10,
        maxRetries: 2,
        retryDelayMs: 1000,
        timeoutMs: 30000,
      }) as any,
    getMemoryStore: () => null,
    getCheckpointer: () => {
      throw new Error('not serializable');
    },
    getInbox: () => {
      throw new Error('not serializable');
    },
    getTeamRegistry: () => {
      throw new Error('not serializable');
    },
    getHandoff: () => {
      throw new Error('not serializable');
    },
    getExecutionScheduler: () => {
      throw new Error('not serializable');
    },
    getCompensationRegistry: () => {
      throw new Error('not serializable');
    },
    getReliabilityEngine: () => {
      throw new Error('not serializable');
    },
    cancelAllSteps: () => 0,
    getStepTimeoutManager: () => {
      throw new Error('not serializable');
    },
    listUnfinishedRuns: () => [],
    resume: async () => null,
    listResumableRuns: () => [],
    pauseRun: () => true,
    unpauseRun: () => {},
    isPaused: () => false,
    getActiveRuns: () => [],
    getActiveRunCount: () => 0,
    isRunActive: () => false,
    getSemanticCacheStats: () => ({ hitCount: 0, missCount: 0 }) as any,
    getSingleFlightStats: () => ({ deduped: 0 }) as any,
    getGeminiCacheStats: () => ({ cachedCount: 0 }) as any,
    getCostEstimatorHistory: () => [],
    getProviderHealth: () => [],
    listToolNames: () => ['web_search', 'file_read'],
    dispose: () => {},
  };
}

describe('MtlsRuntime IPC', () => {
  let server: MtlsRuntimeServer | null = null;
  let proxy: MtlsRuntimeProxy | null = null;

  afterEach(async () => {
    proxy?.dispose();
    if (server) await server.stop();
    server = null;
    proxy = null;
  });

  it('forwards execute() over mTLS and returns the remote result', async () => {
    const certs = await generateTestCerts();
    const expected: AgentExecutionResult = {
      runId: 'run-1',
      agentId: 'agent-1',
      status: 'success',
      summary: 'executed over mTLS',
      steps: [],
      totalTokenUsage: { prompt: 10, completion: 5, total: 15 },
      totalDurationMs: 42,
    };
    const runtime = makeStubRuntime(expected);

    server = new MtlsRuntimeServer(runtime, {
      port: 0,
      host: '127.0.0.1',
      cert: certs.serverCert,
      key: certs.serverKey,
      ca: certs.ca,
    });
    await server.start();

    proxy = new MtlsRuntimeProxy({
      baseUrl: `https://localhost:${server.getPort()}`,
      cert: certs.clientCert,
      key: certs.clientKey,
      ca: certs.ca,
      timeoutMs: 5000,
    });

    const ctx: AgentExecutionContext = {
      agentId: 'agent-1',
      projectId: 'test',
      goal: 'prove mTLS works',
      availableTools: [],
      maxSteps: 1,
      tokenBudget: 100,
      contextData: {},
    };
    const result = await proxy.execute(ctx);
    expect(result.status).toBe('success');
    expect(result.summary).toBe('executed over mTLS');
  });

  it('rejects a client with an untrusted certificate', async () => {
    const certs = await generateTestCerts();
    const otherCa = await selfsigned.generate([{ name: 'commonName', value: 'evil-ca' }], {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{ name: 'basicConstraints', cA: true, critical: true }],
    });
    const evilClient = await selfsigned.generate([{ name: 'commonName', value: 'evil-client' }], {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'extKeyUsage', clientAuth: true },
      ],
      ca: { key: otherCa.private, cert: otherCa.cert },
    });

    const runtime = makeStubRuntime({} as AgentExecutionResult);
    server = new MtlsRuntimeServer(runtime, {
      port: 0,
      host: '127.0.0.1',
      cert: certs.serverCert,
      key: certs.serverKey,
      ca: certs.ca,
    });
    await server.start();

    proxy = new MtlsRuntimeProxy({
      baseUrl: `https://localhost:${server.getPort()}`,
      cert: evilClient.cert,
      key: evilClient.private,
      ca: certs.ca,
      timeoutMs: 2000,
    });

    // Use execute() (async path) instead of a sync getter: the proxy's
    // rpcSync busy-wait blocks the event loop, which would otherwise mask
    // the TLS rejection behind a full timeoutMs wait. execute() resolves
    // through the rpc() promise's req.on('error') immediately when the
    // server refuses the untrusted cert at the handshake.
    await expect(
      proxy.execute({
        agentId: 'agent-1',
        projectId: 'cert-rejection-test',
        goal: 'never executes',
        availableTools: [],
        maxSteps: 1,
        tokenBudget: 100,
        contextData: {},
      }),
    ).rejects.toThrow();
  });

  it('rejects disallowed methods at the server boundary', async () => {
    const certs = await generateTestCerts();
    const runtime = makeStubRuntime({} as AgentExecutionResult);
    server = new MtlsRuntimeServer(runtime, {
      port: 0,
      host: '127.0.0.1',
      cert: certs.serverCert,
      key: certs.serverKey,
      ca: certs.ca,
    });
    await server.start();

    const body = JSON.stringify({ method: 'registerTool', args: [] });
    const response = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = https.request(
        {
          hostname: '127.0.0.1',
          port: server.getPort(),
          path: '/rpc',
          method: 'POST',
          cert: certs.clientCert,
          key: certs.clientKey,
          ca: certs.ca,
          rejectUnauthorized: true,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          // Drain the response body so 'end' fires; otherwise resolve hangs
          // on chunked TLS streams and the assertion never runs.
          res.on('data', () => {
            /* drain */
          });
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0 }));
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    expect(response.statusCode).toBe(403);
  });
});
