import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  assertEgressAllowlistBeforeDaemonStart,
  assertEgressUrlAllowed,
  parseEgressAllowlist,
} from './egress.js';
import { createAdapterOpsWiring } from './wiring.js';

describe('adapter-ops run wiring', () => {
  it('starts reconciliation and compensation against sqlite kernel', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-run-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const saved = {
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
    };
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    try {
      const wiring = await createAdapterOpsWiring();
      assert.equal(wiring.demoOpenHollowPep, false);
      wiring.reconciliation.start();
      wiring.compensation.start();
      assert.equal(typeof wiring.reconciliation.stop, 'function');
      await wiring.reconciliation.stop();
      await wiring.compensation.stop();
      await wiring.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('constructs wiring under NODE_ENV=production without broker gate errors', async () => {
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_DATABASE_URL: process.env.COMMANDER_KERNEL_DATABASE_URL,
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
    };
    process.env.NODE_ENV = 'production';
    process.env.COMMANDER_KERNEL_BACKEND = 'postgres';
    process.env.COMMANDER_KERNEL_DATABASE_URL =
      'postgres://commander:commander@127.0.0.1:5432/commander';
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    try {
      const wiring = await createAdapterOpsWiring();
      assert.equal(wiring.demoOpenHollowPep, false);
      await wiring.close();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('refuses COMMANDER_ADAPTER_OPS_DEMO_OPEN=1 in production', async () => {
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_PROFILE: process.env.COMMANDER_PROFILE,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_DATABASE_URL: process.env.COMMANDER_KERNEL_DATABASE_URL,
    };
    process.env.NODE_ENV = 'production';
    process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN = '1';
    process.env.COMMANDER_KERNEL_BACKEND = 'postgres';
    process.env.COMMANDER_KERNEL_DATABASE_URL =
      'postgres://commander:commander@127.0.0.1:5432/commander';
    try {
      await assert.rejects(
        () => createAdapterOpsWiring(),
        /ADAPTER_OPS_DEMO_OPEN_FORBIDDEN_IN_PRODUCTION/,
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('switches to hollow PEP when COMMANDER_ADAPTER_OPS_DEMO_OPEN=1 outside production', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-demo-open-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const saved = {
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_PROFILE: process.env.COMMANDER_PROFILE,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
    };
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_PROFILE;
    process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN = '1';
    try {
      const wiring = await createAdapterOpsWiring();
      assert.equal(wiring.demoOpenHollowPep, true);
      await wiring.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('adapter-ops egress fail-closed', () => {
  it('parses allowlist CSV', () => {
    assert.deepEqual(
      parseEgressAllowlist({ COMMANDER_ADAPTER_EGRESS_ALLOWLIST: ' api.github.com, *.service-now.com ' }),
      ['api.github.com', '*.service-now.com'],
    );
  });

  it('blocks daemon start on non-demo without allowlist', () => {
    assert.throws(
      () => assertEgressAllowlistBeforeDaemonStart('enterprise', []),
      /ADAPTER_OPS_EGRESS_ALLOWLIST_REQUIRED/,
    );
    assert.throws(
      () => assertEgressAllowlistBeforeDaemonStart('standard', []),
      /ADAPTER_OPS_EGRESS_ALLOWLIST_REQUIRED/,
    );
  });

  it('allows demo tier with empty allowlist', () => {
    assert.doesNotThrow(() => assertEgressAllowlistBeforeDaemonStart('demo', []));
  });

  it('allows non-demo when allowlist is non-empty', () => {
    assert.doesNotThrow(() =>
      assertEgressAllowlistBeforeDaemonStart('enterprise', ['api.github.com']),
    );
  });

  it('denies transport hosts outside hostname allowlist', () => {
    assert.throws(
      () => assertEgressUrlAllowed('https://evil.example/x', ['api.github.com']),
      /ADAPTER_OPS_EGRESS_DENIED/,
    );
    assert.doesNotThrow(() =>
      assertEgressUrlAllowed('https://api.github.com/repos/o/r', ['api.github.com']),
    );
  });
});
