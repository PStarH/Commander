import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  aggregateScenarioPass,
  aggregateScenarioChecks,
  assertHelmVersion,
  assertNegativeCanaryResult,
  assertProofPodContract,
  buildExternalPostgresResources,
  buildLifecycleValues,
  calicoImagesForArchitecture,
  kindNodeImageForArchitecture,
  leafCertificateExtensions,
  nodeInventoriesContainExactReference,
  namespaceCleanupArgs,
  postgresImageForArchitecture,
  productionImageReferences,
  productionImageBuildArguments,
  reusableProductionImageDigest,
  controlPlaneReadinessSelectors,
  proofReaderName,
  selectLifecycleScenarios,
  sanitizeEvidence,
  kindClusterExists,
  proofTemplatesPresent,
  parseOwnerFailureEvidence,
  productionImageSourceRevision,
  KIND_NODE_IMAGE,
  CALICO_URL,
} from './helm-lifecycle-kind.js';

describe('helm-lifecycle-kind helpers', () => {
  it('retains only a parsed allowlisted owner failure record and source revision', () => {
    assert.deepEqual(
      parseOwnerFailureEvidence(
        'HELM_TENANT_CUTOVER_FAILED: TENANT_CUTOVER_OWNER_JOB_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=owner_pool_connect;log_sha256=' +
          'a'.repeat(64),
      ),
      {
        code: 'COMMANDER_MIGRATION_FAILED',
        producer: 'owner_entrypoint',
        transport: 'kubectl_logs',
        ownerStage: 'owner_pool_connect',
        logSha256: 'a'.repeat(64),
      },
    );
    assert.deepEqual(
      parseOwnerFailureEvidence(
        'HELM_TENANT_CUTOVER_FAILED: TENANT_CUTOVER_OWNER_JOB_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=bootstrap_context_catalog_query;log_sha256=' +
          'b'.repeat(64) +
          '\nNAME   READY   STATUS\npod/postgres-0   1/1   Running',
      ),
      {
        code: 'COMMANDER_MIGRATION_FAILED',
        producer: 'owner_entrypoint',
        transport: 'kubectl_logs',
        ownerStage: 'bootstrap_context_catalog_query',
        logSha256: 'b'.repeat(64),
      },
    );
    assert.equal(
      productionImageSourceRevision({ GITHUB_SHA: 'b'.repeat(40) }, () => 'c'.repeat(40)),
      'b'.repeat(40),
    );
    assert.equal(
      productionImageSourceRevision({}, () => 'c'.repeat(40)),
      'c'.repeat(40),
    );
    assert.equal(parseOwnerFailureEvidence('postgres://owner:secret@db private detail'), undefined);
  });

  it('pins Kubernetes 1.33.2 and the expected digest', () => {
    assert.match(KIND_NODE_IMAGE, /kindest\/node:v1\.33\.2/);
    assert.match(KIND_NODE_IMAGE, /sha256:[a-f0-9]{64}/);
  });

  it('selects immutable Kind node manifests for both supported CI architectures', () => {
    assert.equal(
      kindNodeImageForArchitecture('x64'),
      'kindest/node:v1.33.2@sha256:18e6c8f260d51cda4bc32d9f1a4852f9e693c7b667aa14321996ed7c411fc121',
    );
    assert.equal(
      kindNodeImageForArchitecture('arm64'),
      'kindest/node:v1.33.2@sha256:2206121406df04dd321ea04919c7a1a3c3b12220770b4a62dc5e57e2cfab4dad',
    );
    assert.throws(() => kindNodeImageForArchitecture('ia32'), /KIND_ARCHITECTURE_UNSUPPORTED/);
  });

  it('selects immutable Calico and PostgreSQL manifests for both supported architectures', () => {
    assert.deepEqual(calicoImagesForArchitecture('arm64'), [
      'docker.io/calico/cni:v3.29.0@sha256:173ea2834c655eeee3aa9c3491c7ef6d75a2de1e622e127f524f02a4e1918f17',
      'docker.io/calico/node:v3.29.0@sha256:f74ff658399ab2c7deb7cb28f2eccccd303d22bfd674b32547a8e6d83a44ac7c',
      'docker.io/calico/kube-controllers:v3.29.0@sha256:38d28083aad4783556c4172df0cfcca30e31b1a323017bb74988ea95ca391c14',
    ]);
    assert.deepEqual(calicoImagesForArchitecture('x64'), [
      'docker.io/calico/cni:v3.29.0@sha256:10643eba882c49d2558ee1f047ab4b42283c4b3e9e0864e4007e46c9faf5d50e',
      'docker.io/calico/node:v3.29.0@sha256:ec9fc719f8b51397fff195d60c7d12d4149fa08c3167a6485e7691119560451f',
      'docker.io/calico/kube-controllers:v3.29.0@sha256:10a8342ee971aeb53cfe94599f1ba7048ff815e43689014cd436cc46d4d7d1e0',
    ]);
    assert.equal(
      postgresImageForArchitecture('arm64'),
      'docker.io/library/postgres:16-alpine@sha256:7ae1143a9f249af815f056751a122a86d7e44ddce0926f2b227e3d5c434444f4',
    );
    assert.throws(() => calicoImagesForArchitecture('ia32'), /KIND_ARCHITECTURE_UNSUPPORTED/);
  });

  it('uses ECDSA-compatible key usage for live fixture leaf certificates', () => {
    const extensions = leafCertificateExtensions(['postgres.default.svc']);
    assert.match(extensions, /keyUsage=critical,digitalSignature\n/);
    assert.doesNotMatch(extensions, /keyEncipherment/);
  });

  it('bounds namespace cleanup and requires every control-plane component after image imports', () => {
    assert.deepEqual(namespaceCleanupArgs('commander-lifecycle'), [
      'delete',
      'namespace',
      'commander-lifecycle',
      '--ignore-not-found=true',
      '--wait=true',
      '--timeout=120s',
    ]);
    assert.deepEqual(controlPlaneReadinessSelectors(), [
      'component=etcd',
      'component=kube-apiserver',
      'component=kube-controller-manager',
      'component=kube-scheduler',
    ]);
  });

  it('requires the exact supported Helm runtime', () => {
    assert.doesNotThrow(() => assertHelmVersion('v3.17.3+ge4da497'));
    assert.doesNotThrow(() => assertHelmVersion('v3.17.3'));
    assert.throws(() => assertHelmVersion('v3.17.3-rc.1'), /HELM_VERSION_INVALID/);
    assert.throws(() => assertHelmVersion('v4.2.3+g43e8b7f'), /HELM_VERSION_INVALID/);
  });

  it('builds digest-pinned production values with all six database roles sealed', () => {
    const values = buildLifecycleValues({
      namespace: 'commander-lifecycle',
      release: 'cmdr-live',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      databaseSpkiSha256: 'b'.repeat(64),
      logLevel: 'info',
    });
    assert.match(values, /repository: commander-lifecycle-api/);
    assert.match(values, new RegExp(`digest: sha256:${'a'.repeat(64)}`));
    assert.match(values, /bundled: true\n    user: postgres/);
    assert.match(values, /existingSecret: cmdr-live-database-tls/);
    for (const role of ['owner', 'app', 'tenant-authority', 'scheduler', 'worker', 'adapter-ops']) {
      assert.match(values, new RegExp(`- ${role}`));
    }
    assert.doesNotMatch(values, /commander-lifecycle-noop/);
  });

  it('builds a real external PostgreSQL TLS lifecycle configuration', () => {
    const values = buildLifecycleValues({
      namespace: 'commander-lifecycle',
      release: 'cmdr-external',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      databaseSpkiSha256: 'b'.repeat(64),
      logLevel: 'info',
      database: {
        kind: 'external',
        secretName: 'cmdr-external-database',
        caSecret: 'cmdr-external-database-ca',
        bootstrapAuthoritySecret: 'cmdr-external-bootstrap',
        serviceNamespace: 'external-db',
        serviceName: 'external-postgres',
        serviceClusterIp: '10.96.12.34',
      },
    });
    assert.match(values, /bundled: false/);
    assert.match(values, /existingSecret: cmdr-external-database/);
    assert.match(values, /caSecret: cmdr-external-database-ca/);
    assert.match(values, /bootstrapAuthoritySecret: cmdr-external-bootstrap/);
    assert.match(values, /namespace: external-db/);
    assert.match(values, /name: external-postgres/);
    assert.match(values, /databaseCidrs:\n      - 10\.96\.12\.34\/32/);
    assert.doesNotMatch(values, /existingSecret: cmdr-external-database-tls/);
  });

  it('provisions external PostgreSQL with TLS and the exact six-role E2 envelope', () => {
    const resources = buildExternalPostgresResources({
      namespace: 'external-db',
      image: `docker.io/library/postgres:16-alpine@sha256:${'c'.repeat(64)}`,
      credentialsSecret: 'external-postgres-credentials',
      tlsSecret: 'external-postgres-tls',
    });
    const serialized = JSON.stringify(resources);
    assert.match(serialized, /ssl=on/);
    assert.match(serialized, /ssl_ca_file=\/run\/commander\/database-tls\/ca\.crt/);
    assert.match(serialized, /ssl_cert_file=\/run\/commander\/database-tls\/tls\.crt/);
    assert.match(serialized, /ssl_key_file=\/run\/commander\/database-tls\/tls\.key/);
    assert.match(serialized, /external-postgres-tls/);
    for (const role of [
      'commander_owner',
      'commander_app',
      'commander_tenant_authority',
      'commander_scheduler',
      'commander_worker',
      'commander_adapter_ops',
    ]) {
      assert.match(serialized, new RegExp(`CREATE ROLE ${role}`));
    }
    assert.equal((resources as { items?: unknown[] }).items?.length, 3);
  });

  it('pins owner memberships to the exact PostgreSQL 16 privilege envelope', () => {
    const resources = buildExternalPostgresResources({
      namespace: 'external-db',
      image: `docker.io/library/postgres:16-alpine@sha256:${'c'.repeat(64)}`,
      credentialsSecret: 'external-postgres-credentials',
      tlsSecret: 'external-postgres-tls',
    });
    const externalInit = JSON.stringify(resources);
    const bundledInit = readFileSync(
      resolve('deploy/helm/commander/templates/configmap-database-init.yaml'),
      'utf8',
    );
    for (const role of [
      'commander_app',
      'commander_tenant_authority',
      'commander_scheduler',
      'commander_worker',
      'commander_adapter_ops',
    ]) {
      const grant = new RegExp(
        `GRANT ${role} TO commander_owner WITH ADMIN OPTION, INHERIT FALSE, SET TRUE;`,
      );
      assert.match(externalInit, grant);
      assert.match(bundledInit, grant);
    }
  });

  it('pins fresh E2 database ownership and removes ambient PUBLIC access', () => {
    const resources = buildExternalPostgresResources({
      namespace: 'external-db',
      image: `docker.io/library/postgres:16-alpine@sha256:${'c'.repeat(64)}`,
      credentialsSecret: 'external-postgres-credentials',
      tlsSecret: 'external-postgres-tls',
    });
    const initializers = [
      JSON.stringify(resources),
      readFileSync(resolve('deploy/helm/commander/templates/configmap-database-init.yaml'), 'utf8'),
    ];
    for (const initializer of initializers) {
      assert.match(
        initializer,
        /ALTER DATABASE (?:commander|\$\{POSTGRES_DB\}) OWNER TO commander_owner;/,
      );
      assert.match(initializer, /ALTER SCHEMA public OWNER TO commander_owner;/);
      assert.match(
        initializer,
        /REVOKE ALL ON DATABASE (?:commander|\$\{POSTGRES_DB\}) FROM PUBLIC;/,
      );
      assert.match(initializer, /REVOKE ALL ON SCHEMA public FROM PUBLIC;/);
      assert.doesNotMatch(initializer, /GRANT ALL PRIVILEGES ON DATABASE/);
      assert.doesNotMatch(initializer, /GRANT CREATE ON SCHEMA public TO commander_owner/);
      for (const role of [
        'commander_app',
        'commander_tenant_authority',
        'commander_scheduler',
        'commander_worker',
        'commander_adapter_ops',
      ]) {
        assert.match(
          initializer,
          new RegExp(`GRANT CONNECT ON DATABASE (?:commander|\\$\\{POSTGRES_DB\\}) TO ${role};`),
        );
        assert.match(initializer, new RegExp(`GRANT USAGE ON SCHEMA public TO ${role};`));
      }
    }
  });

  it('creates both fresh E2 fixtures with exact role attributes and app settings', () => {
    const initializers = [
      JSON.stringify(
        buildExternalPostgresResources({
          namespace: 'external-db',
          image: `docker.io/library/postgres:16-alpine@sha256:${'c'.repeat(64)}`,
          credentialsSecret: 'external-postgres-credentials',
          tlsSecret: 'external-postgres-tls',
        }),
      ),
      readFileSync(resolve('deploy/helm/commander/templates/configmap-database-init.yaml'), 'utf8'),
    ];
    const roleAttributes = new Map([
      ['commander_owner', 'NOSUPERUSER NOCREATEDB CREATEROLE INHERIT NOREPLICATION BYPASSRLS'],
      ['commander_app', 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'],
      [
        'commander_tenant_authority',
        'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      ],
      [
        'commander_scheduler',
        'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS',
      ],
      [
        'commander_worker',
        'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      ],
      [
        'commander_adapter_ops',
        'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      ],
    ]);
    for (const initializer of initializers) {
      for (const [role, attributes] of roleAttributes) {
        assert.match(
          initializer,
          new RegExp(`CREATE ROLE ${role} WITH LOGIN PASSWORD '[^']+' ${attributes};`),
        );
      }
      assert.match(initializer, /ALTER ROLE commander_app SET statement_timeout = '55s';/);
      assert.match(
        initializer,
        /ALTER ROLE commander_app SET idle_in_transaction_session_timeout = '10s';/,
      );
    }
  });

  it('selects the complete real lifecycle matrix and rejects unknown scenarios', () => {
    assert.deepEqual(selectLifecycleScenarios(), [
      'real-bundled',
      'real-external-tls',
      'failed-rollout-recovery',
    ]);
    assert.deepEqual(selectLifecycleScenarios('real-external-tls'), ['real-external-tls']);
    assert.throws(() => selectLifecycleScenarios('external-postgres'), /KIND_SCENARIO_INVALID/);
  });

  it('fails the top-level harness when any selected scenario fails', () => {
    assert.equal(aggregateScenarioPass([{ passed: true }, { passed: false }]), false);
    assert.equal(aggregateScenarioPass([{ passed: true }, { passed: true }]), true);
    assert.equal(aggregateScenarioPass([]), false);
  });

  it('includes RBAC and NetworkPolicy results in each scenario pass decision', () => {
    assert.equal(
      aggregateScenarioChecks({
        assertions: [{ passed: true }],
        rbac: [{ passed: false }],
        networkPolicy: [{ passed: true }],
      }),
      false,
    );
    assert.equal(
      aggregateScenarioChecks({
        assertions: [{ passed: true }],
        rbac: [{ passed: true }],
        networkPolicy: [{ passed: true }],
      }),
      true,
    );
    assert.equal(aggregateScenarioChecks({ assertions: [], rbac: [], networkPolicy: [] }), false);
  });

  it('maps the local production tag to the exact Kind containerd digest reference', () => {
    assert.deepEqual(productionImageReferences(`sha256:${'a'.repeat(64)}`), {
      source: 'docker.io/library/commander-lifecycle-api:kind',
      target: `docker.io/library/commander-lifecycle-api@sha256:${'a'.repeat(64)}`,
    });
    assert.throws(() => productionImageReferences('sha256:bad'), /PRODUCTION_IMAGE_DIGEST_INVALID/);
  });

  it('passes the checked-out source revision into the production image build', () => {
    const args = productionImageBuildArguments('a'.repeat(40));
    assert.ok(args.includes('--build-arg'));
    assert.ok(args.includes('COMMANDER_SOURCE_REVISION=' + 'a'.repeat(40)));
    assert.throws(
      () => productionImageBuildArguments('not-a-revision'),
      /PRODUCTION_IMAGE_SOURCE_REVISION_INVALID/,
    );
  });

  it('reuses a local production image only when its exact repo digest matches its image ID', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    assert.equal(
      reusableProductionImageDigest({
        imageId: digest,
        repoDigests: [`commander-lifecycle-api@${digest}`],
      }),
      digest,
    );
    assert.throws(
      () =>
        reusableProductionImageDigest({
          imageId: digest,
          repoDigests: [`commander-lifecycle-api@sha256:${'b'.repeat(64)}`],
        }),
      /PRODUCTION_IMAGE_REUSE_INVALID/,
    );
    assert.throws(
      () => reusableProductionImageDigest({ imageId: digest, repoDigests: [] }),
      /PRODUCTION_IMAGE_REUSE_INVALID/,
    );
  });

  it('skips a Kind image import only when every node has the exact digest reference', () => {
    const exact = `docker.io/library/postgres:16-alpine@sha256:${'a'.repeat(64)}`;
    assert.equal(
      nodeInventoriesContainExactReference(
        [
          { node: 'control-plane', references: [exact] },
          { node: 'worker', references: ['postgres:16-alpine', exact] },
        ],
        exact,
      ),
      true,
    );
    assert.equal(
      nodeInventoriesContainExactReference(
        [
          { node: 'control-plane', references: [exact] },
          { node: 'worker', references: ['postgres:16-alpine'] },
        ],
        exact,
      ),
      false,
    );
    assert.equal(nodeInventoriesContainExactReference([], exact), false);
  });

  it('requires the exact proof-reader identity and projected token contract', () => {
    const serviceAccountName = proofReaderName('commander-lifecycle', 'cmdr-live');
    assert.match(serviceAccountName, /^commander-proof-reader-[a-f0-9]{16}$/);
    assert.doesNotThrow(() =>
      assertProofPodContract(
        {
          spec: {
            serviceAccountName,
            automountServiceAccountToken: false,
            volumes: [
              {
                name: 'proof-api-token',
                projected: {
                  sources: [
                    {
                      serviceAccountToken: {
                        audience: 'commander-tenant-cutover-proof/v1',
                        expirationSeconds: 300,
                        path: 'token',
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
        serviceAccountName,
      ),
    );
    assert.throws(
      () =>
        assertProofPodContract(
          {
            spec: {
              serviceAccountName: 'default',
              automountServiceAccountToken: true,
              volumes: [],
            },
          },
          serviceAccountName,
        ),
      /PROOF_POD_CONTRACT_INVALID/,
    );
  });

  it('accepts only the explicit NetworkPolicy timeout sentinel as a negative canary', () => {
    assert.doesNotThrow(() => assertNegativeCanaryResult({ exitCode: 42, reason: 'Error' }));
    assert.throws(
      () => assertNegativeCanaryResult({ exitCode: 1, reason: 'Error' }),
      /NETWORK_POLICY_NEGATIVE_CANARY_INVALID/,
    );
  });

  it('pins the Calico manifest URL', () => {
    assert.match(CALICO_URL, /projectcalico\/calico\/v3\.29\.0/);
  });

  it('detects proof job templates in a chart directory', () => {
    const tmp = mkdtempSync(resolve(tmpdir(), 'kind-chart-'));
    writeFileSync(resolve(tmp, 'Chart.yaml'), 'name: test\nversion: 0.0.1\n');
    writeFileSync(resolve(tmp, 'values.yaml'), '{}\n');
    const templatesDir = resolve(tmp, 'templates');
    mkdirSync(templatesDir, { recursive: true });
    // No templates yet.
    assert.equal(proofTemplatesPresent(tmp), false);

    // Create the template.
    writeFileSync(resolve(templatesDir, 'tenant-cutover-prove-job.yaml'), 'kind: Job\n');
    assert.equal(proofTemplatesPresent(tmp), true);
  });

  it('runs the live Kind workflow for every production proof dependency', () => {
    const workflow = readFileSync(resolve('.github/workflows/helm-lifecycle.yml'), 'utf8');
    for (const path of [
      'apps/api/**',
      'deploy/helm/commander/**',
      'packages/**',
      'scripts/**',
      '.dockerignore',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig*.json',
    ]) {
      const quoted = `'${path.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`;
      assert.equal(
        workflow.match(new RegExp(`^\\s*- ${quoted}$`, 'gm'))?.length,
        2,
        `${path} must trigger both pull_request and push lifecycle proofs`,
      );
    }
    assert.match(workflow, /run: pnpm exec tsx scripts\/helm-lifecycle-kind\.ts run/);
  });

  it('sanitizes DSNs and PEM blocks from evidence', () => {
    const evidence = {
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: true,
          durationMs: 100,
          events: [],
          assertions: [
            {
              description: 'contains a DSN',
              passed: true,
              detail: 'postgres://owner:secret@db:5432/commander',
            },
          ],
        },
      ] as any[],
      passed: true,
      sanitized: false,
    };
    const sanitized = sanitizeEvidence(evidence);
    assert.equal(sanitized.sanitized, true);
    const detail = sanitized.scenarios[0].assertions[0].detail;
    assert.ok(detail !== undefined);
    assert.ok(!detail.includes('secret'), 'password should be redacted');
    assert.ok(detail.startsWith('postgres://'), 'DSN prefix preserved for diagnostics');
  });

  it('reports cluster existence without throwing', () => {
    const exists = kindClusterExists('commander-helm-lifecycle');
    assert.equal(typeof exists, 'boolean');
  });
});
