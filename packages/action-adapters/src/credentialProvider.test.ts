import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EnvAdapterCredentialProvider, parseKubernetesDeploymentDestination } from './types.js';

describe('EnvAdapterCredentialProvider', () => {
  it('requires cell tenant id at construction', () => {
    assert.throws(
      () => new EnvAdapterCredentialProvider({ cellTenantId: '' }),
      /COMMANDER_CELL_TENANT_ID/,
    );
  });

  it('rejects tenant id mismatch fail-closed', async () => {
    const provider = new EnvAdapterCredentialProvider({ cellTenantId: 'tenant-a' });
    await assert.rejects(
      () => provider.getGitHubToken('tenant-b', 'github://octo/repo/pulls'),
      /Tenant credential isolation/,
    );
  });

  it('returns github token for matching tenant without logging value', async () => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'gh-secret-token';
    try {
      const provider = new EnvAdapterCredentialProvider({ cellTenantId: 'tenant-a' });
      const token = await provider.getGitHubToken('tenant-a', 'github://octo/repo/pulls');
      assert.equal(token, 'gh-secret-token');
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });

  it('returns servicenow credentials when instance matches destination', async () => {
    const prev = {
      instance: process.env.SERVICENOW_INSTANCE,
      username: process.env.SERVICENOW_USERNAME,
      password: process.env.SERVICENOW_PASSWORD,
    };
    process.env.SERVICENOW_INSTANCE = 'dev12345';
    process.env.SERVICENOW_USERNAME = 'admin';
    process.env.SERVICENOW_PASSWORD = 'secret';
    try {
      const provider = new EnvAdapterCredentialProvider({ cellTenantId: 'tenant-a' });
      const creds = await provider.getServiceNowCredentials(
        'tenant-a',
        'servicenow://dev12345/incident',
      );
      assert.deepEqual(creds, {
        instance: 'dev12345',
        username: 'admin',
        password: 'secret',
      });
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        const envKey =
          key === 'instance'
            ? 'SERVICENOW_INSTANCE'
            : key === 'username'
              ? 'SERVICENOW_USERNAME'
              : 'SERVICENOW_PASSWORD';
        if (value === undefined) delete process.env[envKey];
        else process.env[envKey] = value;
      }
    }
  });

  it('parses strict Kubernetes deployment destinations', () => {
    assert.deepEqual(parseKubernetesDeploymentDestination('k8s://kind/commander/deployments/api'), {
      cluster: 'kind',
      namespace: 'commander',
      name: 'api',
    });
    assert.throws(
      () => parseKubernetesDeploymentDestination('k8s://kind/other%2Ftenant/deployments/api'),
      /Invalid Kubernetes deployment destination/,
    );
    assert.throws(
      () => parseKubernetesDeploymentDestination('k8s://Kind/commander/deployments/api'),
      /Invalid Kubernetes deployment destination/,
    );
  });

  it('isolates Kubernetes tokens by tenant and registered cluster', async () => {
    const previous = process.env.KIND_BEARER_TOKEN;
    process.env.KIND_BEARER_TOKEN = 'kind-secret-token';
    try {
      const provider = new EnvAdapterCredentialProvider({
        cellTenantId: 'tenant-a',
        kubernetesClusters: {
          kind: {
            server: 'https://127.0.0.1:6443',
            tokenEnv: 'KIND_BEARER_TOKEN',
            namespaces: ['commander'],
          },
        },
      });
      assert.equal(
        await provider.getToken('tenant-a', 'kind', 'commander'),
        'kind-secret-token',
      );
      assert.equal(
        provider.getServer('tenant-a', 'kind', 'commander').href,
        'https://127.0.0.1:6443/',
      );
      await assert.rejects(
        () => provider.getToken('tenant-b', 'kind', 'commander'),
        /Tenant credential isolation/,
      );
      await assert.rejects(
        () => provider.getToken('tenant-a', 'other', 'commander'),
        /Kubernetes cluster is not registered/,
      );
      await assert.rejects(
        () => provider.getToken('tenant-a', 'kind', 'other'),
        /Kubernetes namespace is not authorized/,
      );
      assert.throws(
        () => provider.getServer('tenant-a', 'kind', 'other'),
        /Kubernetes namespace is not authorized/,
      );
    } finally {
      if (previous === undefined) delete process.env.KIND_BEARER_TOKEN;
      else process.env.KIND_BEARER_TOKEN = previous;
    }
  });
});
