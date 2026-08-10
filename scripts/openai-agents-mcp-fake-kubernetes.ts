#!/usr/bin/env tsx

import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

const port = Number(process.env.OPENAI_AGENTS_MCP_FAKE_KUBERNETES_PORT ?? '4104');
const certFile = process.env.OPENAI_AGENTS_MCP_FAKE_KUBERNETES_CERT_FILE;
const keyFile = process.env.OPENAI_AGENTS_MCP_FAKE_KUBERNETES_KEY_FILE;
const holdForwardResponse =
  process.env.OPENAI_AGENTS_MCP_FAKE_KUBERNETES_HOLD_FORWARD_RESPONSE === '1';
if (!certFile || !keyFile) {
  throw new Error(
    'OPENAI_AGENTS_MCP_FAKE_KUBERNETES_CERT_FILE and OPENAI_AGENTS_MCP_FAKE_KUBERNETES_KEY_FILE are required',
  );
}
const collection = '/apis/apps/v1/namespaces/commander/deployments';
const deploymentPath = `${collection}/api`;
const templateV1 = {
  metadata: { labels: { app: 'api' } },
  spec: { containers: [{ name: 'api', image: 'example/api:v1' }] },
};
const templateV2 = {
  metadata: { labels: { app: 'api' } },
  spec: { containers: [{ name: 'api', image: 'example/api:v2' }] },
};

const state = {
  revision: '2',
  resourceVersion: 100,
  generation: 2,
  template: templateV2,
  annotations: { 'deployment.kubernetes.io/revision': '2' },
  rollbackWrites: 0,
  compensationWrites: 0,
  outcomeQueries: 0,
  responseLost: false,
  forwardCommitPending: false,
  forwardCommittedAt: null as string | null,
};

function deployment(): Record<string, unknown> {
  return {
    metadata: {
      name: 'api',
      namespace: 'commander',
      uid: 'fake-deployment-api',
      resourceVersion: String(state.resourceVersion),
      generation: state.generation,
      annotations: state.annotations,
    },
    spec: { selector: { matchLabels: { app: 'api' } }, template: state.template },
    status: {
      observedGeneration: state.generation,
      replicas: 1,
      updatedReplicas: 1,
      availableReplicas: 1,
      unavailableReplicas: 0,
    },
  };
}

function replicaSets(): Record<string, unknown>[] {
  return [
    {
      metadata: {
        name: 'api-v1',
        namespace: 'commander',
        annotations: { 'deployment.kubernetes.io/revision': '1' },
        ownerReferences: [{ kind: 'Deployment', uid: 'fake-deployment-api' }],
      },
      spec: { template: templateV1 },
    },
    {
      metadata: {
        name: 'api-v2',
        namespace: 'commander',
        annotations: { 'deployment.kubernetes.io/revision': '2' },
        ownerReferences: [{ kind: 'Deployment', uid: 'fake-deployment-api' }],
      },
      spec: { template: templateV2 },
    },
  ];
}

function sendJson(
  response: import('node:http').ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const server = createServer(
  { cert: readFileSync(certFile), key: readFileSync(keyFile), minVersion: 'TLSv1.2' },
  async (request, response) => {
    const method = request.method ?? 'GET';
    const path = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      .pathname;
    if (method === 'GET' && path === collection) {
      state.outcomeQueries += 1;
      sendJson(response, 200, { items: [deployment()] });
      return;
    }
    if (method === 'GET' && path === '/apis/apps/v1/namespaces/commander/replicasets') {
      sendJson(response, 200, { items: replicaSets() });
      return;
    }
    if (method === 'GET' && path === '/state') {
      sendJson(response, 200, state);
      return;
    }
    if (method === 'PATCH' && path === deploymentPath) {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const metadata = (body.metadata ?? {}) as Record<string, unknown>;
      const annotations = (metadata.annotations ?? {}) as Record<string, string>;
      Object.assign(state.annotations, annotations);
      state.resourceVersion += 1;
      if (body.spec && typeof body.spec === 'object') {
        state.template = (body.spec as Record<string, unknown>).template as typeof templateV1;
        state.generation += 1;
        state.revision = '3';
        state.annotations['deployment.kubernetes.io/revision'] = '3';
        const compensation = 'commander.io/compensation-marker' in state.annotations;
        if (compensation) state.compensationWrites += 1;
        else state.rollbackWrites += 1;
        if (!compensation && !state.responseLost) {
          state.responseLost = true;
          state.forwardCommittedAt = new Date().toISOString();
          if (holdForwardResponse) {
            state.forwardCommitPending = true;
            await new Promise<void>((resolve) => request.once('close', resolve));
            state.forwardCommitPending = false;
            return;
          }
          response.socket.destroy();
          return;
        }
      }
      sendJson(response, 200, deployment());
      return;
    }
    sendJson(response, 404, { error: 'NOT_FOUND' });
  },
);

server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`[fake-kubernetes] listening on https://localhost:${port}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
