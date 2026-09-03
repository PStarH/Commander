#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadAll } from 'js-yaml';
import { createTask1PrerequisitePolicyConfig } from './task1-helm-prerequisite.js';

const root = resolve(import.meta.dirname, '..');
const chart = 'deploy/helm/commander';
const digest = `sha256:${'a'.repeat(64)}`;
const configuration = 'b'.repeat(64);
const expectedServerSpki = 'c'.repeat(64);
const databaseRoles = [
  'owner',
  'app',
  'tenant-authority',
  'scheduler',
  'worker',
  'adapter-ops',
] as const;
const profiles = [
  ['bundled-ephemeral', 'values-bundled-ephemeral.yaml', false],
  ['bundled-persistent', 'values-bundled-persistent.yaml', false],
  ['bundled-persistent-upgrade', 'values-bundled-persistent.yaml', true],
  ['external', 'values-external.yaml', false],
  ['external-upgrade', 'values-external.yaml', true],
] as const;

type Manifest = {
  kind?: string;
  metadata?: { name?: string };
  spec?: Record<string, unknown>;
};

function assertLifecycleNetworkContract(
  rendered: string,
  releaseName: string,
  databaseEndpoints: Parameters<typeof createTask1PrerequisitePolicyConfig>[0]['databaseEndpoints'],
): void {
  const resources = loadAll(rendered, undefined, { json: true }).filter(
    (value): value is Manifest => typeof value === 'object' && value !== null,
  );
  const resource = (kind: string, name: string): Manifest => {
    const value = resources.find(
      (candidate) => candidate.kind === kind && candidate.metadata?.name === name,
    );
    assert.ok(value, `${kind}/${name} missing`);
    return value;
  };

  const migration = resources.find(
    (candidate) =>
      candidate.kind === 'Job' &&
      candidate.metadata?.name?.startsWith(`${releaseName}-migration-r`),
  );
  assert.ok(migration, `${releaseName} migration Job missing`);
  const podTemplate = migration.spec?.template as {
    metadata?: { labels?: Record<string, string> };
  };
  assert.deepEqual(podTemplate.metadata?.labels, {
    'app.kubernetes.io/name': releaseName,
    'app.kubernetes.io/instance': releaseName,
    'commander.io/migration-client-v2': 'true',
    'commander.io/migration-release': releaseName,
  });

  for (const policyName of [
    'api-egress',
    'worker-egress',
    'kernel-ops-egress',
    'adapter-ops-egress',
    'migration-egress',
  ]) {
    const policy = resource('NetworkPolicy', `${releaseName}-${policyName}`);
    const egress = (policy.spec?.egress ?? []) as Array<{ ports?: Array<{ port?: number }> }>;
    assert.ok(
      egress.some((rule) => rule.ports?.some(({ port }) => port === 5432)),
      `${policyName} lacks its database endpoint`,
    );
  }

  const legacyMigration = resource('NetworkPolicy', `${releaseName}-migration-egress`);
  assert.deepEqual(
    (legacyMigration.spec?.podSelector as { matchLabels?: Record<string, string> }).matchLabels,
    {
      'app.kubernetes.io/name': releaseName,
      'app.kubernetes.io/instance': releaseName,
      'commander.io/migration-client-v2': 'true',
      'commander.io/migration-release': releaseName,
    },
  );

  const projection = createTask1PrerequisitePolicyConfig({
    namespace: 'default',
    releaseName,
    clusterDomain: 'cluster.local',
    migrationOperatorSubject: 'system:serviceaccount:commander-ops:migration-operator',
    clusterDns: { namespace: 'kube-system', podSelector: { 'k8s-app': 'kube-dns' } },
    databaseEndpoints,
    apiProof: {
      serviceName: `${releaseName}-api-proof`,
      servicePort: 9443,
      targetPort: 9443,
      podSelector: {
        'app.kubernetes.io/name': releaseName,
        'app.kubernetes.io/instance': releaseName,
        'app.kubernetes.io/component': 'api',
      },
      dnsSan: `${releaseName}-api-proof.default.svc.cluster.local`,
      spkiSha256: expectedServerSpki,
    },
  });
  const names = new Set(resources.map((value) => value.metadata?.name));
  assert.equal(names.has(projection.value.stablePolicyNames.egress), false);
  assert.equal(names.has(projection.value.stablePolicyNames.apiProofIngress), false);
  for (const policy of projection.value.stablePolicyNames.databaseIngress) {
    assert.equal(names.has(policy.name), false);
  }
  assert.doesNotMatch(rendered, /(?:0\.0\.0\.0|::)\/0/);
}

function main(): void {
  const temporary = mkdtempSync(join(tmpdir(), 'commander-helm-static-'));
  try {
    for (const [name, fixture, upgrade] of profiles) {
      const releaseName = `static-${name}`;
      const databaseEndpoints: Parameters<
        typeof createTask1PrerequisitePolicyConfig
      >[0]['databaseEndpoints'] = name.startsWith('external')
        ? [{ roles: [...databaseRoles], cidr: { cidr: '10.55.0.10/32', port: 5432 } }]
        : [
            {
              roles: [...databaseRoles],
              service: {
                namespace: 'default',
                name: `${releaseName}-postgres`,
                servicePort: 5432,
                targetPort: 5432,
                podSelector: {
                  'app.kubernetes.io/name': releaseName,
                  'app.kubernetes.io/instance': releaseName,
                  'app.kubernetes.io/component': 'postgres',
                },
              },
            },
          ];
      const output = join(temporary, `${name}.yaml`);
      const outputFd = openSync(output, 'w');
      try {
        execFileSync(
          'helm',
          [
            'template',
            releaseName,
            chart,
            '-f',
            `scripts/fixtures/helm-lifecycle/${fixture}`,
            '--set',
            `image.digest=${digest}`,
            '--set',
            `tenantAuthority.configurationSha256=${configuration}`,
            '--set',
            name.startsWith('external')
              ? 'databaseTls.caSecret=database-public-ca'
              : 'databaseTls.existingSecret=database-server-tls',
            '--set',
            `databaseTls.expectedServerSpkiSha256=${expectedServerSpki}`,
            '--set',
            'tenantAuthority.apiProof.publicSecret=api-proof-public',
            '--set',
            'tenantAuthority.apiProof.privateSecret=api-proof-private',
            '--set',
            'tenantAuthority.proofOwnerSecret=lifecycle-demo-proof-owner-r1',
            '--set',
            'tenantAuthority.releaseProjectionConfigMap=lifecycle-demo-release-projection-r1',
            '--set',
            'networkPolicy.enabled=true',
            '--set-json',
            `networkPolicy.databaseEndpoints=${JSON.stringify(databaseEndpoints)}`,
            ...(name.startsWith('external')
              ? ['--set-json', 'networkPolicy.egress.databaseCidrs=["10.55.0.10/32"]']
              : []),
            ...(upgrade ? ['--is-upgrade'] : []),
          ],
          { cwd: root, stdio: ['ignore', outputFd, 'inherit'] },
        );
      } finally {
        closeSync(outputFd);
      }
      assertLifecycleNetworkContract(readFileSync(output, 'utf8'), releaseName, databaseEndpoints);
      execFileSync(
        'pnpm',
        [
          'exec',
          'tsx',
          'scripts/helm-cell-assert.ts',
          '--file',
          output,
          '--profile',
          name.startsWith('external') ? 'enterprise' : 'demo',
        ],
        { cwd: root, stdio: 'inherit' },
      );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

main();
