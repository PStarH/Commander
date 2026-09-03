import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as ownerSeeds from './seedWorkerClaimSecret.js';
import type { ClaimSecretSeedClient } from './seedWorkerClaimSecret.js';

describe('owner migration seeds', () => {
  it('seeds both demo ticket policies for every explicit tenant without overwriting', async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const client: ClaimSecretSeedClient = {
      async query(sql: string, values?: readonly unknown[]) {
        calls.push({ sql, values });
      },
    };

    assert.equal(typeof ownerSeeds.seedDemoTicketAllowlist, 'function');
    await ownerSeeds.seedDemoTicketAllowlist(client, ['tenant-a', ' tenant-b ']);

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
    const client: ClaimSecretSeedClient = {
      async query() {
        writes += 1;
      },
    };

    assert.equal(typeof ownerSeeds.seedDemoTicketAllowlist, 'function');
    await assert.rejects(
      ownerSeeds.seedDemoTicketAllowlist(client, ['*']),
      /WORKER_ALLOWED_TENANT_INVALID/,
    );
    assert.equal(writes, 0);
  });

  it('seeds enabled tenant-authority allowlist rows without disabling existing tenants', async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const client: ClaimSecretSeedClient = {
      async query(sql: string, values?: readonly unknown[]) {
        calls.push({ sql, values });
      },
    };

    assert.equal(typeof ownerSeeds.seedTenantAuthorityAllowedTenants, 'function');
    await ownerSeeds.seedTenantAuthorityAllowedTenants(client, ['tenant-a', ' tenant-b ']);

    assert.deepEqual(
      calls.map((call) => call.values),
      [['tenant-a'], ['tenant-b']],
    );
    assert.ok(
      calls.every((call) =>
        /INSERT INTO commander_tenant_authority_allowed_tenants/.test(call.sql),
      ),
    );
    assert.ok(calls.every((call) => /enabled = true/.test(call.sql)));
  });

  it('rejects wildcard tenant-authority rows before writing', async () => {
    let writes = 0;
    const client: ClaimSecretSeedClient = {
      async query() {
        writes += 1;
      },
    };

    await assert.rejects(
      ownerSeeds.seedTenantAuthorityAllowedTenants(client, ['*']),
      /TENANT_AUTHORITY_ALLOWED_TENANT_INVALID/,
    );
    assert.equal(writes, 0);
  });
});
