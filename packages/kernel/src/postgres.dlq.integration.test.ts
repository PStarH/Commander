/**
 * Live Postgres proof for compensation poison-message → DLQ (PROVEN).
 * Skips when COMMANDER_KERNEL_DATABASE_URL / DATABASE_URL is unset.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { runKernelMigrations } from './migrations.js';
import { PostgresKernelRepository } from './postgres.js';

const databaseUrl = process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL;

describe('PostgreSQL compensation poison-message DLQ (live)', () => {
  it('claim→retry→sweep moves poison compensation to DLQ and stops re-claim', { skip: !databaseUrl }, async () => {
    if (!databaseUrl) return;
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const repo = new PostgresKernelRepository(pool, { schedulerMode: true });
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tenantId = `dlq-tenant-${suffix}`;
    const runId = `run-poison-${suffix}`;
    const messageId = randomUUID();
    const eventId = randomUUID();
    const maxAttempts = 3;
    // Anchor available_at to the client clock (minus skew cushion). Docker PG
    // clocks can lead the host by a few seconds; claim compares against
    // Date.toISOString() from the Node process.
    const availableAt = new Date(Date.now() - 60_000).toISOString();

    try {
      await runKernelMigrations(pool);
      await pool.query(
        `INSERT INTO commander_events
           (id, aggregate_type, aggregate_id, sequence, type, tenant_id, run_id, actor, schema_version, payload)
         VALUES ($1,'run',$2,1,'compensation.requested',$3,$2,'integration','v2','{}'::jsonb)`,
        [eventId, runId, tenantId],
      );
      await pool.query(
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
        // Advance past exponential backoff: 2^(attempts-1) seconds.
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
    } finally {
      await pool.query('DELETE FROM commander_outbox_dlq WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM commander_outbox WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM commander_events WHERE tenant_id=$1', [tenantId]);
      await pool.end();
    }
  });
});
