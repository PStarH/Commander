import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EnvAdapterCredentialProvider } from './types.js';

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

  it('returns Kubernetes credentials only for the configured cluster', async () => {
    const previous = {
      cluster: process.env.COMMANDER_KUBERNETES_CLUSTER,
      server: process.env.COMMANDER_KUBERNETES_SERVER,
      token: process.env.COMMANDER_KUBERNETES_TOKEN,
    };
    process.env.COMMANDER_KUBERNETES_CLUSTER = 'cluster-a';
    process.env.COMMANDER_KUBERNETES_SERVER = 'https://kube.example';
    process.env.COMMANDER_KUBERNETES_TOKEN = 'token';
    try {
      const provider = new EnvAdapterCredentialProvider({ cellTenantId: 'tenant-a' });
      const credentials = await provider.getKubernetesCredentials!(
        'tenant-a',
        'k8s://cluster-a/team-a/deployments/api',
      );
      assert.deepEqual(credentials, {
        cluster: 'cluster-a',
        server: 'https://kube.example',
        token: 'token',
      });
      await assert.rejects(
        () =>
          provider.getKubernetesCredentials!('tenant-a', 'k8s://cluster-b/team-a/deployments/api'),
        /Kubernetes cluster mismatch/,
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[`COMMANDER_KUBERNETES_${key.toUpperCase()}`];
        else process.env[`COMMANDER_KUBERNETES_${key.toUpperCase()}`] = value;
      }
    }
  });
});
