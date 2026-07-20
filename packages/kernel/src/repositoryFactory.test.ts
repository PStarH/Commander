import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
      () => createKernelRepository({
        env: {
          NODE_ENV: 'production',
          COMMANDER_KERNEL_BACKEND: 'sqlite',
          COMMANDER_KERNEL_SQLITE_PATH: '/tmp/kernel-test.sqlite',
        },
        sqlitePath: '/tmp/kernel-test.sqlite',
      }),
      (err: unknown) => err instanceof KernelBackendRefusedError && (err as KernelBackendRefusedError).code === 'KERNEL_BACKEND_REFUSED',
    );
  });

  it('refuses sqlite for enterprise profile', async () => {
    await assert.rejects(
      () => createKernelRepository({
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
