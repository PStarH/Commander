import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PoolClient } from 'pg';
import {
  canonicalBootstrapJson,
  canonicalBootstrapSha256,
  createDatabasePeerBinding,
  createDatabasePeerBindingInput,
  createOriginBinding,
  createPrebootstrapSnapshots,
  type PrebootstrapInventoryV1,
} from './canonicalBootstrap.js';
import {
  PINNED_TASK1_LIFECYCLE_MANIFESTS,
  applyTask1LifecycleRoleCredentials,
  assertPinnedTask1LifecycleManifests,
  initializeTask1LifecycleBoundary,
  loadTask1BootstrapContext,
  planTask1LifecycleInitialization,
  resolveTask1BootstrapAuthorityUrl,
  runTask1LifecycleDescriptorStateTransaction,
} from './task1LifecycleInitialize.js';
import { KERNEL_TASK1_BASELINE_MIGRATIONS, KERNEL_TASK1_CLOSURE_MIGRATIONS } from './migrations.js';
import type { SqlClient, SqlQueryResult } from './postgres.js';

const roles = ['adapter-ops', 'app', 'owner', 'scheduler', 'tenant-authority', 'worker'] as const;

function sixRoleCredentialEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    COMMANDER_ADAPTER_OPS_DATABASE_URL:
      'postgres://commander_adapter_ops:adapter-password@db/commander?sslmode=verify-full',
    COMMANDER_APP_DATABASE_URL:
      'postgres://commander_app:app-password@db/commander?sslmode=verify-full',
    COMMANDER_OWNER_DATABASE_URL:
      'postgres://commander_owner:owner-password@db/commander?sslmode=verify-full',
    COMMANDER_SCHEDULER_DATABASE_URL:
      'postgres://commander_scheduler:scheduler-password@db/commander?sslmode=verify-full',
    COMMANDER_TENANT_AUTHORITY_DATABASE_URL:
      'postgres://commander_tenant_authority:tenant-password@db/commander?sslmode=verify-full',
    COMMANDER_WORKER_DATABASE_URL:
      'postgres://commander_worker:worker-password@db/commander?sslmode=verify-full',
    ...overrides,
  };
}

const platformBinding = {
  kind: 'compose' as const,
  projectName: 'commander',
  composeVariant: 'prod' as const,
  composeCredentialInventory: 'fresh-bootstrap-v1' as const,
  composeSourceSha256: 'c'.repeat(64),
  composeCliVersion: '5.3.1' as const,
  composeContentSha256: 'd'.repeat(64),
  phase: 'enforce' as const,
  apiImageDigest: `registry.example/commander@sha256:${'e'.repeat(64)}`,
  apiProofUrl: 'https://api:9443/ready/tenant-authority/v1',
};

const prepared = {
  command: 'install_enforce' as const,
  platformBinding,
  businessConfiguration: { allowedTenants: ['tenant-a'] },
  configuration: { allowedTenants: ['tenant-a'], operationAuditNonce: 'n'.repeat(43) },
  configurationSha256: canonicalBootstrapSha256({
    allowedTenants: ['tenant-a'],
    operationAuditNonce: 'n'.repeat(43),
  }),
};

const bootstrapIdentities = {
  format: 'bootstrap_identities/v1' as const,
  envelope: 'E2' as const,
  authority: { oid: '10', name: 'postgres', superuser: true, commanderNamed: false },
  bootstrapSuperuser: { oid: '10', name: 'postgres', superuser: true, commanderNamed: false },
};

function inventory(
  identities:
    | (Omit<typeof bootstrapIdentities, 'envelope'> & { envelope: 'E1' | 'E2' })
    | null = bootstrapIdentities,
  ledger: Array<{ id: string; checksum: string }> | null = null,
  productRows: boolean[] = [],
): PrebootstrapInventoryV1 {
  const relations = productRows.map((_, index) => ({
    schema: 'public',
    name: `commander_legacy_${index}`,
    kind: 'r',
  }));
  return {
    format: 'prebootstrap_inventory/v1',
    postgresVersion: '16.14',
    catalogVersion: '202307071',
    databaseIdentity: { oid: '16384', name: 'commander' },
    ledger,
    namespaces: [],
    relations,
    functions: [],
    types: [],
    extensions: [],
    policies: [],
    triggers: [],
    productSources: relations.map(({ schema, name }) => `${schema}.${name}`),
    productHasRows: productRows.map((hasRows, index) => ({
      relation: `public.commander_legacy_${index}`,
      hasRows,
    })),
    roles: [],
    memberships: [],
    roleSettings: [],
    databaseAcl: [],
    schemaAcls: [],
    defaultAcls: [],
    bootstrapIdentities: identities,
  };
}

function testCatalogTransaction() {
  return {
    origin: { classification: 'E2' as const, bootstrapIdentities },
    databasePeerBinding: peerBinding,
    collectInventory: async () => inventory(),
    verifyState: () => undefined,
    applyHardening: async () => undefined,
  };
}

const peerBinding = createDatabasePeerBinding({
  roles: roles.map((role) => ({
    role,
    host: 'db.example',
    port: 5432,
    tlsServerSans: { dns: ['db.example'], ip: [] },
    serverSpkiSha256: 'f'.repeat(64),
    databaseOid: '16384',
    databaseName: 'commander',
  })),
});
const peerInput = createDatabasePeerBindingInput({
  roles: roles.map((role) => ({ role, host: 'db.example', port: 5432 })),
  expectedServerSpkiSha256: 'f'.repeat(64),
  ca: { mountIdentity: 'database-ca', path: '/ca.crt', publicBytesSha256: '0'.repeat(64) },
});

function result<T>(rows: T[] = []): SqlQueryResult<T> {
  return { rows, rowCount: rows.length };
}

class RecordingClient implements SqlClient {
  readonly statements: string[] = [];
  readonly bindings: unknown[][] = [];
  failDescriptor = false;
  snapshotTransactionFailure: 'begin' | 'commit' | undefined;
  existingLifecycleState: {
    state: 'fresh_pending' | 'legacy_pending' | 'expanded' | 'enforced';
    pending_configuration_sha256: string | null;
    platform_kind?: 'compose' | 'helm';
    platform_binding_sha256?: string | null;
    state_version?: string;
    prebootstrap_snapshots_jcs?: string;
    prebootstrap_snapshots_sha256?: string;
    bootstrap_identities_jcs?: string | null;
    origin_binding_jcs?: string;
    origin_binding_sha256?: string;
    database_peer_binding_jcs?: string;
    database_peer_binding_sha256?: string;
    proof_key_sha256?: string;
    historical_baseline_manifest_source_sha256?: string;
    historical_baseline_manifest_sha256?: string;
    hardened_baseline_manifest_source_sha256?: string;
    hardened_baseline_manifest_sha256?: string;
    lifecycle_postcondition_manifest_sha256?: string;
    current_configuration_sha256?: string | null;
    current_runtime_operation_version?: string | null;
    recorded_expand_operation_version?: string | null;
  } | null = null;
  lifecycleTables: 'absent' | 'complete' | 'partial' = 'absent';
  operationCount = 0;
  ledgerRows: Array<{ id: string; checksum: string }> = [];

  async query<T = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<T>> {
    this.statements.push(sql.replace(/\s+/g, ' ').trim());
    this.bindings.push([...values]);
    if (
      this.snapshotTransactionFailure === 'begin' &&
      sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
    ) {
      throw new Error('postgres://snapshot:secret@db/commander begin-opaque-marker');
    }
    if (this.snapshotTransactionFailure === 'commit' && sql === 'COMMIT') {
      throw new Error('postgres://snapshot:secret@db/commander commit-opaque-marker');
    }
    if (sql.includes("to_regclass('public.commander_tenant_cutover_state')")) {
      return result<T>([
        this.lifecycleTables === 'absent'
          ? {
              state_table: null,
              operation_table: null,
              proof_table: null,
            }
          : this.lifecycleTables === 'partial'
            ? {
                state_table: 'commander_tenant_cutover_state',
                operation_table: null,
                proof_table: null,
              }
            : {
                state_table: 'commander_tenant_cutover_state',
                operation_table: 'commander_tenant_cutover_operations',
                proof_table: 'commander_tenant_cutover_rollout_proofs',
              },
      ] as T[]);
    }
    if (sql.includes("to_regclass('public.commander_kernel_migrations')")) {
      return result<T>([{ exists: this.ledgerRows.length > 0 } as T]);
    }
    if (sql.includes('SELECT state::text, state_version::text, pending_configuration_sha256')) {
      return result<T>(
        this.existingLifecycleState === null ? [] : ([this.existingLifecycleState] as T[]),
      );
    }
    if (sql.includes('count(*)::text AS operation_count')) {
      return result<T>([{ operation_count: String(this.operationCount) }] as T[]);
    }
    if (sql.includes('SELECT id, checksum') && sql.includes('commander_kernel_migrations')) {
      return result<T>(this.ledgerRows as T[]);
    }
    if (sql.includes('authority.oid::text AS authority_oid')) {
      return result<T>([
        {
          authority_oid: '10',
          authority_name: 'postgres',
          authority_superuser: true,
          bootstrap_oid: '10',
          bootstrap_name: 'postgres',
          bootstrap_superuser: true,
          catalog_version: '202307071',
        } as T,
      ]);
    }
    if (sql.includes('INSERT INTO public.commander_kernel_migrations')) {
      this.ledgerRows.push({ id: String(values[0]), checksum: String(values[1]) });
    }
    if (this.failDescriptor && sql.includes('CREATE TABLE public.commander_tenant_cutover_state')) {
      throw new Error('descriptor failed');
    }
    if (sql.includes('SELECT checksum FROM commander_kernel_migrations')) return result<T>([]);
    return result<T>();
  }

  release(): void {}
}

describe('Task 1 pinned lifecycle initializer manifests', () => {
  it('writes independent explicit adapter-ops and tenant-authority credentials with exact attributes', async () => {
    const client = new RecordingClient();
    await applyTask1LifecycleRoleCredentials(
      client,
      sixRoleCredentialEnv({
        COMMANDER_ADAPTER_OPS_DATABASE_URL:
          'postgres://commander_adapter_ops:adapter%20ops%20password@db/commander?sslmode=verify-full',
        COMMANDER_TENANT_AUTHORITY_DATABASE_URL:
          'postgres://commander_tenant_authority:tenant%2Fauthority%20password@db/commander?sslmode=verify-full',
      }),
    );

    assert.deepEqual(client.bindings.slice(0, 2), [
      ['adapter ops password'],
      ['tenant/authority password'],
    ]);
    const roleWriter = client.statements[2]!;
    for (const role of ['commander_adapter_ops', 'commander_tenant_authority']) {
      assert.match(roleWriter, new RegExp(`CREATE ROLE ${role}`, 'i'));
      assert.match(
        roleWriter,
        new RegExp(`ALTER ROLE ${role} LOGIN NOINHERIT CONNECTION LIMIT -1`, 'i'),
      );
    }
    assert.doesNotMatch(roleWriter, /NOSUPERUSER|NOREPLICATION|NOBYPASSRLS/);
    assert.doesNotMatch(roleWriter, /adapter ops password|tenant\/authority password/);
  });

  it('rejects reused or substituted lifecycle role credentials before role DDL', async () => {
    for (const env of [
      sixRoleCredentialEnv({
        COMMANDER_ADAPTER_OPS_DATABASE_URL:
          'postgres://commander_adapter_ops:same-password@db/commander?sslmode=verify-full',
        COMMANDER_TENANT_AUTHORITY_DATABASE_URL:
          'postgres://commander_tenant_authority:same-password@db/commander?sslmode=verify-full',
      }),
      sixRoleCredentialEnv({
        COMMANDER_ADAPTER_OPS_DATABASE_URL:
          'postgres://commander_worker:adapter-password@db/commander?sslmode=verify-full',
        COMMANDER_TENANT_AUTHORITY_DATABASE_URL:
          'postgres://commander_tenant_authority:tenant-password@db/commander?sslmode=verify-full',
      }),
    ]) {
      const client = new RecordingClient();
      await assert.rejects(
        () => applyTask1LifecycleRoleCredentials(client, env),
        /TASK1_LIFECYCLE_ROLE_CREDENTIAL_INVALID/,
      );
      assert.equal(client.statements.length, 0);
    }

    const inheritedReuse = new RecordingClient();
    await assert.doesNotReject(() =>
      applyTask1LifecycleRoleCredentials(
        inheritedReuse,
        sixRoleCredentialEnv({
          COMMANDER_APP_DATABASE_URL:
            'postgres://commander_app:owner-password@db/commander?sslmode=verify-full',
        }),
      ),
    );
  });

  it('loads bootstrap identity with the PostgreSQL session_user value expression', async () => {
    const client = new RecordingClient();
    const context = await loadTask1BootstrapContext(client as unknown as PoolClient);
    assert.equal(context.sessionUser, 'postgres');
    assert.equal(context.catalogVersion, '202307071');
    assert.match(client.statements[0]!, /authority\.rolname = session_user/i);
    assert.match(client.statements[0]!, /current_setting\('server_version_num'\)/i);
    assert.match(client.statements[0]!, /WHEN 16 THEN '202307071'/i);
    assert.doesNotMatch(client.statements[0]!, /pg_catalog\.session_user/i);
  });

  it('loads the bootstrap catalog contract without a superuser-only control function', async () => {
    const client = new RecordingClient();
    await loadTask1BootstrapContext(client as unknown as PoolClient);

    assert.doesNotMatch(client.statements[0]!, /pg_catalog\.pg_control_system\(\)/i);
    assert.match(client.statements[0]!, /current_setting\('server_version_num'\)/i);
  });

  it('classifies bootstrap authority failures without reflecting their detail', async () => {
    const client = new RecordingClient();
    await assert.rejects(
      () =>
        initializeTask1LifecycleBoundary({
          client,
          prepared,
          dependencies: {
            loadBootstrapContext: async () => {
              throw new Error('postgres://bootstrap:secret@db/commander private detail');
            },
          },
        }),
      (error: unknown) => {
        assert.equal(
          (error as { ownerStage?: unknown }).ownerStage,
          'bootstrap_context',
        );
        return true;
      },
    );
  });

  it('classifies candidate peer observation failures after bootstrap context succeeds', async () => {
    const client = new RecordingClient();
    await assert.rejects(
      () =>
        initializeTask1LifecycleBoundary({
          client,
          prepared,
          dependencies: {
            loadBootstrapContext: async () => ({
              sessionUser: 'postgres',
              authority: bootstrapIdentities.authority,
              bootstrapSuperuser: bootstrapIdentities.bootstrapSuperuser,
              catalogVersion: '202307071',
            }),
            observeCandidatePeers: async () => {
              throw new Error('candidate-peer-opaque-marker');
            },
          },
        }),
      (error: unknown) => {
        assert.equal(
          (error as { ownerStage?: unknown }).ownerStage,
          'lifecycle_candidate_peer_observation',
        );
        return true;
      },
    );
  });

  it('classifies a declared candidate peer binding mismatch after observation', async () => {
    const client = new RecordingClient();
    const declaredPeerInput = createDatabasePeerBindingInput({
      roles: roles.map((role) => ({ role, host: 'db.example', port: 5433 })),
      expectedServerSpkiSha256: 'f'.repeat(64),
      ca: { mountIdentity: 'database-ca', path: '/ca.crt', publicBytesSha256: '0'.repeat(64) },
    });
    const mismatchedPrepared = {
      ...prepared,
      businessConfiguration: {
        ...prepared.businessConfiguration,
        databasePeerBindingInput: declaredPeerInput,
      },
      configuration: {
        ...prepared.configuration,
        databasePeerBindingInput: declaredPeerInput,
      },
      configurationSha256: canonicalBootstrapSha256({
        ...prepared.configuration,
        databasePeerBindingInput: declaredPeerInput,
      }),
    };

    await assert.rejects(
      () =>
        initializeTask1LifecycleBoundary({
          client,
          prepared: mismatchedPrepared,
          dependencies: {
            loadBootstrapContext: async () => ({
              sessionUser: 'postgres',
              authority: bootstrapIdentities.authority,
              bootstrapSuperuser: bootstrapIdentities.bootstrapSuperuser,
              catalogVersion: '202307071',
            }),
            observeCandidatePeers: async () => ({ input: peerInput, binding: peerBinding }),
          },
        }),
      (error: unknown) => {
        assert.equal(
          (error as { ownerStage?: unknown }).ownerStage,
          'lifecycle_candidate_peer_validation',
        );
        return true;
      },
    );
  });

  it('classifies S0 collection failures after candidate validation without state mutation', async () => {
    const client = new RecordingClient();
    let candidateObserved = false;

    await assert.rejects(
      () =>
        initializeTask1LifecycleBoundary({
          client,
          prepared,
          dependencies: {
            loadBootstrapContext: async () => ({
              sessionUser: 'postgres',
              authority: bootstrapIdentities.authority,
              bootstrapSuperuser: bootstrapIdentities.bootstrapSuperuser,
              catalogVersion: '202307071',
            }),
            observeCandidatePeers: async () => {
              candidateObserved = true;
              return { input: peerInput, binding: peerBinding };
            },
            collectInventory: async () => {
              assert.equal(candidateObserved, true);
              throw Object.assign(new Error('prebootstrap-s0-opaque-marker'), {
                catalogStep: 'functions',
              });
            },
          },
        }),
      (error: unknown) => {
        assert.equal(
          (error as { ownerStage?: unknown }).ownerStage,
          'lifecycle_prebootstrap_snapshot',
        );
        assert.equal((error as { snapshot?: unknown }).snapshot, 's0');
        assert.equal((error as { catalogStep?: unknown }).catalogStep, 'functions');
        return true;
      },
    );

    assert.equal(candidateObserved, true);
    assert.equal(
      client.statements.some((statement) => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(statement)),
      false,
    );
  });

  for (const snapshotTransaction of ['begin', 'commit'] as const) {
    it(`classifies the S0 ${snapshotTransaction} transaction boundary without state mutation`, async () => {
      const client = new RecordingClient();
      client.snapshotTransactionFailure = snapshotTransaction;

      await assert.rejects(
        () =>
          initializeTask1LifecycleBoundary({
            client,
            prepared,
            dependencies: {
              loadBootstrapContext: async () => ({
                sessionUser: 'postgres',
                authority: bootstrapIdentities.authority,
                bootstrapSuperuser: bootstrapIdentities.bootstrapSuperuser,
                catalogVersion: '202307071',
              }),
              observeCandidatePeers: async () => ({ input: peerInput, binding: peerBinding }),
              collectInventory: async () => inventory(),
            },
          }),
        (error: unknown) => {
          assert.equal(
            (error as { ownerStage?: unknown }).ownerStage,
            'lifecycle_prebootstrap_snapshot',
          );
          assert.equal((error as { snapshot?: unknown }).snapshot, 's0');
          assert.equal(
            (error as { snapshotTransaction?: unknown }).snapshotTransaction,
            snapshotTransaction,
          );
          return true;
        },
      );

      assert.equal(
        client.statements.some((statement) => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(statement)),
        false,
      );
    });
  }

  it('derives bundled bootstrap authority in memory from the sealed owner peer', () => {
    assert.equal(
      resolveTask1BootstrapAuthorityUrl({
        COMMANDER_OWNER_DATABASE_URL:
          'postgres://commander_owner:owner@commander-postgres:5432/commander?sslmode=verify-full',
        COMMANDER_BUNDLED_POSTGRES_BOOTSTRAP: '1',
        COMMANDER_BUNDLED_POSTGRES_USER: 'postgres',
        COMMANDER_BUNDLED_POSTGRES_PASSWORD: 'root / password',
      }),
      'postgres://postgres:root%20%2F%20password@commander-postgres:5432/commander?sslmode=verify-full',
    );
    assert.throws(
      () =>
        resolveTask1BootstrapAuthorityUrl({
          COMMANDER_OWNER_DATABASE_URL:
            'postgres://commander_owner:owner@commander-postgres:5432/commander?sslmode=verify-full',
          COMMANDER_BUNDLED_POSTGRES_BOOTSTRAP: '1',
          COMMANDER_BUNDLED_POSTGRES_USER: 'commander_root',
          COMMANDER_BUNDLED_POSTGRES_PASSWORD: 'root-password',
        }),
      /TASK1_LIFECYCLE_BOOTSTRAP_AUTHORITY_INVALID/,
    );
    assert.throws(
      () => resolveTask1BootstrapAuthorityUrl({}),
      /TASK1_LIFECYCLE_COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL_REQUIRED/,
    );
  });

  it('ships literal reviewed manifest source and golden hashes that fail closed on tamper', () => {
    assert.match(PINNED_TASK1_LIFECYCLE_MANIFESTS.historical.sourceSha256, /^[0-9a-f]{64}$/);
    assert.match(PINNED_TASK1_LIFECYCLE_MANIFESTS.hardened.sourceSha256, /^[0-9a-f]{64}$/);
    assert.match(PINNED_TASK1_LIFECYCLE_MANIFESTS.lifecycle.sha256, /^[0-9a-f]{64}$/);
    assert.doesNotThrow(() => assertPinnedTask1LifecycleManifests());
    assert.throws(
      () =>
        assertPinnedTask1LifecycleManifests({
          ...PINNED_TASK1_LIFECYCLE_MANIFESTS,
          lifecycle: {
            ...PINNED_TASK1_LIFECYCLE_MANIFESTS.lifecycle,
            source: '{"format":"tampered"}',
          },
        }),
      /MIGRATION_LEDGER_TAMPERED/,
    );
  });

  it('creates the inert fresh E1 and E2 pending boundaries before operation append', async () => {
    for (const envelope of ['E1', 'E2'] as const) {
      const client = new RecordingClient();
      let collection = 0;
      const identities = { ...bootstrapIdentities, envelope };
      const fresh = inventory(identities);
      await initializeTask1LifecycleBoundary({
        client,
        prepared,
        dependencies: {
          collectInventory: async () => {
            collection += 1;
            return fresh;
          },
          collectLockedInventory: async () => fresh,
          verifyLockedCatalogState: () => undefined,
          applyCatalogHardening: async () => undefined,
          loadBootstrapContext: async () => ({
            sessionUser: 'postgres',
            authority: identities.authority,
            bootstrapSuperuser: identities.bootstrapSuperuser,
          }),
          observeCandidatePeers: async () => ({ input: peerInput, binding: peerBinding }),
          observePeers: async () => ({ input: peerInput, binding: peerBinding }),
          proofKeySha256: () => '9'.repeat(64),
          applyRoleCredentials: async (roleClient) => {
            await roleClient.query(`ROLE_CREDENTIALS_${envelope}`);
          },
          instantiateManifestSha256: (kind) =>
            kind === 'historical' ? '7'.repeat(64) : '8'.repeat(64),
        },
      });
      assert.equal(collection, 2);
      assert.equal(
        client.statements.filter((sql) => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
          .length,
        2,
        'S0 and S1 must use separate repeatable-read read-only transactions',
      );
      assert.equal(
        client.statements.filter((sql) =>
          sql.startsWith('INSERT INTO public.commander_tenant_cutover_operations'),
        ).length,
        0,
      );
      assert.equal(
        client.statements.filter((sql) =>
          sql.startsWith('INSERT INTO public.commander_tenant_cutover_state'),
        ).length,
        1,
      );
      assert.equal(
        client.statements.filter((sql) => sql.includes('CREATE ROLE commander_tenant_authority'))
          .length,
        0,
      );
      assert.ok(client.statements.includes(`ROLE_CREDENTIALS_${envelope}`));
    }
  });

  it('reuses the exact baseline ledger bootstrapped before fresh lifecycle initialization', async () => {
    const client = new RecordingClient();
    client.ledgerRows = KERNEL_TASK1_BASELINE_MIGRATIONS.map(({ id, checksum }) => ({
      id,
      checksum,
    }));
    await runTask1LifecycleDescriptorStateTransaction(
      client,
      async () => undefined,
      'fresh',
      undefined,
      testCatalogTransaction(),
    );
    assert.equal(
      client.bindings.filter(
        (values) =>
          typeof values[0] === 'string' &&
          KERNEL_TASK1_BASELINE_MIGRATIONS.some(({ id }) => values[0] === id),
      ).length,
      0,
    );
  });

  it('creates a populated legacy pending boundary with explicit role enablement and rejects a forged ledger first', async () => {
    const ledger = [{ id: '2026-07-21.16.schema', checksum: 'forged' }];
    const forged = new RecordingClient();
    let forgedCollections = 0;
    await assert.rejects(
      () =>
        initializeTask1LifecycleBoundary({
          client: forged,
          prepared: {
            ...prepared,
            command: 'expand',
            platformBinding: { ...prepared.platformBinding, phase: 'expand' },
          },
          dependencies: {
            collectInventory: async () => {
              forgedCollections += 1;
              return inventory(null, ledger, [true]);
            },
            observeCandidatePeers: async () => ({ input: peerInput, binding: peerBinding }),
            observePeers: async () => ({ input: peerInput, binding: peerBinding }),
            proofKeySha256: () => '9'.repeat(64),
            instantiateManifestSha256: (kind) =>
              kind === 'historical' ? '7'.repeat(64) : '8'.repeat(64),
          },
        }),
      /MIGRATION_LEDGER_TAMPERED/,
    );
    assert.equal(forgedCollections, 2);
    assert.equal(
      forged.statements.some((sql) =>
        /CREATE ROLE|CREATE TABLE public\.commander_tenant_cutover_state/i.test(sql),
      ),
      false,
    );

    const client = new RecordingClient();
    const legacyPrepared = {
      ...prepared,
      command: 'expand' as const,
      platformBinding: { ...prepared.platformBinding, phase: 'expand' as const },
    };
    const validLedger = KERNEL_TASK1_BASELINE_MIGRATIONS.map(({ id, checksum }) => ({
      id,
      checksum,
    }));
    const s0 = inventory(null, validLedger, [true]);
    const s1 = inventory(null, validLedger, [false]);
    let collection = 0;
    client.ledgerRows = validLedger;
    await initializeTask1LifecycleBoundary({
      client,
      prepared: legacyPrepared,
      dependencies: {
        collectInventory: async () => (collection++ === 0 ? s0 : s1),
        collectLockedInventory: async () => s1,
        verifyLockedCatalogState: () => undefined,
        applyCatalogHardening: async () => undefined,
        applyRoleCredentials: async (roleClient) => {
          await roleClient.query('ROLE_CREDENTIALS_LEGACY');
        },
        observeCandidatePeers: async () => ({ input: peerInput, binding: peerBinding }),
        observePeers: async () => ({ input: peerInput, binding: peerBinding }),
        proofKeySha256: () => '9'.repeat(64),
        instantiateManifestSha256: (kind) =>
          kind === 'historical' ? '7'.repeat(64) : '8'.repeat(64),
      },
    });
    assert.ok(client.statements.includes('ROLE_CREDENTIALS_LEGACY'));
    assert.equal(
      client.statements.filter((sql) =>
        sql.startsWith('INSERT INTO public.commander_tenant_cutover_state'),
      ).length,
      1,
    );
  });

  it('rejects catalog postcondition tamper before lifecycle mutation', async () => {
    const client = new RecordingClient();
    await assert.rejects(
      () =>
        initializeTask1LifecycleBoundary({
          client,
          prepared,
          dependencies: {
            collectInventory: async () => inventory(),
            verifyCatalogBaseline: () => {
              throw new Error('MIGRATION_LEDGER_TAMPERED');
            },
            loadBootstrapContext: async () => ({
              sessionUser: 'postgres',
              authority: bootstrapIdentities.authority,
              bootstrapSuperuser: bootstrapIdentities.bootstrapSuperuser,
            }),
            observeCandidatePeers: async () => ({ input: peerInput, binding: peerBinding }),
            observePeers: async () => ({ input: peerInput, binding: peerBinding }),
            proofKeySha256: () => '9'.repeat(64),
          },
        }),
      /MIGRATION_LEDGER_TAMPERED/,
    );
    assert.equal(
      client.statements.some((sql) =>
        /CREATE TABLE public\.commander_tenant_cutover_state|INSERT INTO public\.commander_tenant_cutover_state/i.test(
          sql,
        ),
      ),
      false,
    );
  });

  it('classifies fresh, populated legacy, and exact pending retries without trusting a caller state', () => {
    assert.deepEqual(
      planTask1LifecycleInitialization({
        command: 'install_enforce',
        comparisonKind: 'fresh-byte-equal',
        existing: null,
      }),
      { action: 'initialize', state: 'fresh_pending' },
    );
    assert.deepEqual(
      planTask1LifecycleInitialization({
        command: 'expand',
        comparisonKind: 'legacy-except-product-has-rows',
        existing: null,
      }),
      { action: 'initialize', state: 'legacy_pending' },
    );
    assert.deepEqual(
      planTask1LifecycleInitialization({
        command: 'install_enforce',
        comparisonKind: 'fresh-byte-equal',
        existing: { state: 'fresh_pending', pendingConfigurationSha256: 'a'.repeat(64) },
        configurationSha256: 'a'.repeat(64),
      }),
      { action: 'retry', state: 'fresh_pending' },
    );
    assert.throws(
      () =>
        planTask1LifecycleInitialization({
          command: 'install_enforce',
          comparisonKind: 'fresh-byte-equal',
          existing: { state: 'fresh_pending', pendingConfigurationSha256: 'a'.repeat(64) },
          configurationSha256: 'b'.repeat(64),
        }),
      /TENANT_CUTOVER_EXACT_RETRY_REQUIRED/,
    );
  });

  it('rolls descriptor installation and lifecycle state work back as one transaction', async () => {
    const client = new RecordingClient();
    await runTask1LifecycleDescriptorStateTransaction(
      client,
      async () => {
        await client.query('INSERT INTO public.commander_tenant_cutover_state VALUES (true)');
      },
      'fresh',
      undefined,
      testCatalogTransaction(),
    );
    assert.equal(client.statements.filter((statement) => statement === 'BEGIN').length, 1);
    assert.equal(client.statements.filter((statement) => statement === 'COMMIT').length, 1);
    assert.ok(
      client.statements.some((statement) =>
        statement.includes('CREATE TABLE public.commander_tenant_cutover_state'),
      ),
    );

    const failing = new RecordingClient();
    failing.failDescriptor = true;
    await assert.rejects(
      () =>
        runTask1LifecycleDescriptorStateTransaction(
          failing,
          async () => undefined,
          'fresh',
          undefined,
          testCatalogTransaction(),
        ),
      /descriptor failed/,
    );
    assert.ok(failing.statements.includes('ROLLBACK'));
    assert.equal(failing.statements.includes('COMMIT'), false);
  });

  it('verifies locked catalog states 1, 2, and 3 around the real hardening boundary', async () => {
    const client = new RecordingClient();
    const events: string[] = [];
    await runTask1LifecycleDescriptorStateTransaction(
      client,
      async () => {
        events.push('insert-state');
      },
      'fresh',
      undefined,
      {
        origin: { classification: 'E2', bootstrapIdentities },
        databasePeerBinding: peerBinding,
        collectInventory: async () => {
          events.push('collect');
          return inventory();
        },
        verifyState: ({ stage }) => {
          events.push(`verify-${stage}`);
        },
        applyHardening: async () => {
          events.push('harden');
        },
      },
    );

    assert.deepEqual(events, [
      'collect',
      'verify-historical',
      'harden',
      'collect',
      'verify-hardened',
      'collect',
      'verify-lifecycle',
      'insert-state',
    ]);
    const lifecycleDescriptor = client.statements.findIndex((statement) =>
      statement.includes('CREATE TABLE public.commander_tenant_cutover_state'),
    );
    const commit = client.statements.indexOf('COMMIT');
    assert.ok(lifecycleDescriptor > 0);
    assert.ok(commit > lifecycleDescriptor);
  });

  it('rolls back without lifecycle mutation when locked state 2 is tampered', async () => {
    const client = new RecordingClient();
    let inserted = false;
    await assert.rejects(
      () =>
        runTask1LifecycleDescriptorStateTransaction(
          client,
          async () => {
            inserted = true;
          },
          'fresh',
          async () => {
            await client.query('ROLE_CREDENTIALS_TRANSACTIONAL');
          },
          {
            origin: { classification: 'E2', bootstrapIdentities },
            databasePeerBinding: peerBinding,
            collectInventory: async () => inventory(),
            verifyState: ({ stage }) => {
              if (stage === 'hardened') throw new Error('MIGRATION_LEDGER_TAMPERED');
            },
            applyHardening: async () => undefined,
          },
        ),
      /MIGRATION_LEDGER_TAMPERED/,
    );
    assert.equal(inserted, false);
    assert.ok(client.statements.includes('ROLE_CREDENTIALS_TRANSACTIONAL'));
    assert.ok(
      client.statements.indexOf('BEGIN') <
        client.statements.indexOf('ROLE_CREDENTIALS_TRANSACTIONAL'),
    );
    assert.ok(
      client.statements.indexOf('ROLE_CREDENTIALS_TRANSACTIONAL') <
        client.statements.indexOf('ROLLBACK'),
    );
    assert.equal(
      client.statements.some((statement) =>
        statement.includes('CREATE TABLE public.commander_tenant_cutover_state'),
      ),
      false,
    );
    assert.ok(client.statements.includes('ROLLBACK'));
  });

  it('loads an existing pending row and rejects a non-exact initializer retry', async () => {
    const client = new RecordingClient();
    client.lifecycleTables = 'complete';
    client.existingLifecycleState = {
      state: 'fresh_pending',
      pending_configuration_sha256: 'a'.repeat(64),
    };

    await assert.rejects(
      () => initializeTask1LifecycleBoundary({ client, prepared }),
      /TENANT_CUTOVER_EXACT_RETRY_REQUIRED/,
    );
    assert.ok(
      client.statements.some((statement) =>
        statement.includes('FROM public.commander_tenant_cutover_state'),
      ),
    );
  });

  it('rejects an existing pending row whose platform binding differs from the prepared request', async () => {
    const client = new RecordingClient();
    client.lifecycleTables = 'complete';
    client.existingLifecycleState = {
      state: 'fresh_pending',
      pending_configuration_sha256: prepared.configurationSha256,
      platform_kind: 'compose',
      platform_binding_sha256: 'b'.repeat(64),
    };
    await assert.rejects(
      () => initializeTask1LifecycleBoundary({ client, prepared }),
      /TENANT_CUTOVER_EXACT_RETRY_REQUIRED/,
    );
  });

  it('accepts an exact pending boundary with no operation and retries without reclassifying origin', async () => {
    const client = new RecordingClient();
    client.lifecycleTables = 'complete';
    const snapshots = createPrebootstrapSnapshots(inventory(), inventory());
    const origin = createOriginBinding(snapshots);
    client.existingLifecycleState = {
      state: 'fresh_pending',
      state_version: '0',
      pending_configuration_sha256: prepared.configurationSha256,
      platform_kind: 'compose',
      platform_binding_sha256: canonicalBootstrapSha256(platformBinding),
      prebootstrap_snapshots_jcs: canonicalBootstrapJson(snapshots),
      prebootstrap_snapshots_sha256: canonicalBootstrapSha256(snapshots),
      bootstrap_identities_jcs: canonicalBootstrapJson(bootstrapIdentities),
      origin_binding_jcs: canonicalBootstrapJson(origin),
      origin_binding_sha256: canonicalBootstrapSha256(origin),
      database_peer_binding_jcs: canonicalBootstrapJson(peerBinding),
      database_peer_binding_sha256: canonicalBootstrapSha256(peerBinding),
      proof_key_sha256: '9'.repeat(64),
      historical_baseline_manifest_source_sha256:
        PINNED_TASK1_LIFECYCLE_MANIFESTS.historical.sourceSha256,
      historical_baseline_manifest_sha256: '7'.repeat(64),
      hardened_baseline_manifest_source_sha256:
        PINNED_TASK1_LIFECYCLE_MANIFESTS.hardened.sourceSha256,
      hardened_baseline_manifest_sha256: '8'.repeat(64),
      lifecycle_postcondition_manifest_sha256:
        PINNED_TASK1_LIFECYCLE_MANIFESTS.lifecycle.sourceSha256,
      current_configuration_sha256: null,
      current_runtime_operation_version: null,
      recorded_expand_operation_version: null,
    };
    client.operationCount = 0;
    client.ledgerRows = [
      ...KERNEL_TASK1_BASELINE_MIGRATIONS,
      KERNEL_TASK1_CLOSURE_MIGRATIONS[0]!,
    ].map(({ id, checksum }) => ({ id, checksum }));
    let inventoryCollections = 0;
    let bootstrapChecks = 0;
    let peerChecks = 0;

    await initializeTask1LifecycleBoundary({
      client,
      prepared,
      dependencies: {
        collectInventory: async () => {
          inventoryCollections += 1;
          return inventory();
        },
        loadBootstrapContext: async () => {
          bootstrapChecks += 1;
          return {
            sessionUser: 'postgres',
            authority: bootstrapIdentities.authority,
            bootstrapSuperuser: bootstrapIdentities.bootstrapSuperuser,
          };
        },
        observeCandidatePeers: async () => ({ input: peerInput, binding: peerBinding }),
        observePeers: async () => {
          peerChecks += 1;
          return { input: peerInput, binding: peerBinding };
        },
        proofKeySha256: () => '9'.repeat(64),
        instantiateManifestSha256: (_kind, _identities) =>
          _kind === 'historical' ? '7'.repeat(64) : '8'.repeat(64),
      },
    });
    assert.equal(inventoryCollections, 0, 'pending retry must not recollect S0/S1');
    assert.equal(bootstrapChecks, 1);
    assert.equal(peerChecks, 1);
  });

  it('rejects lifecycle tables without the sole state row and partial lifecycle tables', async () => {
    const missingRow = new RecordingClient();
    missingRow.lifecycleTables = 'complete';
    await assert.rejects(
      () => initializeTask1LifecycleBoundary({ client: missingRow, prepared }),
      /MIGRATION_LEDGER_TAMPERED/,
    );
    const partial = new RecordingClient();
    partial.lifecycleTables = 'partial';
    await assert.rejects(
      () => initializeTask1LifecycleBoundary({ client: partial, prepared }),
      /TENANT_CUTOVER_STATE_INVALID/,
    );
  });
});
