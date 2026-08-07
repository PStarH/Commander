import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  bundledDatabaseTransportDigestBytes,
  computeBundledDatabaseTransportDigest,
  parseBundledDatabaseTlsArgs,
  runBundledDatabaseTlsPreparation,
  statefulSetTemplateJsonPatch,
  validateBundledDatabaseTlsIdentity,
  type BundledDatabasePreservationSnapshot,
  type BundledDatabaseTlsPorts,
  type BundledDatabaseTlsRequest,
} from './helm-prepare-bundled-database-tls.js';
import type { KubernetesSecretSnapshot } from './helm-adopt-database-secret.js';

const digest = 'b82d783dc53970b3c8194e82b8ab7134118aa0560119c33da34b5f755a028027';
const request: BundledDatabaseTlsRequest = {
  namespace: 'commander',
  release: 'release-a',
  legacyDatabaseSecret: 'legacy-db',
  stableDatabaseSecret: 'stable-db',
  databaseTlsSecret: 'database-tls',
  expectedPreclosureChartSha256: digest,
};
const logins = {
  owner: 'commander_owner',
  app: 'commander_app',
  scheduler: 'commander_scheduler',
  worker: 'commander_worker',
  'adapter-ops': 'commander_adapter_ops',
} as const;

function encoded(value: string): string {
  return Buffer.from(value).toString('base64');
}

function chartTransportDigest(secretName: string): string {
  return createHash('sha256')
    .update(
      [
        secretName,
        'ca.crt',
        'tls.crt',
        'tls.key',
        'pvc',
        '0440',
        'ssl=on',
        'ssl_ca_file=/run/commander/database-tls/ca.crt',
        'ssl_cert_file=/run/commander/database-tls/tls.crt',
        'ssl_key_file=/run/commander/database-tls/tls.key',
        'postgres-data:/var/lib/postgresql/data',
      ].join('\0'),
    )
    .digest('hex');
}

function databaseSecret(name: string, tls: boolean): KubernetesSecretSnapshot {
  const data: Record<string, string> = {
    'postgres-password': encoded('postgres-password'),
  };
  for (const [key, login] of Object.entries(logins)) {
    const password = `${key}-password`;
    const url = new URL(
      `postgresql://${login}:${password}@release-a-postgres.commander.svc/commander`,
    );
    if (tls) url.searchParams.set('sslmode', 'verify-full');
    data[`${key}-password`] = encoded(password);
    data[`${key}-url`] = encoded(url.toString());
  }
  if (tls) {
    data['tenant-authority-password'] = encoded('tenant-password');
    data['tenant-authority-url'] = encoded(
      'postgresql://commander_tenant_authority:tenant-password@release-a-postgres.commander.svc/commander?sslmode=verify-full',
    );
  }
  return {
    metadata: { namespace: 'commander', name, resourceVersion: '1' },
    type: 'Opaque',
    data,
  };
}

function statefulSet(): Record<string, any> {
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: {
      namespace: 'commander',
      name: 'release-a-postgres',
      resourceVersion: '10',
      labels: {
        'app.kubernetes.io/name': 'release-a',
        'app.kubernetes.io/instance': 'release-a',
        'app.kubernetes.io/version': '0.4.0',
        'app.kubernetes.io/managed-by': 'Helm',
        'helm.sh/chart': 'commander-0.4.0',
        'app.kubernetes.io/component': 'postgres',
      },
      annotations: {
        'meta.helm.sh/release-name': 'release-a',
        'meta.helm.sh/release-namespace': 'commander',
      },
    },
    spec: {
      serviceName: 'release-a-postgres',
      replicas: 1,
      podManagementPolicy: 'OrderedReady',
      revisionHistoryLimit: 10,
      persistentVolumeClaimRetentionPolicy: { whenDeleted: 'Retain', whenScaled: 'Retain' },
      updateStrategy: { rollingUpdate: { partition: 0 }, type: 'RollingUpdate' },
      selector: {
        matchLabels: {
          'app.kubernetes.io/name': 'release-a',
          'app.kubernetes.io/instance': 'release-a',
          'app.kubernetes.io/component': 'postgres',
        },
      },
      volumeClaimTemplates: [
        {
          metadata: { name: 'postgres-data' },
          spec: {
            accessModes: ['ReadWriteOnce'],
            resources: { requests: { storage: '10Gi' } },
            volumeMode: 'Filesystem',
          },
          status: { phase: 'Pending' },
        },
      ],
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'release-a',
            'app.kubernetes.io/instance': 'release-a',
            'app.kubernetes.io/component': 'postgres',
          },
        },
        spec: {
          dnsPolicy: 'ClusterFirst',
          restartPolicy: 'Always',
          schedulerName: 'default-scheduler',
          terminationGracePeriodSeconds: 30,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'postgres',
              image: 'postgres:16-alpine',
              imagePullPolicy: 'IfNotPresent',
              terminationMessagePath: '/dev/termination-log',
              terminationMessagePolicy: 'File',
              ports: [{ name: 'postgres', containerPort: 5432, protocol: 'TCP' }],
              env: [
                { name: 'POSTGRES_USER', value: 'commander' },
                {
                  name: 'POSTGRES_PASSWORD',
                  valueFrom: { secretKeyRef: { name: 'legacy-db', key: 'postgres-password' } },
                },
                { name: 'POSTGRES_DB', value: 'commander' },
                { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
                {
                  name: 'COMMANDER_OWNER_PASSWORD',
                  valueFrom: { secretKeyRef: { name: 'legacy-db', key: 'owner-password' } },
                },
                {
                  name: 'COMMANDER_APP_PASSWORD',
                  valueFrom: { secretKeyRef: { name: 'legacy-db', key: 'app-password' } },
                },
                {
                  name: 'COMMANDER_SCHEDULER_PASSWORD',
                  valueFrom: { secretKeyRef: { name: 'legacy-db', key: 'scheduler-password' } },
                },
                {
                  name: 'COMMANDER_WORKER_PASSWORD',
                  valueFrom: { secretKeyRef: { name: 'legacy-db', key: 'worker-password' } },
                },
              ],
              resources: {
                requests: { cpu: '100m', memory: '256Mi' },
                limits: { cpu: '500m', memory: '1Gi' },
              },
              livenessProbe: {
                exec: { command: ['pg_isready', '-U', 'commander', '-d', 'commander'] },
                initialDelaySeconds: 30,
                periodSeconds: 10,
                failureThreshold: 3,
                successThreshold: 1,
                timeoutSeconds: 1,
              },
              readinessProbe: {
                exec: { command: ['pg_isready', '-U', 'commander', '-d', 'commander'] },
                initialDelaySeconds: 5,
                periodSeconds: 5,
                failureThreshold: 3,
                successThreshold: 1,
                timeoutSeconds: 1,
              },
              volumeMounts: [
                { name: 'postgres-data', mountPath: '/var/lib/postgresql/data' },
                {
                  name: 'database-init',
                  mountPath: '/docker-entrypoint-initdb.d',
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            {
              name: 'database-init',
              configMap: { name: 'release-a-database-init', defaultMode: 0o755 },
            },
          ],
        },
      },
    },
  };
}

function tlsIdentitySecret(): { secret: KubernetesSecretSnapshot; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'commander-bundled-tls-'));
  const caKey = join(directory, 'ca.key');
  const caCert = join(directory, 'ca.crt');
  const serverKey = join(directory, 'tls.key');
  const requestFile = join(directory, 'server.csr');
  const serverCert = join(directory, 'tls.crt');
  const extensions = join(directory, 'server.ext');
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
      '/CN=Commander test CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-keyout',
      caKey,
      '-out',
      caCert,
    ],
    { stdio: 'ignore' },
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-new',
      '-nodes',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-subj',
      '/CN=release-a-postgres.commander.svc',
      '-keyout',
      serverKey,
      '-out',
      requestFile,
    ],
    { stdio: 'ignore' },
  );
  writeFileSync(
    extensions,
    [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature',
      'extendedKeyUsage=serverAuth',
      'subjectAltName=DNS:release-a-postgres.commander.svc',
      '',
    ].join('\n'),
  );
  execFileSync(
    'openssl',
    [
      'x509',
      '-req',
      '-in',
      requestFile,
      '-CA',
      caCert,
      '-CAkey',
      caKey,
      '-CAcreateserial',
      '-days',
      '2',
      '-extfile',
      extensions,
      '-out',
      serverCert,
    ],
    { stdio: 'ignore' },
  );
  return {
    directory,
    secret: {
      metadata: { namespace: 'commander', name: 'database-tls' },
      type: 'kubernetes.io/tls',
      data: {
        'ca.crt': encoded(readFileSync(caCert, 'utf8')),
        'tls.crt': encoded(readFileSync(serverCert, 'utf8')),
        'tls.key': encoded(readFileSync(serverKey, 'utf8')),
      },
    },
  };
}

function fixture(
  failTlsAuthentication = false,
  _concurrentProductWrite = false,
  preservationMutation?: keyof Pick<
    BundledDatabasePreservationSnapshot,
    | 'sentinelIds'
    | 'sentinelRowsSha256'
    | 'schemaSha256'
    | 'rolesSha256'
    | 'ledgerSha256'
    | 'catalogSha256'
  >,
): BundledDatabaseTlsPorts & {
  statefulSet: Record<string, any>;
  persistentVolumeClaim: Record<string, any>;
  readonly productWrites: number;
  readonly productRows: readonly string[];
  patches: Record<string, any>[];
  authentications: string[];
} {
  const current = statefulSet();
  const persistentVolumeClaim = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      namespace: 'commander',
      name: 'postgres-data-release-a-postgres-0',
      uid: 'approved-v8-pvc-uid',
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '10Gi' } },
      storageClassName: 'cluster-default',
      volumeMode: 'Filesystem',
      volumeName: 'approved-v8-persistent-volume',
    },
    status: { phase: 'Bound' },
  };
  const patches: Record<string, any>[] = [];
  const authentications: string[] = [];
  let preservationReads = 0;
  let productWrites = 0;
  const productRows = ['sentinel-independent-product-row'];
  const secrets = new Map<string, KubernetesSecretSnapshot>([
    ['legacy-db', databaseSecret('legacy-db', false)],
    ['stable-db', databaseSecret('stable-db', true)],
    [
      'database-tls',
      {
        metadata: { namespace: 'commander', name: 'database-tls', resourceVersion: '2' },
        type: 'kubernetes.io/tls',
        data: {
          'ca.crt': encoded('ca'),
          'tls.crt': encoded('certificate'),
          'tls.key': encoded('private key'),
        },
      },
    ],
  ]);
  return {
    statefulSet: current,
    persistentVolumeClaim,
    get productWrites() {
      return productWrites;
    },
    productRows,
    patches,
    authentications,
    async readStatefulSet() {
      return structuredClone(current);
    },
    async readPersistentVolumeClaim() {
      return structuredClone(persistentVolumeClaim);
    },
    async readSecret(_namespace, name) {
      return structuredClone(secrets.get(name) ?? null);
    },
    async authenticate(url, expectedLogin, caPem) {
      assert.equal(decodeURIComponent(new URL(url).username), expectedLogin);
      authentications.push(`${expectedLogin}:${caPem ? 'tls' : 'plain'}`);
      if (failTlsAuthentication && caPem) throw new Error('post TLS proof failed');
    },
    validateTlsIdentity() {
      return { caPem: 'ca', expectedServerSpkiSha256: 'c'.repeat(64) };
    },
    async preservationSnapshot(input) {
      preservationReads += 1;
      const snapshot: BundledDatabasePreservationSnapshot = {
        format: 'bundled-database-preservation/v1',
        sentinelIds: ['lifecycle-sentinel'],
        sentinelRowsSha256: '1'.repeat(64),
        schemaSha256: '2'.repeat(64),
        rolesSha256: '3'.repeat(64),
        ledgerSha256: '4'.repeat(64),
        catalogSha256: '5'.repeat(64),
      };
      const baseline = structuredClone(snapshot);
      if (preservationReads === 2) assert.deepEqual(input.baseline, baseline);
      if (preservationReads === 2 && preservationMutation) {
        if (preservationMutation === 'sentinelIds') {
          snapshot.sentinelIds = ['lifecycle-sentinel', 'new-lifecycle-sentinel'];
        } else {
          snapshot[preservationMutation] = 'f'.repeat(64);
        }
      }
      return snapshot;
    },
    async patchTemplate(_namespace, _name, resourceVersion, template) {
      assert.equal(resourceVersion, current.metadata.resourceVersion);
      patches.push(structuredClone(template));
      current.spec.template = structuredClone(template);
      current.metadata.resourceVersion = String(Number(current.metadata.resourceVersion) + 1);
    },
    async waitRollout() {
      if (_concurrentProductWrite) {
        productWrites += 1;
        productRows.push(`concurrent-product-row-${productWrites}`);
      }
    },
  };
}

describe('bundled PostgreSQL TLS maintenance', () => {
  it('accepts only the exact closed CLI grammar', () => {
    const args = [
      '--namespace',
      'commander',
      '--release',
      'release-a',
      '--legacy-database-secret',
      'legacy-db',
      '--stable-database-secret',
      'stable-db',
      '--database-tls-secret',
      'database-tls',
      '--expected-preclosure-chart-sha256',
      digest,
    ];
    assert.deepEqual(parseBundledDatabaseTlsArgs(args), request);
    assert.throws(
      () => parseBundledDatabaseTlsArgs([...args.slice(2), ...args.slice(0, 2)]),
      /TENANT_DATABASE_TLS_PREPARATION_ARGUMENT_INVALID/,
    );
  });

  it('exports the chart-compatible transport digest byte contract', () => {
    const input = {
      secretName: 'database-tls',
      caKey: 'ca.crt',
      certKey: 'tls.crt',
      keyKey: 'tls.key',
      dataVolumeKind: 'pvc' as const,
    };
    assert.equal(
      bundledDatabaseTransportDigestBytes(input).toString('utf8'),
      [
        'database-tls',
        'ca.crt',
        'tls.crt',
        'tls.key',
        'pvc',
        '0440',
        'ssl=on',
        'ssl_ca_file=/run/commander/database-tls/ca.crt',
        'ssl_cert_file=/run/commander/database-tls/tls.crt',
        'ssl_key_file=/run/commander/database-tls/tls.key',
        'postgres-data:/var/lib/postgresql/data',
      ].join('\0'),
    );
    assert.equal(
      computeBundledDatabaseTransportDigest(input),
      chartTransportDigest('database-tls'),
    );
  });

  it('accepts the actual approved-v8 image and annotation-free StatefulSet', async () => {
    const ports = fixture();
    const beforeSpec = structuredClone(ports.statefulSet.spec);
    const result = await runBundledDatabaseTlsPreparation(request, ports);
    assert.equal(result.status, 'prepared');
    assert.equal(ports.patches.length, 1);
    assert.deepEqual(ports.statefulSet.spec.volumeClaimTemplates, beforeSpec.volumeClaimTemplates);
    assert.equal(ports.authentications.filter((value) => value.endsWith(':plain')).length, 5);
    assert.equal(ports.authentications.filter((value) => value.endsWith(':tls')).length, 5);
    assert.match(
      ports.statefulSet.spec.template.metadata.annotations[
        'commander.io/database-transport-content-sha256'
      ],
      /^[0-9a-f]{64}$/,
    );
    assert.equal(result.transportContentSha256, chartTransportDigest('database-tls'));
    assert.equal(
      ports.statefulSet.spec.template.spec.volumes.find(
        (value: Record<string, unknown>) => value.name === 'database-tls',
      ).secret.defaultMode,
      0o440,
    );
  });

  it('rejects any drift from the exact approved-v8 StatefulSet and claim template', async () => {
    const mutations: Array<(value: Record<string, any>) => void> = [
      (value) => {
        value.spec.replicas = 2;
      },
      (value) => {
        value.spec.selector.matchLabels['app.kubernetes.io/component'] = 'database';
      },
      (value) => {
        value.spec.template.spec.securityContext.runAsUser = 70;
      },
      (value) => {
        value.spec.template.spec.enableServiceLinks = true;
      },
      (value) => {
        value.spec.template.spec.serviceAccountName = 'default';
      },
      (value) => {
        value.spec.ordinals = { start: 0 };
      },
      (value) => {
        value.spec.minReadySeconds = 0;
      },
      (value) => {
        value.spec.template.spec.containers.push({ name: 'sidecar', image: 'busybox:latest' });
      },
      (value) => {
        value.spec.volumeClaimTemplates[0].spec.resources.requests.storage = '11Gi';
      },
      (value) => {
        value.spec.template.spec.containers[0].image = `postgres@sha256:${'b'.repeat(64)}`;
      },
    ];
    for (const mutate of mutations) {
      const ports = fixture();
      mutate(ports.statefulSet);
      await assert.rejects(
        runBundledDatabaseTlsPreparation(request, ports),
        /TENANT_DATABASE_TLS_PREPARATION_INVALID/,
      );
      assert.equal(ports.patches.length, 0);
    }
  });

  it('restores the exact old template when post-rollout proof fails', async () => {
    const ports = fixture(true);
    const before = structuredClone(ports.statefulSet.spec.template);
    await assert.rejects(runBundledDatabaseTlsPreparation(request, ports), /post TLS proof failed/);
    assert.equal(ports.patches.length, 2);
    assert.deepEqual(ports.statefulSet.spec.template, before);
  });

  it('bounds rollback retries and verifies restoration with a final exact reread', async () => {
    const ports = fixture(true);
    const before = structuredClone(ports.statefulSet.spec.template);
    const readStatefulSet = ports.readStatefulSet.bind(ports);
    const patchTemplate = ports.patchTemplate.bind(ports);
    const waitRollout = ports.waitRollout.bind(ports);
    let reads = 0;
    let patchAttempts = 0;
    let waits = 0;
    ports.readStatefulSet = async (...args) => {
      reads += 1;
      if (reads === 2) throw new Error('transient rollback read');
      return readStatefulSet(...args);
    };
    ports.patchTemplate = async (...args) => {
      patchAttempts += 1;
      if (patchAttempts === 2) throw new Error('transient rollback patch conflict');
      return patchTemplate(...args);
    };
    ports.waitRollout = async (...args) => {
      waits += 1;
      if (waits === 2) throw new Error('transient rollback rollout');
      return waitRollout(...args);
    };

    await assert.rejects(runBundledDatabaseTlsPreparation(request, ports), /post TLS proof failed/);
    assert.deepEqual(ports.statefulSet.spec.template, before);
    assert.ok(reads >= 6);
    assert.equal(patchAttempts, 3);
    assert.equal(waits, 3);
  });

  it('stops after five persistent rollback failures without claiming restoration', async () => {
    const cases = ['read', 'patch', 'wait', 'final-reread'] as const;
    for (const failure of cases) {
      const ports = fixture(true);
      const readStatefulSet = ports.readStatefulSet.bind(ports);
      const patchTemplate = ports.patchTemplate.bind(ports);
      const waitRollout = ports.waitRollout.bind(ports);
      let reads = 0;
      let patchAttempts = 0;
      let waits = 0;
      ports.readStatefulSet = async (...args) => {
        reads += 1;
        if (failure === 'read' && reads > 1) throw new Error('persistent read failure');
        const value = await readStatefulSet(...args);
        if (failure === 'final-reread' && reads > 1 && reads % 2 === 1 && value) {
          value.spec.template.metadata.labels['rollback-proof'] = 'mismatch';
        }
        return value;
      };
      ports.patchTemplate = async (...args) => {
        patchAttempts += 1;
        if (failure === 'patch' && patchAttempts > 1) {
          throw new Error('persistent patch conflict');
        }
        return patchTemplate(...args);
      };
      ports.waitRollout = async (...args) => {
        waits += 1;
        if (failure === 'wait' && waits > 1) throw new Error('persistent rollout failure');
        return waitRollout(...args);
      };

      await assert.rejects(
        runBundledDatabaseTlsPreparation(request, ports),
        /TENANT_DATABASE_TLS_PREPARATION_ROLLBACK_FAILED/,
      );
      if (failure === 'read') assert.equal(reads, 6);
      if (failure === 'patch') assert.equal(patchAttempts, 6);
      if (failure === 'wait') assert.equal(waits, 6);
      if (failure === 'final-reread') assert.equal(reads, 11);
    }
  });

  it('permits concurrent product writes when preservation state is unchanged', async () => {
    const ports = fixture(false, true);
    const result = await runBundledDatabaseTlsPreparation(request, ports);
    assert.equal(result.status, 'prepared');
    assert.equal(ports.patches.length, 1);
    assert.equal(ports.productWrites, 1);
    assert.deepEqual(ports.productRows, [
      'sentinel-independent-product-row',
      'concurrent-product-row-1',
    ]);
  });

  it('rejects sentinel, schema, role, ledger, and catalog mutations', async () => {
    const dimensions = [
      'sentinelIds',
      'sentinelRowsSha256',
      'schemaSha256',
      'rolesSha256',
      'ledgerSha256',
      'catalogSha256',
    ] as const;
    for (const dimension of dimensions) {
      const ports = fixture(false, false, dimension);
      await assert.rejects(
        runBundledDatabaseTlsPreparation(request, ports),
        /TENANT_DATABASE_TLS_PREPARATION_INVALID/,
      );
      assert.equal(ports.patches.length, 2);
    }
  });

  it('uses a resourceVersion-guarded JSON replacement for exact rollback semantics', () => {
    const template = statefulSet().spec.template;
    assert.deepEqual(statefulSetTemplateJsonPatch('10', template), [
      { op: 'test', path: '/metadata/resourceVersion', value: '10' },
      { op: 'replace', path: '/spec/template', value: template },
    ]);
  });

  it('binds a valid CA, SAN, P-256 certificate, private key, and SPKI', () => {
    const fixture = tlsIdentitySecret();
    try {
      const identity = validateBundledDatabaseTlsIdentity(request, fixture.secret);
      assert.match(identity.expectedServerSpkiSha256, /^[0-9a-f]{64}$/);
      const substituted = structuredClone(fixture.secret);
      substituted.data['tls.key'] = encoded(
        readFileSync(join(fixture.directory, 'ca.key'), 'utf8'),
      );
      assert.throws(
        () => validateBundledDatabaseTlsIdentity(request, substituted),
        /TENANT_DATABASE_TLS_PREPARATION_INVALID/,
      );
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('treats an exact completed patch as idempotent', async () => {
    const ports = fixture();
    await runBundledDatabaseTlsPreparation(request, ports);
    const result = await runBundledDatabaseTlsPreparation(request, ports);
    assert.equal(result.status, 'unchanged');
    assert.equal(ports.patches.length, 1);
  });
});
