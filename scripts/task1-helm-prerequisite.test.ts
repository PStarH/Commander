import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canonicalBootstrapJson,
  canonicalBootstrapSha256,
} from '../packages/kernel/src/canonicalBootstrap.js';
import {
  createTask1PrerequisitePolicyConfig,
  task1StablePolicyNames,
  type Task1PrerequisiteInput,
} from './task1-helm-prerequisite.js';

const roles = ['owner', 'app', 'tenant-authority', 'scheduler', 'worker', 'adapter-ops'] as const;

function input(): Task1PrerequisiteInput {
  return {
    namespace: 'commander',
    releaseName: 'release-a',
    clusterDomain: 'cluster.local',
    migrationOperatorSubject: 'system:serviceaccount:commander-ops:migration-operator',
    clusterDns: { namespace: 'kube-system', podSelector: { 'k8s-app': 'kube-dns' } },
    databaseEndpoints: [
      {
        roles: [...roles],
        service: {
          namespace: 'commander',
          name: 'postgres',
          servicePort: 5432,
          targetPort: 5432,
          podSelector: {
            'app.kubernetes.io/component': 'postgres',
            'app.kubernetes.io/instance': 'release-a',
          },
        },
      },
    ],
    apiProof: {
      serviceName: 'release-a-api-proof',
      servicePort: 9443,
      targetPort: 9443,
      podSelector: {
        'app.kubernetes.io/component': 'api',
        'app.kubernetes.io/instance': 'release-a',
      },
      dnsSan: 'release-a-api-proof.commander.svc.cluster.local',
      spkiSha256: 'a'.repeat(64),
    },
  };
}

describe('Task 1 Helm prerequisite policy projection', () => {
  it('normalizes a complete six-role Service endpoint and stable policy names', () => {
    const config = createTask1PrerequisitePolicyConfig(input());
    assert.equal(config.value.format, 'prerequisite-policy-config/v1');
    assert.deepEqual(config.value.databaseEndpoints[0]!.roles, [...roles].sort());
    assert.match(config.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      task1StablePolicyNames('commander', 'release-a', config.value),
      config.value.stablePolicyNames,
    );
  });

  it('seals complete stable policies and both normalized admission guards into exact JCS', () => {
    const config = createTask1PrerequisitePolicyConfig(input());
    assert.deepEqual(Object.keys(config.value).sort(), [
      'admissionGuards',
      'apiProof',
      'clusterDns',
      'databaseEndpoints',
      'format',
      'migrationOperatorSubject',
      'namespace',
      'releaseName',
      'stablePolicies',
    ]);
    assert.equal(config.value.stablePolicies.length, 3);
    for (const policy of config.value.stablePolicies) {
      assert.deepEqual(Object.keys(policy).sort(), [
        'labels',
        'name',
        'namespace',
        'spec',
        'specSha256',
      ]);
      assert.equal(policy.specSha256, canonicalBootstrapSha256(policy.spec));
    }
    assert.deepEqual(
      config.value.admissionGuards.map((guard) => guard.stage),
      ['network', 'workload'],
    );
    for (const guard of config.value.admissionGuards) {
      assert.deepEqual(Object.keys(guard).sort(), [
        'bindingSpec',
        'bindingSpecSha256',
        'name',
        'policySpec',
        'policySpecSha256',
        'stage',
      ]);
      assert.equal(guard.policySpecSha256, canonicalBootstrapSha256(guard.policySpec));
      assert.equal(guard.bindingSpecSha256, canonicalBootstrapSha256(guard.bindingSpec));
    }
    assert.match(
      canonicalBootstrapJson(config.value.admissionGuards[0]!.policySpec),
      /migration operator may create only an exact rendered stable policy/,
    );
    assert.match(
      canonicalBootstrapJson(config.value.admissionGuards[1]!.policySpec),
      /COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256/,
    );
    assert.equal(config.jcs, canonicalBootstrapJson(config.value));
    assert.equal(config.sha256, canonicalBootstrapSha256(config.value));
    assert.equal(config.sha256, '51d1879103986711cf903aee39262cbe02d41239054a301b22b02a2a7662e8d6');
  });

  it('changes the sealed digest when a normalized policy or guard input changes', () => {
    const original = createTask1PrerequisitePolicyConfig(input());
    const changedInput = input();
    changedInput.databaseEndpoints[0]!.service!.podSelector = {
      ...changedInput.databaseEndpoints[0]!.service!.podSelector,
      revision: 'two',
    };
    const changed = createTask1PrerequisitePolicyConfig(changedInput);
    assert.notEqual(changed.sha256, original.sha256);
    assert.notEqual(
      changed.value.stablePolicies.find(
        (policy) => policy.labels['commander.io/purpose'] === 'database-migration-ingress',
      )?.specSha256,
      original.value.stablePolicies.find(
        (policy) => policy.labels['commander.io/purpose'] === 'database-migration-ingress',
      )?.specSha256,
    );
    assert.notEqual(
      changed.value.admissionGuards[0]!.policySpecSha256,
      original.value.admissionGuards[0]!.policySpecSha256,
    );
  });

  it('rejects role omissions, broad CIDRs, hostname endpoints, and non-numeric Service ports', () => {
    const base = {
      namespace: 'commander',
      releaseName: 'release-a',
      clusterDomain: 'cluster.local',
      migrationOperatorSubject: 'system:serviceaccount:ops:operator',
      clusterDns: { namespace: 'kube-system', podSelector: { 'k8s-app': 'kube-dns' } },
      apiProof: {
        serviceName: 'release-a-api-proof',
        servicePort: 9443,
        targetPort: 9443,
        podSelector: { app: 'api' },
        dnsSan: 'release-a-api-proof.commander.svc.cluster.local',
        spkiSha256: 'a'.repeat(64),
      },
    } as const;
    assert.throws(
      () =>
        createTask1PrerequisitePolicyConfig({
          ...base,
          databaseEndpoints: [{ roles: ['owner'], cidr: { cidr: '10.0.0.0/24', port: 5432 } }],
        }),
      /TENANT_POLICY_ENDPOINT_INVALID/,
    );
    assert.throws(
      () =>
        createTask1PrerequisitePolicyConfig({
          ...base,
          databaseEndpoints: [
            {
              roles: [...roles],
              service: {
                namespace: 'commander',
                name: 'postgres',
                servicePort: '5432',
                targetPort: 5432,
                podSelector: { app: 'postgres' },
              },
            },
          ],
        } as never),
      /TENANT_POLICY_ENDPOINT_INVALID/,
    );
  });
});
