import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { describe, it } from 'node:test';
import { buildVerifiedPostgresPoolConfig, verifyPeerCertificateSpki } from './postgresRuntime.js';

function fixtureCertificate(): {
  caFile: string;
  certificate: X509Certificate;
  spkiSha256: string;
} {
  const pem = rootCertificates[0];
  assert.ok(pem, 'Node must provide at least one trusted root certificate');
  const directory = mkdtempSync(join(tmpdir(), 'commander-kernel-postgres-runtime-'));
  const caFile = join(directory, 'ca.pem');
  writeFileSync(caFile, pem, { mode: 0o600 });
  const certificate = new X509Certificate(pem);
  return {
    caFile,
    certificate,
    spkiSha256: createHash('sha256')
      .update(certificate.publicKey.export({ format: 'der', type: 'spki' }))
      .digest('hex'),
  };
}

describe('kernel verified PostgreSQL pool configuration', () => {
  it('requires the CA file and expected SPKI before a pool can open', () => {
    assert.throws(
      () =>
        buildVerifiedPostgresPoolConfig(
          { connectionString: 'postgres://app:secret@db.internal/commander?sslmode=verify-full' },
          {},
        ),
      /COMMANDER_DATABASE_TLS_CA_FILE_REQUIRED/,
    );
  });

  it('installs strict CA and SPKI verification outside the DSN', () => {
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
    assert.equal(
      config.ssl && typeof config.ssl === 'object' && config.ssl.rejectUnauthorized,
      true,
    );
    assert.equal(
      config.ssl && typeof config.ssl === 'object' && config.ssl.ca,
      rootCertificates[0],
    );
    assert.equal(
      config.ssl && typeof config.ssl === 'object' && typeof config.ssl.checkServerIdentity,
      'function',
    );
  });

  it('rejects a mismatched peer SPKI', () => {
    const { certificate, spkiSha256 } = fixtureCertificate();
    assert.doesNotThrow(() => verifyPeerCertificateSpki(certificate.toLegacyObject(), spkiSha256));
    assert.throws(
      () => verifyPeerCertificateSpki(certificate.toLegacyObject(), '0'.repeat(64)),
      /COMMANDER_DATABASE_SERVER_SPKI_MISMATCH/,
    );
  });
});
