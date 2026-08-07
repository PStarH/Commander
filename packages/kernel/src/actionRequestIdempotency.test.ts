import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { SqliteKernelRepository } from './sqlite.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('durable Action Gateway request binding', () => {
  it('replays the stored response and conflicts on a changed request after reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-action-request-'));
    directories.push(directory);
    const path = join(directory, 'kernel.sqlite');
    const input = {
      tenantId: 'tenant-a',
      idempotencyKey: 'action-key-0001',
      requestHash: 'a'.repeat(64),
    };
    const first = new SqliteKernelRepository({ path });
    await first.initialize();
    assert.deepEqual(await first.beginActionRequest(input), { state: 'STARTED' });
    await first.completeActionRequest({
      ...input,
      responseStatus: 202,
      responseBody: { action: { runId: 'run-1' } },
    });
    first.close();

    const reopened = new SqliteKernelRepository({ path });
    await reopened.initialize();
    assert.deepEqual(await reopened.beginActionRequest(input), {
      state: 'REPLAY',
      responseStatus: 202,
      responseBody: { action: { runId: 'run-1' } },
    });
    assert.deepEqual(await reopened.beginActionRequest({ ...input, requestHash: 'b'.repeat(64) }), {
      state: 'CONFLICT',
    });
    reopened.close();
  });
});
