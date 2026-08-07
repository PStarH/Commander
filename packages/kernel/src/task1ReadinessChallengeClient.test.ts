import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { requestTask1ReadinessChallenge } from './task1ReadinessChallengeClient.js';

function tlsFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'commander-proof-client-'));
  const keyFile = join(directory, 'tls.key');
  const certFile = join(directory, 'tls.crt');
  execFileSync('openssl', [
    'req', '-x509', '-new', '-nodes', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-keyout', keyFile, '-out', certFile,
  ], { stdio: 'ignore' });
  const cert = readFileSync(certFile);
  return {
    cert, key: readFileSync(keyFile),
    spki: createHash('sha256')
      .update(new X509Certificate(cert).publicKey.export({ format: 'der', type: 'spki' }))
      .digest('hex'),
  };
}

describe('Task 1 readiness challenge client', () => {
  it('uses TLS 1.3, verifies SAN/SPKI on the authenticated socket, and forbids redirects', async () => {
    const fixture = tlsFixture();
    const challenge = Buffer.alloc(32, 7).toString('base64url');
    const server = createServer({
      cert: fixture.cert, key: fixture.key, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
    }, (request, response) => {
      assert.equal((request.socket as unknown as { getProtocol(): string | null }).getProtocol(), 'TLSv1.3');
      assert.equal(request.headers['x-commander-readiness-challenge'], challenge);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ challenge }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const response = await requestTask1ReadinessChallenge({
        url: `https://localhost:${address.port}/ready/tenant-authority/v1`,
        challenge,
        expectedServerSpkiSha256: fixture.spki,
        ca: fixture.cert,
      });
      assert.deepEqual(response, { challenge });
      await assert.rejects(
        () => requestTask1ReadinessChallenge({
          url: `https://localhost:${address.port}/ready/tenant-authority/v1`,
          challenge,
          expectedServerSpkiSha256: '0'.repeat(64),
          ca: fixture.cert,
        }),
        /TENANT_CUTOVER_PROOF_SPKI_MISMATCH/,
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
