import { X509Certificate, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkServerIdentity as checkTlsServerIdentity, createSecureContext } from 'node:tls';
import type { PeerCertificate } from 'node:tls';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';

const CA_FILE_ENV = 'COMMANDER_DATABASE_TLS_CA_FILE';
const EXPECTED_SPKI_ENV = 'COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256';
const SHA256_HEX = /^[a-f0-9]{64}$/;

function isIpLiteral(hostname: string): boolean {
  if (hostname.includes(':')) return true;
  const octets = hostname.split('.');
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d+$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255)
  );
}

export type VerifiedPostgresPoolInput = Omit<PoolConfig, 'connectionString' | 'ssl'> & {
  connectionString: string;
};

function fail(code: string): never {
  throw new Error(code);
}

function requiredEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) fail(`${name}_REQUIRED`);
  return value;
}

function readTrustedCa(env: NodeJS.ProcessEnv): string {
  const file = requiredEnvironmentValue(env, CA_FILE_ENV);
  let ca: string;
  try {
    ca = readFileSync(file, 'utf8');
  } catch {
    fail(`${CA_FILE_ENV}_UNREADABLE`);
  }
  if (!ca.trim()) fail(`${CA_FILE_ENV}_INVALID`);
  try {
    new X509Certificate(ca);
    createSecureContext({ ca });
  } catch {
    fail(`${CA_FILE_ENV}_INVALID`);
  }
  return ca;
}

function expectedSpki(env: NodeJS.ProcessEnv): string {
  const value = requiredEnvironmentValue(env, EXPECTED_SPKI_ENV);
  if (!SHA256_HEX.test(value)) fail(`${EXPECTED_SPKI_ENV}_INVALID`);
  return value;
}

function parseVerifiedConnectionString(connectionString: string): {
  connectionString: string;
  hostname: string;
} {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    fail('COMMANDER_DATABASE_DSN_INVALID');
  }
  if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || !url.hostname) {
    fail('COMMANDER_DATABASE_DSN_INVALID');
  }
  const sslModes = url.searchParams.getAll('sslmode');
  if (sslModes.length !== 1 || sslModes[0] !== 'verify-full') {
    fail('COMMANDER_DATABASE_SSLMODE_VERIFY_FULL_REQUIRED');
  }
  for (const name of url.searchParams.keys()) {
    if (name.toLowerCase().startsWith('ssl') && name.toLowerCase() !== 'sslmode') {
      fail('COMMANDER_DATABASE_DSN_TLS_OPTION_FORBIDDEN');
    }
    if (name.toLowerCase() === 'uselibpqcompat') {
      fail('COMMANDER_DATABASE_DSN_TLS_OPTION_FORBIDDEN');
    }
  }
  url.searchParams.delete('sslmode');
  const hostname =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;
  return { connectionString: url.toString(), hostname };
}

export function verifyPeerCertificateSpki(
  certificate: Pick<PeerCertificate, 'raw'>,
  expectedSha256: string,
): void {
  if (!SHA256_HEX.test(expectedSha256) || !Buffer.isBuffer(certificate.raw)) {
    fail('COMMANDER_DATABASE_SERVER_CERTIFICATE_INVALID');
  }
  let observed: Buffer;
  try {
    const x509 = new X509Certificate(certificate.raw);
    observed = createHash('sha256')
      .update(x509.publicKey.export({ format: 'der', type: 'spki' }))
      .digest();
  } catch {
    fail('COMMANDER_DATABASE_SERVER_CERTIFICATE_INVALID');
  }
  const expected = Buffer.from(expectedSha256, 'hex');
  if (expected.length !== observed.length || !timingSafeEqual(observed, expected)) {
    fail('COMMANDER_DATABASE_SERVER_SPKI_MISMATCH');
  }
}

export function buildVerifiedPostgresPoolConfig(
  input: VerifiedPostgresPoolInput,
  env: NodeJS.ProcessEnv = process.env,
): PoolConfig {
  const ca = readTrustedCa(env);
  const expectedServerSpkiSha256 = expectedSpki(env);
  const parsed = parseVerifiedConnectionString(input.connectionString);
  return {
    ...input,
    connectionString: parsed.connectionString,
    ssl: {
      ca,
      rejectUnauthorized: true,
      servername: isIpLiteral(parsed.hostname) ? 'commander-ip-literal.invalid' : parsed.hostname,
      checkServerIdentity(_tlsServername, certificate) {
        const identityError = checkTlsServerIdentity(parsed.hostname, certificate);
        if (identityError) return identityError;
        try {
          verifyPeerCertificateSpki(certificate, expectedServerSpkiSha256);
          return undefined;
        } catch (error) {
          return error instanceof Error
            ? error
            : new Error('COMMANDER_DATABASE_SERVER_CERTIFICATE_INVALID');
        }
      },
    },
  };
}

export function createVerifiedPostgresPool(
  input: VerifiedPostgresPoolInput,
  env: NodeJS.ProcessEnv = process.env,
): Pool {
  return new Pool(buildVerifiedPostgresPoolConfig(input, env));
}
