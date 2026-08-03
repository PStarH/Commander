import assert from 'node:assert/strict';
import { describe } from 'node:test';
import {
  commanderActionMarker,
  compensationIdempotencyKey,
  githubPrBodyMarker,
  servicenowCorrelationId,
} from '@commander/contracts';
import { createGitHubPullRequestCreateAdapter } from '../github/pullRequestCreate.js';
import { createServiceNowIncidentCreateAdapter } from '../servicenow/incidentCreate.js';
import { createKubernetesDeploymentRollbackAdapter } from '../kubernetes/deploymentRollback.js';
import type { AdapterCredentialProvider, KubernetesCredentialProvider } from '../types.js';
import { registerConformanceSuite, type ConformanceAdapterFactory } from './suite.js';

const tenantId = 'tenant-a';
const idempotencyKey = 'conformance-idem';

function githubCredentials(): AdapterCredentialProvider {
  return {
    async getGitHubToken() {
      return 'gh-test-token';
    },
    async getServiceNowCredentials() {
      throw new Error('not used');
    },
  };
}

function serviceNowCredentials(): AdapterCredentialProvider {
  return {
    async getGitHubToken() {
      throw new Error('not used');
    },
    async getServiceNowCredentials() {
      return { instance: 'dev12345', username: 'admin', password: 'secret' };
    },
  };
}

const githubFactory: ConformanceAdapterFactory = {
  name: 'github.pull-request.create',
  createAdapter() {
    const counters = { createCount: 0, writeCount: 0, compensateCount: 0 };
    const pulls: Array<{
      number: number;
      html_url: string;
      state: string;
      title: string;
      body: string;
      head: { ref: string };
      base: { ref: string };
    }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/pulls?')) {
        return new Response(JSON.stringify(pulls), { status: 200 });
      }
      if (method === 'POST' && url.endsWith('/pulls')) {
        counters.createCount += 1;
        counters.writeCount += 1;
        const body = JSON.parse(String(init?.body)) as {
          title: string;
          body: string;
          head: string;
          base: string;
        };
        const created = {
          number: pulls.length + 1,
          html_url: `https://github.com/octo/repo/pull/${pulls.length + 1}`,
          state: 'open',
          title: body.title,
          body: body.body,
          head: { ref: body.head },
          base: { ref: body.base },
        };
        pulls.push(created);
        return new Response(JSON.stringify(created), { status: 201 });
      }
      if (method === 'PATCH' && /\/pulls\/\d+$/.test(url)) {
        counters.writeCount += 1;
        const prNumber = Number(url.split('/').pop());
        const pull = pulls.find((entry) => entry.number === prNumber);
        if (!pull) return new Response('not found', { status: 404 });
        if (pull.state !== 'closed') {
          counters.compensateCount += 1;
          pull.state = 'closed';
        }
        return new Response(JSON.stringify(pull), { status: 200 });
      }
      if (method === 'GET' && /\/pulls\/\d+$/.test(url)) {
        const prNumber = Number(url.split('/').pop());
        const pull = pulls.find((entry) => entry.number === prNumber);
        if (!pull) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify(pull), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    };
    return {
      adapter: createGitHubPullRequestCreateAdapter({
        credentials: githubCredentials(),
        fetch: fetchImpl,
      }),
      counters,
      destination: 'github://octo/repo/pulls',
      executeArgs: { title: 'Conformance PR', body: 'body', head: 'feature', base: 'main' },
      queryRequest: { head: 'feature', base: 'main' },
      compensationPatch: {},
    };
  },
  createAuthFailureAdapter() {
    return createGitHubPullRequestCreateAdapter({
      credentials: githubCredentials(),
      fetch: async () => new Response('forbidden', { status: 403 }),
    });
  },
  createMultiMarkerContext() {
    const marker = githubPrBodyMarker(tenantId, idempotencyKey);
    const counters = { createCount: 0, writeCount: 0, compensateCount: 0 };
    const pulls = [
      {
        number: 1,
        html_url: 'https://github.com/octo/repo/pull/1',
        state: 'open',
        body: marker,
        head: { ref: 'feature' },
        base: { ref: 'main' },
      },
      {
        number: 2,
        html_url: 'https://github.com/octo/repo/pull/2',
        state: 'open',
        body: marker,
        head: { ref: 'feature' },
        base: { ref: 'main' },
      },
    ];
    return {
      adapter: createGitHubPullRequestCreateAdapter({
        credentials: githubCredentials(),
        fetch: async (input, init) => {
          if ((init?.method ?? 'GET') === 'GET' && String(input).includes('/pulls?')) {
            return new Response(JSON.stringify(pulls), { status: 200 });
          }
          return new Response('unexpected', { status: 500 });
        },
      }),
      counters,
      destination: 'github://octo/repo/pulls',
      executeArgs: { title: 'Conformance PR', body: 'body', head: 'feature', base: 'main' },
      queryRequest: { head: 'feature', base: 'main' },
      compensationPatch: {},
    };
  },
};

const serviceNowFactory: ConformanceAdapterFactory = {
  name: 'servicenow.incident.create',
  createAdapter() {
    const counters = { createCount: 0, writeCount: 0, compensateCount: 0 };
    const incidents: Array<{
      sys_id: string;
      number: string;
      state: string;
      correlation_id: string;
      short_description: string;
      description: string;
    }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/api/now/table/incident?')) {
        return new Response(JSON.stringify({ result: incidents }), { status: 200 });
      }
      if (method === 'POST' && url.endsWith('/api/now/table/incident')) {
        counters.createCount += 1;
        counters.writeCount += 1;
        const body = JSON.parse(String(init?.body)) as {
          short_description: string;
          description: string;
          correlation_id: string;
        };
        const created = {
          sys_id: `sys-${incidents.length + 1}`,
          number: `INC${incidents.length + 1}`,
          state: '1',
          correlation_id: body.correlation_id,
          short_description: body.short_description,
          description: body.description,
        };
        incidents.push(created);
        return new Response(JSON.stringify({ result: created }), { status: 201 });
      }
      if (method === 'PATCH' && /\/incident\/sys-/.test(url)) {
        counters.writeCount += 1;
        const sysId = url.split('/').pop()!;
        const incident = incidents.find((entry) => entry.sys_id === sysId);
        if (!incident) return new Response('not found', { status: 404 });
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (typeof patch.state === 'string' && incident.state !== patch.state) {
          counters.compensateCount += 1;
          incident.state = patch.state;
        }
        return new Response(JSON.stringify({ result: incident }), { status: 200 });
      }
      if (method === 'GET' && /\/incident\/sys-/.test(url)) {
        const sysId = url.split('/').pop()!;
        const incident = incidents.find((entry) => entry.sys_id === sysId);
        if (!incident) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify({ result: incident }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    };
    return {
      adapter: createServiceNowIncidentCreateAdapter({
        credentials: serviceNowCredentials(),
        fetch: fetchImpl,
      }),
      counters,
      destination: 'servicenow://dev12345/incident',
      executeArgs: { short_description: 'Conformance incident', description: 'details' },
      queryRequest: {},
      compensationPatch: { state: '7' },
    };
  },
  createAuthFailureAdapter() {
    return createServiceNowIncidentCreateAdapter({
      credentials: serviceNowCredentials(),
      fetch: async () => new Response('unauthorized', { status: 401 }),
    });
  },
  createMultiMarkerContext() {
    const correlationId = servicenowCorrelationId(tenantId, idempotencyKey);
    const counters = { createCount: 0, writeCount: 0, compensateCount: 0 };
    const incidents = [
      {
        sys_id: 'sys-1',
        number: 'INC1',
        state: '1',
        correlation_id: correlationId,
        short_description: 'a',
        description: 'a',
      },
      {
        sys_id: 'sys-2',
        number: 'INC2',
        state: '1',
        correlation_id: correlationId,
        short_description: 'b',
        description: 'b',
      },
    ];
    return {
      adapter: createServiceNowIncidentCreateAdapter({
        credentials: serviceNowCredentials(),
        fetch: async (input, init) => {
          if (
            (init?.method ?? 'GET') === 'GET' &&
            String(input).includes('/api/now/table/incident?')
          ) {
            return new Response(JSON.stringify({ result: incidents }), { status: 200 });
          }
          return new Response('unexpected', { status: 500 });
        },
      }),
      counters,
      destination: 'servicenow://dev12345/incident',
      executeArgs: { short_description: 'Conformance incident', description: 'details' },
      queryRequest: {},
      compensationPatch: { state: '7' },
    };
  },
};

const kubernetesFactory: ConformanceAdapterFactory = {
  name: 'kubernetes.deployment.rollback',
  createAdapter() {
    const counters = { createCount: 0, writeCount: 0, compensateCount: 0 };
    let timeoutNextRollback = false;
    let deployment = {
      revision: '9',
      template: {
        metadata: { labels: { app: 'api' } },
        spec: { containers: [{ name: 'api', image: 'example/api:v2' }] },
      },
      annotations: {} as Record<string, string>,
      generation: 2,
    };
    const targetTemplate = {
      metadata: { labels: { app: 'api' } },
      spec: { containers: [{ name: 'api', image: 'example/api:v1' }] },
    };
    const provider: KubernetesCredentialProvider = {
      async getToken(requestTenant, cluster, namespace) {
        assert.equal(requestTenant, tenantId);
        assert.equal(cluster, 'kind');
        assert.equal(namespace, 'commander');
        return 'k8s-test-token';
      },
      getServer(requestTenant, cluster, namespace) {
        assert.equal(requestTenant, tenantId);
        assert.equal(cluster, 'kind');
        assert.equal(namespace, 'commander');
        return new URL('https://kubernetes.example');
      },
    };
    const wireDeployment = () =>
      Response.json({
        items: [
          {
            metadata: {
              name: 'api',
              namespace: 'commander',
              uid: 'uid-api',
              resourceVersion: '100',
              generation: deployment.generation,
              annotations: {
                'deployment.kubernetes.io/revision': deployment.revision,
                ...deployment.annotations,
              },
            },
            spec: { selector: { matchLabels: { app: 'api' } }, template: deployment.template },
            status: {
              observedGeneration: deployment.generation,
              replicas: 1,
              updatedReplicas: 1,
              availableReplicas: 1,
              unavailableReplicas: 0,
            },
          },
        ],
      });
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer k8s-test-token');
      if (method === 'GET' && url.pathname.endsWith('/deployments')) return wireDeployment();
      if (method === 'GET' && url.pathname.endsWith('/replicasets')) {
        return Response.json({
          items: [
            {
              metadata: {
                annotations: { 'deployment.kubernetes.io/revision': '7' },
                ownerReferences: [{ kind: 'Deployment', uid: 'uid-api' }],
              },
              spec: { template: targetTemplate },
            },
            {
              metadata: {
                annotations: { 'deployment.kubernetes.io/revision': '9' },
                ownerReferences: [{ kind: 'Deployment', uid: 'uid-api' }],
              },
              spec: { template: deployment.template },
            },
          ],
        });
      }
      if (method === 'PATCH' && url.pathname.endsWith('/api')) {
        counters.writeCount += 1;
        const metadata = (body.metadata ?? {}) as Record<string, unknown>;
        const annotations = (metadata.annotations ?? {}) as Record<string, string>;
        Object.assign(deployment.annotations, annotations);
        if (body.spec) {
          counters.compensateCount += deployment.annotations['commander.io/compensation-marker']
            ? 1
            : 0;
          deployment.template = (body.spec as Record<string, unknown>).template as Record<
            string,
            unknown
          >;
          deployment.revision = String(Number(deployment.revision) + 1);
          deployment.generation += 1;
          const response = Response.json({
            metadata: {
              name: 'api',
              namespace: 'commander',
              uid: 'uid-api',
              resourceVersion: '101',
              generation: deployment.generation,
              annotations: {
                'deployment.kubernetes.io/revision': deployment.revision,
                ...deployment.annotations,
              },
            },
            spec: { selector: { matchLabels: { app: 'api' } }, template: deployment.template },
            status: {
              observedGeneration: deployment.generation,
              replicas: 1,
              updatedReplicas: 1,
              availableReplicas: 1,
              unavailableReplicas: 0,
            },
          });
          if (timeoutNextRollback) {
            timeoutNextRollback = false;
            throw new DOMException('accepted but timed out', 'AbortError');
          }
          return response;
        }
        counters.createCount += deployment.annotations['commander.io/action-marker'] ? 1 : 0;
        return Response.json({
          metadata: {
            name: 'api',
            namespace: 'commander',
            uid: 'uid-api',
            resourceVersion: '101',
            generation: deployment.generation,
            annotations: {
              'deployment.kubernetes.io/revision': deployment.revision,
              ...deployment.annotations,
            },
          },
          spec: { selector: { matchLabels: { app: 'api' } }, template: deployment.template },
          status: {
            observedGeneration: deployment.generation,
            replicas: 1,
            updatedReplicas: 1,
            availableReplicas: 1,
            unavailableReplicas: 0,
          },
        });
      }
      return new Response('{}', { status: 404 });
    };
    return {
      adapter: createKubernetesDeploymentRollbackAdapter({
        credentials: provider,
        fetch: fetchImpl,
      }),
      counters,
      destination: 'k8s://kind/commander/deployments/api',
      executeArgs: { targetRevision: '7', reason: 'conformance rollback' },
      queryRequest: { args: { targetRevision: '7' } },
      compensationPatch: { targetRevision: '9', reason: 'conformance compensation' },
      prepareTimeout: () => {
        timeoutNextRollback = true;
      },
    };
  },
  createAuthFailureAdapter() {
    return createKubernetesDeploymentRollbackAdapter({
      credentials: {
        async getToken() {
          return 'k8s-test-token';
        },
        getServer() {
          return new URL('https://kubernetes.example');
        },
      },
      fetch: async () => new Response('{}', { status: 403 }),
    });
  },
  createMultiMarkerContext() {
    const marker = commanderActionMarker(tenantId, idempotencyKey);
    return {
      counters: { createCount: 0, writeCount: 0, compensateCount: 0 },
      destination: 'k8s://kind/commander/deployments/api',
      executeArgs: { targetRevision: '7', reason: 'conformance rollback' },
      queryRequest: { args: { targetRevision: '7' } },
      compensationPatch: { targetRevision: '9', reason: 'conformance compensation' },
      adapter: createKubernetesDeploymentRollbackAdapter({
        credentials: {
          async getToken() {
            return 'k8s-test-token';
          },
          getServer() {
            return new URL('https://kubernetes.example');
          },
        },
        fetch: async (input, init) => {
          if ((init?.method ?? 'GET') === 'GET' && String(input).includes('/deployments')) {
            return Response.json({
              items: [
                {
                  metadata: {
                    name: 'api',
                    namespace: 'commander',
                    uid: 'uid-api',
                    generation: 2,
                    annotations: {
                      'commander.io/action-marker': marker,
                      'deployment.kubernetes.io/revision': '7',
                    },
                  },
                  spec: {
                    selector: { matchLabels: { app: 'api' } },
                    template: { metadata: { labels: { app: 'api' } } },
                  },
                  status: {
                    observedGeneration: 2,
                    replicas: 1,
                    updatedReplicas: 1,
                    availableReplicas: 1,
                    unavailableReplicas: 0,
                  },
                },
                {
                  metadata: {
                    name: 'api-copy',
                    namespace: 'commander',
                    uid: 'uid-copy',
                    generation: 2,
                    annotations: {
                      'commander.io/action-marker': marker,
                      'deployment.kubernetes.io/revision': '7',
                    },
                  },
                  spec: {
                    selector: { matchLabels: { app: 'api-copy' } },
                    template: { metadata: { labels: { app: 'api-copy' } } },
                  },
                  status: {
                    observedGeneration: 2,
                    replicas: 1,
                    updatedReplicas: 1,
                    availableReplicas: 1,
                    unavailableReplicas: 0,
                  },
                },
              ],
            });
          }
          return new Response('{}', { status: 500 });
        },
      }),
    };
  },
};

describe('L4-02 adapter conformance suite', () => {
  registerConformanceSuite({ factory: githubFactory });
  registerConformanceSuite({ factory: serviceNowFactory });
  registerConformanceSuite({ factory: kubernetesFactory });
});
