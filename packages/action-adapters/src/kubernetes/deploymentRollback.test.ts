import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AdapterExecutionError } from '@commander/effect-broker';
import { createKubernetesDeploymentRollbackAdapter } from './deploymentRollback.js';
import type { AdapterCredentialProvider } from '../types.js';

const input = {
  tenantId: 'tenant-a',
  effectId: 'effect-1',
  idempotencyKey: 'idem-1',
  destination: 'k8s://cluster-a/team-a/deployments/api',
  signal: new AbortController().signal,
};

function credentials(
  overrides: Partial<AdapterCredentialProvider> = {},
): AdapterCredentialProvider {
  return {
    getGitHubToken: async () => 'github',
    getServiceNowCredentials: async () => ({ instance: 'dev', username: 'u', password: 'p' }),
    getKubernetesCredentials: async () => ({
      cluster: 'cluster-a',
      server: 'https://kube.example',
      token: 'kube-token',
    }),
    ...overrides,
  };
}

describe('Kubernetes deployment rollback adapter', () => {
  it('fails closed when credentials are unavailable', async () => {
    const adapter = createKubernetesDeploymentRollbackAdapter({
      credentials: credentials({ getKubernetesCredentials: undefined }),
    });
    await assert.rejects(
      () => adapter.execute({ ...input, args: { targetRevision: '12', reason: 'rollback' } }),
      /Kubernetes credentials are not configured/,
    );
  });

  it('patches only the destination deployment and rollback fields', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = createKubernetesDeploymentRollbackAdapter({
      credentials: credentials(),
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        if (String(url).includes('/replicasets?')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  metadata: {
                    name: 'api-12',
                    annotations: { 'deployment.kubernetes.io/revision': '12' },
                    ownerReferences: [{ uid: 'deploy-uid' }],
                  },
                  spec: {
                    template: {
                      metadata: { labels: { app: 'api' } },
                      spec: { containers: [{ name: 'api', image: 'api:v12' }] },
                    },
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            metadata: { name: 'api', uid: 'deploy-uid', generation: 2 },
            spec: {
              replicas: 1,
              selector: { matchLabels: { app: 'api' } },
              template: { metadata: { annotations: {} } },
            },
            status: { observedGeneration: 2, updatedReplicas: 1, readyReplicas: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const result = await adapter.execute({
      ...input,
      args: { targetRevision: '12', reason: 'rollback' },
    });
    assert.equal(result.deployment, 'api');
    assert.equal(requests[0]?.init?.method, undefined);
    assert.equal(
      requests[2]?.url,
      'https://kube.example/apis/apps/v1/namespaces/team-a/replicasets?labelSelector=app%3Dapi',
    );
    assert.equal(requests[3]?.init?.method, 'PATCH');
    assert.equal(
      requests[3]?.url,
      'https://kube.example/apis/apps/v1/namespaces/team-a/deployments/api',
    );
    assert.deepEqual(JSON.parse(String(requests[3]?.init?.body)), {
      spec: {
        template: {
          metadata: {
            labels: { app: 'api' },
            annotations: {
              'commander.io/idempotency-key': 'idem-1',
              'commander.io/target-revision': '12',
              'commander.io/reason': 'rollback',
            },
          },
          spec: { containers: [{ name: 'api', image: 'api:v12' }] },
        },
      },
    });
  });

  it('lets a governed post-PATCH observer classify one committed rollback as unknown', async () => {
    const adapter = createKubernetesDeploymentRollbackAdapter({
      credentials: credentials(),
      afterPatchResponse: async (patch) => {
        assert.deepEqual(patch, {
          tenantId: 'tenant-a',
          effectId: 'effect-1',
          idempotencyKey: 'idem-1',
          destination: 'k8s://cluster-a/team-a/deployments/api',
        });
        throw new AdapterExecutionError('Governed fault after Kubernetes PATCH', {
          code: 'GOVERNED_TIMEOUT_AFTER_COMMIT',
          commitState: 'UNKNOWN',
          retryMode: 'QUERY_FIRST',
        });
      },
      fetch: async (url) => {
        if (String(url).includes('/replicasets?')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  metadata: {
                    annotations: { 'deployment.kubernetes.io/revision': '12' },
                    ownerReferences: [{ uid: 'deploy-uid' }],
                  },
                  spec: { template: { metadata: { labels: { app: 'api' } }, spec: {} } },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            metadata: { uid: 'deploy-uid' },
            spec: { selector: { matchLabels: { app: 'api' } }, template: { metadata: {} } },
          }),
          { status: 200 },
        );
      },
    });

    await assert.rejects(
      () => adapter.execute({ ...input, args: { targetRevision: '12', reason: 'rollback' } }),
      (error: unknown) =>
        error instanceof AdapterExecutionError &&
        error.commitState === 'UNKNOWN' &&
        error.retryMode === 'QUERY_FIRST' &&
        error.code === 'GOVERNED_TIMEOUT_AFTER_COMMIT',
    );
  });

  it('returns UNKNOWN until the deployment reports the requested revision', async () => {
    const adapter = createKubernetesDeploymentRollbackAdapter({
      credentials: credentials(),
      fetch: async () =>
        new Response(
          JSON.stringify({
            metadata: { generation: 2 },
            status: { observedGeneration: 1, updatedReplicas: 0 },
          }),
          { status: 200 },
        ),
    });
    const outcome = await adapter.queryOutcome({ ...input, request: {} });
    assert.deepEqual(outcome, { status: 'UNKNOWN' });
  });

  it('rejects a credential bound to another cluster', async () => {
    const adapter = createKubernetesDeploymentRollbackAdapter({
      credentials: credentials({
        getKubernetesCredentials: async () => ({
          cluster: 'other',
          server: 'https://kube.example',
          token: 'x',
        }),
      }),
    });
    await assert.rejects(
      () => adapter.queryOutcome({ ...input, request: {} }),
      /Kubernetes cluster credential mismatch/,
    );
  });
});
