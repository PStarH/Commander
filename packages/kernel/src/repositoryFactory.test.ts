import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { describe, it, mock } from 'node:test';
import { Pool } from 'pg';
import { PostgresKernelRepository } from './postgres.js';
import {
  createKernelRepository,
  KernelBackendMissingError,
  KernelBackendRefusedError,
  resolveKernelBackend,
} from './repositoryFactory.js';

describe('resolveKernelBackend', () => {
  it('returns null when COMMANDER_KERNEL_BACKEND is missing', () => {
    assert.equal(resolveKernelBackend({}), null);
    assert.equal(resolveKernelBackend({ COMMANDER_KERNEL_BACKEND: '' }), null);
  });

  it('returns postgres or sqlite for explicit values', () => {
    assert.equal(resolveKernelBackend({ COMMANDER_KERNEL_BACKEND: 'postgres' }), 'postgres');
    assert.equal(resolveKernelBackend({ COMMANDER_KERNEL_BACKEND: 'sqlite' }), 'sqlite');
    assert.equal(resolveKernelBackend({ COMMANDER_KERNEL_BACKEND: 'SQLITE' }), 'sqlite');
  });

  it('returns null for unknown backend (no memory guess)', () => {
    assert.equal(resolveKernelBackend({ COMMANDER_KERNEL_BACKEND: 'memory' }), null);
    assert.equal(resolveKernelBackend({ COMMANDER_KERNEL_BACKEND: 'inmemory' }), null);
  });
});

describe('createKernelRepository boot policy', () => {
  it('refuses sqlite in production', async () => {
    await assert.rejects(
      () =>
        createKernelRepository({
          env: {
            NODE_ENV: 'production',
            COMMANDER_KERNEL_BACKEND: 'sqlite',
            COMMANDER_KERNEL_SQLITE_PATH: '/tmp/kernel-test.sqlite',
          },
          sqlitePath: '/tmp/kernel-test.sqlite',
        }),
      (err: unknown) =>
        err instanceof KernelBackendRefusedError &&
        (err as KernelBackendRefusedError).code === 'KERNEL_BACKEND_REFUSED',
    );
  });

  it('refuses sqlite for enterprise profile', async () => {
    await assert.rejects(
      () =>
        createKernelRepository({
          env: {
            COMMANDER_PROFILE: 'enterprise',
            COMMANDER_KERNEL_BACKEND: 'sqlite',
            COMMANDER_KERNEL_SQLITE_PATH: '/tmp/kernel-test.sqlite',
          },
        }),
      (err: unknown) => err instanceof KernelBackendRefusedError,
    );
  });

  it('throws KERNEL_BACKEND_MISSING when backend unset', async () => {
    await assert.rejects(
      () => createKernelRepository({ env: {} }),
      (err: unknown) => err instanceof KernelBackendMissingError,
    );
  });

  it('refuses postgres before connecting when verified TLS inputs are absent', async () => {
    await assert.rejects(
      () =>
        createKernelRepository({
          env: {
            COMMANDER_KERNEL_BACKEND: 'postgres',
            COMMANDER_KERNEL_DATABASE_URL:
              'postgres://commander_app:secret@db.internal/commander?sslmode=verify-full',
          },
        }),
      /COMMANDER_DATABASE_TLS_CA_FILE_REQUIRED/,
    );
  });

  it('requires a dedicated authority DSN when tenant context is enabled', async () => {
    await assert.rejects(
      () =>
        createKernelRepository({
          env: {
            COMMANDER_KERNEL_BACKEND: 'postgres',
            COMMANDER_KERNEL_DATABASE_URL:
              'postgres://commander_app:secret@db.internal/commander?sslmode=verify-full',
            COMMANDER_TENANT_CONTEXT_PHASE: 'enforce',
          },
        }),
      /COMMANDER_TENANT_AUTHORITY_DATABASE_URL is required/,
    );
  });

  it('closes both PostgreSQL pools when repository initialization fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-kernel-factory-'));
    const caFile = join(directory, 'ca.pem');
    const certificate = rootCertificates[0];
    assert.ok(certificate, 'Node must provide a root certificate fixture');
    writeFileSync(caFile, certificate, { mode: 0o600 });

    let closedPools = 0;
    const initialize = mock.method(PostgresKernelRepository.prototype, 'initialize', async () => {
      throw new Error('INITIALIZE_FAILED');
    });
    const end = mock.method(Pool.prototype, 'end', async () => {
      closedPools += 1;
    });

    try {
      await assert.rejects(
        () =>
          createKernelRepository({
            env: {
              COMMANDER_KERNEL_BACKEND: 'postgres',
              COMMANDER_KERNEL_DATABASE_URL:
                'postgres://commander_app:secret@app.internal/commander?sslmode=verify-full',
              COMMANDER_TENANT_AUTHORITY_DATABASE_URL:
                'postgres://commander_tenant_authority:secret@authority.internal/commander?sslmode=verify-full',
              COMMANDER_TENANT_CONTEXT_PHASE: 'enforce',
              COMMANDER_DATABASE_TLS_CA_FILE: caFile,
              COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: '1'.repeat(64),
            },
          }),
        /INITIALIZE_FAILED/,
      );
      assert.equal(closedPools, 2);
    } finally {
      initialize.mock.restore();
      end.mock.restore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('closes the app pool when authority pool construction fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-kernel-factory-'));
    const caFile = join(directory, 'ca.pem');
    const certificate = rootCertificates[0];
    assert.ok(certificate, 'Node must provide a root certificate fixture');
    writeFileSync(caFile, certificate, { mode: 0o600 });

    let closedPools = 0;
    const end = mock.method(Pool.prototype, 'end', async () => {
      closedPools += 1;
    });

    try {
      await assert.rejects(
        () =>
          createKernelRepository({
            env: {
              COMMANDER_KERNEL_BACKEND: 'postgres',
              COMMANDER_KERNEL_DATABASE_URL:
                'postgres://commander_app:secret@app.internal/commander?sslmode=verify-full',
              COMMANDER_TENANT_AUTHORITY_DATABASE_URL: 'not-a-postgres-url',
              COMMANDER_TENANT_CONTEXT_PHASE: 'enforce',
              COMMANDER_DATABASE_TLS_CA_FILE: caFile,
              COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: '1'.repeat(64),
            },
          }),
        /COMMANDER_DATABASE_DSN_INVALID/,
      );
      assert.equal(closedPools, 1);
    } finally {
      end.mock.restore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('creates sqlite repository when configured', async () => {
    const handle = await createKernelRepository({
      env: { COMMANDER_KERNEL_BACKEND: 'sqlite' },
      sqlitePath: ':memory:',
    });
    try {
      assert.equal(handle.backend, 'sqlite');
      await handle.repository.initialize();
    } finally {
      await handle.close();
    }
  });
});
