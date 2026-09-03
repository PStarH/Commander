import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalBootstrapJson } from '../packages/kernel/src/canonicalBootstrap.js';
import {
  materializeRetainedRendererValues,
  projectHelmReleaseRevision,
} from './helm-release-projection.js';

const chart = 'b'.repeat(64);
const historicalPassword = 'historical-postgres-password';
const manifest = `
apiVersion: v1
kind: Secret
metadata:
  name: commander-database
  namespace: commander
  labels:
    app.kubernetes.io/instance: commander
type: Opaque
immutable: true
data:
  owner-url: cG9zdGdyZXM6Ly9zZWNyZXQ=
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: commander-api
  namespace: commander
spec:
  selector:
    matchLabels: { app: commander-api }
  template:
    metadata:
      labels: { app: commander-api }
    spec:
      containers:
        - name: api
          image: ghcr.io/commander/api@sha256:${'a'.repeat(64)}
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: commander-database
                  key: owner-url
---
apiVersion: batch/v1
kind: Job
metadata:
  name: commander-migrate
  namespace: commander
  annotations:
    helm.sh/hook: pre-upgrade
    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
spec: { template: { spec: { restartPolicy: Never, containers: [{ name: migrate, image: x }] } } }
`;

describe('Helm release projection', () => {
  it('retains secret-free comparators, references, renderer input, and hooks', () => {
    const projection = projectHelmReleaseRevision({
      namespace: 'commander',
      releaseName: 'commander',
      revision: '7',
      manifest,
      values: `tenantAuthority:\n  chartContentSha256: ${chart}\n`,
    });
    assert.equal(projection.chartContentSha256, chart);
    assert.deepEqual(
      projection.objects.map(({ identity }) => `${identity.kind}/${identity.name}`),
      ['Deployment/commander-api', 'Secret/commander-database'],
    );
    assert.deepEqual(projection.objects[0]?.secretReferences, [
      { apiVersion: 'v1', kind: 'Secret', namespace: 'commander', name: 'commander-database' },
    ]);
    assert.deepEqual(projection.hooks, [
      {
        identity: {
          apiVersion: 'batch/v1',
          kind: 'Job',
          namespace: 'commander',
          name: 'commander-migrate',
        },
        deletePolicies: ['before-hook-creation', 'hook-succeeded'],
      },
    ]);
    const serialized = canonicalBootstrapJson(projection);
    assert.doesNotMatch(serialized, /cG9zdGdyZXM6Ly9zZWNyZXQ=|postgres:\/\/secret/);
    assert.match(serialized, /"dataKeys":\["owner-url"\]/);
    assert.match(serialized, /helm-renderer-input-projection\/v1/);
  });

  it('replaces the closed historical password value with an exact typed Secret reference', () => {
    const credentialManifest = manifest.replace(
      '  owner-url: cG9zdGdyZXM6Ly9zZWNyZXQ=',
      `  owner-url: cG9zdGdyZXM6Ly9zZWNyZXQ=\n  postgres-password: ${Buffer.from(historicalPassword).toString('base64')}`,
    );
    const projection = projectHelmReleaseRevision({
      namespace: 'commander',
      releaseName: 'commander',
      revision: '7',
      manifest: credentialManifest,
      values: [
        'database:',
        '  postgres:',
        `    password: ${historicalPassword}`,
        'tenantAuthority:',
        `  chartContentSha256: ${chart}`,
        '',
      ].join('\n'),
    });
    const rendererValues = projection.rendererInput.values as {
      database: { postgres: { password: string } };
    };
    assert.equal(
      rendererValues.database.postgres.password,
      'commander-secret-ref/v1:/database/postgres/password:commander-database:postgres-password',
    );
    assert.deepEqual(projection.rendererInput.secretReferences, [
      { apiVersion: 'v1', kind: 'Secret', namespace: 'commander', name: 'commander-database' },
    ]);
    assert.doesNotMatch(canonicalBootstrapJson(projection), new RegExp(historicalPassword));
  });

  it('revalidates an exact retained Secret sentinel during restore projection', () => {
    const sentinel =
      'commander-secret-ref/v1:/database/postgres/password:commander-database:postgres-password';
    const credentialManifest = manifest.replace(
      '  owner-url: cG9zdGdyZXM6Ly9zZWNyZXQ=',
      `  owner-url: cG9zdGdyZXM6Ly9zZWNyZXQ=\n  postgres-password: ${Buffer.from(historicalPassword).toString('base64')}`,
    );
    const project = (password: string) =>
      projectHelmReleaseRevision({
        namespace: 'commander',
        releaseName: 'commander',
        revision: '8',
        manifest: credentialManifest,
        values: `database:\n  postgres:\n    password: ${password}\ntenantAuthority:\n  chartContentSha256: ${chart}\n`,
      });

    const projection = project(sentinel);
    assert.equal(
      (projection.rendererInput.values as { database: { postgres: { password: string } } }).database
        .postgres.password,
      sentinel,
    );
    for (const tampered of [
      sentinel.replace('commander-database', 'other-secret'),
      sentinel.replace('postgres-password', 'other-key'),
      sentinel.replace('/database/postgres/password', '/database/password'),
    ]) {
      assert.throws(() => project(tampered), /TENANT_CUTOVER_RESTORE_PROJECTION_INVALID/);
    }
  });

  it('materializes a retained sentinel only from one live projected Secret source', () => {
    const sentinel =
      'commander-secret-ref/v1:/database/postgres/password:commander-database:postgres-password';
    const credentialManifest = manifest.replace(
      '  owner-url: cG9zdGdyZXM6Ly9zZWNyZXQ=',
      `  owner-url: cG9zdGdyZXM6Ly9zZWNyZXQ=\n  postgres-password: ${Buffer.from(historicalPassword).toString('base64')}`,
    );
    const projection = projectHelmReleaseRevision({
      namespace: 'commander',
      releaseName: 'commander',
      revision: '8',
      manifest: credentialManifest,
      values: `database:\n  postgres:\n    password: ${sentinel}\ntenantAuthority:\n  chartContentSha256: ${chart}\n`,
    });
    const materialize = (sourceManifest: string, values = projection.rendererInput.values) =>
      materializeRetainedRendererValues({
        values,
        secretReferences: projection.rendererInput.secretReferences,
        manifest: sourceManifest,
        namespace: 'commander',
      });

    assert.deepEqual(materialize(credentialManifest), {
      database: { postgres: { password: historicalPassword } },
      tenantAuthority: { chartContentSha256: chart },
    });
    assert.doesNotMatch(canonicalBootstrapJson(projection), new RegExp(historicalPassword));
    for (const malformed of [
      credentialManifest.replace('name: commander-database', 'name: other-database'),
      credentialManifest.replace('namespace: commander', 'deletionTimestamp: 2026-07-29T00:00:00Z'),
      `${credentialManifest}\n---\n${credentialManifest.split('---')[0]}`,
    ]) {
      assert.throws(() => materialize(malformed), /TENANT_CUTOVER_RESTORE_PROJECTION_INVALID/);
    }
    assert.throws(
      () =>
        materialize(credentialManifest, {
          database: {
            postgres: {
              password: sentinel.replace('commander-database', 'unprojected-database'),
            },
          },
          tenantAuthority: { chartContentSha256: chart },
        }),
      /TENANT_CUTOVER_RESTORE_PROJECTION_INVALID/,
    );
  });

  it('refuses to project a retained credential from a deleting Secret', () => {
    const deletingManifest = manifest
      .replace(
        '  namespace: commander',
        '  namespace: commander\n  deletionTimestamp: 2026-07-29T00:00:00Z',
      )
      .replace(
        '  owner-url: cG9zdGdyZXM6Ly9zZWNyZXQ=',
        `  owner-url: cG9zdGdyZXM6Ly9zZWNyZXQ=\n  postgres-password: ${Buffer.from(historicalPassword).toString('base64')}`,
      );
    assert.throws(
      () =>
        projectHelmReleaseRevision({
          namespace: 'commander',
          releaseName: 'commander',
          revision: '7',
          manifest: deletingManifest,
          values: `database:\n  postgres:\n    password: ${historicalPassword}\ntenantAuthority:\n  chartContentSha256: ${chart}\n`,
        }),
      /TENANT_CUTOVER_RESTORE_PROJECTION_INVALID/,
    );
  });

  it('requires the retained Secret source name to be independently referenced by the release', () => {
    const credentialManifest = manifest
      .replace(
        '  owner-url: cG9zdGdyZXM6Ly9zZWNyZXQ=',
        `  owner-url: cG9zdGdyZXM6Ly9zZWNyZXQ=\n  postgres-password: ${Buffer.from(historicalPassword).toString('base64')}`,
      )
      .replace(
        'name: commander-database\n                  key: owner-url',
        'name: other-database\n                  key: owner-url',
      );
    assert.throws(
      () =>
        projectHelmReleaseRevision({
          namespace: 'commander',
          releaseName: 'commander',
          revision: '7',
          manifest: credentialManifest,
          values: `database:\n  postgres:\n    password: ${historicalPassword}\ntenantAuthority:\n  chartContentSha256: ${chart}\n`,
        }),
      /TENANT_CUTOVER_RESTORE_PROJECTION_INVALID/,
    );
  });

  it('rejects a credential literal in every non-Secret manifest field', () => {
    const inlineCredentialManifest = manifest.replace(
      '              valueFrom:\n                secretKeyRef:\n                  name: commander-database\n                  key: owner-url',
      '              value: postgres://commander:literal@postgres/commander',
    );
    assert.throws(
      () =>
        projectHelmReleaseRevision({
          namespace: 'commander',
          releaseName: 'commander',
          revision: '7',
          manifest: inlineCredentialManifest,
          values: `tenantAuthority:\n  chartContentSha256: ${chart}\n`,
        }),
      /TENANT_CUTOVER_RESTORE_PROJECTION_INVALID/,
    );
  });

  it('orders renderer secret references by canonical JSON code-unit order', () => {
    // 'database-ca' sorts before 'database' under localeCompare (ICU-dependent)
    // but after it under the default string order the task1 restore-evidence
    // validator re-derives from JSON.stringify. The projection must use the
    // validator's ordering.
    const dualSecretManifest = `${manifest}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: commander-api-tls
  namespace: commander
spec:
  selector:
    matchLabels: { app: commander-api-tls }
  template:
    metadata:
      labels: { app: commander-api-tls }
    spec:
      containers:
        - name: api
          image: ghcr.io/commander/api@sha256:${'a'.repeat(64)}
          env:
            - name: DATABASE_CA
              valueFrom:
                secretKeyRef:
                  name: commander-database-ca
                  key: ca.crt
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: commander-database
                  key: owner-url
`;
    const projection = projectHelmReleaseRevision({
      namespace: 'commander',
      releaseName: 'commander',
      revision: '7',
      manifest: dualSecretManifest,
      values: `tenantAuthority:\n  chartContentSha256: ${chart}\n`,
    });
    const serialized = (reference: { name: string }): string => JSON.stringify(reference);
    const references = projection.rendererInput.secretReferences as Array<{ name: string }>;
    assert.deepEqual(
      references.map((reference) => reference.name),
      [...references.map((reference) => reference.name)].sort((left, right) => {
        const leftRef = references.find((reference) => reference.name === left)!;
        const rightRef = references.find((reference) => reference.name === right)!;
        return serialized(leftRef) < serialized(rightRef)
          ? -1
          : serialized(leftRef) > serialized(rightRef)
            ? 1
            : 0;
      }),
    );
    assert.equal(
      references.some((reference) => reference.name === 'commander-database'),
      true,
    );
    assert.equal(
      references.some((reference) => reference.name === 'commander-database-ca'),
      true,
    );
    // The exact historical regression: localeCompare placed -ca first.
    const databaseIndex = references.findIndex(
      (reference) => reference.name === 'commander-database',
    );
    const databaseCaIndex = references.findIndex(
      (reference) => reference.name === 'commander-database-ca',
    );
    assert.ok(databaseIndex < databaseCaIndex);
  });

  it('rejects duplicate identities and a revision without a sealed chart digest', () => {
    assert.throws(
      () =>
        projectHelmReleaseRevision({
          namespace: 'commander',
          releaseName: 'commander',
          revision: '7',
          manifest: `${manifest}\n---\n${manifest.split('---')[0]}`,
          values: `tenantAuthority:\n  chartContentSha256: ${chart}\n`,
        }),
      /TENANT_CUTOVER_RESTORE_PROJECTION_INVALID/,
    );
    assert.throws(
      () =>
        projectHelmReleaseRevision({
          namespace: 'commander',
          releaseName: 'commander',
          revision: '7',
          manifest,
          values: 'tenantAuthority: {}\n',
        }),
      /TENANT_CUTOVER_RESTORE_PROJECTION_INVALID/,
    );
    assert.throws(
      () =>
        projectHelmReleaseRevision({
          namespace: 'commander',
          releaseName: 'commander',
          revision: '7',
          manifest,
          values: `oauth:\n  clientSecret: must-not-be-retained\ntenantAuthority:\n  chartContentSha256: ${chart}\n`,
        }),
      /TENANT_CUTOVER_RESTORE_PROJECTION_INVALID/,
    );
    for (const unclassified of [
      'database:\n  connectionString: postgres://commander:literal@postgres/commander',
      'oauth:\n  apiKey: literal-api-key',
      'signing:\n  privateKeyPem: literal-private-key',
    ]) {
      assert.throws(
        () =>
          projectHelmReleaseRevision({
            namespace: 'commander',
            releaseName: 'commander',
            revision: '7',
            manifest,
            values: `${unclassified}\ntenantAuthority:\n  chartContentSha256: ${chart}\n`,
          }),
        /TENANT_CUTOVER_RESTORE_PROJECTION_INVALID/,
      );
    }
  });
});
