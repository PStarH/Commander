import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import express from 'express';
import { createV1GatewayRouter } from '../src/v1GatewayEndpoints.js';
import type { V1KernelGateway } from '../src/v1GatewayKernel.js';
import {
  buildEffectCatalogDocument,
  NEVER_LOCAL_ONLY_TOOLS,
  validateStepsAgainstEffectCatalog,
  verifyCatalogSignature,
} from '../src/effectCatalog.js';

class FakeGateway implements V1KernelGateway {
  private readonly runs = new Map<string, any>();
  async submit(input: any) {
    const id = `run-${input.idempotencyKey}`;
    const old = this.runs.get(id);
    if (old) return { run: old, created: false };
    const timestamp = new Date().toISOString();
    const run = {
      id,
      tenantId: input.tenantId,
      state: 'PENDING',
      createdAt: timestamp,
      updatedAt: timestamp,
      intentHash: 'intent',
      workGraphHash: 'graph',
      workGraphVersion: input.workGraphVersion,
      policySnapshotId: input.policySnapshotId,
    };
    this.runs.set(id, run);
    return { run, created: true };
  }
  async getRun(runId: string, tenantId: string) {
    const value = this.runs.get(runId);
    return value?.tenantId === tenantId ? value : null;
  }
  async listEvents() {
    return [];
  }
  async pauseRun() {
    return null;
  }
  async resumeRun() {
    return null;
  }
  async cancelRun() {
    return null;
  }
}

async function withGateway(
  kernel: V1KernelGateway | null,
  action: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const prev = process.env.COMMANDER_DEFAULT_POLICY_SNAPSHOT_ID;
  process.env.COMMANDER_DEFAULT_POLICY_SNAPSHOT_ID = 'policy-test';
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).tenantId = 'tenant-a';
    (req as any).apiKeyId = 'test-key';
    next();
  });
  app.use('/v1', createV1GatewayRouter(() => kernel));
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
    if (prev === undefined) delete process.env.COMMANDER_DEFAULT_POLICY_SNAPSHOT_ID;
    else process.env.COMMANDER_DEFAULT_POLICY_SNAPSHOT_ID = prev;
  }
}

describe('L3-03b-http effect-catalog', () => {
  it('GET /v1/effect-catalog returns hashed default allowlist', async () => {
    await withGateway(new FakeGateway(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/effect-catalog`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.deepEqual(body.tools, ['echo']);
      assert.deepEqual(body.connectors, ['memory']);
      assert.equal(typeof body.contentHash, 'string');
      assert.equal(body.contentHash.length, 64);
    });
  });

  it('rejects forged localOnly tool at admit', async () => {
    await withGateway(new FakeGateway(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'key-localonly-1',
        },
        body: JSON.stringify({
          goal: 'forge',
          steps: [
            {
              kind: 'tool',
              input: { toolName: 'http.post', localOnly: true, args: {} },
            },
          ],
        }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as any;
      assert.equal(body.error.code, 'LOCALONLY_NOT_IN_CATALOG');
    });
  });

  it('allows catalog-authorized echo localOnly', async () => {
    await withGateway(new FakeGateway(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'key-localonly-2',
        },
        body: JSON.stringify({
          goal: 'echo ok',
          steps: [
            {
              kind: 'tool',
              input: { toolName: 'echo', localOnly: true, args: { text: 'hi' } },
            },
          ],
        }),
      });
      assert.equal(res.status, 202);
    });
  });

  it('rejects forged localOnly connector at admit', async () => {
    await withGateway(new FakeGateway(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'key-localonly-conn-1',
        },
        body: JSON.stringify({
          goal: 'forge connector',
          steps: [
            {
              kind: 'connector',
              input: { connectorName: 'postgres', localOnly: true },
            },
          ],
        }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as any;
      assert.equal(body.error.code, 'LOCALONLY_NOT_IN_CATALOG');
    });
  });

  it('rejects connector localOnly with connection at admit', async () => {
    await withGateway(new FakeGateway(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'key-localonly-conn-2',
        },
        body: JSON.stringify({
          goal: 'connection forbidden',
          steps: [
            {
              kind: 'connector',
              input: {
                connectorName: 'memory',
                localOnly: true,
                connection: { host: 'db' },
              },
            },
          ],
        }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as any;
      assert.equal(body.error.code, 'LOCALONLY_CONNECTION_FORBIDDEN');
    });
  });

  it('validateStepsAgainstEffectCatalog pure helper', () => {
    const catalog = buildEffectCatalogDocument({
      version: 'v0',
      tools: ['echo'],
      connectors: ['memory'],
    });
    assert.equal(
      validateStepsAgainstEffectCatalog(
        [{ kind: 'tool', input: { toolName: 'echo', localOnly: true } }],
        catalog,
      ),
      null,
    );
    assert.equal(
      validateStepsAgainstEffectCatalog(
        [{ kind: 'tool', input: { toolName: 'http.post', localOnly: true } }],
        catalog,
      )?.code,
      'LOCALONLY_NOT_IN_CATALOG',
    );
    assert.equal(
      validateStepsAgainstEffectCatalog(
        [{ kind: 'connector', input: { connectorName: 'postgres', localOnly: true } }],
        catalog,
      )?.code,
      'LOCALONLY_NOT_IN_CATALOG',
    );
    assert.equal(
      validateStepsAgainstEffectCatalog(
        [
          {
            kind: 'connector',
            input: { connectorName: 'memory', localOnly: true, connection: {} },
          },
        ],
        catalog,
      )?.code,
      'LOCALONLY_CONNECTION_FORBIDDEN',
    );
  });

  it('NEVER_LOCAL_ONLY strips env-injected http.post and rejects admit', () => {
    assert.ok(NEVER_LOCAL_ONLY_TOOLS.has('http.post'));
    const catalog = buildEffectCatalogDocument({
      version: 'v0',
      tools: ['echo', 'http.post', 'shell.exec'],
      connectors: ['memory', 'http', 'smtp'],
    });
    assert.deepEqual(catalog.tools, ['echo']);
    assert.deepEqual(catalog.connectors, ['memory']);
    assert.equal(
      validateStepsAgainstEffectCatalog(
        [{ kind: 'tool', input: { toolName: 'http.post', localOnly: true } }],
        catalog,
      )?.code,
      'LOCALONLY_NOT_IN_CATALOG',
    );
    assert.equal(
      validateStepsAgainstEffectCatalog(
        [{ kind: 'connector', input: { connectorName: 'http', localOnly: true } }],
        catalog,
      )?.code,
      'LOCALONLY_NOT_IN_CATALOG',
    );
  });

  it('buildEffectCatalogDocument signs contentHash when HMAC secret set', () => {
    const catalog = buildEffectCatalogDocument(
      { version: 'v0', tools: ['echo'], connectors: ['memory'] },
      { COMMANDER_EFFECT_CATALOG_HMAC_SECRET: 'gw-secret' },
    );
    assert.equal(typeof catalog.signature, 'string');
    assert.equal(catalog.signature?.length, 64);
    assert.equal(
      verifyCatalogSignature(catalog, 'gw-secret'),
      true,
    );
    assert.equal(verifyCatalogSignature(catalog, 'wrong'), false);
  });
});