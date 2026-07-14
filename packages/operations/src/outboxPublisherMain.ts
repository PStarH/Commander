/**
 * Outbox Publisher — production entry point.
 *
 * Connects to the shared Postgres kernel and runs an OutboxPublisher loop
 * that claims unpublished outbox messages and delivers them to a configured
 * event publisher.
 */
import { PostgresKernelRepository } from '@commander/kernel';
import { OutboxPublisher } from './index.js';

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL is required for the outbox publisher');
  }

  const { Pool } = require('pg') as { Pool: new (config: { connectionString: string }) => import('@commander/kernel').SqlPool & { end(): Promise<void> } };
  const pool = new Pool({ connectionString: dbUrl });
  // The outbox publisher is a scheduler/recovery process: it scans cross-tenant
  // outbox rows. It must connect as the commander_scheduler role and opt into
  // scheduler mode. Migrations are applied by the dedicated migration job.
  const repo = new PostgresKernelRepository(pool, { schedulerMode: true });

  const publisher = {
    publish: async (message: { topic: string; key: string; payload: Record<string, unknown> }) => {
      // Default console publisher. Production deployments should replace this
      // with a real broker (Kafka, RabbitMQ, SNS, etc.) publisher.
      console.log(`[outbox] ${message.topic} ${message.key}`, message.payload);
    },
  };

  const outboxPublisher = new OutboxPublisher(repo, publisher);
  const intervalMs = parseInt(process.env.COMMANDER_OUTBOX_INTERVAL_MS ?? '5000', 10);
  const limit = parseInt(process.env.COMMANDER_OUTBOX_LIMIT ?? '100', 10);

  const timer = setInterval(async () => {
    try {
      const result = await outboxPublisher.publishOnce(limit);
      if (result.published > 0 || result.failed > 0) {
        console.log(`[outbox] published=${result.published} failed=${result.failed}`);
      }
    } catch (error) {
      console.error('[outbox] publish error:', error);
    }
  }, intervalMs);

  const shutdown = () => {
    clearInterval(timer);
    void pool.end().then(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  console.log(`[outbox] Started (intervalMs=${intervalMs}, limit=${limit})`);
}

void main().catch((error) => {
  console.error(`[outbox] fatal: ${(error as Error).message}`);
  process.exitCode = 1;
});
