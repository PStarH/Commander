import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createTask1KubernetesProofApi,
  parseTask1ProjectedTokenIdentity,
} from './task1KubernetesProofRuntime.js';

const audience = 'commander-tenant-cutover-proof/v1';

function token(overrides: Record<string, unknown> = {}): string {
  const payload = {
    aud: [audience],
    exp: 1785258600,
    iat: 1785258000,
    iss: 'https://kubernetes.default.svc.cluster.local',
    sub: 'system:serviceaccount:commander:commander-proof-reader-c48e77f6d68ea66c',
    'kubernetes.io': {
      namespace: 'commander',
      pod: { name: 'proof-pod', uid: 'proof-pod-uid' },
      serviceaccount: {
        name: 'commander-proof-reader-c48e77f6d68ea66c',
        uid: 'proof-reader-uid',
      },
    },
    ...overrides,
  };
  return [
    Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

function tlsFixture(): { directory: string; cert: Buffer; key: Buffer } {
  const directory = mkdtempSync(join(tmpdir(), 'commander-kube-proof-'));
  const keyFile = join(directory, 'tls.key');
  const certFile = join(directory, 'tls.crt');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-new',
      '-nodes',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-keyout',
      keyFile,
      '-out',
      certFile,
    ],
    { stdio: 'ignore' },
  );
  return { directory, cert: readFileSync(certFile), key: readFileSync(keyFile) };
}

describe('Task 1 Kubernetes proof runtime', () => {
  it('derives only the bound proof-reader Pod identity from the projected JWT', () => {
    assert.deepEqual(parseTask1ProjectedTokenIdentity(token()), {
      audience,
      issuedAt: '2026-07-28T17:00:00.000Z',
      expiresAt: '2026-07-28T17:10:00.000Z',
      namespace: 'commander',
      serviceAccountName: 'commander-proof-reader-c48e77f6d68ea66c',
      podName: 'proof-pod',
      podUid: 'proof-pod-uid',
    });
    assert.throws(
      () => parseTask1ProjectedTokenIdentity(token({ aud: [audience, 'other'] })),
      /TENANT_CUTOVER_KUBERNETES_TOKEN_INVALID/,
    );
    assert.throws(
      () =>
        parseTask1ProjectedTokenIdentity(token({ sub: 'system:serviceaccount:commander:default' })),
      /TENANT_CUTOVER_KUBERNETES_TOKEN_INVALID/,
    );
  });

  it('accepts a pod-bound token whose expiration Kubernetes extends beyond the requested lifetime', () => {
    assert.deepEqual(parseTask1ProjectedTokenIdentity(token({ exp: 1816794000 })), {
      audience,
      issuedAt: '2026-07-28T17:00:00.000Z',
      expiresAt: '2027-07-28T17:00:00.000Z',
      namespace: 'commander',
      serviceAccountName: 'commander-proof-reader-c48e77f6d68ea66c',
      podName: 'proof-pod',
      podUid: 'proof-pod-uid',
    });
  });

  it('reads exact Kubernetes resources over authenticated cluster-CA HTTPS', async () => {
    const fixture = tlsFixture();
    const kubernetesApiToken = token({ aud: ['https://kubernetes.default.svc'] });
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const server = createServer({ cert: fixture.cert, key: fixture.key }, (request, response) => {
      requests.push({
        url: request.url ?? '',
        authorization: request.headers.authorization,
      });
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ metadata: { name: 'release-a-api-proof' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const api = createTask1KubernetesProofApi({
        hostname: 'localhost',
        port: address.port,
        readToken: async () => kubernetesApiToken,
        readCa: async () => fixture.cert,
      });
      assert.deepEqual(
        await api.read({
          resource: 'service',
          namespace: 'commander',
          name: 'release-a-api-proof',
          audience,
        }),
        { metadata: { name: 'release-a-api-proof' } },
      );
      assert.deepEqual(
        await api.read({
          resource: 'pods',
          namespace: 'commander',
          audience,
          selector: {
            'app.kubernetes.io/instance': 'release-a',
            'app.kubernetes.io/component': 'api',
          },
        }),
        { metadata: { name: 'release-a-api-proof' } },
      );
      assert.deepEqual(requests, [
        {
          url: '/api/v1/namespaces/commander/services/release-a-api-proof',
          authorization: `Bearer ${kubernetesApiToken}`,
        },
        {
          url: '/api/v1/namespaces/commander/pods?labelSelector=app.kubernetes.io%2Fcomponent%3Dapi%2Capp.kubernetes.io%2Finstance%3Drelease-a',
          authorization: `Bearer ${kubernetesApiToken}`,
        },
      ]);
      await assert.rejects(
        () => api.read({ resource: 'service', namespace: '../other', name: 'x', audience }),
        /TENANT_CUTOVER_KUBERNETES_REQUEST_INVALID/,
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
});
