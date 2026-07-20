import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createOperationsWiring } from './wiring.js';

describe('operations run wiring', () => {
  it('starts reconciliation and compensation against sqlite kernel', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-run-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const saved = {
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      NODE_ENV: process.env.NODE_ENV,
    };
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    delete process.env.NODE_ENV;
    try {
      const wiring = await createOperationsWiring();
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
    };
    process.env.NODE_ENV = 'production';
    process.env.COMMANDER_KERNEL_BACKEND = 'postgres';
    process.env.COMMANDER_KERNEL_DATABASE_URL = 'postgres://commander:commander@127.0.0.1:5432/commander';
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    try {
      const wiring = await createOperationsWiring();
      await wiring.close();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
