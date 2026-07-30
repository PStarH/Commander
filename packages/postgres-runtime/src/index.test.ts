import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { X509Certificate, createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { buildVerifiedPostgresPoolConfig, verifyPeerCertificateSpki } from './index.js';

function fixtureCertificate(): {
  caFile: string;
  certificate: X509Certificate;
  spkiSha256: string;
} {
  const pem = rootCertificates[0];
  assert.ok(pem, 'Node must provide at least one trusted root certificate');
  const directory = mkdtempSync(join(tmpdir(), 'commander-postgres-runtime-'));
  const caFile = join(directory, 'ca.pem');
  writeFileSync(caFile, pem, { mode: 0o600 });
  const certificate = new X509Certificate(pem);
  const spki = certificate.publicKey.export({ format: 'der', type: 'spki' });
  return {
    caFile,
    certificate,
    spkiSha256: createHash('sha256').update(spki).digest('hex'),
  };
}

describe('verified PostgreSQL pool configuration', () => {
  it('requires the CA file and expected SPKI before a pool can open', () => {
    const connectionString = 'postgres://app:secret@db.internal/commander?sslmode=verify-full';

    assert.throws(
      () => buildVerifiedPostgresPoolConfig({ connectionString }, {}),
      /COMMANDER_DATABASE_TLS_CA_FILE_REQUIRED/,
    );
  });

  it('requires exactly sslmode=verify-full and rejects URL-owned TLS options', () => {
    const { caFile, spkiSha256 } = fixtureCertificate();
    const env = {
      COMMANDER_DATABASE_TLS_CA_FILE: caFile,
      COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: spkiSha256,
    };

    assert.throws(
      () =>
        buildVerifiedPostgresPoolConfig(
          { connectionString: 'postgres://app:secret@db/commander' },
          env,
        ),
      /COMMANDER_DATABASE_SSLMODE_VERIFY_FULL_REQUIRED/,
    );
    assert.throws(
      () =>
        buildVerifiedPostgresPoolConfig(
          {
            connectionString:
              'postgres://app:secret@db/commander?sslmode=verify-full&sslrootcert=%2Ftmp%2Fother.pem',
          },
          env,
        ),
      /COMMANDER_DATABASE_DSN_TLS_OPTION_FORBIDDEN/,
    );
  });

  it('rejects a malformed CA before returning a pool configuration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-postgres-runtime-invalid-ca-'));
    const caFile = join(directory, 'ca.pem');
    writeFileSync(caFile, 'not a certificate', { mode: 0o600 });

    assert.throws(
      () =>
        buildVerifiedPostgresPoolConfig(
          { connectionString: 'postgres://app:secret@db/commander?sslmode=verify-full' },
          {
            COMMANDER_DATABASE_TLS_CA_FILE: caFile,
            COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: '1'.repeat(64),
          },
        ),
      /COMMANDER_DATABASE_TLS_CA_FILE_INVALID/,
    );
  });

  it('moves TLS ownership out of the DSN and installs strict CA and SPKI verification', () => {
    const { caFile, spkiSha256 } = fixtureCertificate();
    const config = buildVerifiedPostgresPoolConfig(
      {
        connectionString:
          'postgres://app:secret@db.internal:5432/commander?application_name=api&sslmode=verify-full',
        max: 7,
      },
      {
        COMMANDER_DATABASE_TLS_CA_FILE: caFile,
        COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: spkiSha256,
      },
    );

    const rendered = new URL(config.connectionString!);
    assert.equal(rendered.searchParams.has('sslmode'), false);
    assert.equal(rendered.searchParams.get('application_name'), 'api');
    assert.equal(config.max, 7);
    assert.equal(typeof config.ssl, 'object');
    assert.equal(config.ssl && config.ssl.rejectUnauthorized, true);
    assert.equal(config.ssl && config.ssl.ca, rootCertificates[0]);
    assert.equal(config.ssl && typeof config.ssl.checkServerIdentity, 'function');
  });

  it('forces identity verification for literal IP hosts', () => {
    const { caFile, spkiSha256 } = fixtureCertificate();
    const config = buildVerifiedPostgresPoolConfig(
      { connectionString: 'postgres://app:secret@127.0.0.1/commander?sslmode=verify-full' },
      {
        COMMANDER_DATABASE_TLS_CA_FILE: caFile,
        COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: spkiSha256,
      },
    );

    assert.equal(config.ssl && config.ssl.servername, 'commander-ip-literal.invalid');
  });

  it('accepts the expected same-certificate SPKI and rejects a different pin', () => {
    const { certificate, spkiSha256 } = fixtureCertificate();
    const peer = certificate.toLegacyObject();

    assert.doesNotThrow(() => verifyPeerCertificateSpki(peer, spkiSha256));
    assert.throws(
      () => verifyPeerCertificateSpki(peer, '0'.repeat(64)),
      /COMMANDER_DATABASE_SERVER_SPKI_MISMATCH/,
    );
  });
});
