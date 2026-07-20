/**
 * SQLite proof for compensation poison-message → DLQ (mirrors postgres.dlq.integration.test.ts).
 * Cell SQLite kernel ops assume single-writer + BEGIN IMMEDIATE (see docs/deploy.md).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { SqlClient } from './postgres.js';
import { SqliteKernelRepository } from './sqlite.js';

class SeedingSqliteKernelRepository extends SqliteKernelRepository {
  async seedPoisonCompensation(input: {
    eventId: string;
    messageId: string;
    tenantId: string;
    runId: string;
    suffix: string;
    maxAttempts: number;
    availableAt: string;
  }): Promise<void> {
    const { eventId, messageId, tenantId, runId, suffix, maxAttempts, availableAt } = input;
    await this.withTransaction(async (client: SqlClient) => {
      await client.query(
        `INSERT INTO commander_events
           (id, aggregate_type, aggregate_id, sequence, type, tenant_id, run_id, actor, schema_version, payload)
         VALUES ($1,'run',$2,1,'compensation.requested',$3,$2,'integration','v2','{}'::jsonb)`,
        [eventId, runId, tenantId],
      );
      await client.query(
        `INSERT INTO commander_outbox
           (id, event_id, tenant_id, topic, key, payload, attempts, max_attempts, available_at)
         VALUES ($1,$2,$3,'commander.compensation',$4,$5::jsonb,0,$6,$7::timestamptz)`,
        [
          messageId,
          eventId,
          tenantId,
          runId,
          JSON.stringify({
            tenantId,
            runId,
            stepId: `step-${suffix}`,
            compensationAction: 'crm.compensate',
            compensationPayload: { undo: true },
          }),
          maxAttempts,
          availableAt,
        ],
      );
    });
  }
}

describe('SQLite compensation poison-message DLQ', () => {
  it('claim→retry→sweep moves poison compensation to DLQ and stops re-claim (S5, PG parity)', async () => {
    const repo = new SeedingSqliteKernelRepository({ path: ':memory:', allowMemory: true, schedulerMode: true });
    await repo.initialize();
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tenantId = `dlq-tenant-${suffix}`;
    const runId = `run-poison-${suffix}`;
    const messageId = randomUUID();
    const eventId = randomUUID();
    const maxAttempts = 3;
    const availableAt = new Date(Date.now() - 60_000).toISOString();

    await repo.seedPoisonCompensation({
      eventId,
      messageId,
      tenantId,
      runId,
      suffix,
      maxAttempts,
      availableAt,
    });

    let clock = Date.now();
    for (let i = 0; i < maxAttempts; i++) {
      const at = new Date(clock);
      const claimed = await repo.claimOutboxByTopic('commander.compensation', 10, at);
      const poison = claimed.find((m) => m.id === messageId);
      assert.ok(poison, `round ${i} should claim the poison message`);
      assert.ok(poison.claimToken);
      await repo.retryOutbox(
        poison.id,
        poison.claimToken!,
        { code: 'POISON', message: 'always fails' },
        at,
      );
      clock += (2 ** i) * 1_000 + 1_000;
    }

    assert.equal(
      (await repo.claimOutboxByTopic('commander.compensation', 10, new Date(clock)))
        .filter((m) => m.id === messageId).length,
      0,
      'exhausted poison must not be reclaimed',
    );

    const sweep = await repo.sweepOutboxDlq(new Date(clock), 50);
    assert.ok(sweep.movedToDlq >= 1, 'sweep must move exhausted poison into DLQ');

    const dlq = await repo.listDlqEntries(50, 'commander.compensation');
    const entry = dlq.find((e) => e.originalId === messageId);
    assert.ok(entry, 'DLQ must contain the original poison message');
    assert.equal(entry.dlqReason, 'max_attempts_exceeded');
    assert.equal(entry.tenantId, tenantId);

    assert.equal(
      (await repo.claimOutboxByTopic('commander.compensation', 10, new Date(clock)))
        .filter((m) => m.id === messageId).length,
      0,
      'DLQ\'d poison must stay out of claim path',
    );

    repo.close();
  });
});
