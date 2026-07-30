import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertExpectedTlsFailure,
  assertSanitizedTlsEvidence,
  buildTlsFixtureCases,
  type TlsFixtureEvidence,
  type TlsFixtureEndpoints,
} from './task1-postgres-tls-fixture.js';

const endpoints: TlsFixtureEndpoints = {
  directPort: 55432,
  l4Port: 55433,
  terminatingPort: 55434,
};

describe('Task 1 PostgreSQL TLS fixture contract', () => {
  it('accepts a fragmented PostgreSQL SSLRequest and rejects trailing bytes', async () => {
    const { createPostgresSslRequestReader } =
      await import('../deploy/testing/postgres-tls/fixture-proxies.mjs');
    let accepted = 0;
    let rejected = 0;
    const reader = createPostgresSslRequestReader(
      () => {
        accepted += 1;
      },
      () => {
        rejected += 1;
      },
    );
    reader(Buffer.from('000000', 'hex'));
    assert.equal(accepted, 0);
    reader(Buffer.from('0804d2162f', 'hex'));
    assert.equal(accepted, 1);
    assert.equal(rejected, 0);

    const invalid = createPostgresSslRequestReader(
      () => {
        accepted += 1;
      },
      () => {
        rejected += 1;
      },
    );
    invalid(Buffer.from('0000000804d2162f00', 'hex'));
    assert.equal(rejected, 1);
  });

  it('covers every service role through direct and L4 TLS plus each fail-closed boundary', () => {
    const cases = buildTlsFixtureCases(endpoints, {
      caFile: '/fixture/ca.crt',
      untrustedCaFile: '/fixture/untrusted-ca.crt',
      expectedSpkiSha256: 'a'.repeat(64),
      rolePasswords: {
        owner: 'owner-password',
        app: 'app-password',
        'tenant-authority': 'tenant-authority-password',
        scheduler: 'scheduler-password',
        worker: 'worker-password',
        'adapter-ops': 'adapter-ops-password',
      },
    });

    const successful = cases.filter(({ expectation }) => expectation === 'success');
    assert.equal(successful.length, 12);
    assert.deepEqual([...new Set(successful.map(({ role }) => role))].sort(), [
      'adapter-ops',
      'app',
      'owner',
      'scheduler',
      'tenant-authority',
      'worker',
    ]);
    for (const role of ['owner', 'app', 'tenant-authority', 'scheduler', 'worker', 'adapter-ops']) {
      assert.deepEqual(
        successful
          .filter((testCase) => testCase.role === role)
          .map(({ route }) => route)
          .sort(),
        ['direct', 'l4-passthrough'],
      );
    }
    assert.deepEqual(
      cases
        .filter(({ expectation }) => expectation !== 'success')
        .map(({ name, expectation }) => [name, expectation]),
      [
        ['untrusted CA', 'ca-rejection'],
        ['wrong hostname', 'hostname-rejection'],
        ['wrong SPKI pin', 'spki-rejection'],
        ['terminating proxy', 'spki-rejection'],
      ],
    );
    assert.deepEqual(
      Object.fromEntries(successful.map(({ role, databaseRole }) => [role, databaseRole])),
      {
        owner: 'commander_owner',
        app: 'commander_app',
        'tenant-authority': 'commander_tenant_authority',
        scheduler: 'commander_scheduler',
        worker: 'commander_worker',
        'adapter-ops': 'commander_adapter_ops',
      },
    );
    assert.match(successful[0]!.connectionString, /postgres:\/\/commander_owner:/);
    assert.match(successful[0]!.connectionString, /@localhost:55432\//);
    assert.match(successful[1]!.connectionString, /@localhost:55433\//);
  });

  it('retains only scrubbed, fresh, cross-route identity evidence', () => {
    const evidence: TlsFixtureEvidence = {
      schemaVersion: 1,
      generatedAt: '2026-07-28T00:00:00.000Z',
      serverSpkiSha256: 'a'.repeat(64),
      proofs: [
        ...['owner', 'app', 'tenant-authority', 'scheduler', 'worker', 'adapter-ops'].flatMap(
          (role) => [
            {
              role,
              databaseRole: `commander_${role.replace('-', '_')}`,
              route: 'direct' as const,
              databaseOid: '12345',
              databaseName: 'fixture',
              serverSpkiSha256: 'a'.repeat(64),
              tlsActive: true,
              challenge: `direct-${role}`,
            },
            {
              role,
              databaseRole: `commander_${role.replace('-', '_')}`,
              route: 'l4-passthrough' as const,
              databaseOid: '12345',
              databaseName: 'fixture',
              serverSpkiSha256: 'a'.repeat(64),
              tlsActive: true,
              challenge: `l4-${role}`,
            },
          ],
        ),
      ],
      negativeChecks: [
        { name: 'untrusted CA', expectation: 'ca-rejection' },
        { name: 'wrong hostname', expectation: 'hostname-rejection' },
        { name: 'wrong SPKI pin', expectation: 'spki-rejection' },
        { name: 'terminating proxy', expectation: 'spki-rejection' },
      ],
    };

    assert.doesNotThrow(() => assertSanitizedTlsEvidence(evidence));
    assert.throws(
      () =>
        assertSanitizedTlsEvidence({
          ...evidence,
          leakedDsn: 'postgres://fixture_owner:secret@localhost/fixture',
        }),
      /TLS_FIXTURE_EVIDENCE_SECRET_LEAK/,
    );
    assert.throws(
      () =>
        assertSanitizedTlsEvidence({
          ...evidence,
          proofs: [...evidence.proofs.slice(0, -1), evidence.proofs[0]!],
        }),
      /TLS_FIXTURE_EVIDENCE_CHALLENGE_NOT_FRESH/,
    );
  });

  it('does not accept generic network failures as TLS evidence', () => {
    assert.doesNotThrow(() =>
      assertExpectedTlsFailure(
        'spki-rejection',
        new Error('COMMANDER_DATABASE_SERVER_SPKI_MISMATCH'),
      ),
    );
    assert.doesNotThrow(() =>
      assertExpectedTlsFailure(
        'hostname-rejection',
        new Error("Hostname/IP does not match certificate's altnames"),
      ),
    );
    assert.doesNotThrow(() =>
      assertExpectedTlsFailure(
        'ca-rejection',
        new Error('self-signed certificate in certificate chain'),
      ),
    );

    assert.throws(
      () => assertExpectedTlsFailure('spki-rejection', new Error('connect ECONNREFUSED')),
      /expected spki-rejection/,
    );
  });
});
