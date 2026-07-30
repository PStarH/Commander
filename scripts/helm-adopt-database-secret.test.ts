import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  parseDatabaseSecretAdoptionArgs,
  planExternalDatabaseSecretAdd,
  readOwnerOnlyAdoptionFile,
  runDatabaseSecretAdoption,
  transformBundledPersistentSecret,
  type DatabaseSecretAdoptionPorts,
  type KubernetesSecretSnapshot,
} from './helm-adopt-database-secret.js';

const encode = (value: string): string => Buffer.from(value, 'utf8').toString('base64');
const decode = (value: string): string => Buffer.from(value, 'base64').toString('utf8');

const logins = {
  'owner-url': 'commander_owner',
  'app-url': 'commander_app',
  'scheduler-url': 'commander_scheduler',
  'worker-url': 'commander_worker',
  'adapter-ops-url': 'commander_adapter_ops',
} as const;

function legacySecret(): KubernetesSecretSnapshot {
  const data: Record<string, string> = {};
  for (const [key, login] of Object.entries(logins)) {
    data[key] = encode(
      `postgres://${login}:${key}-password@postgres.commander.svc:5432/commander?application_name=${key}`,
    );
  }
  for (const key of [
    'owner-password',
    'app-password',
    'scheduler-password',
    'worker-password',
    'adapter-ops-password',
    'postgres-password',
  ]) {
    data[key] = encode(`${key}-value`);
  }
  return {
    metadata: { namespace: 'commander', name: 'managed-db', resourceVersion: '17' },
    type: 'Opaque',
    data,
  };
}

function approvedV8Secret(): KubernetesSecretSnapshot {
  const source = legacySecret();
  delete source.data['adapter-ops-url'];
  delete source.data['adapter-ops-password'];
  return source;
}

describe('Helm database Secret adoption', () => {
  it('creates the exact stable 13-key bundled Secret without changing the source', () => {
    const source = legacySecret();
    const before = structuredClone(source);
    const authorityPassword = 'authority-password';
    const target = transformBundledPersistentSecret({
      source,
      targetName: 'stable-db',
      tenantAuthorityUrl:
        `postgres://commander_tenant_authority:${authorityPassword}` +
        '@postgres.commander.svc:5432/commander?sslmode=verify-full',
      tenantAuthorityPassword: authorityPassword,
    });

    assert.deepEqual(source, before);
    assert.equal(target.metadata.name, 'stable-db');
    assert.equal(target.metadata.namespace, 'commander');
    assert.equal(Object.keys(target.data).length, 13);
    assert.deepEqual(Object.keys(target.data).sort(), [
      'adapter-ops-password',
      'adapter-ops-url',
      'app-password',
      'app-url',
      'owner-password',
      'owner-url',
      'postgres-password',
      'scheduler-password',
      'scheduler-url',
      'tenant-authority-password',
      'tenant-authority-url',
      'worker-password',
      'worker-url',
    ]);
    for (const key of Object.keys(logins)) {
      const url = new URL(decode(target.data[key]!));
      assert.equal(url.searchParams.get('sslmode'), 'verify-full');
      assert.equal(url.searchParams.get('application_name'), key);
      assert.equal([...url.searchParams.keys()].filter((name) => name.startsWith('ssl')).length, 1);
    }
  });

  it('rejects source-shape, login, TLS parameter, and supplied authority parity drift', () => {
    const valid = {
      source: legacySecret(),
      targetName: 'stable-db',
      tenantAuthorityUrl:
        'postgres://commander_tenant_authority:authority-password@postgres.commander.svc:5432/commander?sslmode=verify-full',
      tenantAuthorityPassword: 'authority-password',
    };
    const cases = [
      () => {
        const source = legacySecret();
        source.data.extra = encode('unexpected');
        return { ...valid, source };
      },
      () => {
        const source = legacySecret();
        source.data['owner-url'] = encode(
          'postgres://wrong:secret@postgres.commander.svc:5432/commander',
        );
        return { ...valid, source };
      },
      () => {
        const source = legacySecret();
        source.data['owner-url'] = encode(
          'postgres://commander_owner:secret@postgres.commander.svc:5432/commander?ssl=true',
        );
        return { ...valid, source };
      },
      () => ({ ...valid, tenantAuthorityPassword: 'different' }),
      () => ({
        ...valid,
        tenantAuthorityUrl: valid.tenantAuthorityUrl.replace('verify-full', 'require'),
      }),
    ];
    for (const fixture of cases) {
      assert.throws(
        () => transformBundledPersistentSecret(fixture()),
        /TENANT_DATABASE_SECRET_ADOPTION_INVALID/,
      );
    }
  });

  it('adopts the actual approved-v8 9-key Secret with explicit adapter-ops credentials', () => {
    const source = approvedV8Secret();
    const before = structuredClone(source);
    assert.equal(Object.keys(source.data).length, 9);
    const target = transformBundledPersistentSecret({
      source,
      targetName: 'stable-db',
      adapterOpsUrl:
        'postgres://commander_adapter_ops:adapter-password@postgres.commander.svc:5432/commander?application_name=adapter-ops',
      adapterOpsPassword: 'adapter-password',
      tenantAuthorityUrl:
        'postgres://commander_tenant_authority:authority-password@postgres.commander.svc:5432/commander?sslmode=verify-full',
      tenantAuthorityPassword: 'authority-password',
    });
    assert.equal(Object.keys(target.data).length, 13);
    assert.equal(decode(target.data['adapter-ops-password']!), 'adapter-password');
    assert.equal(
      new URL(decode(target.data['adapter-ops-url']!)).searchParams.get('sslmode'),
      'verify-full',
    );
    assert.deepEqual(source, before);
  });

  it('plans a resourceVersion-guarded external add and treats exact retries as unchanged', () => {
    const source = approvedV8Secret();
    const authorityUrl =
      'postgres://commander_tenant_authority:authority-password@proxy.example.test:6432/commander?sslmode=verify-full';
    const planned = planExternalDatabaseSecretAdd({
      source,
      tenantAuthorityUrl: authorityUrl,
      tenantAuthorityKey: 'authority-proxy-url',
    });
    assert.equal(planned.action, 'patch');
    assert.deepEqual(planned.patch, [
      { op: 'test', path: '/metadata/resourceVersion', value: '17' },
      { op: 'add', path: '/data/authority-proxy-url', value: encode(authorityUrl) },
    ]);

    source.data['authority-proxy-url'] = encode(authorityUrl);
    assert.deepEqual(
      planExternalDatabaseSecretAdd({
        source,
        tenantAuthorityUrl: authorityUrl,
        tenantAuthorityKey: 'authority-proxy-url',
      }),
      { action: 'unchanged', patch: [] },
    );
    source.data['authority-proxy-url'] = encode(`${authorityUrl}&application_name=changed`);
    assert.throws(
      () =>
        planExternalDatabaseSecretAdd({
          source,
          tenantAuthorityUrl: authorityUrl,
          tenantAuthorityKey: 'authority-proxy-url',
        }),
      /TENANT_DATABASE_SECRET_ADOPTION_CONFLICT/,
    );
  });

  it('performs create-only bundled adoption and reports no credential material', async () => {
    const source = approvedV8Secret();
    const sourceBefore = structuredClone(source);
    const secrets = new Map([[source.metadata.name, structuredClone(source)]]);
    const adapterOpsPassword = 'adapter-password';
    const adapterOpsUrl =
      `postgres://commander_adapter_ops:${adapterOpsPassword}` +
      '@postgres.commander.svc:5432/commander';
    const authorityPassword = 'authority-password';
    const authorityUrl =
      `postgres://commander_tenant_authority:${authorityPassword}` +
      '@postgres.commander.svc:5432/commander?sslmode=verify-full';
    const authenticated: string[] = [];
    const ports: DatabaseSecretAdoptionPorts = {
      readOwnerOnlyFile: async (path) => {
        if (path.includes('adapter') && path.endsWith('url')) {
          return `${adapterOpsUrl}\n`;
        }
        if (path.includes('adapter')) return `${adapterOpsPassword}\n`;
        return path.endsWith('url') ? `${authorityUrl}\n` : `${authorityPassword}\n`;
      },
      readSecret: async (_namespace, name) => structuredClone(secrets.get(name) ?? null),
      authenticateOwner: async (url) => {
        authenticated.push(url);
      },
      createSecret: async (secret) => {
        assert.equal(secrets.has(secret.metadata.name), false);
        const created = structuredClone(secret);
        created.metadata.resourceVersion = '18';
        secrets.set(secret.metadata.name, created);
      },
      patchSecret: async () => assert.fail('bundled mode must not patch'),
    };
    const result = await runDatabaseSecretAdoption(
      {
        mode: 'bundled-persistent',
        namespace: 'commander',
        source: 'managed-db',
        target: 'stable-db',
        adapterOpsUrlFile: '/run/adapter-url',
        adapterOpsPasswordFile: '/run/adapter-password',
        tenantAuthorityUrlFile: '/run/authority-url',
        tenantAuthorityPasswordFile: '/run/authority-password',
      },
      ports,
    );
    assert.equal(authenticated.length, 1);
    assert.match(authenticated[0]!, /^postgres:\/\/commander_owner:/);
    assert.deepEqual(source, sourceBefore);
    assert.equal(Object.keys(source.data).length, 9);
    const created = secrets.get('stable-db')!;
    assert.equal(Object.keys(created.data).length, 13);
    assert.equal(decode(created.data['adapter-ops-url']!), `${adapterOpsUrl}?sslmode=verify-full`);
    assert.equal(decode(created.data['adapter-ops-password']!), adapterOpsPassword);
    assert.equal(decode(created.data['tenant-authority-url']!), authorityUrl);
    assert.equal(decode(created.data['tenant-authority-password']!), authorityPassword);
    assert.notEqual(
      decode(created.data['adapter-ops-password']!),
      decode(source.data['owner-password']!),
    );
    const output = JSON.stringify(result);
    assert.doesNotMatch(output, /:authority-password@|postgres:\/\/commander/);
    assert.deepEqual(result, {
      mode: 'bundled-persistent',
      status: 'created',
      namespace: 'commander',
      secret: 'stable-db',
      keyNames: Object.keys(created.data).sort(),
    });
  });

  it('parses only the two closed CLI modes and enforces owner-only input files', async () => {
    assert.deepEqual(
      parseDatabaseSecretAdoptionArgs([
        'bundled-persistent',
        '--namespace',
        'commander',
        '--source',
        'managed-db',
        '--target',
        'stable-db',
        '--adapter-ops-url-file',
        '/run/adapter-url',
        '--adapter-ops-password-file',
        '/run/adapter-password',
        '--tenant-authority-url-file',
        '/run/authority-url',
        '--tenant-authority-password-file',
        '/run/authority-password',
      ]),
      {
        mode: 'bundled-persistent',
        namespace: 'commander',
        source: 'managed-db',
        target: 'stable-db',
        adapterOpsUrlFile: '/run/adapter-url',
        adapterOpsPasswordFile: '/run/adapter-password',
        tenantAuthorityUrlFile: '/run/authority-url',
        tenantAuthorityPasswordFile: '/run/authority-password',
      },
    );
    assert.deepEqual(
      parseDatabaseSecretAdoptionArgs([
        'external-add',
        '--namespace',
        'commander',
        '--secret',
        'database',
        '--tenant-authority-url-file',
        '/run/authority-url',
        '--tenant-authority-key',
        'authority-proxy-url',
      ]),
      {
        mode: 'external-add',
        namespace: 'commander',
        secret: 'database',
        tenantAuthorityUrlFile: '/run/authority-url',
        tenantAuthorityKey: 'authority-proxy-url',
      },
    );
    assert.throws(
      () =>
        parseDatabaseSecretAdoptionArgs([
          'external-add',
          '--namespace',
          'commander',
          '--secret',
          'database',
          '--tenant-authority-url-file',
          '/run/url',
          '--force',
          'true',
        ]),
      /TENANT_DATABASE_SECRET_ADOPTION_ARGUMENT_INVALID/,
    );

    const directory = mkdtempSync(join(tmpdir(), 'commander-adoption-'));
    const file = join(directory, 'value');
    writeFileSync(file, 'secret\n', { mode: 0o600 });
    assert.equal(await readOwnerOnlyAdoptionFile(file), 'secret\n');
    chmodSync(file, 0o644);
    await assert.rejects(
      () => readOwnerOnlyAdoptionFile(file),
      /TENANT_DATABASE_SECRET_ADOPTION_FILE_INVALID/,
    );
  });
});
