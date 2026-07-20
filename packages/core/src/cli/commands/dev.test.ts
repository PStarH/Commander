import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import {
  acquireDevLock,
  buildDevChildEnv,
  buildDevChildSpecs,
  DevAlreadyRunningError,
  DEV_SHUTDOWN_ORDER,
  prepareDevDataDir,
  resolveDevLayout,
  shutdownChildren,
} from './dev.js';
import { parseFlags } from '../util.js';
import { readFileSync } from 'node:fs';

function mockChild(): ChildProcess {
  const emitter = new EventEmitter();
  return emitter as unknown as ChildProcess;
}

describe('commander dev supervisor', () => {
  it('acquireDevLock rejects a second lock with DEV_ALREADY_RUNNING', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-lock-'));
    const layout = resolveDevLayout({ dataDir: dir });
    prepareDevDataDir(layout, false);
    const first = acquireDevLock(layout);
    assert.throws(() => acquireDevLock(layout), DevAlreadyRunningError);
    first.release();
    rmSync(dir, { recursive: true, force: true });
  });

  it('injects sqlite backend env for all children', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-env-'));
    const layout = resolveDevLayout({ dataDir: dir });
    const env = buildDevChildEnv({
      layout,
      port: 4010,
      apiKey: 'test-api-key',
      workerAuthToken: 'worker-token',
      repoRoot: '/repo',
      opsHealthPort: 8091,
    });
    assert.equal(env.COMMANDER_KERNEL_BACKEND, 'sqlite');
    assert.equal(env.COMMANDER_KERNEL_SQLITE_PATH, layout.kernelSqlite);
    assert.equal(env.COMMANDER_KERNEL_ENABLED, '1');
    assert.equal(env.TENANT_API_KEYS, 'local:test-api-key');
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds four child specs without importing kernel/api/worker modules', () => {
    const specs = buildDevChildSpecs({
      repoRoot: '/repo',
      env: {
        COMMANDER_WORKER_BOOTSTRAP: '/repo/packages/worker-plane/src/bootstrap.ts',
      },
    });
    assert.equal(specs.length, 4);
    assert.deepEqual(
      specs.map((s) => s.role),
      ['api', 'worker', 'kernel-ops', 'operations'],
    );
    assert.equal(specs[0]?.args.includes('apps/api/src/index.ts'), true);
    assert.equal(specs[1]?.args[0], 'packages/worker-plane/dist/main.js');
  });

  it('shuts down children in reverse start order', async () => {
    const killed: string[] = [];
    const children = new Map(
      DEV_SHUTDOWN_ORDER.map((role) => {
        const child = mockChild();
        (child as unknown as { kill: (signal?: string) => void }).kill = (signal?: string) => {
          killed.push(`${role}:${signal ?? 'SIGTERM'}`);
        };
        (child as unknown as { killed: boolean }).killed = false;
        return [role, child] as const;
      }),
    );
    await shutdownChildren(children, DEV_SHUTDOWN_ORDER, 'SIGTERM', 10);
    assert.deepEqual(killed.slice(0, 4), [
      'operations:SIGTERM',
      'worker:SIGTERM',
      'kernel-ops:SIGTERM',
      'api:SIGTERM',
    ]);
  });

  it('writes api-key file with restrictive permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-key-'));
    const layout = resolveDevLayout({ dataDir: dir });
    prepareDevDataDir(layout, false);
    assert.equal(existsSync(layout.apiKeyPath), true);
    assert.ok(readFileSync(layout.apiKeyPath, 'utf8').trim().length >= 16);
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolveDevLayout honors --data-dir kebab-case flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-data-dir-'));
    const { flags } = parseFlags([`--data-dir=${dir}`]);
    const layout = resolveDevLayout(flags);
    assert.equal(layout.dataDir, dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it('verbose ops.env includes only PORT and COMMANDER_* keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-verbose-'));
    const layout = resolveDevLayout({ dataDir: dir });
    prepareDevDataDir(layout, false);
    const env = buildDevChildEnv({
      layout,
      port: 4010,
      apiKey: 'test-api-key',
      workerAuthToken: 'worker-token',
      repoRoot: '/repo',
      opsHealthPort: 8091,
    });
    const filtered = Object.fromEntries(
      Object.entries(env).filter(([k]) => k === 'PORT' || k.startsWith('COMMANDER_')),
    );
    writeFileSync(join(layout.dataDir, 'ops.env'), JSON.stringify(filtered, null, 2), {
      mode: 0o600,
    });
    const written = JSON.parse(readFileSync(join(layout.dataDir, 'ops.env'), 'utf8')) as Record<
      string,
      string
    >;
    assert.equal(written.PORT, '4010');
    assert.ok(written.COMMANDER_KERNEL_BACKEND);
    assert.equal(written.PATH, undefined);
    assert.equal(written.HOME, undefined);
    rmSync(dir, { recursive: true, force: true });
  });
});
