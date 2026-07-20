import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createKernelRepository } from '../packages/kernel/src/repositoryFactory.js';
import { SqliteKernelRepository } from '../packages/kernel/src/sqlite.js';
import {
  normalizeTranscript,
  runKernelTranscriptScenarios,
} from '../packages/kernel/src/testing/kernelTranscript.js';

describe('l4-b local enterprise equivalence (sqlite-only)', () => {
  it('produces a stable sqlite transcript digest without DATABASE_URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'l4-equiv-test-'));
    const path = join(dir, 'kernel.sqlite');
    try {
      let n = 0;
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
      const entries = await runKernelTranscriptScenarios(repo, {
        clock: { now: () => '2030-01-01T00:00:00.000Z' },
        ids: { uuid: () => `equiv-test-id-${++n}` },
      });
      const digest = normalizeTranscript(entries);
      assert.match(digest, /^[a-f0-9]{64}$/);
      await handle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
