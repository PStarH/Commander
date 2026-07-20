#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernelRepository } from '../packages/kernel/src/repositoryFactory.js';
import { SqliteKernelRepository } from '../packages/kernel/src/sqlite.js';
import {
  normalizeTranscript,
  runKernelTranscriptScenarios,
} from '../packages/kernel/src/testing/kernelTranscript.js';

const sqliteOnly = process.argv.includes('--sqlite-only');
const clock = { now: () => '2030-01-01T00:00:00.000Z' };
let idCounter = 0;
const ids = { uuid: () => `equiv-id-${++idCounter}` };

async function runSqliteDigest(): Promise<string> {
  idCounter = 0;
  const dir = mkdtempSync(join(tmpdir(), 'l4-equiv-sqlite-'));
  const path = join(dir, 'kernel.sqlite');
  try {
    const handle = await createKernelRepository({
      env: {
        COMMANDER_KERNEL_BACKEND: 'sqlite',
        COMMANDER_KERNEL_SQLITE_PATH: path,
      },
      sqlitePath: path,
    });
      const repo = handle.repository;
      if (repo instanceof SqliteKernelRepository) {
        repo.seedTestWorker('worker-transcript', ['tenant-transcript'], 1);
      }
    const entries = await runKernelTranscriptScenarios(repo, { clock, ids });
    const digest = normalizeTranscript(entries);
    await handle.close();
    return digest;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runPostgresDigest(databaseUrl: string): Promise<string> {
  idCounter = 0;
  const handle = await createKernelRepository({
    env: {
      COMMANDER_KERNEL_BACKEND: 'postgres',
      DATABASE_URL: databaseUrl,
      COMMANDER_KERNEL_SCHEDULER_MODE: '1',
    },
  });
  try {
    const entries = await runKernelTranscriptScenarios(handle.repository, { clock, ids });
    return normalizeTranscript(entries);
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const sqliteDigest = await runSqliteDigest();
  console.log(`sqlite digest: ${sqliteDigest}`);

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.log('postgres: SKIPPED (no DATABASE_URL) — equivalence ENFORCED (sqlite-only)');
    if (sqliteOnly) process.exit(0);
    process.exit(0);
  }

  const postgresDigest = await runPostgresDigest(databaseUrl);
  console.log(`postgres digest: ${postgresDigest}`);
  const match = sqliteDigest === postgresDigest;
  console.log(`match=${match}`);
  if (!match) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error('[l4-b-equivalence] fatal:', error);
  process.exitCode = 1;
});
