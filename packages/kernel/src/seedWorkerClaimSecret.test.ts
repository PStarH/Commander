import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as ownerSeeds from './seedWorkerClaimSecret.js';

describe('owner migration seeds', () => {
  it('seeds both demo ticket policies for every explicit tenant without overwriting', async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const client = {
      async query(sql: string, values?: readonly unknown[]) {
        calls.push({ sql, values });
      },
    };
    const seedDemoTicketAllowlist = (
      ownerSeeds as typeof ownerSeeds & {
        seedDemoTicketAllowlist: (
          client: typeof client,
          tenantIds: readonly string[],
        ) => Promise<void>;
      }
    ).seedDemoTicketAllowlist;

    assert.equal(typeof seedDemoTicketAllowlist, 'function');
    await seedDemoTicketAllowlist(client, ['tenant-a', ' tenant-b ']);

    assert.deepEqual(
      calls.map((call) => call.values),
      [
        ['tenant-a', 'demo.ticket.create', true],
        ['tenant-a', 'compensate.demo.ticket.create', true],
        ['tenant-b', 'demo.ticket.create', true],
        ['tenant-b', 'compensate.demo.ticket.create', true],
      ],
    );
    assert.ok(
      calls.every((call) => /ON CONFLICT \(tenant_id, action_pattern\) DO NOTHING/.test(call.sql)),
    );
  });

  it('rejects wildcard tenants before writing policy', async () => {
    let writes = 0;
    const client = {
      async query() {
        writes += 1;
      },
    };
    const seedDemoTicketAllowlist = (
      ownerSeeds as typeof ownerSeeds & {
        seedDemoTicketAllowlist: (
          client: typeof client,
          tenantIds: readonly string[],
        ) => Promise<void>;
      }
    ).seedDemoTicketAllowlist;

    assert.equal(typeof seedDemoTicketAllowlist, 'function');
    await assert.rejects(seedDemoTicketAllowlist(client, ['*']), /WORKER_ALLOWED_TENANT_INVALID/);
    assert.equal(writes, 0);
  });
});
