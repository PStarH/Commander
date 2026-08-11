import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KernelInvariantError } from './types.js';
import type { KillSwitchMatchDims } from './types.js';
import { InMemoryKernelRepository } from './testing/inMemoryRepository.js';
import { KILL_SWITCH_MIGRATION_ID, KILL_SWITCH_SQL } from './killSwitchSchema.js';
import { KERNEL_MIGRATIONS } from './migrations.js';

const dims: KillSwitchMatchDims = {
  package: 'test-package',
  model: 'test-model',
  tool: 'ticket.create',
  destination: 'demo://tickets',
  effectType: 'demo.ticket.create',
};

async function enableKillSwitch(
  repo: InMemoryKernelRepository,
  scope: Parameters<InMemoryKernelRepository['putKillSwitch']>[0]['scope'],
  value: string,
  tenantId = 'tenant-a',
) {
  await repo.putKillSwitch({
    tenantId,
    scope,
    value,
    enabled: true,
    actor: 'ops-a',
    reason: `block ${scope}`,
  });
}

describe('Kill switch matrix', () => {
  it('ships an additive migration for durable kernels created before kill switches', () => {
    const migration = KERNEL_MIGRATIONS.find((entry) => entry.id === KILL_SWITCH_MIGRATION_ID);

    assert.ok(migration, 'kill-switch storage must have an independent migration entry');
    assert.equal(migration.sql, KILL_SWITCH_SQL);
    assert.match(migration.id, /^2026-08-12\.1\.kill_switches$/);
    assert.match(KILL_SWITCH_SQL, /CREATE TABLE IF NOT EXISTS commander_action_kill_switches/);
    assert.match(
      KILL_SWITCH_SQL,
      /ALTER TABLE commander_action_kill_switches ENABLE ROW LEVEL SECURITY/,
    );
    assert.match(
      KILL_SWITCH_SQL,
      /ALTER TABLE commander_action_kill_switches FORCE ROW LEVEL SECURITY/,
    );
    assert.match(
      KILL_SWITCH_SQL,
      /CREATE POLICY commander_tenant_isolation ON commander_action_kill_switches/,
    );
    assert.match(
      KILL_SWITCH_SQL,
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE commander_action_kill_switches TO commander_app/,
    );
    assert.match(
      KILL_SWITCH_SQL,
      /GRANT SELECT ON TABLE commander_action_kill_switches TO commander_worker/,
    );
  });

  it('matches all six scopes with exact dimension values', async () => {
    const repo = new InMemoryKernelRepository();
    const cases = [
      { scope: 'tenant' as const, value: 'tenant-a' },
      { scope: 'package' as const, value: dims.package! },
      { scope: 'model' as const, value: dims.model! },
      { scope: 'tool' as const, value: dims.tool! },
      { scope: 'destination' as const, value: dims.destination! },
      { scope: 'effect-type' as const, value: dims.effectType! },
    ];
    for (const entry of cases) {
      const isolated = new InMemoryKernelRepository();
      await enableKillSwitch(isolated, entry.scope, entry.value);
      const match = await isolated.findMatchingKillSwitch('tenant-a', dims);
      assert.ok(match, `expected match for scope ${entry.scope}`);
      assert.equal(match.scope, entry.scope);
      assert.equal(match.value, entry.value);
      assert.equal(match.enabled, true);
    }
  });

  it('isolates kill switches by tenant', async () => {
    const repo = new InMemoryKernelRepository();
    await enableKillSwitch(repo, 'tool', 'ticket.create', 'tenant-a');
    assert.equal(await repo.findMatchingKillSwitch('tenant-b', dims), null);
    const listed = await repo.listKillSwitches('tenant-b');
    assert.equal(listed.length, 0);
  });

  it('does not match disabled rules', async () => {
    const repo = new InMemoryKernelRepository();
    await repo.putKillSwitch({
      tenantId: 'tenant-a',
      scope: 'tool',
      value: 'ticket.create',
      enabled: false,
      actor: 'ops-a',
      reason: 'disabled',
    });
    assert.equal(await repo.findMatchingKillSwitch('tenant-a', dims), null);
  });

  it('requires exact matches for non-tenant scopes', async () => {
    const repo = new InMemoryKernelRepository();
    await enableKillSwitch(repo, 'tool', 'ticket.create');
    assert.equal(
      await repo.findMatchingKillSwitch('tenant-a', { ...dims, tool: 'ticket.delete' }),
      null,
    );
  });

  it('tenant scope blocks only when value equals tenantId', async () => {
    const repo = new InMemoryKernelRepository();
    await enableKillSwitch(repo, 'tenant', 'tenant-a');
    assert.ok(await repo.findMatchingKillSwitch('tenant-a', dims));
    await repo.removeKillSwitch({ tenantId: 'tenant-a', scope: 'tenant', value: 'tenant-a' });
    await enableKillSwitch(repo, 'tenant', 'tenant-b');
    assert.equal(await repo.findMatchingKillSwitch('tenant-a', dims), null);
  });

  it('lists, updates, and removes kill switches for a tenant', async () => {
    const repo = new InMemoryKernelRepository();
    await repo.putKillSwitch({
      tenantId: 'tenant-a',
      scope: 'package',
      value: 'pkg-a',
      enabled: true,
      actor: 'ops-a',
      reason: 'initial',
    });
    let listed = await repo.listKillSwitches('tenant-a');
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.reason, 'initial');

    await repo.putKillSwitch({
      tenantId: 'tenant-a',
      scope: 'package',
      value: 'pkg-a',
      enabled: false,
      actor: 'ops-b',
      reason: 'relaxed',
    });
    listed = await repo.listKillSwitches('tenant-a');
    assert.equal(listed[0]?.enabled, false);
    assert.equal(listed[0]?.actor, 'ops-b');

    await repo.removeKillSwitch({ tenantId: 'tenant-a', scope: 'package', value: 'pkg-a' });
    listed = await repo.listKillSwitches('tenant-a');
    assert.equal(listed.length, 0);
  });

  it('fails closed when kill switch lookup cannot complete', async () => {
    const repo = new InMemoryKernelRepository();
    repo.listKillSwitches = async () => {
      throw new Error('storage unavailable');
    };
    await assert.rejects(
      () => repo.findMatchingKillSwitch('tenant-a', dims),
      (error) => error instanceof KernelInvariantError && error.code === 'KILL_SWITCH_LOOKUP_FAILED',
    );
  });
});
