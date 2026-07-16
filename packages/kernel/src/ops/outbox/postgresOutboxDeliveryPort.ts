import { randomUUID } from 'node:crypto';
import type { SqlClient, SqlPool } from '../../postgres.js';
import {
  DEFAULT_OUTBOX_DELIVERY_OPTIONS,
  type ClaimedOutboxDelivery,
  type OutboxDeliveryError,
  type OutboxDeliveryOptions,
  type OutboxDeliveryPort,
  type OutboxEnvelope,
} from './types.js';

interface DeliveryRow {
  id: string;
  event_id: string;
  schema_version: number;
  tenant_id: string;
  topic: string;
  key: string;
  occurred_at: Date | string;
  payload: Record<string, unknown>;
  attempts: number;
  available_at: Date | string;
  claim_token: string;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export class PostgresOutboxDeliveryPort implements OutboxDeliveryPort {
  private readonly options: OutboxDeliveryOptions;

  constructor(private readonly pool: SqlPool, options: Partial<OutboxDeliveryOptions> = {}) {
    this.options = { ...DEFAULT_OUTBOX_DELIVERY_OPTIONS, ...options };
  }

  async publish(envelope: OutboxEnvelope): Promise<{ deliveryId: string; duplicate: boolean }> {
    return this.transaction(async (client) => {
      await client.query(`SELECT set_config('app.tenant_scope', $1, true)`, [envelope.tenantId]);
      const id = randomUUID();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO commander_outbox_deliveries
           (id,event_id,schema_version,tenant_id,topic,key,occurred_at,payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING id`,
        [id, envelope.eventId, envelope.schemaVersion, envelope.tenantId, envelope.topic,
          envelope.key, envelope.occurredAt, JSON.stringify(envelope.payload)],
      );
      if (inserted.rows[0]) return { deliveryId: inserted.rows[0].id, duplicate: false };
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM commander_outbox_deliveries WHERE event_id=$1',
        [envelope.eventId],
      );
      if (!existing.rows[0]) throw new Error(`Outbox delivery ${envelope.eventId} is not visible`);
      return { deliveryId: existing.rows[0].id, duplicate: true };
    });
  }

  async claim(consumerId: string, limit: number, now = new Date()): Promise<ClaimedOutboxDelivery[]> {
    return this.transaction(async (client) => {
      const token = randomUUID();
      const result = await client.query<DeliveryRow>(
        `WITH candidate AS (
           SELECT id FROM commander_outbox_deliveries
           WHERE acknowledged_at IS NULL AND moved_to_dlq_at IS NULL AND available_at <= $1
             AND (claimed_at IS NULL OR claimed_at <= $1::timestamptz - ($2::bigint * interval '1 millisecond'))
           ORDER BY available_at, created_at
           FOR UPDATE SKIP LOCKED LIMIT $3
         )
         UPDATE commander_outbox_deliveries d SET
           consumer_id=$4, claim_token=$5, claimed_at=$1, attempts=d.attempts+1
         FROM candidate WHERE d.id=candidate.id
         RETURNING d.*`,
        [now.toISOString(), this.options.claimTtlMs, limit, consumerId, token],
      );
      return result.rows.map((row) => ({
        deliveryId: row.id,
        eventId: row.event_id,
        schemaVersion: 1,
        tenantId: row.tenant_id,
        topic: row.topic,
        key: row.key,
        occurredAt: iso(row.occurred_at),
        payload: row.payload ?? {},
        claimToken: row.claim_token,
        attempts: Number(row.attempts),
        availableAt: iso(row.available_at),
      }));
    });
  }

  async acknowledge(deliveryId: string, claimToken: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE commander_outbox_deliveries SET
           acknowledged_at=now(), claim_token=NULL, claimed_at=NULL
         WHERE id=$1 AND claim_token=$2 AND acknowledged_at IS NULL AND moved_to_dlq_at IS NULL`,
        [deliveryId, claimToken],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  async retry(deliveryId: string, claimToken: string, error: OutboxDeliveryError, now = new Date()): Promise<boolean> {
    return this.transaction(async (client) => {
      const locked = await client.query<{ attempts: number }>(
        `SELECT attempts FROM commander_outbox_deliveries
         WHERE id=$1 AND claim_token=$2 AND acknowledged_at IS NULL AND moved_to_dlq_at IS NULL
         FOR UPDATE`,
        [deliveryId, claimToken],
      );
      const attempts = Number(locked.rows[0]?.attempts ?? 0);
      if (!locked.rows[0]) return false;
      if (attempts >= this.options.maxAttempts) {
        await client.query(
          `UPDATE commander_outbox_deliveries SET
             moved_to_dlq_at=$1, dlq_reason='max_attempts_exceeded', last_error=$2::jsonb,
             consumer_id=NULL, claim_token=NULL, claimed_at=NULL
           WHERE id=$3 AND claim_token=$4`,
          [now.toISOString(), JSON.stringify(error), deliveryId, claimToken],
        );
        return true;
      }
      const backoff = Math.min(
        this.options.baseBackoffMs * 2 ** Math.max(0, attempts - 1),
        this.options.maxBackoffMs,
      );
      const result = await client.query(
        `UPDATE commander_outbox_deliveries SET
           available_at=$1, last_error=$2::jsonb,
           consumer_id=NULL, claim_token=NULL, claimed_at=NULL
         WHERE id=$3 AND claim_token=$4`,
        [new Date(now.getTime() + backoff).toISOString(), JSON.stringify(error), deliveryId, claimToken],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  private async transaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.release();
    }
  }
}
