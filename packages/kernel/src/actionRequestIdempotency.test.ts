import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { KERNEL_ACTION_REQUEST_IDEMPOTENCY_SQL } from './actionRequestSchema.js';
import { SqliteKernelRepository } from './sqlite.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('durable Action Gateway request binding', () => {
  it('binds Postgres RLS to the authenticated app tenant', () => {
    assert.match(
      KERNEL_ACTION_REQUEST_IDEMPOTENCY_SQL,
      /CREATE POLICY commander_app_authenticated_tenant[\s\S]*tenant_id = public\.commander_authenticated_app_tenant\(\)/,
    );
    assert.doesNotMatch(
      KERNEL_ACTION_REQUEST_IDEMPOTENCY_SQL,
      /current_setting\('app\.tenant_scope'/,
    );
    assert.match(
      KERNEL_ACTION_REQUEST_IDEMPOTENCY_SQL,
      /REVOKE ALL ON TABLE public\.commander_action_requests[\s\S]*commander_worker, commander_scheduler/,
    );
  });

  it('replays the stored response and conflicts on a changed request after reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-action-request-'));
    directories.push(directory);
    const path = join(directory, 'kernel.sqlite');
    const input = {
      tenantId: 'tenant-a',
      idempotencyKey: 'action-key-0001',
      requestHash: 'a'.repeat(64),
      attemptToken: 'attempt-original',
      now: new Date('2026-08-07T00:00:00.000Z'),
      staleAfterMs: 30_000,
      allowStaleTakeover: true,
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

  it('takes over only a stale recoverable request and fences the prior attempt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-action-request-takeover-'));
    directories.push(directory);
    const repository = new SqliteKernelRepository({ path: join(directory, 'kernel.sqlite') });
    await repository.initialize();
    const startedAt = new Date('2026-08-07T00:00:00.000Z');
    const request = {
      tenantId: 'tenant-a',
      idempotencyKey: 'action-takeover-0001',
      requestHash: 'c'.repeat(64),
      attemptToken: 'attempt-original',
      now: startedAt,
      staleAfterMs: 30_000,
      allowStaleTakeover: true,
    };

    assert.deepEqual(await repository.beginActionRequest(request), { state: 'STARTED' });
    assert.deepEqual(
      await repository.beginActionRequest({
        ...request,
        attemptToken: 'attempt-active-retry',
        now: new Date(startedAt.getTime() + 29_999),
      }),
      { state: 'IN_PROGRESS' },
    );
    assert.deepEqual(
      await repository.beginActionRequest({
        ...request,
        attemptToken: 'attempt-takeover',
        now: new Date(startedAt.getTime() + 30_000),
      }),
      { state: 'TAKEOVER' },
    );
    assert.deepEqual(
      await repository.beginActionRequest({
        ...request,
        attemptToken: 'attempt-competing-takeover',
        now: new Date(startedAt.getTime() + 30_000),
      }),
      { state: 'IN_PROGRESS' },
    );

    await assert.rejects(
      repository.completeActionRequest({
        ...request,
        responseStatus: 202,
        responseBody: { stale: true },
      }),
      /ACTION_REQUEST_BINDING_FENCED/,
    );
    await repository.completeActionRequest({
      ...request,
      attemptToken: 'attempt-takeover',
      now: new Date(startedAt.getTime() + 30_000),
      responseStatus: 202,
      responseBody: { recovered: true },
    });
    assert.deepEqual(
      await repository.beginActionRequest({
        ...request,
        attemptToken: 'attempt-replay',
        now: new Date(startedAt.getTime() + 30_001),
      }),
      { state: 'REPLAY', responseStatus: 202, responseBody: { recovered: true } },
    );
    repository.close();
  });

  it('does not take over a stale request for a route without recovery semantics', async () => {
    const repository = new SqliteKernelRepository({ path: ':memory:', allowMemory: true });
    await repository.initialize();
    const startedAt = new Date('2026-08-07T00:00:00.000Z');
    const request = {
      tenantId: 'tenant-a',
      idempotencyKey: 'action-no-takeover-0001',
      requestHash: 'd'.repeat(64),
      attemptToken: 'attempt-original',
      now: startedAt,
      staleAfterMs: 30_000,
      allowStaleTakeover: false,
    };

    assert.deepEqual(await repository.beginActionRequest(request), { state: 'STARTED' });
    assert.deepEqual(
      await repository.beginActionRequest({
        ...request,
        attemptToken: 'attempt-retry',
        now: new Date(startedAt.getTime() + 60_000),
      }),
      { state: 'IN_PROGRESS' },
    );
    repository.close();
  });

  it('upgrades an existing SQLite action request table with recovery lease columns', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-action-request-upgrade-'));
    directories.push(directory);
    const path = join(directory, 'kernel.sqlite');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE commander_action_requests (
        tenant_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        response_status INTEGER,
        response_body TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (tenant_id, idempotency_key)
      );
      INSERT INTO commander_action_requests
        (tenant_id, idempotency_key, request_hash, state, created_at)
      VALUES
        ('tenant-a', 'legacy-action-request', '${'e'.repeat(64)}', 'IN_PROGRESS',
         '2026-08-07T00:00:00.000Z');
    `);
    legacy.close();

    const repository = new SqliteKernelRepository({ path });
    await repository.initialize();
    assert.deepEqual(
      await repository.beginActionRequest({
        tenantId: 'tenant-a',
        idempotencyKey: 'legacy-action-request',
        requestHash: 'e'.repeat(64),
        attemptToken: 'attempt-after-upgrade',
        now: new Date('2026-08-07T00:00:30.000Z'),
        staleAfterMs: 30_000,
        allowStaleTakeover: true,
      }),
      { state: 'TAKEOVER' },
    );
    repository.close();
  });
});
