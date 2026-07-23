/**
 * P0 regression: after forcing schedulerMode:false, compensation outbox must not
 * call withTransaction([]) (mute daemon). Worker path uses DEFINER RPC + tenant-scoped mark/retry.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PostgresKernelRepository } from './postgres.js';
import type { SqlClient, SqlPool, SqlQueryResult } from './postgres.js';

function ok<T extends Record<string, unknown>>(rows: T[] = [], rowCount = rows.length): SqlQueryResult<T> {
  return { rows, rowCount };
}

function createWorkerFakePool(onQuery: (sql: string, params?: unknown[]) => SqlQueryResult | Promise<SqlQueryResult>): SqlPool {
  return {
    connect: async (): Promise<SqlClient> => ({
      query: async <T extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ): Promise<SqlQueryResult<T>> => {
        if (/session_user/i.test(sql)) {
          return ok([{ login_role: 'commander_worker' }]) as SqlQueryResult<T>;
        }
        if (/^BEGIN/i.test(sql) || /^COMMIT/i.test(sql) || /^ROLLBACK/i.test(sql)) {
          return ok() as SqlQueryResult<T>;
        }
        return (await onQuery(sql, params)) as SqlQueryResult<T>;
      },
      release: async () => undefined,
    }),
  };
}

describe('PostgresKernelRepository worker-mode outbox (P0 mute regression)', () => {
  it('claimOutbox throws on worker LOGIN (must use claimOutboxByTopic)', async () => {
    const repo = new PostgresKernelRepository(createWorkerFakePool(() => ok()), {
      schedulerMode: false,
    });
    await assert.rejects(
      () => repo.claimOutbox(10),
      /claimOutbox requires schedulerMode/,
    );
  });

  it('markOutboxPublished / retryOutbox without tenantId throw tenant scope error', async () => {
    const repo = new PostgresKernelRepository(createWorkerFakePool(() => ok()), {
      schedulerMode: false,
    });
    await assert.rejects(
      () => repo.markOutboxPublished('msg-1', 'tok'),
      /Outbox mark\/retry requires tenantId|Kernel write must explicitly carry tenant scope/,
    );
    await assert.rejects(
      () => repo.retryOutbox('msg-1', 'tok', { code: 'X', message: 'y' }),
      /Outbox mark\/retry requires tenantId|Kernel write must explicitly carry tenant scope/,
    );
  });

  it('claimOutboxByTopic without authz throws (does not mute via empty withTransaction)', async () => {
    const repo = new PostgresKernelRepository(createWorkerFakePool(() => ok()), {
      schedulerMode: false,
    });
    await assert.rejects(
      () => repo.claimOutboxByTopic('commander.compensation', 10),
      /claimOutboxByTopic requires workerId/,
    );
  });

  it('claimOutboxByTopic with authz calls claim_outbox_by_topic DEFINER RPC', async () => {
    const seen: string[] = [];
    const repo = new PostgresKernelRepository(
      createWorkerFakePool((sql) => {
        seen.push(sql);
        if (/claim_outbox_by_topic/i.test(sql)) {
          return ok([
            {
              claim_outbox_by_topic: {
                claimToken: 'rpc-tok',
                rows: [
                  {
                    id: 'o1',
                    event_id: 'e1',
                    tenant_id: 'tenant-a',
                    topic: 'commander.compensation',
                    key: 'k',
                    payload: {},
                    attempts: 1,
                    available_at: new Date().toISOString(),
                    published_at: null,
                    created_at: new Date().toISOString(),
                  },
                ],
              },
            },
          ]);
        }
        return ok();
      }),
      { schedulerMode: false },
    );
    const claimed = await repo.claimOutboxByTopic('commander.compensation', 5, new Date(), {
      workerId: 'cmp-worker',
      workerGeneration: 1,
      claimSecret: 'secret',
    });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.claimToken, 'rpc-tok');
    assert.equal(claimed[0]!.tenantId, 'tenant-a');
    assert.ok(seen.some((s) => /claim_outbox_by_topic/i.test(s)));
    assert.ok(!seen.some((s) => /FOR UPDATE SKIP LOCKED/i.test(s)));
  });

  it('markOutboxPublished with tenantId scopes withTransaction (no mute throw)', async () => {
    const scopes: string[] = [];
    const repo = new PostgresKernelRepository(
      createWorkerFakePool((sql, params) => {
        if (/set_config\('app\.tenant_scope'/i.test(sql)) {
          scopes.push(String(params?.[0] ?? ''));
          return ok();
        }
        if (/UPDATE commander_outbox SET published_at/i.test(sql)) {
          return ok([], 1);
        }
        return ok();
      }),
      { schedulerMode: false },
    );
    const okMark = await repo.markOutboxPublished('msg-1', 'tok', 'tenant-a');
    assert.equal(okMark, true);
    assert.ok(scopes.includes('tenant-a'));
  });
});
