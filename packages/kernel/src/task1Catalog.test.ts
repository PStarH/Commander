import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { SqlClient, SqlQueryResult } from './postgres.js';
import {
  canonicalBootstrapJson,
  createDatabasePeerBinding,
  type DatabasePeerBindingV1,
  type PrebootstrapInventoryV1,
} from './canonicalBootstrap.js';
import {
  TASK1_CATALOG_HARDENING_SQL,
  TASK1_CATALOG_QUERIES,
  applyTask1CatalogHardening,
  classifyTask1CatalogOrigin,
  collectTask1LockedCatalogInventory,
  collectTask1PrebootstrapInventory,
  exportTask1CatalogPostcondition,
  verifyTask1CatalogPostcondition,
  verifyTask1LockedCatalogState,
  type Task1CatalogBootstrapContext,
} from './task1Catalog.js';

const roleNames = [
  'commander_adapter_ops',
  'commander_app',
  'commander_owner',
  'commander_scheduler',
  'commander_tenant_authority',
  'commander_worker',
] as const;

const bootstrap: Task1CatalogBootstrapContext = {
  sessionUser: 'postgres',
  authority: { oid: '10', name: 'postgres', superuser: true, commanderNamed: false },
  bootstrapSuperuser: { oid: '10', name: 'postgres', superuser: true, commanderNamed: false },
};

const databaseIdentitySentinels = {
  oid: 'task1_database_identity/v1:oid',
  name: 'task1_database_identity/v1:name',
} as const;

const bootstrapIdentitySentinels = {
  authorityOid: 'task1_bootstrap_identity/v1:authority-oid',
  authorityName: 'task1_bootstrap_identity/v1:authority-name',
  bootstrapSuperuserOid: 'task1_bootstrap_identity/v1:bootstrap-superuser-oid',
  bootstrapSuperuserName: 'task1_bootstrap_identity/v1:bootstrap-superuser-name',
} as const;

const peerRoles = [
  'adapter-ops',
  'app',
  'owner',
  'scheduler',
  'tenant-authority',
  'worker',
] as const;

function databasePeerBinding(oid = '16384', name = 'commander'): DatabasePeerBindingV1 {
  return createDatabasePeerBinding({
    roles: peerRoles.map((peerRole) => ({
      role: peerRole,
      host: 'database.example',
      port: 5432,
      tlsServerSans: { dns: ['database.example'], ip: [] },
      serverSpkiSha256: 'f'.repeat(64),
      databaseOid: oid,
      databaseName: name,
    })),
  });
}

function manifestSource(file: string): string {
  return readFileSync(new URL(file, import.meta.url), 'utf8').trimEnd();
}

function goldenInventory(
  file: string,
  classification: 'E1' | 'E2' | 'legacy',
  databaseIdentity = { oid: '16384', name: 'commander' },
): PrebootstrapInventoryV1 {
  const source = JSON.parse(manifestSource(file)) as {
    branches?: Record<string, { manifest?: { catalog?: PrebootstrapInventoryV1 } }>;
  };
  const catalog = structuredClone(source.branches?.[classification]?.manifest?.catalog);
  assert.ok(catalog, `${file}:${classification} must contain golden catalog bytes`);
  assert.deepEqual(catalog.databaseIdentity, databaseIdentitySentinels);
  catalog.databaseIdentity = databaseIdentity;
  catalog.databaseAcl = catalog.databaseAcl.map((entry) => {
    assert.equal(entry.objectIdentity, databaseIdentitySentinels.name);
    return { ...entry, objectIdentity: databaseIdentity.name };
  });
  catalog.roleSettings = catalog.roleSettings.map((entry) => ({
    ...entry,
    database:
      entry.database === databaseIdentitySentinels.name ? databaseIdentity.name : entry.database,
  }));
  if (classification === 'legacy') {
    assert.equal(catalog.bootstrapIdentities, null);
  } else {
    assert.deepEqual(catalog.bootstrapIdentities, {
      format: 'bootstrap_identities/v1',
      envelope: classification,
      authority: {
        oid: bootstrapIdentitySentinels.authorityOid,
        name: bootstrapIdentitySentinels.authorityName,
        superuser: true,
        commanderNamed: false,
      },
      bootstrapSuperuser: {
        oid: bootstrapIdentitySentinels.bootstrapSuperuserOid,
        name: bootstrapIdentitySentinels.bootstrapSuperuserName,
        superuser: true,
        commanderNamed: false,
      },
    });
    catalog.bootstrapIdentities = {
      format: 'bootstrap_identities/v1',
      envelope: classification,
      authority: bootstrap.authority,
      bootstrapSuperuser: bootstrap.bootstrapSuperuser,
    };
    catalog.memberships = catalog.memberships.map((entry) => ({
      ...entry,
      grantor:
        entry.grantor === bootstrapIdentitySentinels.authorityName
          ? bootstrap.authority.name
          : entry.grantor === bootstrapIdentitySentinels.bootstrapSuperuserName
            ? bootstrap.bootstrapSuperuser.name
            : entry.grantor,
    }));
  }
  catalog.productHasRows = catalog.productSources.map((relation) => ({ relation, hasRows: false }));
  return catalog;
}

function role(name: (typeof roleNames)[number]) {
  const owner = name === 'commander_owner';
  const scheduler = name === 'commander_scheduler';
  return {
    name,
    superuser: false,
    inherit: owner,
    createRole: owner,
    createDatabase: false,
    canLogin: true,
    replication: false,
    bypassRls: owner || scheduler,
    connectionLimit: -1,
    validUntil: null,
    roleConfig:
      name === 'commander_app'
        ? [
            { name: 'idle_in_transaction_session_timeout', value: '10s' },
            { name: 'statement_timeout', value: '55s' },
          ]
        : [],
  };
}

function membership(name: Exclude<(typeof roleNames)[number], 'commander_owner'>) {
  return {
    role: name,
    member: 'commander_owner',
    grantor: 'postgres',
    adminOption: true,
    inheritOption: false,
    setOption: true,
  };
}

class CatalogClient implements SqlClient {
  readonly queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  released = false;
  failMarker?: string;

  constructor(private readonly overrides: Record<string, unknown[]> = {}) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<T>> {
    this.queries.push({ sql, values });
    const marker = /task1-catalog:([a-z-]+)/.exec(sql)?.[1];
    if (marker && marker === this.failMarker) throw new Error('catalog failed');
    if (!marker) return { rows: [], rowCount: 0 };
    const defaults: Record<string, unknown[]> = {
      identity: [
        {
          postgres_version: '16.14',
          catalog_version: '202307071',
          database_oid: '16384',
          database_name: 'commander',
          ledger_exists: false,
        },
      ],
      ledger: [],
      namespaces: [],
      relations: [],
      functions: [],
      types: [],
      extensions: [],
      policies: [],
      triggers: [],
      'product-has-rows': [{ has_rows: false }],
      roles: roleNames.map(role),
      memberships: roleNames
        .filter((name) => name !== 'commander_owner')
        .map((name) => membership(name)),
      'role-settings': [
        {
          database: '*',
          role: 'commander_app',
          settings: [
            { name: 'idle_in_transaction_session_timeout', value: '10s' },
            { name: 'statement_timeout', value: '55s' },
          ],
        },
      ],
      'database-acl': [],
      'schema-acls': [],
      'default-acls': [],
    };
    const rows = this.overrides[marker] ?? defaults[marker] ?? [];
    return { rows: rows as T[], rowCount: rows.length };
  }

  release(): void {
    this.released = true;
  }
}

describe('Task 1 PostgreSQL catalog collector', () => {
  it('ships closed state-1, state-2, and state-3 semantic catalog source contracts', () => {
    const manifestFiles = [
      ['task1HistoricalBaselineManifestSource.v1.json', 'historical_baseline_manifest_source/v1'],
      ['task1HardenedBaselineManifestSource.v1.json', 'hardened_baseline_manifest_source/v1'],
      ['task1LifecyclePostconditionManifest.v1.json', 'lifecycle_postcondition_manifest/v1'],
    ] as const;

    for (const [file, format] of manifestFiles) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8').trimEnd();
      const parsed = JSON.parse(source) as {
        catalogProjection?: { format?: string; rowFields?: Record<string, string[]> };
        normalizationSchema?: {
          format?: string;
          databaseIdentity?: { oid?: string; name?: string };
          paths?: string[];
        };
        descriptorSet?: unknown[];
        format?: string;
        branches?: Record<
          string,
          {
            classification?: string;
            manifest?: {
              authorityClassifierManifest?: unknown;
              authorityClassifierManifestSha256?: string;
              catalog?: Record<string, unknown>;
              catalogProjection?: string;
              descriptorSet?: unknown[];
            };
          }
        >;
      };
      assert.equal(parsed.format, format);
      assert.deepEqual(Object.keys(parsed.branches ?? {}).sort(), ['E1', 'E2', 'legacy']);
      for (const classification of ['E1', 'E2', 'legacy']) {
        const branch = parsed.branches?.[classification];
        assert.equal(branch?.classification, classification);
        assert.ok(
          branch?.manifest,
          `${file}:${classification} must contain a real golden manifest`,
        );
        assert.ok(branch.manifest.authorityClassifierManifest);
        assert.match(branch.manifest.authorityClassifierManifestSha256 ?? '', /^[0-9a-f]{64}$/);
        assert.equal(branch.manifest.catalogProjection, 'task1_semantic_catalog_projection/v1');
        assert.deepEqual(Object.keys(branch.manifest.catalog ?? {}).sort(), [
          'bootstrapIdentities',
          'catalogVersion',
          'databaseAcl',
          'databaseIdentity',
          'defaultAcls',
          'extensions',
          'format',
          'functions',
          'ledger',
          'memberships',
          'namespaces',
          'policies',
          'postgresVersion',
          'productSources',
          'relations',
          'roleSettings',
          'roles',
          'schemaAcls',
          'triggers',
          'types',
        ]);
        assert.deepEqual(branch.manifest.catalog?.databaseIdentity, databaseIdentitySentinels);
      }
      assert.ok(Array.isArray(parsed.descriptorSet));
      assert.ok(parsed.descriptorSet.length > 0);
      assert.equal(parsed.catalogProjection?.format, 'task1_semantic_catalog_projection/v1');
      assert.deepEqual(Object.keys(parsed.catalogProjection?.rowFields ?? {}).sort(), [
        'bootstrapIdentities',
        'databaseAcl',
        'databaseIdentity',
        'defaultAcls',
        'extensions',
        'functions',
        'ledger',
        'memberships',
        'namespaces',
        'policies',
        'relations',
        'roleSettings',
        'roles',
        'schemaAcls',
        'triggers',
        'types',
      ]);
      assert.deepEqual(parsed.normalizationSchema, {
        format: 'task1_catalog_normalization/v1',
        databaseIdentity: databaseIdentitySentinels,
        paths: [
          'databaseIdentity.oid',
          'databaseIdentity.name',
          'databaseAcl[*].objectIdentity',
          'roleSettings[*].database',
        ],
      });
    }
  });

  it('collects one deterministic read-only inventory and classifies exact E2', async () => {
    const client = new CatalogClient();
    const inventory = await collectTask1PrebootstrapInventory(client, bootstrap);
    assert.equal(inventory.format, 'prebootstrap_inventory/v1');
    assert.deepEqual(Object.keys(inventory), [
      'format',
      'postgresVersion',
      'catalogVersion',
      'databaseIdentity',
      'ledger',
      'namespaces',
      'relations',
      'functions',
      'types',
      'extensions',
      'policies',
      'triggers',
      'productSources',
      'productHasRows',
      'roles',
      'memberships',
      'roleSettings',
      'databaseAcl',
      'schemaAcls',
      'defaultAcls',
      'bootstrapIdentities',
    ]);
    assert.equal(classifyTask1CatalogOrigin(inventory, bootstrap).kind, 'E2');
    assert.deepEqual(inventory.bootstrapIdentities, {
      format: 'bootstrap_identities/v1',
      envelope: 'E2',
      authority: bootstrap.authority,
      bootstrapSuperuser: bootstrap.bootstrapSuperuser,
    });
    assert.equal(client.queries[0]?.sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(client.queries[1]?.sql, 'SET LOCAL search_path = pg_catalog');
    assert.equal(client.queries.at(-1)?.sql, 'COMMIT');
    assert.ok(client.queries.every(({ values }) => values.length === 0));
  });

  it('classifies fresh E2 with the expected global commander_app role settings', async () => {
    const client = new CatalogClient({
      'role-settings': [
        {
          database: '*',
          role: 'commander_app',
          settings: [
            { name: 'idle_in_transaction_session_timeout', value: '10s' },
            { name: 'statement_timeout', value: '55s' },
          ],
        },
      ],
    });

    const inventory = await collectTask1PrebootstrapInventory(client, bootstrap);

    assert.equal(classifyTask1CatalogOrigin(inventory, bootstrap).kind, 'E2');
  });

  it('does not commit a read-only snapshot owned by the lifecycle initializer', async () => {
    const client = new CatalogClient();
    await collectTask1PrebootstrapInventory(client, bootstrap, { transaction: 'caller' });
    assert.equal(client.queries[0]?.sql, 'SET LOCAL search_path = pg_catalog');
    assert.doesNotMatch(
      client.queries.map(({ sql }) => sql).join('\n'),
      /^(?:BEGIN|COMMIT|ROLLBACK)$/m,
    );
  });

  it('collects a locked state without reclassifying the sealed E2 origin as legacy', async () => {
    const client = new CatalogClient({
      relations: [{ schema: 'public', name: 'commander_runs', kind: 'r' }],
      'product-has-rows': [{ has_rows: false }],
    });
    const observed = await collectTask1LockedCatalogInventory(client, {
      classification: 'E2',
      bootstrapIdentities: {
        format: 'bootstrap_identities/v1',
        envelope: 'E2',
        authority: bootstrap.authority,
        bootstrapSuperuser: bootstrap.bootstrapSuperuser,
      },
    });
    assert.equal(observed.bootstrapIdentities?.envelope, 'E2');
    assert.equal(client.queries[0]?.sql, 'SET LOCAL search_path = pg_catalog');
    assert.doesNotMatch(
      client.queries.map(({ sql }) => sql).join('\n'),
      /^(?:BEGIN|COMMIT|ROLLBACK)$/m,
    );
  });

  it('contains the required semantic deparsers and fixed Commander predicate', () => {
    const sql = Object.values(TASK1_CATALOG_QUERIES).join('\n');
    assert.match(sql, /substr\([^)]*, 1, 10\) COLLATE "C" = 'commander_'/i);
    assert.match(sql, /pg_get_expr\([^)]*, false\)/i);
    assert.match(sql, /pg_get_constraintdef\([^)]*, false\)/i);
    assert.match(sql, /pg_get_indexdef\([^)]*, 0, false\)/i);
    assert.match(sql, /pg_get_functiondef/i);
    assert.match(sql, /aclexplode/i);
    assert.match(TASK1_CATALOG_QUERIES.identity, /server_version_num/);
    assert.doesNotMatch(TASK1_CATALOG_QUERIES.identity, /server_version'\)/);
    assert.match(TASK1_CATALOG_QUERIES.relations, /relation\.relacl/i);
    assert.match(TASK1_CATALOG_QUERIES.functions, /procedure\.proacl/i);
    assert.match(TASK1_CATALOG_QUERIES.types, /type\.typacl/i);
    assert.doesNotMatch(sql, /rolpassword/i);
  });

  it('fails closed on one role attribute or grant-provenance substitution', async () => {
    for (const overrides of [
      {
        roles: roleNames
          .map(role)
          .map((value) =>
            value.name === 'commander_worker' ? { ...value, bypassRls: true } : value,
          ),
      },
      {
        memberships: roleNames
          .filter((name) => name !== 'commander_owner')
          .map((name) =>
            name === 'commander_worker'
              ? { ...membership(name), setOption: false }
              : membership(name),
          ),
      },
    ] as Array<Record<string, unknown[]>>) {
      const client = new CatalogClient(overrides);
      await assert.rejects(
        () => collectTask1PrebootstrapInventory(client, bootstrap),
        /TASK1_CATALOG_COLLECTION_FAILED/,
      );
      assert.equal(client.queries.at(-1)?.sql, 'ROLLBACK');
    }
  });

  it('classifies populated catalogs only as legacy and compares postconditions byte-for-byte', async () => {
    const legacyClient = new CatalogClient({
      identity: [
        {
          postgres_version: '16.14',
          catalog_version: '202307071',
          database_oid: '16384',
          database_name: 'commander',
          ledger_exists: true,
        },
      ],
      ledger: [{ id: '2026-07-21.16.schema', checksum: 'a'.repeat(64) }],
      relations: [{ schema: 'public', name: 'commander_runs', kind: 'r', columns: [] }],
      roles: roleNames.map(role),
      memberships: [],
    });
    const inventory = await collectTask1PrebootstrapInventory(legacyClient, null);
    assert.equal(classifyTask1CatalogOrigin(inventory, null).kind, 'legacy');

    const expected = exportTask1CatalogPostcondition('historical', 'legacy', inventory);
    const productChanged = structuredClone(inventory);
    productChanged.productHasRows = [{ relation: 'public.commander_runs', hasRows: true }];
    assert.equal(exportTask1CatalogPostcondition('historical', 'legacy', productChanged), expected);
    assert.doesNotThrow(() =>
      verifyTask1CatalogPostcondition(expected, 'historical', 'legacy', productChanged),
    );

    const catalogChanged = structuredClone(inventory);
    catalogChanged.relations.push({
      schema: 'public',
      name: 'commander_extra',
      kind: 'r',
      columns: [],
    });
    assert.throws(
      () => verifyTask1CatalogPostcondition(expected, 'historical', 'legacy', catalogChanged),
      /MIGRATION_LEDGER_TAMPERED/,
    );
  });

  it('rolls back a failed catalog snapshot without returning partial evidence', async () => {
    const client = new CatalogClient();
    client.failMarker = 'functions';
    await assert.rejects(
      () => collectTask1PrebootstrapInventory(client, bootstrap),
      /TASK1_CATALOG_COLLECTION_FAILED/,
    );
    assert.equal(client.queries.at(-1)?.sql, 'ROLLBACK');
  });

  it('executes the finite state-2 hardening delta on the caller transaction', async () => {
    const client = new CatalogClient();
    await applyTask1CatalogHardening(client);

    assert.equal(client.queries.length, 1);
    assert.equal(client.queries[0]?.sql, TASK1_CATALOG_HARDENING_SQL);
    assert.match(TASK1_CATALOG_HARDENING_SQL, /REVOKE ALL PRIVILEGES ON TABLE/);
    assert.match(TASK1_CATALOG_HARDENING_SQL, /commander_kernel_migrations/);
    assert.match(TASK1_CATALOG_HARDENING_SQL, /commander_worker_allowed_tenants/);
    assert.match(TASK1_CATALOG_HARDENING_SQL, /commander_worker_claim_secrets/);
    assert.match(TASK1_CATALOG_HARDENING_SQL, /ALTER DEFAULT PRIVILEGES FOR ROLE commander_owner/);
    assert.doesNotMatch(TASK1_CATALOG_HARDENING_SQL, /\bBEGIN\b|\bCOMMIT\b/);
  });

  it('byte-verifies PostgreSQL 16.14 state 1 and state 2 goldens for every origin', () => {
    for (const classification of ['E1', 'E2', 'legacy'] as const) {
      const identities =
        classification === 'legacy'
          ? null
          : {
              format: 'bootstrap_identities/v1' as const,
              envelope: classification,
              authority: bootstrap.authority,
              bootstrapSuperuser: bootstrap.bootstrapSuperuser,
            };
      const state1 = goldenInventory(
        'task1HistoricalBaselineManifestSource.v1.json',
        classification,
      );
      const state2 = goldenInventory('task1HardenedBaselineManifestSource.v1.json', classification);
      const binding = databasePeerBinding();
      assert.doesNotThrow(() =>
        verifyTask1LockedCatalogState({
          stage: 'historical',
          classification,
          bootstrapIdentities: identities,
          databasePeerBinding: binding,
          manifestSourceJcs: manifestSource('task1HistoricalBaselineManifestSource.v1.json'),
          observed: state1,
        }),
      );
      assert.doesNotThrow(() =>
        verifyTask1LockedCatalogState({
          stage: 'hardened',
          classification,
          bootstrapIdentities: identities,
          databasePeerBinding: binding,
          manifestSourceJcs: manifestSource('task1HardenedBaselineManifestSource.v1.json'),
          previous: state1,
          observed: state2,
        }),
      );

      const changed = structuredClone(state2);
      changed.namespaces.push({ schema: 'commander_unreviewed' });
      assert.throws(
        () =>
          verifyTask1LockedCatalogState({
            stage: 'hardened',
            classification,
            bootstrapIdentities: identities,
            databasePeerBinding: binding,
            manifestSourceJcs: manifestSource('task1HardenedBaselineManifestSource.v1.json'),
            previous: state1,
            observed: changed,
          }),
        /MIGRATION_LEDGER_TAMPERED/,
      );
    }
  });

  it('validates raw database identity before typed sentinel normalization', () => {
    const identity = { oid: '24576', name: 'commander_portable' };
    const state1 = goldenInventory('task1HistoricalBaselineManifestSource.v1.json', 'E2', identity);
    const input = {
      stage: 'historical' as const,
      classification: 'E2' as const,
      bootstrapIdentities: state1.bootstrapIdentities,
      manifestSourceJcs: manifestSource('task1HistoricalBaselineManifestSource.v1.json'),
      observed: state1,
    };
    assert.doesNotThrow(() =>
      verifyTask1LockedCatalogState({
        ...input,
        databasePeerBinding: databasePeerBinding(identity.oid, identity.name),
      }),
    );
    assert.throws(
      () =>
        verifyTask1LockedCatalogState({
          ...input,
          databasePeerBinding: databasePeerBinding('24577', identity.name),
        }),
      /MIGRATION_LEDGER_TAMPERED/,
    );
    assert.throws(
      () =>
        verifyTask1LockedCatalogState({
          ...input,
        } as Parameters<typeof verifyTask1LockedCatalogState>[0]),
      /MIGRATION_LEDGER_TAMPERED/,
    );

    const aclSubstitution = structuredClone(state1);
    aclSubstitution.databaseAcl[0]!.objectIdentity = 'other';
    assert.throws(
      () =>
        verifyTask1LockedCatalogState({
          ...input,
          databasePeerBinding: databasePeerBinding(identity.oid, identity.name),
          observed: aclSubstitution,
        }),
      /MIGRATION_LEDGER_TAMPERED/,
    );

    const databaseScopedSource = JSON.parse(input.manifestSourceJcs) as {
      branches: { E2: { manifest: { catalog: PrebootstrapInventoryV1 } } };
    };
    databaseScopedSource.branches.E2.manifest.catalog.roleSettings = [
      {
        database: databaseIdentitySentinels.name,
        role: 'commander_app',
        settings: [{ name: 'search_path', value: 'public' }],
      },
    ];
    const databaseScoped = structuredClone(state1);
    databaseScoped.roleSettings = [
      {
        database: identity.name,
        role: 'commander_app',
        settings: [{ name: 'search_path', value: 'public' }],
      },
    ];
    assert.doesNotThrow(() =>
      verifyTask1LockedCatalogState({
        ...input,
        databasePeerBinding: databasePeerBinding(identity.oid, identity.name),
        manifestSourceJcs: canonicalBootstrapJson(databaseScopedSource),
        observed: databaseScoped,
      }),
    );
    databaseScoped.roleSettings[0]!.database = 'other';
    assert.throws(
      () =>
        verifyTask1LockedCatalogState({
          ...input,
          databasePeerBinding: databasePeerBinding(identity.oid, identity.name),
          manifestSourceJcs: canonicalBootstrapJson(databaseScopedSource),
          observed: databaseScoped,
        }),
      /MIGRATION_LEDGER_TAMPERED/,
    );
  });

  it('requires state 3 to be exact state 2 plus the pinned lifecycle delta', () => {
    const state2 = goldenInventory('task1HardenedBaselineManifestSource.v1.json', 'E2');
    const state3 = goldenInventory('task1LifecyclePostconditionManifest.v1.json', 'E2');
    const input = {
      stage: 'lifecycle' as const,
      classification: 'E2' as const,
      bootstrapIdentities: state3.bootstrapIdentities,
      databasePeerBinding: databasePeerBinding(),
      manifestSourceJcs: manifestSource('task1LifecyclePostconditionManifest.v1.json'),
      previous: state2,
    };
    assert.doesNotThrow(() => verifyTask1LockedCatalogState({ ...input, observed: state3 }));

    const omitted = structuredClone(state3);
    omitted.triggers.pop();
    assert.throws(
      () => verifyTask1LockedCatalogState({ ...input, observed: omitted }),
      /MIGRATION_LEDGER_TAMPERED/,
    );

    const predecessorChanged = structuredClone(state2);
    predecessorChanged.roles[0]!.connectionLimit = 4;
    assert.throws(
      () =>
        verifyTask1LockedCatalogState({
          ...input,
          previous: predecessorChanged,
          observed: state3,
        }),
      /MIGRATION_LEDGER_TAMPERED/,
    );
  });
});
