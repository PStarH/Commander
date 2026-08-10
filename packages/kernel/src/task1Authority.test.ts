import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  KERNEL_ADAPTER_OPS_SQL,
  KERNEL_ADMIT_CLASS_A_SQL,
  KERNEL_ROLES_SQL,
  KERNEL_TASK1_COMPLETED_REPLAY_GATE_SQL,
  KERNEL_TASK1_FINAL_REVIEW_SQL,
  KERNEL_TASK1_FINAL_SCHEMA_VERSION,
  KERNEL_TASK1_REPLAY_GATE_SCHEMA_VERSION,
  KERNEL_TASK1_RUNTIME_AUTHORITY_CLOSURE_SQL,
  KERNEL_CLAIM_SQL,
} from './schema.js';
import {
  KERNEL_2026072116_MIGRATIONS,
  KERNEL_TASK1_FORWARD_MIGRATION_CHECKSUMS,
  KERNEL_TASK1_FORWARD_MIGRATIONS,
  KERNEL_TASK1_BASELINE_MIGRATIONS,
  KERNEL_TASK1_CLOSURE_MIGRATION_CHECKSUMS,
  KERNEL_TASK1_CLOSURE_MIGRATIONS,
  KERNEL_FORWARD_MIGRATIONS,
  KERNEL_HISTORICAL_MIGRATION_CHECKSUMS,
  KERNEL_MIGRATIONS,
  KERNEL_TASK2_FORWARD_MIGRATIONS,
  KERNEL_TASK2_FORWARD_MIGRATION_CHECKSUMS,
  KERNEL_COMPENSATION_CLAIM_GUARD_MIGRATIONS,
  KERNEL_TASK1_TENANT_CONTEXT_BIND_MONOTONICITY_MIGRATIONS,
  KERNEL_TASK1_TENANT_CONTEXT_CLOCK_SAFETY_MIGRATIONS,
  runTask1ClosureMigrations,
  runKernelMigrations,
} from './migrations.js';
import type { SqlClient, SqlPool, SqlQueryResult } from './postgres.js';
import {
  KERNEL_TASK1_AUTHENTICATED_TENANT_AUTHORITY_ENFORCE_SQL,
  KERNEL_TASK1_TENANT_CONTEXT_BIND_MONOTONICITY_SQL,
  KERNEL_TASK1_TENANT_CONTEXT_CLOCK_SAFETY_SQL,
} from './task1TenantContext.js';
import {
  KERNEL_COMPENSATION_APPROVAL_BINDING_SQL,
  KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
} from './compensationSchema.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function sqlResult<T>(rows: T[]): SqlQueryResult<T> {
  return { rows, rowCount: rows.length };
}

class MigrationLedgerClient implements SqlClient {
  readonly appliedMigrationIds: string[] = [];

  constructor(private readonly ledger: Map<string, string>) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<T>> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      return sqlResult<T>([]);
    }
    if (normalized.includes('pg_advisory_xact_lock')) {
      return sqlResult<T>([]);
    }
    if (normalized === 'SELECT current_user, session_user') {
      return sqlResult([{ current_user: 'commander_owner', session_user: 'commander_owner' } as T]);
    }
    if (
      normalized.includes("tablename = 'commander_runs'") &&
      normalized.includes('tableowner = current_user')
    ) {
      return sqlResult([{ owns: true } as T]);
    }
    if (
      normalized.includes("tablename='public'") ||
      normalized.includes("tablename='commander_runs'")
    ) {
      return sqlResult([{ exists: true } as T]);
    }
    if (normalized.startsWith('CREATE TABLE IF NOT EXISTS commander_kernel_migrations')) {
      return sqlResult<T>([]);
    }
    if (normalized === 'SELECT checksum FROM commander_kernel_migrations WHERE id=$1') {
      const checksum = this.ledger.get(String(values[0]));
      return sqlResult(checksum ? [{ checksum } as T] : []);
    }
    if (normalized.startsWith('INSERT INTO commander_kernel_migrations')) {
      const id = String(values[0]);
      this.ledger.set(id, String(values[1]));
      this.appliedMigrationIds.push(id);
      return sqlResult<T>([]);
    }
    if (normalized === 'SELECT rolbypassrls, rolname FROM pg_roles WHERE rolname = current_user') {
      return sqlResult([{ rolbypassrls: true, rolname: 'commander_owner' } as T]);
    }
    return sqlResult<T>([]);
  }

  release(): void {}
}

class MigrationLedgerPool implements SqlPool {
  readonly client: MigrationLedgerClient;

  constructor(ledger: Map<string, string>) {
    this.client = new MigrationLedgerClient(ledger);
  }

  async connect(): Promise<SqlClient> {
    return this.client;
  }
}

describe('Task 1 authoritative Class A admission', () => {
  it('installs the approval-binding claim RPC after the campaign2 public wrapper', () => {
    const ids = KERNEL_FORWARD_MIGRATIONS.map(({ id }) => id);
    const campaign2Index = ids.indexOf('2026-07-29.2.campaign2_critical_authority_hardening');
    const approvalBindingIndex = ids.indexOf(
      '2026-08-08.4.compensation_approval_binding_claim_rpc',
    );
    assert.ok(campaign2Index >= 0);
    assert.ok(approvalBindingIndex > campaign2Index);
    assert.equal(
      KERNEL_MIGRATIONS.find(
        ({ id }) => id === '2026-08-08.4.compensation_approval_binding_claim_rpc',
      )?.sql,
      KERNEL_COMPENSATION_APPROVAL_BINDING_SQL,
    );
  });

  it('installs compensation terminal closure after the approval-bound claim RPC', () => {
    const ids = KERNEL_FORWARD_MIGRATIONS.map(({ id }) => id);
    const campaign2Index = ids.indexOf('2026-07-29.2.campaign2_critical_authority_hardening');
    const approvalBindingIndex = ids.indexOf(
      '2026-08-08.4.compensation_approval_binding_claim_rpc',
    );
    const terminalClosureId = '2026-08-08.5.compensation_terminal_closure';
    const terminalClosureIndex = ids.indexOf(terminalClosureId);
    assert.ok(campaign2Index >= 0);
    assert.ok(approvalBindingIndex >= 0);
    assert.ok(terminalClosureIndex > approvalBindingIndex);
    assert.ok(approvalBindingIndex > campaign2Index);
    assert.equal(
      KERNEL_MIGRATIONS.find(({ id }) => id === terminalClosureId)?.sql,
      KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
    );
  });

  it('overrides the immutable baseline claim RPC with the governed-run guard', () => {
    const baseline = KERNEL_2026072116_MIGRATIONS.find(({ id }) => id.endsWith('.claim'));
    const guardId = '2026-08-08.6.compensation_claim_guard';
    const forward = KERNEL_COMPENSATION_CLAIM_GUARD_MIGRATIONS.find(({ id }) => id === guardId);
    assert.ok(baseline);
    assert.ok(forward);
    assert.doesNotMatch(baseline.sql, /compensationRequestId/i);
    assert.match(KERNEL_CLAIM_SQL, /r\.metadata->>'compensationRequestId'\s+IS NULL/i);
    assert.equal(forward.sql, KERNEL_CLAIM_SQL);
    const ids = KERNEL_FORWARD_MIGRATIONS.map(({ id }) => id);
    assert.ok(ids.indexOf(guardId) > ids.indexOf(baseline.id));
    assert.equal(KERNEL_MIGRATIONS.find(({ id }) => id === guardId)?.sql, KERNEL_CLAIM_SQL);
  });

  it('installs the clock-safe tenant-context close as a new forward descriptor', () => {
    const id = '2026-08-08.7.task1_tenant_context_clock_safety';
    const forward = KERNEL_TASK1_TENANT_CONTEXT_CLOCK_SAFETY_MIGRATIONS.find(
      ({ id: migrationId }) => migrationId === id,
    );
    assert.ok(forward);
    assert.equal(forward.sql, KERNEL_TASK1_TENANT_CONTEXT_CLOCK_SAFETY_SQL);
    assert.equal(
      KERNEL_FORWARD_MIGRATIONS.find(({ id: migrationId }) => migrationId === id)?.sql,
      forward.sql,
    );
    assert.equal(
      KERNEL_MIGRATIONS.find(({ id: migrationId }) => migrationId === id)?.sql,
      forward.sql,
    );
    assert.equal(
      KERNEL_TASK1_CLOSURE_MIGRATION_CHECKSUMS[
        '2026-07-27.3.task1_authenticated_tenant_authority_enforce'
      ],
      '9994edfd6cd1cb7f68b538b4b0f04d1f73435a003b6dba958da7ccdcffc42fc5',
    );
  });

  it('installs bind timestamp monotonicity as a new forward descriptor', () => {
    const id = '2026-08-09.1.task1_tenant_context_bind_monotonicity';
    const forward = KERNEL_TASK1_TENANT_CONTEXT_BIND_MONOTONICITY_MIGRATIONS.find(
      ({ id: migrationId }) => migrationId === id,
    );
    assert.ok(forward);
    assert.equal(forward.sql, KERNEL_TASK1_TENANT_CONTEXT_BIND_MONOTONICITY_SQL);
    assert.equal(
      KERNEL_FORWARD_MIGRATIONS.find(({ id: migrationId }) => migrationId === id)?.sql,
      forward.sql,
    );
    assert.equal(
      KERNEL_MIGRATIONS.find(({ id: migrationId }) => migrationId === id)?.sql,
      forward.sql,
    );
  });

  it('ships the admission split and role closure as a new forward migration', () => {
    assert.equal(KERNEL_TASK1_FINAL_SCHEMA_VERSION, '2026-07-25.1');
    assert.ok(
      KERNEL_MIGRATIONS.some(
        (migration) =>
          migration.id === `${KERNEL_TASK1_FINAL_SCHEMA_VERSION}.task1_final_review` &&
          migration.sql === KERNEL_TASK1_FINAL_REVIEW_SQL,
      ),
    );
    assert.equal(KERNEL_TASK1_REPLAY_GATE_SCHEMA_VERSION, '2026-07-26.1');
    assert.ok(
      KERNEL_MIGRATIONS.some(
        (migration) =>
          migration.id ===
            `${KERNEL_TASK1_REPLAY_GATE_SCHEMA_VERSION}.task1_completed_replay_gate` &&
          migration.sql === KERNEL_TASK1_COMPLETED_REPLAY_GATE_SQL,
      ),
    );
    assert.ok(
      KERNEL_MIGRATIONS.some(
        (migration) =>
          migration.id ===
            `${KERNEL_TASK1_REPLAY_GATE_SCHEMA_VERSION}.task1_runtime_authority_closure` &&
          migration.sql === KERNEL_TASK1_RUNTIME_AUTHORITY_CLOSURE_SQL,
      ),
    );
  });

  it('pins every Task 1 forward migration ID and checksum', () => {
    assert.deepEqual(KERNEL_TASK1_FORWARD_MIGRATION_CHECKSUMS, {
      '2026-07-23.17.task1_role_closure':
        '4530eb230afb208500eec8639711fb669057b0185cb021093bc06e711fdc6070',
      '2026-07-23.17.task1_worker_registration_guard':
        '47dc6b111b972285a03be3c8c47814ef43c772a9b290da7e54ab47b0b381da8e',
      '2026-07-23.17.task1_adapter_ops_rpcs':
        '45fcc1e8c3f45228c30cc931ab3cddae7dd64c7888e81407ec8feb3e557f4e37',
      '2026-07-23.17.task1_admission_foundation':
        '7d7e029ad011daebd45f9f44773055d1142d667c034e489846116583e0587a8d',
      '2026-07-23.17.task1_adapter_ops_claims':
        '4661787e70ecce5005456e8757959f02573234d5cb5e25be9bb47c1737c33e71',
      '2026-07-25.1.task1_final_review':
        'cd38a10af9a988fcb06f57a00e5266e03baa5c03a022afd650a3dc69150a8100',
      '2026-07-26.1.task1_completed_replay_gate':
        'a946e4a209282b9a287bd0e6f82d3253d0ce91e69a382fd3d7f8cb2a93fe569c',
      '2026-07-26.1.task1_runtime_authority_closure':
        'e6dc7640498b11819d67670d765109b91c9327e841dcff2536b7cce7629077ba',
      '2026-08-01.1.task1_api_operations_readiness':
        '6b206a58b9dbb97e0b8310d5bc7a8fee4aa5d893eeb6d7b92a5b08509e6c2c53',
    });
    assert.deepEqual(
      Object.fromEntries(KERNEL_TASK1_FORWARD_MIGRATIONS.map(({ id, checksum }) => [id, checksum])),
      KERNEL_TASK1_FORWARD_MIGRATION_CHECKSUMS,
    );
    assert.deepEqual(KERNEL_TASK1_CLOSURE_MIGRATION_CHECKSUMS, {
      '2026-07-27.1.task1_helm_lifecycle_gate':
        '6b7e2bc0acd4ee28ad02f9c70924709bb6f9e00205247d87e752e2df5ff930f3',
      '2026-07-27.2.task1_authenticated_tenant_authority_expand':
        'd9a70e13065a7eeb82fae265080530481bd644c0798e32bd88b67722cbdf6eb5',
      '2026-07-27.3.task1_authenticated_tenant_authority_enforce':
        '9994edfd6cd1cb7f68b538b4b0f04d1f73435a003b6dba958da7ccdcffc42fc5',
    });
    assert.deepEqual(
      KERNEL_TASK1_CLOSURE_MIGRATIONS.map(({ id }) => id),
      [
        '2026-07-27.1.task1_helm_lifecycle_gate',
        '2026-07-27.2.task1_authenticated_tenant_authority_expand',
        '2026-07-27.3.task1_authenticated_tenant_authority_enforce',
      ],
    );
    assert.equal(
      KERNEL_MIGRATIONS.some(({ id }) => id.startsWith('2026-07-27.')),
      false,
      'runtime startup must not bypass the phase-aware lifecycle runner',
    );
  });

  it('binds the Task 2 schema baseline to every canonical Task 1 closure descriptor', () => {
    const task2Schema = KERNEL_TASK2_FORWARD_MIGRATIONS.find(
      ({ id }) => id === '2026-08-02.3.task2_reconciliation_schema_canonical_baseline',
    );
    assert.ok(task2Schema);

    for (const [id, checksum] of Object.entries(KERNEL_TASK1_CLOSURE_MIGRATION_CHECKSUMS)) {
      assert.ok(
        task2Schema.sql.includes(`'${id}', '${checksum}'`),
        `Task 2 schema baseline must require canonical Task 1 closure descriptor ${id}`,
      );
    }

    const historicalTask2Schema = KERNEL_TASK2_FORWARD_MIGRATIONS.find(
      ({ id }) => id === '2026-07-26.2.task2_reconciliation_schema',
    );
    assert.ok(historicalTask2Schema);
    assert.match(
      historicalTask2Schema.sql,
      /'2026-07-27\.3\.task1_authenticated_tenant_authority_enforce', 'fa9474d03f7f7adca4b32d9164c2510b6eb09ed5ad9929747d997272accb126e'/,
    );
    assert.deepEqual(KERNEL_TASK2_FORWARD_MIGRATION_CHECKSUMS, {
      '2026-07-26.2.task2_reconciliation_schema':
        '281a703a1cc0a6f98e53d30e78ce9cdf632f31685794bdd3d95c122e431c7703',
      '2026-08-02.3.task2_reconciliation_schema_canonical_baseline':
        '46a7513bc4f2402ec1819c1f286c58586417daea9eead4070b278962c73d21c1',
      '2026-07-26.2.task2_reconciliation_rpcs':
        '79007556a06e8188c4d85c23ec71d0ee114eafdff337747c5aa5ee76c8bb2b62',
      '2026-07-26.2.task2_role_closure':
        '5e56de3dfa9a4d884822c077ca28e6bdc7d482a1cfcc3a3b9a7d5a567e6e0289',
    });
  });

  it('ships a tenant-bound read-only operations readiness RPC for the app role', () => {
    const migration = KERNEL_MIGRATIONS.find(
      ({ id }) => id === '2026-08-01.1.task1_api_operations_readiness',
    );
    assert.ok(migration, 'app readiness must be installed as a new forward descriptor');

    const rpc =
      migration.sql.match(
        /CREATE OR REPLACE FUNCTION public\.get_api_operations_readiness[\s\S]*?\$fn\$;/i,
      )?.[0] ?? '';
    assert.match(rpc, /SECURITY DEFINER/i);
    assert.match(rpc, /session_user IS DISTINCT FROM 'commander_app'/i);
    assert.match(rpc, /commander_authenticated_app_tenant\(\)/i);
    assert.match(rpc, /commander_authenticated_app_tenant\(\) IS DISTINCT FROM p_tenant_id/i);
    assert.match(rpc, /FROM public\.commander_workers/i);
    assert.doesNotMatch(rpc, /\b(?:INSERT INTO|UPDATE public\.|DELETE FROM)\b/i);
    assert.match(
      migration.sql,
      /ALTER FUNCTION public\.get_api_operations_readiness\(text\) OWNER TO commander_owner/i,
    );
    assert.match(
      migration.sql,
      /GRANT EXECUTE ON FUNCTION public\.get_api_operations_readiness\(text\) TO commander_app/i,
    );
    assert.doesNotMatch(
      migration.sql,
      /GRANT SELECT ON (?:TABLE )?public\.commander_workers TO commander_app/i,
    );
  });

  it('continues to verify every merged 2026-07-21.16 migration before forward upgrades', () => {
    assert.deepEqual(
      KERNEL_MIGRATIONS.slice(0, KERNEL_2026072116_MIGRATIONS.length),
      KERNEL_2026072116_MIGRATIONS,
    );
    assert.deepEqual(
      KERNEL_2026072116_MIGRATIONS.map((migration) => migration.id),
      [
        '2026-07-21.16.schema',
        '2026-07-21.16.rls',
        '2026-07-21.16.roles',
        '2026-07-21.16.claim_secret',
        '2026-07-21.16.claim',
        '2026-07-21.16.claim_reconcile',
      ],
    );
    assert.ok(
      KERNEL_FORWARD_MIGRATIONS.every((migration) => !migration.id.startsWith('2026-07-21.16.')),
    );
    const forbiddenForwardIds = new Set([
      '2026-07-23.17.schema',
      '2026-07-23.17.rls',
      '2026-07-23.17.roles',
      '2026-07-23.17.claim_secret',
      '2026-07-23.17.claim',
      '2026-07-23.17.claim_reconcile',
    ]);
    assert.equal(
      KERNEL_FORWARD_MIGRATIONS.some((migration) => forbiddenForwardIds.has(migration.id)),
      false,
    );
    assert.deepEqual(Object.keys(KERNEL_HISTORICAL_MIGRATION_CHECKSUMS).sort(), [
      '2026-07-21.16.claim',
      '2026-07-21.16.claim_reconcile',
      '2026-07-21.16.claim_secret',
      '2026-07-21.16.rls',
      '2026-07-21.16.roles',
      '2026-07-21.16.schema',
    ]);
    assert.deepEqual(KERNEL_HISTORICAL_MIGRATION_CHECKSUMS, {
      '2026-07-21.16.claim': 'd1df7704a98023619f6dfbd1c5b572edd275d371b313c4f15bdfc3163a5c3971',
      '2026-07-21.16.claim_reconcile':
        '70e7f78b58c3f03458aeaa8019c0e6322e74ef77e29d4e2f1d961871fc772d1a',
      '2026-07-21.16.claim_secret':
        '445a054b641ab539f068742baf22de51638b1f5bf91fadec976f84e0c7d55d50',
      '2026-07-21.16.rls': '5d239cf964c13c49e68451ff58241e2f1fad5bee9fc66dbfce8ea499597f74db',
      '2026-07-21.16.roles': 'e265f5868d57e7671102a114cf3b5d0e915d9d46231bc6617f447141d82ad804',
      '2026-07-21.16.schema': '75f3f81f04cf88ebad9de172dd144884d6ff3423405e3bf4c6ccac5084149b7d',
    });
  });

  it('skips already-applied 2026-07-21.16 descriptors and applies only forward migrations', async () => {
    const ledger = new Map(Object.entries(KERNEL_HISTORICAL_MIGRATION_CHECKSUMS));
    const pool = new MigrationLedgerPool(ledger);

    await runKernelMigrations(pool);

    assert.deepEqual(
      pool.client.appliedMigrationIds,
      KERNEL_TASK1_FORWARD_MIGRATIONS.map((migration) => migration.id),
    );
  });

  it('applies Task 2 descriptors immediately after the exact Task 1 enforce descriptor', async () => {
    const ledger = new Map(
      [...KERNEL_TASK1_BASELINE_MIGRATIONS, ...KERNEL_TASK1_CLOSURE_MIGRATIONS].map(
        ({ id, checksum }) => [id, checksum],
      ),
    );
    const pool = new MigrationLedgerPool(ledger);

    await runKernelMigrations(pool);

    const canonicalTask2Ids = KERNEL_TASK2_FORWARD_MIGRATIONS.filter(
      ({ id }) => id !== '2026-07-26.2.task2_reconciliation_schema',
    ).map(({ id }) => id);
    assert.deepEqual(
      pool.client.appliedMigrationIds.slice(0, canonicalTask2Ids.length),
      canonicalTask2Ids,
    );
  });

  it('preserves a historical Task 2 ledger row while applying the canonical repair', async () => {
    const ledger = new Map(
      [...KERNEL_TASK1_BASELINE_MIGRATIONS, ...KERNEL_TASK1_CLOSURE_MIGRATIONS].map(
        ({ id, checksum }) => [id, checksum],
      ),
    );
    ledger.set(
      '2026-07-26.2.task2_reconciliation_schema',
      '281a703a1cc0a6f98e53d30e78ce9cdf632f31685794bdd3d95c122e431c7703',
    );
    const pool = new MigrationLedgerPool(ledger);

    await runKernelMigrations(pool);

    assert.equal(
      pool.client.appliedMigrationIds[0],
      '2026-08-02.3.task2_reconciliation_schema_canonical_baseline',
    );
    assert.equal(
      pool.client.appliedMigrationIds.includes('2026-07-26.2.task2_reconciliation_schema'),
      false,
    );
    assert.equal(
      ledger.get('2026-07-26.2.task2_reconciliation_schema'),
      '281a703a1cc0a6f98e53d30e78ce9cdf632f31685794bdd3d95c122e431c7703',
    );
  });

  it('fails closed for the unreachable historical Task 1 enforce baseline', async () => {
    const ledger = new Map(
      [...KERNEL_TASK1_BASELINE_MIGRATIONS, ...KERNEL_TASK1_CLOSURE_MIGRATIONS].map(
        ({ id, checksum }) => [id, checksum],
      ),
    );
    ledger.set(
      '2026-07-27.3.task1_authenticated_tenant_authority_enforce',
      'fa9474d03f7f7adca4b32d9164c2510b6eb09ed5ad9929747d997272accb126e',
    );
    const pool = new MigrationLedgerPool(ledger);

    await assert.rejects(
      () => runKernelMigrations(pool),
      /Task 1 enforce closure checksum is not the canonical published descriptor/,
    );
    assert.deepEqual(pool.client.appliedMigrationIds, []);
  });

  it('rejects a changed 2026-07-21.16 migration checksum before any forward migration runs', async () => {
    const ledger = new Map(Object.entries(KERNEL_HISTORICAL_MIGRATION_CHECKSUMS));
    ledger.set('2026-07-21.16.schema', '0'.repeat(64));
    const pool = new MigrationLedgerPool(ledger);

    await assert.rejects(
      () => runKernelMigrations(pool),
      /Kernel migration checksum mismatch for 2026-07-21\.16\.schema/,
    );
    assert.deepEqual(pool.client.appliedMigrationIds, []);
  });

  it('applies closure descriptors only through the phase-aware owner runner', async () => {
    const ledger = new Map(
      KERNEL_TASK1_BASELINE_MIGRATIONS.map(({ id, checksum }) => [id, checksum]),
    );
    const pool = new MigrationLedgerPool(ledger);

    await runTask1ClosureMigrations(pool, 'expand');
    assert.deepEqual(
      pool.client.appliedMigrationIds,
      KERNEL_TASK1_CLOSURE_MIGRATIONS.slice(0, 2).map(({ id }) => id),
    );

    pool.client.appliedMigrationIds.length = 0;
    await runTask1ClosureMigrations(pool, 'enforce');
    assert.deepEqual(pool.client.appliedMigrationIds, [KERNEL_TASK1_CLOSURE_MIGRATIONS[2]!.id]);
  });

  it('uses distinct class-bound RPCs and keeps the shared helper private', () => {
    assert.match(KERNEL_TASK1_FINAL_REVIEW_SQL, /CREATE OR REPLACE FUNCTION admit_class_a_effect/i);
    assert.match(
      KERNEL_TASK1_FINAL_REVIEW_SQL,
      /CREATE OR REPLACE FUNCTION admit_non_class_a_effect/i,
    );
    assert.match(KERNEL_TASK1_FINAL_REVIEW_SQL, /EFFECT_CLASS_MISMATCH/i);
    assert.match(
      KERNEL_TASK1_FINAL_REVIEW_SQL,
      /REVOKE ALL ON FUNCTION commander_admit_effect_private[\s\S]*FROM PUBLIC/i,
    );
    assert.doesNotMatch(
      KERNEL_TASK1_FINAL_REVIEW_SQL,
      /GRANT EXECUTE ON FUNCTION commander_admit_effect_private[\s\S]*TO commander_(?:app|worker)/i,
    );
    assert.match(
      KERNEL_TASK1_FINAL_REVIEW_SQL,
      /REVOKE SELECT ON TABLE commander_workers FROM commander_adapter_ops/i,
    );
    const nonClassAWrapper =
      KERNEL_TASK1_FINAL_REVIEW_SQL.match(
        /CREATE OR REPLACE FUNCTION admit_non_class_a_effect[\s\S]*?\$fn\$;/i,
      )?.[0] ?? '';
    assert.doesNotMatch(nonClassAWrapper, /db:commander_adapter_ops/i);
    assert.doesNotMatch(nonClassAWrapper, /effect\.(?:reconcile|compensate)/i);
    assert.doesNotMatch(nonClassAWrapper, /FOR (?:NO KEY )?UPDATE OF w/i);
  });

  it('defines an owner-owned SECURITY DEFINER RPC that locks drains and inserts the effect', () => {
    assert.match(KERNEL_ADMIT_CLASS_A_SQL, /CREATE OR REPLACE FUNCTION admit_class_a_effect/i);
    assert.match(KERNEL_ADMIT_CLASS_A_SQL, /SECURITY DEFINER/i);
    assert.match(KERNEL_ADMIT_CLASS_A_SQL, /FOR (?:NO KEY )?UPDATE/i);
    assert.match(KERNEL_ADMIT_CLASS_A_SQL, /INSERT INTO commander_effects/i);
    assert.match(
      KERNEL_ADMIT_CLASS_A_SQL,
      /sha256\(convert_to\(commander_canonical_jsonb\(p_request\)/i,
    );
    assert.match(
      KERNEL_ADMIT_CLASS_A_SQL,
      /ALTER FUNCTION admit_class_a_effect[\s\S]*OWNER TO commander_owner/i,
    );
    assert.match(KERNEL_ADMIT_CLASS_A_SQL, /GRANT EXECUTE[\s\S]*TO commander_worker/i);
    assert.match(KERNEL_ADMIT_CLASS_A_SQL, /GRANT EXECUTE[\s\S]*TO commander_app/i);
  });

  it('does not grant runtime roles UPDATE on the worker registry', () => {
    assert.doesNotMatch(
      KERNEL_ROLES_SQL,
      /GRANT\s+UPDATE(?:\s*,[^;]*)?\s+ON(?:\s+TABLE)?\s+commander_workers[\s\S]*?TO\s+(?:commander_app|commander_worker|commander_adapter_ops)/i,
    );
  });

  it('reserves operations identity and capabilities to the adapter-ops RPC', () => {
    assert.match(
      KERNEL_ROLES_SQL,
      /REVOKE INSERT ON TABLE commander_effects FROM commander_worker/i,
    );
    assert.match(KERNEL_ROLES_SQL, /REVOKE INSERT ON TABLE commander_effects FROM commander_app/i);
    const source = readFileSync(resolve(root, 'packages/kernel/src/schema.ts'), 'utf8');
    assert.match(source, /GENERIC_WORKER_RESERVED_CAPABILITY/i);
    assert.match(source, /'db:' \|\| session_user/i);
  });

  it('uses an owner-owned aggregate readiness RPC based only on fresh worker rows', () => {
    assert.match(KERNEL_ADAPTER_OPS_SQL, /CREATE OR REPLACE FUNCTION get_operations_readiness/i);
    assert.match(KERNEL_ADAPTER_OPS_SQL, /SECURITY DEFINER/i);
    assert.match(
      KERNEL_ADAPTER_OPS_SQL,
      /ALTER FUNCTION get_operations_readiness[\s\S]*OWNER TO commander_owner/i,
    );
    assert.match(
      KERNEL_ADAPTER_OPS_SQL,
      /GRANT EXECUTE[\s\S]*get_operations_readiness[\s\S]*TO commander_adapter_ops/i,
    );
    const readinessFunction =
      KERNEL_ADAPTER_OPS_SQL.match(
        /CREATE OR REPLACE FUNCTION get_operations_readiness[\s\S]*?\$fn\$;/i,
      )?.[0] ?? '';
    assert.doesNotMatch(readinessFunction, /commander_outbox/i);
    assert.doesNotMatch(
      KERNEL_ADAPTER_OPS_SQL.match(
        /CREATE OR REPLACE FUNCTION heartbeat_adapter_ops_worker[\s\S]*?\$fn\$;/i,
      )?.[0] ?? '',
      /commander_outbox/i,
      'heartbeat must not be suppressed across every tenant served by one worker row',
    );
  });

  it('evaluates the readiness TTL after operations worker locks are acquired', () => {
    assert.doesNotMatch(
      KERNEL_TASK1_FINAL_REVIEW_SQL,
      /v_fresh_after timestamptz\s*:=\s*clock_timestamp\(\)/i,
    );
    assert.match(
      KERNEL_TASK1_FINAL_REVIEW_SQL,
      /last_heartbeat_at\s*>=\s*clock_timestamp\(\)\s*-\s*interval '30 seconds'/i,
    );
  });

  it('closes scheduler insertion and validates runtime lease authority before readiness locks', () => {
    assert.match(
      KERNEL_TASK1_RUNTIME_AUTHORITY_CLOSURE_SQL,
      /REVOKE INSERT ON TABLE commander_effects FROM commander_scheduler/i,
    );
    const admission =
      KERNEL_TASK1_AUTHENTICATED_TENANT_AUTHORITY_ENFORCE_SQL.match(
        /CREATE OR REPLACE FUNCTION public\.admit_class_a_effect[\s\S]*?\$function\$;/i,
      )?.[0] ?? '';
    const scopeCheck = admission.indexOf('commander_runtime_effect_tenant_authorized(p_tenant_id)');
    const leaseAuthorization = admission.indexOf('lease_worker.tenant_ids ? p_tenant_id');
    const readinessLock = admission.indexOf('WITH locked_workers AS MATERIALIZED');
    const replayRecheck = admission.lastIndexOf('SELECT e.* INTO v_existing');

    assert.ok(scopeCheck >= 0);
    assert.equal(leaseAuthorization, -1, 'the public wrapper must delegate lease checks');
    assert.equal(readinessLock, -1, 'the public wrapper must delegate readiness locking');
    assert.equal(replayRecheck, -1, 'the public wrapper must delegate replay handling');
    assert.doesNotMatch(admission, /current_setting\('app\.tenant_scope'/i);
    assert.match(
      KERNEL_TASK1_AUTHENTICATED_TENANT_AUTHORITY_ENFORCE_SQL,
      /session_user = 'commander_app'[\s\S]*p_tenant_id = public\.commander_authenticated_app_tenant\(\)/i,
    );
    assert.match(
      KERNEL_TASK1_AUTHENTICATED_TENANT_AUTHORITY_ENFORCE_SQL,
      /CREATE OR REPLACE FUNCTION public\.commander_runtime_effect_tenant_authorized[\s\S]*admit_non_class_a_effect[\s\S]*commander_runtime_effect_tenant_authorized\(p_tenant_id\)[\s\S]*enforce_runtime_effect_tenant_scope[\s\S]*commander_runtime_effect_tenant_authorized\(NEW\.tenant_id\)/i,
    );
    assert.match(
      KERNEL_TASK1_RUNTIME_AUTHORITY_CLOSURE_SQL,
      /NEW\.id !~ '\^\(reconcile\|compensation\):\[a-z0-9\]/i,
    );
  });

  it('routes PostgreSQL repository admission through the RPC', () => {
    const source = readFileSync(resolve(root, 'packages/kernel/src/postgres.ts'), 'utf8');
    assert.match(
      source,
      /if \(!this\.options\.schedulerMode\)/,
      'runtime app and worker repositories must use the owner RPC after direct effect INSERT is revoked',
    );
    assert.match(
      source,
      /if \(isClassAEffectType\(request\.type\) && !isCompensation\)[\s\S]*this\.enforceAtomicOperationsReadiness\(\)[\s\S]*OPERATIONS_NOT_READY[\s\S]*getOperationsReadiness\(request\.tenantId\)/,
      'direct repositories must either fail closed or prove operations readiness before Class A insertion',
    );
    assert.match(source, /SELECT \* FROM admit_class_a_effect\(/);
    assert.match(source, /SELECT \* FROM admit_non_class_a_effect\(/);
    assert.match(source, /isClassAEffectType\(request\.type\)/);
  });

  it('adapter-ops startup does not probe the private worker table', () => {
    const source = readFileSync(resolve(root, 'packages/adapter-ops/src/wiring.ts'), 'utf8');
    assert.doesNotMatch(source, /to_regclass\('public\.commander_workers'\)/);
  });
});
