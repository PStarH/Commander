import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildRestoreDatabaseUrl,
  assertDrTlsConfiguration,
  buildDrPostgresEnv,
  computeRpoMs,
  queryRunCommittedAt,
  parseDatabaseUrl,
  resolveHonestyLevel,
  assertDistinctRestoreTarget,
  refuseSourceDestructiveRestore,
  sanitizeError,
  assessRestoredEvidence,
  assertRegularArtifact,
  restoreBackupDirectory,
  restoredValidationFailures,
  createFreshRestoreDatabase,
  restoreIntoFreshTarget,
  assertEmptyRestoreTarget,
  verifyDrDatabaseTlsConnection,
  buildPostgresControlDatabaseUrl,
  buildPgRestoreArgs,
  isIgnorablePgRestoreCompatibilityFailure,
  DRILL_KILL_SWITCH_RELATION,
  preflightRestoreServerBeforeCreate,
  validateRetainedJwks,
  verifyRestoredReceipts,
  verifyRestoredReceiptPages,
  parseRestoredReceiptRows,
  resolveDrillOverall,
  type DrillReport,
  type DsnParts,
} from './dr-backup-verify.js';
import {
  buildRunEvidenceBundle,
  canonicalEvidenceBody,
  createEvidenceSigner,
} from '../packages/effect-broker/src/index.js';

describe('dr-backup-verify honesty', () => {
  it('validates the kernel action kill-switch relation name', () => {
    assert.equal(DRILL_KILL_SWITCH_RELATION, 'commander_action_kill_switches');
  });

  it('passes the restore database through pg_restore without putting credentials in argv', () => {
    assert.deepEqual(buildPgRestoreArgs('fixture_dr', '/tmp/drill.dump'), [
      '--no-owner',
      '--no-acl',
      '--dbname=fixture_dr',
      '/tmp/drill.dump',
    ]);
  });

  it('only tolerates the known transaction_timeout client/server compatibility warning', () => {
    const warning = `pg_restore: error: could not execute query: ERROR:  unrecognized configuration parameter "transaction_timeout"
Command was: SET transaction_timeout = 0;
pg_restore: warning: errors ignored on restore: 1`;
    assert.equal(isIgnorablePgRestoreCompatibilityFailure(warning), true);
    assert.equal(
      isIgnorablePgRestoreCompatibilityFailure(`${warning}\npg_restore: error: permission denied`),
      false,
    );
  });

  it('parseDatabaseUrl extracts host/port/database', () => {
    const dsn = parseDatabaseUrl('postgres://user:pass@src.example.com:5432/commander');
    assert.equal(dsn.host, 'src.example.com');
    assert.equal(dsn.port, 5432);
    assert.equal(dsn.database, 'commander');
    assert.equal(dsn.user, 'user');
  });

  it('buildRestoreDatabaseUrl uses a different port than source', () => {
    const source = 'postgres://user:pass@localhost:5432/commander';
    const restore = buildRestoreDatabaseUrl(source, '5433');
    const src = parseDatabaseUrl(source);
    const rst = parseDatabaseUrl(restore);
    assert.notEqual(src.port, rst.port);
    assert.equal(rst.port, 5433);
  });

  it('requires explicit verified TLS inputs for every DR CLI database connection', () => {
    const source = 'postgres://user:pass@source.example.test:5432/commander?sslmode=verify-full';
    const restore =
      'postgres://user:pass@restore.example.test:5432/commander_dr?sslmode=verify-full';
    const tls = {
      COMMANDER_DATABASE_TLS_CA_FILE: '/run/commander/database-tls/ca.crt',
      COMMANDER_DATABASE_TLS_CA_MOUNT_IDENTITY: 'secret/commander-db-tls:ca.crt',
      COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: 'a'.repeat(64),
    };
    assert.doesNotThrow(() => assertDrTlsConfiguration(source, restore, tls));
    assert.throws(
      () => assertDrTlsConfiguration(source.replace('?sslmode=verify-full', ''), restore, tls),
      /DATABASE_URL must require sslmode=verify-full/,
    );
    assert.throws(
      () =>
        assertDrTlsConfiguration(source, restore, { ...tls, COMMANDER_DATABASE_TLS_CA_FILE: '' }),
      /COMMANDER_DATABASE_TLS_CA_FILE_REQUIRED/,
    );

    const env = buildDrPostgresEnv(parseDatabaseUrl(source), tls);
    assert.equal(env.PGSSLMODE, 'verify-full');
    assert.equal(env.PGSSLROOTCERT, tls.COMMANDER_DATABASE_TLS_CA_FILE);
  });

  it('uses the verified pool contract before opening a DR database connection', async () => {
    await assert.rejects(
      () =>
        verifyDrDatabaseTlsConnection(
          'postgres://user:pass@restore.example.test:5432/commander_dr?sslmode=verify-full',
          {
            COMMANDER_DATABASE_TLS_CA_FILE: '/does/not/exist',
            COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: 'not-a-sha256-pin',
          },
        ),
      /COMMANDER_DATABASE_TLS_CA_FILE_UNREADABLE|COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256_INVALID/,
    );
  });

  it('probes the restore server through the postgres control database before createdb', () => {
    assert.equal(
      buildPostgresControlDatabaseUrl(
        'postgres://user:pass@restore.example.test:5432/commander_dr?sslmode=verify-full',
      ),
      'postgres://user:pass@restore.example.test:5432/postgres?sslmode=verify-full',
    );
  });

  it('rejects restore TLS preflight before the database creation callback runs', async () => {
    let createCalls = 0;
    await assert.rejects(
      () =>
        preflightRestoreServerBeforeCreate(
          'postgres://user:pass@restore.example.test:5432/commander_dr?sslmode=verify-full',
          async (databaseUrl) => {
            assert.equal(
              databaseUrl,
              'postgres://user:pass@restore.example.test:5432/postgres?sslmode=verify-full',
            );
            throw new Error('restore server SPKI mismatch');
          },
          () => {
            createCalls += 1;
          },
        ),
      /restore server SPKI mismatch/,
    );
    assert.equal(createCalls, 0);
  });

  it('does not invoke createdb when the restore control preflight rejects', () => {
    const root = mkdtempSync(join(tmpdir(), 'commander-dr-restore-preflight-'));
    const bin = join(root, 'bin');
    const createdbMarker = join(root, 'createdb-called');
    const createdbPath = join(bin, 'createdb');
    const keyPair = generateKeyPairSync('ed25519');
    const publicJwk = keyPair.publicKey.export({ format: 'jwk' }) as { x: string };
    try {
      mkdirSync(bin);
      writeFileSync(join(root, 'dump.dump'), 'not-used-before-preflight');
      writeFileSync(
        join(root, 'jwks.json'),
        JSON.stringify({
          keys: [
            {
              kty: 'OKP',
              crv: 'Ed25519',
              alg: 'EdDSA',
              use: 'sig',
              kid: 'retained',
              x: publicJwk.x,
            },
          ],
        }),
      );
      writeFileSync(createdbPath, `#!/bin/sh\ntouch '${createdbMarker}'\n`);
      chmodSync(createdbPath, 0o755);

      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve('scripts/dr-backup-verify.ts'),
          '--restore',
          '--backup-path',
          root,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            DATABASE_URL:
              'postgres://user:pass@source.example.test:5432/commander?sslmode=verify-full',
            RST_DATABASE_URL:
              'postgres://user:pass@restore.example.test:5432/commander_dr?sslmode=verify-full',
            COMMANDER_DATABASE_TLS_CA_FILE: join(root, 'missing-ca.crt'),
            COMMANDER_DATABASE_TLS_CA_MOUNT_IDENTITY: 'test-ca-mount',
            COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: 'a'.repeat(64),
          },
        },
      );

      assert.equal(result.status, 1, result.stderr);
      assert.equal(existsSync(createdbMarker), false, result.stdout);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('assertDistinctRestoreTarget rejects same host:port:database', () => {
    const dsn: DsnParts = {
      host: 'localhost',
      port: 5432,
      database: 'commander',
      user: 'u',
      password: 'p',
    };
    assert.throws(() => assertDistinctRestoreTarget(dsn, { ...dsn }), /distinct restore/);
  });

  it('refuseSourceDestructiveRestore blocks restore when RST DSN equals source', () => {
    const dsn: DsnParts = {
      host: 'localhost',
      port: 5432,
      database: 'commander',
      user: 'u',
      password: 'p',
    };
    const reason = refuseSourceDestructiveRestore(dsn, { ...dsn });
    assert.match(reason ?? '', /distinct restore/);
  });

  it('refuseSourceDestructiveRestore allows distinct port restore target', () => {
    const source: DsnParts = {
      host: 'localhost',
      port: 5432,
      database: 'commander',
      user: 'u',
      password: 'p',
    };
    const restore: DsnParts = {
      host: 'localhost',
      port: 5433,
      database: 'commander_dr',
      user: 'u',
      password: 'p',
    };
    assert.equal(refuseSourceDestructiveRestore(source, restore), null);
  });

  it('assertDistinctRestoreTarget accepts different port', () => {
    const source: DsnParts = {
      host: 'localhost',
      port: 5432,
      database: 'commander',
      user: 'u',
      password: 'p',
    };
    const restore: DsnParts = {
      host: 'localhost',
      port: 5433,
      database: 'commander',
      user: 'u',
      password: 'p',
    };
    assert.doesNotThrow(() => assertDistinctRestoreTarget(source, restore));
  });

  it('computeRpoMs uses backup completion minus DB commit (can exceed target)', () => {
    const cutoff = new Date('2026-07-19T12:00:00.000Z');
    const lastCommitted = new Date('2026-07-19T11:58:30.000Z');
    const rpo = computeRpoMs(cutoff, lastCommitted);
    assert.equal(rpo, 90_000);
    assert.notEqual(rpo, 0);
    const stale = computeRpoMs(new Date('2026-07-19T12:10:00.000Z'), lastCommitted);
    assert.ok(stale > 5 * 60 * 1000, 'RPO must be able to exceed 5min target');
  });

  it('queryRunCommittedAt reads epoch ms from psql output', () => {
    const dsn: DsnParts = {
      host: 'localhost',
      port: 5432,
      database: 'commander',
      user: 'u',
      password: 'p',
    };
    const epochMs = '1718806710000';
    const committed = queryRunCommittedAt(dsn, 'run_test', (_d, _sql) => epochMs);
    assert.equal(committed.getTime(), Number(epochMs));
  });

  it('resolveHonestyLevel is DRAFT without independent restore', () => {
    assert.equal(
      resolveHonestyLevel({ independentRestore: false, sentinelVerified: false }),
      'DRAFT',
    );
  });

  it('resolveHonestyLevel is ENFORCED with restore + sentinel but no cell processes', () => {
    assert.equal(
      resolveHonestyLevel({
        independentRestore: true,
        sentinelVerified: true,
      }),
      'ENFORCED',
    );
  });

  it('never promotes an environment flag to PROVEN', () => {
    assert.equal(
      resolveHonestyLevel({
        independentRestore: true,
        sentinelVerified: true,
      }),
      'ENFORCED',
    );
  });

  it('sanitizeError strips passwords and DSN fragments', () => {
    const secret = 'SecretPass_XYZ';
    const err = new Error(`Command failed: psql postgres://drill:${secret}@127.0.0.1:5432/db`);
    const cleaned = sanitizeError(err, [secret]);
    assert.ok(!cleaned.includes(secret));
    assert.ok(!cleaned.includes('postgres://'));
  });

  it('attests restored signed receipts, anchors, and identity/outcome accounting', () => {
    const dsn: DsnParts = {
      host: 'restore.example.invalid',
      port: 5433,
      database: 'commander_dr',
      user: 'verifier',
      password: 'not-retained',
    };
    const values = ['t', '3', '3', '3'];
    assert.deepEqual(
      assessRestoredEvidence(dsn, () => values.shift() ?? ''),
      {
        evidenceReceiptsRestored: true,
        evidenceAnchorsRestored: true,
        identityOutcomeAccountingPreserved: true,
        evidenceReceiptCount: 3,
        anchoredEvidenceReceiptCount: 3,
      },
    );
  });

  it('fails closed when restored receipts are missing, unanchored, or malformed', () => {
    const dsn: DsnParts = {
      host: 'restore.example.invalid',
      port: 5433,
      database: 'commander_dr',
      user: 'verifier',
      password: 'not-retained',
    };
    const values = ['t', '2', '1', '1'];
    assert.deepEqual(
      assessRestoredEvidence(dsn, () => values.shift() ?? ''),
      {
        evidenceReceiptsRestored: true,
        evidenceAnchorsRestored: false,
        identityOutcomeAccountingPreserved: false,
        evidenceReceiptCount: 2,
        anchoredEvidenceReceiptCount: 1,
      },
    );
  });

  it('uses the supplied backup artifact directory exactly for restore-only drills', () => {
    assert.equal(
      restoreBackupDirectory('restore', '/var/backups/retained-drill', 'new-drill-id'),
      '/var/backups/retained-drill',
    );
    assert.equal(
      restoreBackupDirectory('full', '/var/backups', 'new-drill-id'),
      '/var/backups/new-drill-id',
    );
  });

  it('rejects a missing or non-regular dump artifact before restore', () => {
    assert.throws(
      () => assertRegularArtifact('/var/backups/drill/dump.dump', { isFile: () => false }),
      /not a regular file/,
    );
  });

  it('fails closed on a restore database creation failure without retrying', () => {
    const dsn: DsnParts = {
      host: 'localhost',
      port: 5433,
      database: 'commander_dr',
      user: 'u',
      password: 'p',
    };
    let attempts = 0;
    assert.throws(
      () =>
        createFreshRestoreDatabase(dsn, () => {
          attempts += 1;
          throw new Error('database already exists');
        }),
      /create a fresh restore database/,
    );
    assert.equal(attempts, 1);
  });

  it('rejects a newly created restore target that contains user objects', () => {
    assert.throws(() => assertEmptyRestoreTarget(1), /not empty/);
    assert.doesNotThrow(() => assertEmptyRestoreTarget(0));
  });

  it('checks a newly created target is empty before invoking pg_restore', () => {
    const calls: string[] = [];
    assert.throws(
      () =>
        restoreIntoFreshTarget({
          createDatabase: () => calls.push('create'),
          countUserObjects: () => {
            calls.push('empty-check');
            return 1;
          },
          restore: () => calls.push('pg_restore'),
        }),
      /not empty/,
    );
    assert.deepEqual(calls, ['create', 'empty-check']);
  });

  it('lists every failed required restored lifecycle and evidence invariant', () => {
    const validation: DrillReport['validation'] = {
      runsTableExists: false,
      stepsTableExists: false,
      eventsTableExists: false,
      effects: false,
      interactions: false,
      killSwitches: false,
      outboxTableExists: false,
      timersTableExists: false,
      evidenceReceiptsRestored: false,
      evidenceAnchorsRestored: false,
      identityOutcomeAccountingPreserved: false,
      evidenceReceiptCount: 0,
      anchoredEvidenceReceiptCount: 0,
      evidenceReceiptsVerified: 0,
      evidenceReceiptVerificationFailures: 0,
      retainedJwksSha256: null,
      retainedJwksKeyIds: [],
      rowCount: { runs: 0, steps: 0, events: 0 },
    };
    assert.equal(restoredValidationFailures(validation).length, 11);
  });

  it('allows PASS only for a fully valid full drill', () => {
    assert.equal(
      resolveDrillOverall({
        mode: 'full',
        independentRestore: true,
        restoreFailures: [],
        validationFailures: [],
        sentinelVerified: true,
        rpoPassed: true,
        rtoPassed: true,
      }),
      'PASS',
    );
  });

  it('fails a restored artifact/schema/evidence problem even when source checks are unavailable', () => {
    assert.equal(
      resolveDrillOverall({
        mode: 'restore',
        independentRestore: true,
        restoreFailures: [],
        validationFailures: ['restored evidence receipts missing'],
        sentinelVerified: false,
        rpoPassed: false,
        rtoPassed: true,
      }),
      'FAIL',
    );
  });

  it('keeps a valid restore-only drill DRAFT without source sentinel or RPO context', () => {
    assert.equal(
      resolveDrillOverall({
        mode: 'restore',
        independentRestore: true,
        restoreFailures: [],
        validationFailures: [],
        sentinelVerified: false,
        rpoPassed: false,
        rtoPassed: true,
      }),
      'DRAFT',
    );
  });

  it('fails rather than drafting an unsafe or non-independent restore', () => {
    assert.equal(
      resolveDrillOverall({
        mode: 'restore',
        independentRestore: false,
        restoreFailures: ['restore target equals source'],
        validationFailures: [],
        sentinelVerified: false,
        rpoPassed: false,
        rtoPassed: true,
      }),
      'FAIL',
    );
  });

  it('fails restore-only for every restore-side failure class', () => {
    for (const restoreFailures of [
      ['restore target equals source'],
      ['backup artifact missing'],
      ['pg_restore failed'],
    ]) {
      assert.equal(
        resolveDrillOverall({
          mode: 'restore',
          independentRestore: true,
          restoreFailures,
          validationFailures: [],
          sentinelVerified: false,
          rpoPassed: false,
          rtoPassed: true,
        }),
        'FAIL',
      );
    }

    for (const validationFailure of [
      'restored schema invalid',
      'restored evidence invalid',
      'retained JWKS artifact invalid',
    ]) {
      assert.equal(
        resolveDrillOverall({
          mode: 'restore',
          independentRestore: true,
          restoreFailures: [],
          validationFailures: [validationFailure],
          sentinelVerified: false,
          rpoPassed: false,
          rtoPassed: true,
        }),
        'FAIL',
      );
    }
  });

  it('accepts only public unique Ed25519 retained JWKS keys', () => {
    const keyPair = generateKeyPairSync('ed25519');
    const publicJwk = keyPair.publicKey.export({ format: 'jwk' }) as { x: string };
    const jwks = validateRetainedJwks(
      {
        keys: [
          { kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig', kid: 'old-1', x: publicJwk.x },
        ],
      },
      Buffer.from('{"keys":[{"kid":"old-1"}]}'),
    );
    assert.deepEqual(jwks.keyIds, ['old-1']);
    assert.match(jwks.sha256, /^[a-f0-9]{64}$/);
    assert.throws(
      () =>
        validateRetainedJwks(
          {
            keys: [
              {
                kty: 'OKP',
                crv: 'Ed25519',
                alg: 'EdDSA',
                use: 'sig',
                kid: 'valid-before-bad',
                x: publicJwk.x,
              },
              {
                kty: 'OKP',
                crv: 'Ed25519',
                alg: 'EdDSA',
                use: 'sig',
                kid: 'private',
                x: 'public',
                d: 'secret',
              },
            ],
          },
          Buffer.from('{}'),
        ),
      /private key material/,
    );
    assert.throws(
      () =>
        validateRetainedJwks(
          {
            keys: [
              { kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig', kid: 'same', x: publicJwk.x },
              { kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig', kid: 'same', x: publicJwk.x },
            ],
          },
          Buffer.from('{}'),
        ),
      /unique/,
    );
    assert.throws(
      () =>
        validateRetainedJwks(
          {
            keys: [
              {
                kty: 'OKP',
                crv: 'Ed25519',
                alg: 'EdDSA',
                use: 'sig',
                kid: 'bad',
                x: 'not-a-public-key',
              },
            ],
          },
          Buffer.from('{}'),
        ),
      /public key is invalid/,
    );
  });

  it('verifies a real restored receipt and rejects body signature tampering', async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const privateKeyPem = keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const signer = createEvidenceSigner({ privateKeyPem, keyId: 'retained' });
    const body = buildRunEvidenceBundle({
      tenantId: 'tenant-1',
      runId: 'run-1',
      policySnapshotId: 'policy-1',
      effects: [
        {
          id: 'effect-1',
          runId: 'run-1',
          stepId: 'step-1',
          tenantId: 'tenant-1',
          type: 'kubernetes.deployment.rollback',
          state: 'COMPLETED',
          policyDecisionId: 'decision-1',
          requestHash: 'a'.repeat(64),
          createdAt: '2026-07-31T00:00:00.000Z',
          completedAt: '2026-07-31T00:00:01.000Z',
        },
      ],
    });
    const signature = await signer.sign(canonicalEvidenceBody(body));
    const completeBody = { ...body, signature };
    const retainedJwks = validateRetainedJwks(
      signer.jwks,
      Buffer.from(JSON.stringify(signer.jwks), 'utf8'),
    ).jwks;
    const row = {
      body: completeBody,
      signature,
      actionDigest: completeBody.actionDigest,
      contentHash: completeBody.contentHash,
    };
    const verified = verifyRestoredReceipts([row], retainedJwks);
    assert.deepEqual(verified, { verified: 1, failed: 0, failures: [] });
    const tampered = verifyRestoredReceipts(
      [{ ...row, body: { ...completeBody, signature: { ...signature, value: 'tampered' } } }],
      retainedJwks,
    );
    assert.deepEqual(tampered, {
      verified: 0,
      failed: 1,
      failures: ['EVIDENCE_SIGNATURE_BINDING_MISMATCH'],
    });
    const tamperedColumn = verifyRestoredReceipts(
      [{ ...row, signature: { ...signature, value: 'tampered-column' } }],
      retainedJwks,
    );
    assert.deepEqual(tamperedColumn, {
      verified: 0,
      failed: 1,
      failures: ['EVIDENCE_SIGNATURE_BINDING_MISMATCH'],
    });
  });

  it('rejects database hash columns and retained key ids independently', () => {
    const jwks = {
      keys: [
        { kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig', kid: 'retained', x: 'public' },
      ],
    };
    const signature = {
      algorithm: 'Ed25519',
      keyId: 'missing',
      signedAt: new Date().toISOString(),
      value: 'signature',
    } as const;
    const receipt = {
      body: { actionDigest: 'body-action', contentHash: 'body-content', signature } as never,
      signature,
      actionDigest: 'db-action',
      contentHash: 'body-content',
    };
    assert.deepEqual(verifyRestoredReceipts([receipt], jwks), {
      verified: 0,
      failed: 1,
      failures: ['EVIDENCE_ACTION_DIGEST_MISMATCH'],
    });
    assert.deepEqual(
      verifyRestoredReceipts(
        [{ ...receipt, actionDigest: 'body-action', contentHash: 'db-content' }],
        jwks,
      ),
      {
        verified: 0,
        failed: 1,
        failures: ['EVIDENCE_CONTENT_HASH_MISMATCH'],
      },
    );
    assert.deepEqual(
      verifyRestoredReceipts(
        [{ ...receipt, actionDigest: 'body-action', contentHash: 'body-content' }],
        jwks,
      ),
      {
        verified: 0,
        failed: 1,
        failures: ['EVIDENCE_KEY_ID_NOT_RETAINED'],
      },
    );
    assert.deepEqual(
      parseRestoredReceiptRows(JSON.stringify([{ body: {}, signature: {} }])).length,
      1,
    );
  });

  it('verifies restored receipts page by page with keyset cursors and bounded failure reasons', () => {
    const cursors: Array<{ createdAt: string; tenantId: string; bundleId: string } | null> = [];
    const invalidReceipt = {
      body: {} as never,
      signature: {} as never,
    };
    const result = verifyRestoredReceiptPages(
      (cursor) => {
        cursors.push(cursor);
        if (!cursor) {
          return {
            receipts: [invalidReceipt, invalidReceipt],
            cursor: {
              createdAt: '2026-07-31T00:00:00.000Z',
              tenantId: 'tenant-a',
              bundleId: 'bundle-b',
            },
          };
        }
        assert.deepEqual(cursor, {
          createdAt: '2026-07-31T00:00:00.000Z',
          tenantId: 'tenant-a',
          bundleId: 'bundle-b',
        });
        return {
          receipts: [invalidReceipt],
          cursor: {
            createdAt: '2026-07-31T00:00:01.000Z',
            tenantId: 'tenant-a',
            bundleId: 'bundle-c',
          },
        };
      },
      { keys: [] },
      { pageSize: 2, maxFailureReasons: 2 },
    );

    assert.deepEqual(cursors, [
      null,
      {
        createdAt: '2026-07-31T00:00:00.000Z',
        tenantId: 'tenant-a',
        bundleId: 'bundle-b',
      },
    ]);
    assert.deepEqual(result, {
      verified: 0,
      failed: 3,
      failures: ['EVIDENCE_SIGNATURE_BINDING_MISMATCH', 'EVIDENCE_SIGNATURE_BINDING_MISMATCH'],
    });
  });
});
