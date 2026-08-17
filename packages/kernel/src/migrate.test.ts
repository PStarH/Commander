import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as migrationEntrypoint from './migrate.js';
import {
  isTask1OwnerCommandMode,
  parseTask1ClosureMigrationPhase,
  resolveMigrationDatabaseUrl,
  runTask1OwnerMode,
  runTask1OwnerAppendBootstrap,
  currentTask1Operation,
  createTask1ProofRuntime,
  readTask1OwnerInput,
} from './migrate.js';
import { canonicalBootstrapJson, canonicalBootstrapSha256 } from './canonicalBootstrap.js';
import { KERNEL_TASK1_BASELINE_MIGRATIONS, KERNEL_TASK1_CLOSURE_MIGRATIONS } from './migrations.js';
import type { SqlClient, SqlPool, SqlQueryResult } from './postgres.js';
import type { Task1RolloutProofReceipt } from './task1RolloutProof.js';

function sqlResult<T>(rows: T[]): SqlQueryResult<T> {
  return { rows, rowCount: rows.length };
}

class OwnerBootstrapLedgerClient implements SqlClient {
  readonly appliedMigrationIds: string[] = [];

  constructor(private readonly ledger = new Map<string, string>()) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<T>> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      return sqlResult<T>([]);
    }
    if (normalized.includes('pg_advisory_xact_lock')) return sqlResult<T>([]);
    if (normalized === 'SELECT current_user, session_user') {
      return sqlResult([{ current_user: 'commander_owner', session_user: 'commander_owner' } as T]);
    }
    if (normalized.includes("tablename = 'commander_runs'") && normalized.includes('tableowner')) {
      return sqlResult([{ owns: true } as T]);
    }
    if (
      normalized.includes("tablename='public'") ||
      normalized.includes("tablename='commander_runs'") ||
      normalized.includes("tablename = 'commander_runs'")
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

class OwnerBootstrapLedgerPool implements SqlPool {
  readonly client = new OwnerBootstrapLedgerClient();

  async connect(): Promise<SqlClient> {
    return this.client;
  }
}

class FailingOwnerBootstrapLedgerClient extends OwnerBootstrapLedgerClient {
  override async query<T = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<T>> {
    if (sql === KERNEL_TASK1_BASELINE_MIGRATIONS[0]?.sql) {
      throw Object.assign(
        new Error('postgres://owner:secret@postgres/commander SELECT private_value'),
        {
          code: '42P01',
        },
      );
    }
    return super.query(sql, values);
  }
}

class FailingOwnerBootstrapLedgerPool implements SqlPool {
  readonly client = new FailingOwnerBootstrapLedgerClient();

  async connect(): Promise<SqlClient> {
    return this.client;
  }
}

describe('kernel owner migration entrypoint', () => {
  const digest = (value: string): string => value.repeat(64).slice(0, 64);

  it('formats only a sanitized PostgreSQL migration failure diagnostic', () => {
    const formatter = (
      migrationEntrypoint as typeof migrationEntrypoint & {
        migrationFailureDiagnostic?: (error: unknown) => string;
      }
    ).migrationFailureDiagnostic;
    assert.equal(typeof formatter, 'function');

    const failure = Object.assign(
      new Error('postgres://owner:secret@postgres/commander SELECT private_value'),
      {
        migrationId: '2026-07-27.3.task1_authenticated_tenant_authority_enforce',
        phase: 'enforce',
        sqlstate: '42P01',
        ownerStage: 'bootstrap_kernel',
      },
    );
    const result = formatter!(failure);

    assert.equal(
      result,
      'COMMANDER_MIGRATION_FAILED;owner_stage=bootstrap_kernel;migration=2026-07-27.3.task1_authenticated_tenant_authority_enforce;phase=enforce;sqlstate=42P01',
    );
    assert.doesNotMatch(result, /postgres:|secret|SELECT|private_value/i);
  });

  it('formats every allowlisted owner boundary without reflecting failure details', () => {
    const formatter = (
      migrationEntrypoint as typeof migrationEntrypoint & {
        migrationFailureDiagnostic?: (error: unknown) => string;
      }
    ).migrationFailureDiagnostic;
    assert.equal(typeof formatter, 'function');

    const stages = [
      'input',
      'proof_runtime',
      'bootstrap_kernel',
      'bootstrap_closure',
      'owner_pool_configuration',
      'owner_pool_connect',
      'bootstrap_context',
      'bootstrap_context_authority_url',
      'bootstrap_context_pool_configuration',
      'bootstrap_context_pool_connect',
      'bootstrap_context_catalog_query',
      'bootstrap_context_pool_close',
      'lifecycle_initialize',
      'lifecycle_candidate_peer_observation',
      'lifecycle_candidate_peer_validation',
      'lifecycle_prebootstrap_snapshot',
      'lifecycle_transaction',
      'current_read',
      'rollout_proof',
    ] as const;

    for (const ownerStage of stages) {
      const result = formatter!(
        Object.assign(new Error('owner-stage-opaque-marker'), {
          ownerStage,
        }),
      );
      assert.equal(result, 'COMMANDER_MIGRATION_FAILED;owner_stage=' + ownerStage);
      assert.doesNotMatch(result, /owner-stage-opaque-marker/i);
    }
  });

  it('formats only the fixed prebootstrap snapshot and catalog step', () => {
    const formatter = (
      migrationEntrypoint as typeof migrationEntrypoint & {
        migrationFailureDiagnostic?: (error: unknown) => string;
      }
    ).migrationFailureDiagnostic;
    assert.equal(typeof formatter, 'function');

    const result = formatter!(
      Object.assign(new Error('postgres://owner:secret@postgres/commander SELECT private_value'), {
        ownerStage: 'lifecycle_prebootstrap_snapshot',
        snapshot: 's0',
        catalogStep: 'functions',
      }),
    );

    assert.equal(
      result,
      'COMMANDER_MIGRATION_FAILED;owner_stage=lifecycle_prebootstrap_snapshot;snapshot=s0;catalog_step=functions',
    );
    assert.doesNotMatch(result, /postgres:|secret|SELECT|private_value/i);
  });

  for (const snapshotTransaction of ['begin', 'commit'] as const) {
    it(`formats only the fixed ${snapshotTransaction} snapshot transaction boundary`, () => {
      const formatter = (
        migrationEntrypoint as typeof migrationEntrypoint & {
          migrationFailureDiagnostic?: (error: unknown) => string;
        }
      ).migrationFailureDiagnostic;
      assert.equal(typeof formatter, 'function');

      const result = formatter!(
        Object.assign(new Error('postgres://owner:secret@postgres/commander SELECT private_value'), {
          ownerStage: 'lifecycle_prebootstrap_snapshot',
          snapshot: 's0',
          snapshotTransaction,
        }),
      );

      assert.equal(
        result,
        'COMMANDER_MIGRATION_FAILED;owner_stage=lifecycle_prebootstrap_snapshot;snapshot=s0;snapshot_transaction=' +
          snapshotTransaction,
      );
      assert.doesNotMatch(result, /postgres:|secret|SELECT|private_value/i);
    });
  }

  it('fails closed when an owner stage is not allowlisted', () => {
    const formatter = (
      migrationEntrypoint as typeof migrationEntrypoint & {
        migrationFailureDiagnostic?: (error: unknown) => string;
      }
    ).migrationFailureDiagnostic;
    assert.equal(typeof formatter, 'function');

    const result = formatter!(
      Object.assign(new Error('untrusted-owner-stage-marker'), {
        ownerStage: 'untrusted_stage',
        migrationId: '2026-07-27.3.task1_authenticated_tenant_authority_enforce',
        phase: 'enforce',
        sqlstate: '42P01',
      }),
    );

    assert.equal(result, 'COMMANDER_MIGRATION_FAILED');
  });

  it('fails closed when migration failure fields are malformed', () => {
    const formatter = (
      migrationEntrypoint as typeof migrationEntrypoint & {
        migrationFailureDiagnostic?: (error: unknown) => string;
      }
    ).migrationFailureDiagnostic;
    assert.equal(typeof formatter, 'function');

    const result = formatter!(
      Object.assign(new Error('postgres://owner:secret@postgres/commander'), {
        migrationId: 'not a migration id',
        phase: 'unbounded',
        sqlstate: 'not-a-sqlstate',
      }),
    );

    assert.equal(result, 'COMMANDER_MIGRATION_FAILED');
  });

  it('attaches only migration identity, phase, and PostgreSQL SQLSTATE to a failed query', async () => {
    const pool = new FailingOwnerBootstrapLedgerPool();

    await assert.rejects(
      () => migrationEntrypoint.bootstrapTask1OwnerAppendMigrations(pool, 'enforce'),
      (error: unknown) => {
        const failure = error as Error & {
          migrationId?: string;
          phase?: string;
          sqlstate?: string;
        };
        assert.equal(failure.migrationId, KERNEL_TASK1_BASELINE_MIGRATIONS[0]?.id);
        assert.equal(failure.phase, 'baseline');
        assert.equal(failure.sqlstate, '42P01');
        assert.equal(failure.ownerStage, 'bootstrap_kernel');
        assert.doesNotMatch(failure.message, /postgres:|secret|SELECT|private_value/i);
        return true;
      },
    );
  });

  it('bootstraps enforce lifecycle descriptors before a fresh owner append initializes state', async () => {
    const bootstrap = (
      migrationEntrypoint as typeof migrationEntrypoint & {
        bootstrapTask1OwnerAppendMigrations?: (pool: SqlPool, command: 'enforce') => Promise<void>;
      }
    ).bootstrapTask1OwnerAppendMigrations;
    assert.equal(typeof bootstrap, 'function');

    const pool = new OwnerBootstrapLedgerPool();
    await bootstrap!(pool, 'enforce');

    assert.deepEqual(pool.client.appliedMigrationIds, [
      ...KERNEL_TASK1_BASELINE_MIGRATIONS.map(({ id }) => id),
      ...KERNEL_TASK1_CLOSURE_MIGRATIONS.map(({ id }) => id),
    ]);
  });

  it('initializes the lifecycle catalog before applying the requested closure', async () => {
    const events: string[] = [];
    const client = new OwnerBootstrapLedgerClient();
    const pool = {
      client,
      async connect() {
        return client;
      },
    } as unknown as SqlPool;
    const prepared = { command: 'install_enforce' } as Parameters<
      typeof runTask1OwnerAppendBootstrap
    >[1];

    await runTask1OwnerAppendBootstrap(pool, prepared, {
      initialize: async () => {
        events.push('lifecycle_initialize');
      },
      applyClosure: async () => {
        events.push('bootstrap_closure');
      },
    });

    assert.deepEqual(events, ['lifecycle_initialize', 'bootstrap_closure']);
  });

  it('classifies a rejected owner pool connection before lifecycle initialization', async () => {
    const pool = {
      async connect() {
        throw new Error('postgres://owner:secret@db/commander connect refused');
      },
    } as unknown as SqlPool;
    const prepared = { command: 'install_enforce' } as Parameters<
      typeof runTask1OwnerAppendBootstrap
    >[1];

    await assert.rejects(
      () => runTask1OwnerAppendBootstrap(pool, prepared),
      (error: unknown) => {
        assert.equal((error as { ownerStage?: unknown }).ownerStage, 'owner_pool_connect');
        return true;
      },
    );
  });

  it('uses the dedicated owner DSN before legacy migration variables', () => {
    assert.equal(
      resolveMigrationDatabaseUrl({
        COMMANDER_OWNER_DATABASE_URL: 'postgres://owner',
        COMMANDER_KERNEL_DATABASE_URL: 'postgres://kernel',
        DATABASE_URL: 'postgres://legacy',
      }),
      'postgres://owner',
    );
  });

  it('runs closure descriptors only for the explicit phase-bound action', () => {
    assert.equal(parseTask1ClosureMigrationPhase([], {}), undefined);
    assert.equal(
      parseTask1ClosureMigrationPhase(['tenant-cutover-migrate'], {
        COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE: 'expand',
      }),
      'expand',
    );
    assert.equal(
      parseTask1ClosureMigrationPhase(['tenant-cutover-migrate'], {
        COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE: 'enforce',
      }),
      'enforce',
    );
    assert.throws(
      () => parseTask1ClosureMigrationPhase(['tenant-cutover-migrate'], {}),
      /TASK1_CLOSURE_PHASE_REQUIRED/,
    );
    assert.equal(isTask1OwnerCommandMode('tenant-cutover-plan'), true);
    assert.equal(isTask1OwnerCommandMode('tenant-cutover-append'), true);
    assert.equal(isTask1OwnerCommandMode('tenant-cutover-recover'), true);
    assert.equal(isTask1OwnerCommandMode('tenant-cutover-prove'), true);
    assert.equal(isTask1OwnerCommandMode('tenant-cutover-restore'), true);
    assert.equal(isTask1OwnerCommandMode('migration'), false);
  });

  it('reads owner requests only from stdin or the fixed in-cluster request mount', async () => {
    let stdinReads = 0;
    let fileReads = 0;
    assert.equal(
      await readTask1OwnerInput(
        {},
        async () => {
          stdinReads += 1;
          return '{"source":"stdin"}';
        },
        async () => {
          fileReads += 1;
          return '';
        },
      ),
      '{"source":"stdin"}',
    );
    assert.equal(stdinReads, 1);
    assert.equal(fileReads, 0);

    assert.equal(
      await readTask1OwnerInput(
        { COMMANDER_TENANT_CUTOVER_INPUT_FILE: '/run/commander/tenant-cutover/request.json' },
        async () => {
          throw new Error('stdin must not be read');
        },
        async (path, encoding) => {
          fileReads += 1;
          assert.equal(path, '/run/commander/tenant-cutover/request.json');
          assert.equal(encoding, 'utf8');
          return '{"source":"file"}';
        },
      ),
      '{"source":"file"}',
    );
    assert.equal(fileReads, 1);

    await assert.rejects(
      readTask1OwnerInput(
        { COMMANDER_TENANT_CUTOVER_INPUT_FILE: '/tmp/request.json' },
        async () => '',
        async () => '',
      ),
      /TENANT_CUTOVER_INPUT_FILE_INVALID/,
    );
    await assert.rejects(
      readTask1OwnerInput(
        {},
        async () => 'x'.repeat(128 * 1024 + 1),
        async () => '',
      ),
      /TENANT_CUTOVER_INPUT_TOO_LARGE/,
    );
  });

  it('wires prove mode to the atomic proof runtime instead of the current-row boolean', async () => {
    const operation = {
      installation_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      operation_version: '7',
      predecessor_state_version: '6',
      resulting_state_version: '7',
      predecessor_state: 'expanded',
      resulting_state: 'enforced',
      operation_kind: 'enforce',
      runtime_phase: 'enforce',
      platform_kind: 'compose',
      previous_binding_jcs: null,
      previous_binding_sha256: null,
      requested_binding_jcs: '{"kind":"compose"}',
      requested_binding_sha256: 'a'.repeat(64),
      previous_configuration_jcs: null,
      previous_configuration_sha256: null,
      requested_configuration_jcs: '{}',
      requested_configuration_sha256: 'b'.repeat(64),
      previous_business_configuration_sha256: null,
      requested_business_configuration_sha256: 'c'.repeat(64),
      origin_binding_sha256: 'd'.repeat(64),
      database_peer_binding_sha256: 'e'.repeat(64),
      proof_key_sha256: 'f'.repeat(64),
      descriptor_set: [],
      predecessor_evidence_jcs: '{}',
      predecessor_evidence_sha256: '1'.repeat(64),
      result: 'committed',
    };
    let provedVersion: string | undefined;
    const pool = {
      query: async (sql: string) =>
        sql.includes('to_regclass')
          ? {
              rows: [
                {
                  state_table: 'commander_tenant_cutover_state',
                  operation_table: 'commander_tenant_cutover_operations',
                },
              ],
              rowCount: 1,
            }
          : { rows: [{ operation, proofs: [] }], rowCount: 1 },
    };
    const receipt: Task1RolloutProofReceipt = {
      operationVersion: '7',
      proofSequence: '1',
      proofAttemptId: '11111111-1111-4111-8111-111111111111',
      rolloutProofSha256: '9'.repeat(64),
    };
    const output = await runTask1OwnerMode('tenant-cutover-prove', '', pool as never, {
      proveCurrent: async (current) => {
        provedVersion = current.operationVersion;
        return receipt;
      },
    });
    assert.equal(provedVersion, '7');
    assert.equal(output.rolloutProofSha256, '9'.repeat(64));
  });

  it('selects exactly one contained platform proof runtime', () => {
    const pool = {} as never;
    assert.equal(createTask1ProofRuntime(pool, {}), undefined);
    assert.ok(
      createTask1ProofRuntime(pool, {
        COMMANDER_COMPOSE_TOPOLOGY_RELAY_SOCKET: '/tmp/relay.sock',
        COMMANDER_COMPOSE_TOPOLOGY_RELAY_ATTEMPT: 'attempt-1',
        COMMANDER_COMPOSE_TOPOLOGY_RELAY_TOKEN: 't'.repeat(43),
      }),
    );
    assert.ok(
      createTask1ProofRuntime(pool, {
        COMMANDER_KUBERNETES_PROOF_RUNTIME: '1',
        KUBERNETES_SERVICE_HOST: 'kubernetes.default.svc',
        KUBERNETES_SERVICE_PORT_HTTPS: '443',
      }),
    );
    assert.throws(
      () =>
        createTask1ProofRuntime(pool, {
          COMMANDER_KUBERNETES_PROOF_RUNTIME: '1',
          KUBERNETES_SERVICE_HOST: 'kubernetes.default.svc',
          KUBERNETES_SERVICE_PORT_HTTPS: '443',
          COMMANDER_COMPOSE_TOPOLOGY_RELAY_SOCKET: '/tmp/relay.sock',
          COMMANDER_COMPOSE_TOPOLOGY_RELAY_ATTEMPT: 'attempt-1',
          COMMANDER_COMPOSE_TOPOLOGY_RELAY_TOKEN: 't'.repeat(43),
        }),
      /TENANT_CUTOVER_PROOF_PLATFORM_AMBIGUOUS/,
    );
    assert.throws(
      () =>
        createTask1ProofRuntime(pool, {
          COMMANDER_KUBERNETES_PROOF_RUNTIME: '1',
          KUBERNETES_SERVICE_HOST: 'kubernetes.default.svc',
        }),
      /TENANT_CUTOVER_KUBERNETES_CONFIGURATION_INVALID/,
    );
  });

  it('loads the immediate predecessor operation from the append-only ledger', async () => {
    const current = {
      installation_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      operation_version: '7',
      predecessor_state_version: '6',
      resulting_state_version: '7',
      predecessor_state: 'expanded',
      resulting_state: 'enforced',
      operation_kind: 'enforce',
      runtime_phase: 'enforce',
      platform_kind: 'compose',
      previous_binding_jcs: '{"kind":"compose"}',
      previous_binding_sha256: '0'.repeat(64),
      requested_binding_jcs: '{"kind":"compose"}',
      requested_binding_sha256: 'a'.repeat(64),
      previous_configuration_jcs: '{}',
      previous_configuration_sha256: '0'.repeat(64),
      requested_configuration_jcs: '{}',
      requested_configuration_sha256: 'b'.repeat(64),
      previous_business_configuration_sha256: '0'.repeat(64),
      requested_business_configuration_sha256: 'c'.repeat(64),
      origin_binding_sha256: 'd'.repeat(64),
      database_peer_binding_sha256: 'e'.repeat(64),
      proof_key_sha256: 'f'.repeat(64),
      descriptor_set: [],
      predecessor_evidence_jcs: '{}',
      predecessor_evidence_sha256: '1'.repeat(64),
      result: 'committed',
    };
    const predecessor = {
      ...current,
      operation_version: '6',
      predecessor_state_version: '5',
      resulting_state_version: '6',
      operation_kind: 'legacy_expand',
      runtime_phase: 'expand',
    };
    const pool = {
      query: async (sql: string) =>
        sql.includes('to_regclass')
          ? { rows: [{ state_table: 'state', operation_table: 'operations' }], rowCount: 1 }
          : { rows: [{ operation: current, predecessor, proofs: [] }], rowCount: 1 },
    };
    const result = await currentTask1Operation(pool as never);
    assert.equal(result.operation?.operationVersion, '7');
    assert.equal(result.predecessor?.operationVersion, '6');
    assert.equal(result.predecessor?.operationKind, 'legacy_expand');
  });

  it('maps only a proven Helm proof projection into restore evidence', async () => {
    const binding = {
      kind: 'helm',
      namespace: 'commander',
      releaseName: 'commander',
      chartContentSha256: digest('a'),
      phase: 'enforce',
      apiImageDigest: `sha256:${digest('b')}`,
    };
    const configuration = { operationAuditNonce: 'n'.repeat(43) };
    const operation = {
      installation_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      operation_version: '7',
      predecessor_state_version: '6',
      resulting_state_version: '7',
      predecessor_state: 'expanded',
      resulting_state: 'enforced',
      operation_kind: 'enforce',
      runtime_phase: 'enforce',
      platform_kind: 'helm',
      previous_binding_jcs: null,
      previous_binding_sha256: null,
      requested_binding_jcs: canonicalBootstrapJson(binding),
      requested_binding_sha256: canonicalBootstrapSha256(binding),
      previous_configuration_jcs: null,
      previous_configuration_sha256: null,
      requested_configuration_jcs: canonicalBootstrapJson(configuration),
      requested_configuration_sha256: canonicalBootstrapSha256(configuration),
      previous_business_configuration_sha256: null,
      requested_business_configuration_sha256: digest('c'),
      origin_binding_sha256: digest('d'),
      database_peer_binding_sha256: digest('e'),
      proof_key_sha256: digest('f'),
      descriptor_set: [],
      predecessor_evidence_jcs: canonicalBootstrapJson({ kind: 'fresh-no-predecessor/v1' }),
      predecessor_evidence_sha256: digest('1'),
      result: 'committed',
    };
    const platformArtifact = {
      format: 'helm-release-projection/v1',
      namespace: 'commander',
      releaseName: 'commander',
      revision: '12',
      chartContentSha256: digest('a'),
      objects: [],
      hooks: [],
      rendererInput: {
        format: 'helm-renderer-input-projection/v1',
        values: {
          tenantAuthority: { chartContentSha256: digest('a') },
          database: { existingSecret: 'commander-database' },
        },
        secretReferences: [],
      },
    };
    const challengedResponse = {
      challenge: 'c'.repeat(43),
      operationVersion: '7',
      phase: 'enforce',
      installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      databasePeerBindingSha256: digest('e'),
      imageDigest: `sha256:${digest('b')}`,
      configurationSha256: canonicalBootstrapSha256(configuration),
    };
    const proof = {
      format: 'rollout-proof/v1',
      installationId: operation.installation_uuid,
      operationVersion: '7',
      proofSequence: '2',
      proofAttemptId: '11111111-1111-4111-8111-111111111111',
      lifecycleCommand: 'enforce',
      topology: 'helm',
      configurationSha256: operation.requested_configuration_sha256,
      platformBindingSha256: operation.requested_binding_sha256,
      requestedImageDigest: `sha256:${digest('b')}`,
      proofKeySha256: operation.proof_key_sha256,
      challengedResponse,
      challengedResponseSha256: canonicalBootstrapSha256(challengedResponse),
      platformArtifact,
      platformArtifactSha256: canonicalBootstrapSha256(platformArtifact),
      workload: {
        uid: 'deployment-uid',
        generation: '1',
        observedGeneration: '1',
        templateSha256: digest('2'),
        ready: ['commander-api-1'],
      },
      startedAt: '2026-07-29T00:00:00.000Z',
      provenAt: '2026-07-29T00:00:01.000Z',
      pinned: { chart: digest('a') },
      metadata: {
        specRevision: 27,
        evidenceLevel: 'live',
        writeOwner: 'commander_owner',
        publicationPoint: 'commander_tenant_cutover_rollout_proofs',
      },
    };
    const pool = {
      query: async (sql: string) =>
        sql.includes('to_regclass')
          ? { rows: [{ state_table: 'state', operation_table: 'operations' }], rowCount: 1 }
          : {
              rows: [
                {
                  operation,
                  predecessor: null,
                  proofs: [
                    {
                      jcs: canonicalBootstrapJson(proof),
                      sha256: canonicalBootstrapSha256(proof),
                      sequence: '2',
                    },
                  ],
                },
              ],
              rowCount: 1,
            },
    };
    const result = await currentTask1Operation(pool as never);
    assert.equal(result.proven, true);
    assert.equal(result.restoreEvidence?.revision, '12');
    assert.equal(
      result.restoreEvidence?.releaseProjectionSha256,
      canonicalBootstrapSha256(platformArtifact),
    );

    const secretArtifact = {
      ...platformArtifact,
      objects: [
        {
          identity: { apiVersion: 'v1', kind: 'Secret', namespace: 'commander', name: 'db' },
          comparator: { format: 'kubernetes-field-comparator/v1', data: { url: 'fixture-secret' } },
          secretReferences: [],
        },
      ],
    };
    const secretProof = {
      ...proof,
      platformArtifact: secretArtifact,
      platformArtifactSha256: canonicalBootstrapSha256(secretArtifact),
    };
    const secretPool = {
      query: async (sql: string) =>
        sql.includes('to_regclass')
          ? { rows: [{ state_table: 'state', operation_table: 'operations' }], rowCount: 1 }
          : {
              rows: [
                {
                  operation,
                  predecessor: null,
                  proofs: [
                    {
                      jcs: canonicalBootstrapJson(secretProof),
                      sha256: canonicalBootstrapSha256(secretProof),
                      sequence: '2',
                    },
                  ],
                },
              ],
              rowCount: 1,
            },
    };
    const secretResult = await currentTask1Operation(secretPool as never);
    assert.equal(secretResult.proven, true);
    assert.equal(secretResult.restoreEvidence, undefined);

    const newerSecretProof = { ...secretProof, proofSequence: '3' };
    const mixedPool = {
      query: async (sql: string) =>
        sql.includes('to_regclass')
          ? { rows: [{ state_table: 'state', operation_table: 'operations' }], rowCount: 1 }
          : {
              rows: [
                {
                  operation,
                  predecessor: null,
                  proofs: [
                    {
                      jcs: canonicalBootstrapJson(proof),
                      sha256: canonicalBootstrapSha256(proof),
                      sequence: '2',
                    },
                    {
                      jcs: canonicalBootstrapJson(newerSecretProof),
                      sha256: canonicalBootstrapSha256(newerSecretProof),
                      sequence: '3',
                    },
                  ],
                },
              ],
              rowCount: 1,
            },
    };
    const mixedResult = await currentTask1Operation(mixedPool as never);
    assert.equal(mixedResult.proven, true);
    assert.equal(mixedResult.restoreEvidence, undefined);
  });
});
