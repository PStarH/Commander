import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canonicalBootstrapJson,
  canonicalBootstrapSha256,
  createDatabasePeerBinding,
  createDatabasePeerBindingInput,
  createOriginBinding,
  createPrebootstrapSnapshots,
  verifyDatabasePeerBinding,
} from './canonicalBootstrap.js';

describe('canonical bootstrap JCS', () => {
  it('matches the RFC 8785 object-ordering vector as UTF-8 without a BOM', () => {
    const value = {
      '1': { f: { f: 'hi', F: 5 }, '\n': 56 },
      '10': {},
      '': 'empty',
      a: {},
      '111': [{ e: 'yes', E: 'no' }],
      A: {},
    };

    assert.equal(
      canonicalBootstrapJson(value),
      '{"":"empty","1":{"\\n":56,"f":{"F":5,"f":"hi"}},"10":{},"111":[{"E":"no","e":"yes"}],"A":{},"a":{}}',
    );
    assert.equal(
      canonicalBootstrapSha256(value),
      '605f65004ec2db7692522a0852c22f1c989e036d547e88963d1a3143cf3195d5',
    );
  });

  it('rejects floats, unsafe integers, non-finite numbers, and non-JSON values', () => {
    for (const value of [
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      1n,
      new Date(),
      { value: undefined },
    ]) {
      assert.throws(() => canonicalBootstrapJson(value), /COMMANDER_CANONICAL_JSON_INVALID/);
    }
  });

  it('rejects unpaired UTF-16 surrogates and circular structures', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    assert.throws(
      () => canonicalBootstrapJson('\ud800'),
      /COMMANDER_CANONICAL_JSON_INVALID_UNICODE/,
    );
    assert.throws(
      () => canonicalBootstrapJson({ '\udfff': 'value' }),
      /COMMANDER_CANONICAL_JSON_INVALID_UNICODE/,
    );
    assert.throws(() => canonicalBootstrapJson(circular), /COMMANDER_CANONICAL_JSON_CYCLE/);
  });
});

describe('canonical Task 1 owner-derived records', () => {
  const roles = [
    'owner',
    'app',
    'tenant-authority',
    'scheduler',
    'worker',
    'adapter-ops',
  ] as const;

  it('pins the closed pre-render peer input and separately observed peer record', () => {
    const input = createDatabasePeerBindingInput({
      roles: roles.map((role) => ({ role, host: `${role}.DB.Example.`, port: 5432 })),
      expectedServerSpkiSha256: 'a'.repeat(64),
      ca: {
        mountIdentity: 'database-ca',
        path: '/run/commander/database-ca/ca.crt',
        publicBytesSha256: 'b'.repeat(64),
      },
    });
    assert.equal(input.format, 'database_peer_binding_input/v1');
    assert.deepEqual(input.roles.map(({ role }) => role), [...roles].sort());
    assert.ok(input.roles.every(({ host }) => host.endsWith('.db.example')));
    assert.equal(Object.hasOwn(input.roles[0]!, 'databaseOid'), false);

    const observed = createDatabasePeerBinding({
      roles: input.roles.map(({ role, host, port }) => ({
        role,
        host,
        port,
        tlsServerSans: {
          dns: ['DB.EXAMPLE.', '*.DB.Example.', 'db.example'],
          ip: ['2001:0db8:0:0:0:0:0:1', '192.0.2.1'],
        },
        serverSpkiSha256: 'a'.repeat(64),
        databaseOid: '16384',
        databaseName: 'commander',
      })),
    });
    assert.equal(observed.format, 'database_peer_binding_v1');
    assert.deepEqual(observed.roles[0]!.tlsServerSans, {
      dns: ['*.db.example', 'db.example'],
      ip: ['192.0.2.1', '2001:db8::1'],
    });
    assert.deepEqual(Object.keys(observed).sort(), ['format', 'roles']);
    assert.deepEqual(Object.keys(observed.roles[0]!).sort(), [
      'databaseName', 'databaseOid', 'host', 'port', 'role', 'serverSpkiSha256', 'tlsServerSans',
    ]);
    assert.equal(
      canonicalBootstrapSha256(observed),
      '5b926104d408642afc0e02689b13e48eefed05e1f8f21a17a3733bbef9c771e8',
    );
    assert.equal(
      canonicalBootstrapJson(observed),
      canonicalBootstrapJson(createDatabasePeerBinding(structuredClone(observed))),
    );
    verifyDatabasePeerBinding(input, observed);
  });

  it('rejects a substituted observed SAN, SPKI, OID, database name, or role endpoint', () => {
    const input = createDatabasePeerBindingInput({
      roles: roles.map((role) => ({ role, host: 'db.example', port: 5432 })),
      expectedServerSpkiSha256: 'a'.repeat(64),
      ca: { mountIdentity: 'database-ca', path: '/ca.crt', publicBytesSha256: 'b'.repeat(64) },
    });
    const base = createDatabasePeerBinding({
      roles: roles.map((role) => ({
        role,
        host: 'db.example',
        port: 5432,
        tlsServerSans: { dns: ['db.example'], ip: [] },
        serverSpkiSha256: 'a'.repeat(64),
        databaseOid: '16384',
        databaseName: 'commander',
      })),
    });
    for (const mutate of [
      (value: typeof base) => { value.roles[0]!.tlsServerSans.dns[0] = 'other.example'; },
      (value: typeof base) => { value.roles[0]!.serverSpkiSha256 = 'c'.repeat(64); },
      (value: typeof base) => { value.roles[0]!.databaseOid = '16385'; },
      (value: typeof base) => { value.roles[0]!.databaseName = 'other'; },
      (value: typeof base) => { value.roles[0]!.port = 6432; },
    ]) {
      const changed = structuredClone(base);
      mutate(changed);
      assert.throws(() => verifyDatabasePeerBinding(input, changed), /DATABASE_PEER_BINDING_INVALID/);
    }
  });

  it('persists complete S0/S1 snapshots and derives an immutable origin binding', () => {
    const bootstrapIdentities = {
      format: 'bootstrap_identities/v1' as const,
      envelope: 'E2' as const,
      authority: { oid: '10', name: 'postgres', superuser: true, commanderNamed: false },
      bootstrapSuperuser: { oid: '10', name: 'postgres', superuser: true, commanderNamed: false },
    };
    const inventory = {
      format: 'prebootstrap_inventory/v1',
      postgresVersion: '16.14',
      catalogVersion: '202307071',
      databaseIdentity: { oid: '16384', name: 'commander' },
      ledger: null,
      namespaces: [], relations: [], functions: [], types: [], extensions: [], policies: [],
      triggers: [], productSources: [], productHasRows: [], roles: [], memberships: [],
      roleSettings: [], databaseAcl: [], schemaAcls: [], defaultAcls: [], bootstrapIdentities,
    };
    const snapshots = createPrebootstrapSnapshots(inventory, structuredClone(inventory));
    assert.equal(snapshots.comparisonKind, 'fresh-byte-equal');
    assert.equal(snapshots.s0Sha256, canonicalBootstrapSha256(inventory));
    assert.equal(snapshots.s1Sha256, canonicalBootstrapSha256(inventory));

    const origin = createOriginBinding(snapshots);
    assert.deepEqual(origin, {
      format: 'origin_binding/v1',
      prebootstrapSnapshotsSha256: canonicalBootstrapSha256(snapshots),
      bootstrapIdentities,
    });

    const changed = structuredClone(inventory);
    changed.databaseIdentity.name = 'other';
    assert.throws(
      () => createPrebootstrapSnapshots(inventory, changed),
      /PREBOOTSTRAP_INVENTORY_CHANGED/,
    );
  });
});
