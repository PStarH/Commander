import assert from 'node:assert/strict';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createVerifiedPostgresPool } from './task1-postgres-tls-fixture-pool.js';

export type TlsFailureExpectation = 'ca-rejection' | 'hostname-rejection' | 'spki-rejection';
export type TlsExpectation = 'success' | TlsFailureExpectation;
export type TlsFixtureRole =
  | 'owner'
  | 'app'
  | 'tenant-authority'
  | 'scheduler'
  | 'worker'
  | 'adapter-ops';
export type TlsFixtureRoute = 'direct' | 'l4-passthrough' | 'terminating-proxy';

export interface TlsFixtureEndpoints {
  directPort: number;
  l4Port: number;
  terminatingPort: number;
}

export interface TlsFixtureMaterial {
  caFile: string;
  untrustedCaFile: string;
  expectedSpkiSha256: string;
  rolePasswords: Readonly<Record<TlsFixtureRole, string>>;
}

export interface TlsFixtureCase {
  name: string;
  expectation: TlsExpectation;
  role: TlsFixtureRole;
  databaseRole: string;
  route: TlsFixtureRoute;
  connectionString: string;
  caFile: string;
  expectedSpkiSha256: string;
}

export interface FixtureRoleDefinition {
  role: TlsFixtureRole;
  databaseRole: string;
  passwordEnvironment: string;
}

export const FIXTURE_ROLES: readonly FixtureRoleDefinition[] = [
  { role: 'owner', databaseRole: 'fixture_owner', passwordEnvironment: 'FIXTURE_OWNER_PASSWORD' },
  { role: 'app', databaseRole: 'fixture_app', passwordEnvironment: 'FIXTURE_APP_PASSWORD' },
  {
    role: 'tenant-authority',
    databaseRole: 'fixture_tenant_authority',
    passwordEnvironment: 'FIXTURE_TENANT_AUTHORITY_PASSWORD',
  },
  {
    role: 'scheduler',
    databaseRole: 'fixture_scheduler',
    passwordEnvironment: 'FIXTURE_SCHEDULER_PASSWORD',
  },
  { role: 'worker', databaseRole: 'fixture_worker', passwordEnvironment: 'FIXTURE_WORKER_PASSWORD' },
  {
    role: 'adapter-ops',
    databaseRole: 'fixture_adapter_ops',
    passwordEnvironment: 'FIXTURE_ADAPTER_OPS_PASSWORD',
  },
];

function fixtureDsn(databaseRole: string, password: string, host: string, port: number): string {
  return `postgres://${encodeURIComponent(databaseRole)}:${encodeURIComponent(password)}@${host}:${port}/fixture?sslmode=verify-full`;
}

export function buildTlsFixtureCases(
  endpoints: TlsFixtureEndpoints,
  material: TlsFixtureMaterial,
): TlsFixtureCase[] {
  const supportedCases = FIXTURE_ROLES.flatMap(({ role, databaseRole }) => {
    const password = material.rolePasswords[role];
    if (!password)
      throw new Error(`FIXTURE_${role.toUpperCase().replace('-', '_')}_PASSWORD_REQUIRED`);
    return [
      {
        name: `${role} direct TLS`,
        expectation: 'success' as const,
        role,
        databaseRole,
        route: 'direct' as const,
        connectionString: fixtureDsn(databaseRole, password, 'localhost', endpoints.directPort),
        caFile: material.caFile,
        expectedSpkiSha256: material.expectedSpkiSha256,
      },
      {
        name: `${role} L4 TLS passthrough`,
        expectation: 'success' as const,
        role,
        databaseRole,
        route: 'l4-passthrough' as const,
        connectionString: fixtureDsn(databaseRole, password, 'localhost', endpoints.l4Port),
        caFile: material.caFile,
        expectedSpkiSha256: material.expectedSpkiSha256,
      },
    ];
  });
  const owner = FIXTURE_ROLES[0]!;
  const ownerPassword = material.rolePasswords[owner.role];
  return [
    ...supportedCases,
    {
      name: 'untrusted CA',
      expectation: 'ca-rejection',
      role: owner.role,
      databaseRole: owner.databaseRole,
      route: 'direct',
      connectionString: fixtureDsn(
        owner.databaseRole,
        ownerPassword,
        'localhost',
        endpoints.directPort,
      ),
      caFile: material.untrustedCaFile,
      expectedSpkiSha256: material.expectedSpkiSha256,
    },
    {
      name: 'wrong hostname',
      expectation: 'hostname-rejection',
      role: owner.role,
      databaseRole: owner.databaseRole,
      route: 'direct',
      connectionString: fixtureDsn(
        owner.databaseRole,
        ownerPassword,
        '127.0.0.1',
        endpoints.directPort,
      ),
      caFile: material.caFile,
      expectedSpkiSha256: material.expectedSpkiSha256,
    },
    {
      name: 'wrong SPKI pin',
      expectation: 'spki-rejection',
      role: owner.role,
      databaseRole: owner.databaseRole,
      route: 'direct',
      connectionString: fixtureDsn(
        owner.databaseRole,
        ownerPassword,
        'localhost',
        endpoints.directPort,
      ),
      caFile: material.caFile,
      expectedSpkiSha256: '0'.repeat(64),
    },
    {
      name: 'terminating proxy',
      expectation: 'spki-rejection',
      role: owner.role,
      databaseRole: owner.databaseRole,
      route: 'terminating-proxy',
      connectionString: fixtureDsn(
        owner.databaseRole,
        ownerPassword,
        'localhost',
        endpoints.terminatingPort,
      ),
      caFile: material.caFile,
      expectedSpkiSha256: material.expectedSpkiSha256,
    },
  ];
}

export interface TlsFixtureProof {
  role: TlsFixtureRole;
  databaseRole: string;
  route: Exclude<TlsFixtureRoute, 'terminating-proxy'>;
  databaseOid: string;
  databaseName: string;
  serverSpkiSha256: string;
  tlsActive: boolean;
  challenge: string;
}

export interface TlsFixtureEvidence {
  schemaVersion: 1;
  generatedAt: string;
  serverSpkiSha256: string;
  proofs: TlsFixtureProof[];
  negativeChecks: Array<{ name: string; expectation: TlsFailureExpectation }>;
}

const EXPECTED_NEGATIVE_CHECKS: ReadonlyArray<
  Readonly<{ name: string; expectation: TlsFailureExpectation }>
> = [
  { name: 'untrusted CA', expectation: 'ca-rejection' },
  { name: 'wrong hostname', expectation: 'hostname-rejection' },
  { name: 'wrong SPKI pin', expectation: 'spki-rejection' },
  { name: 'terminating proxy', expectation: 'spki-rejection' },
];

export function assertSanitizedTlsEvidence(
  evidence: unknown,
): asserts evidence is TlsFixtureEvidence {
  const rendered = JSON.stringify(evidence);
  assert.ok(rendered, 'TLS_FIXTURE_EVIDENCE_INVALID');
  assert.doesNotMatch(
    rendered,
    /postgres(?:ql)?:\/\/|(?:password|credential|secret|dsn|connectionString)/i,
    'TLS_FIXTURE_EVIDENCE_SECRET_LEAK',
  );

  const value = evidence as TlsFixtureEvidence;
  assert.equal(value.schemaVersion, 1, 'TLS_FIXTURE_EVIDENCE_SCHEMA_INVALID');
  assert.match(value.serverSpkiSha256, /^[a-f0-9]{64}$/, 'TLS_FIXTURE_EVIDENCE_SPKI_INVALID');
  assert.equal(
    value.proofs.length,
    FIXTURE_ROLES.length * 2,
    'TLS_FIXTURE_EVIDENCE_PROOF_COUNT_INVALID',
  );
  assert.deepEqual(
    value.negativeChecks,
    EXPECTED_NEGATIVE_CHECKS,
    'TLS_FIXTURE_EVIDENCE_NEGATIVE_CHECKS_INVALID',
  );

  const challenge = new Set<string>();
  const identities = new Set<string>();
  for (const proof of value.proofs) {
    assert.equal(proof.tlsActive, true, 'TLS_FIXTURE_EVIDENCE_TLS_INACTIVE');
    assert.equal(proof.serverSpkiSha256, value.serverSpkiSha256, 'TLS_FIXTURE_EVIDENCE_SPKI_DRIFT');
    assert.ok(
      proof.challenge && !challenge.has(proof.challenge),
      'TLS_FIXTURE_EVIDENCE_CHALLENGE_NOT_FRESH',
    );
    challenge.add(proof.challenge);
    identities.add(
      `${proof.databaseOid}\u0000${proof.databaseName}\u0000${proof.serverSpkiSha256}`,
    );
  }
  assert.equal(identities.size, 1, 'TLS_FIXTURE_EVIDENCE_DATABASE_IDENTITY_DRIFT');

  for (const { role, databaseRole } of FIXTURE_ROLES) {
    const roleProofs = value.proofs.filter((proof) => proof.role === role);
    assert.deepEqual(
      roleProofs.map((proof) => proof.route).sort(),
      ['direct', 'l4-passthrough'],
      `TLS_FIXTURE_EVIDENCE_ROUTE_COVERAGE_INVALID:${role}`,
    );
    assert.ok(
      roleProofs.every((proof) => proof.databaseRole === databaseRole),
      `TLS_FIXTURE_EVIDENCE_ROLE_IDENTITY_INVALID:${role}`,
    );
  }
}

function errorText(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' | ');
}

const TLS_FAILURE_PATTERNS: Record<TlsFailureExpectation, RegExp> = {
  'ca-rejection':
    /self[- ]signed|unable to (?:get local issuer certificate|verify)|certificate chain|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i,
  'hostname-rejection': /ERR_TLS_CERT_ALTNAME_INVALID|Hostname\/IP does not match certificate/i,
  'spki-rejection': /COMMANDER_DATABASE_SERVER_SPKI_MISMATCH/,
};

export function assertExpectedTlsFailure(expectation: TlsFailureExpectation, error: unknown): void {
  const rendered = errorText(error);
  assert.match(
    rendered,
    TLS_FAILURE_PATTERNS[expectation],
    `expected ${expectation}, received ${rendered}`,
  );
}

function certificateSpkiSha256(certificateFile: string): string {
  const certificate = new X509Certificate(readFileSync(certificateFile));
  const spki = certificate.publicKey.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(spki).digest('hex');
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name}_INVALID`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 65_535) throw new Error(`${name}_INVALID`);
  return value;
}

async function exerciseFixtureCase(testCase: TlsFixtureCase): Promise<TlsFixtureProof | undefined> {
  const pool = createVerifiedPostgresPool(
    {
      connectionString: testCase.connectionString,
      connectionTimeoutMillis: 3_000,
      max: 1,
    },
    {
      COMMANDER_DATABASE_TLS_CA_FILE: testCase.caFile,
      COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: testCase.expectedSpkiSha256,
    },
  );

  try {
    const challenge = randomUUID();
    const result = await pool.query<{
      database_role: string;
      database_oid: string;
      database_name: string;
      tls_active: boolean;
      challenge: string;
    }>(
      'SELECT current_user AS database_role, database.oid::text AS database_oid, current_database() AS database_name, ssl.ssl AS tls_active, $1::text AS challenge FROM pg_database AS database JOIN pg_stat_ssl AS ssl ON ssl.pid = pg_backend_pid() WHERE database.datname = current_database()',
      [challenge],
    );
    if (testCase.expectation !== 'success') {
      throw new Error(`${testCase.name} unexpectedly connected`);
    }
    assert.deepEqual(result.rows, [
      {
        database_role: testCase.databaseRole,
        database_oid: result.rows[0]?.database_oid,
        database_name: 'fixture',
        tls_active: true,
        challenge,
      },
    ]);
    return {
      role: testCase.role,
      databaseRole: testCase.databaseRole,
      route: testCase.route as TlsFixtureProof['route'],
      databaseOid: result.rows[0]!.database_oid,
      databaseName: result.rows[0]!.database_name,
      serverSpkiSha256: testCase.expectedSpkiSha256,
      tlsActive: result.rows[0]!.tls_active,
      challenge: result.rows[0]!.challenge,
    };
  } catch (error) {
    if (testCase.expectation === 'success') throw error;
    assertExpectedTlsFailure(testCase.expectation, error);
  } finally {
    await pool.end();
  }
  return undefined;
}

function rolePasswordsFromEnvironment(env: NodeJS.ProcessEnv): Record<TlsFixtureRole, string> {
  return Object.fromEntries(
    FIXTURE_ROLES.map(({ role, passwordEnvironment }) => {
      const password = env[passwordEnvironment];
      if (!password) throw new Error(`${passwordEnvironment}_REQUIRED`);
      return [role, password];
    }),
  ) as Record<TlsFixtureRole, string>;
}

export async function runTlsFixtureMatrix(
  stateDirectory: string,
  endpoints: TlsFixtureEndpoints,
): Promise<void> {
  const material = {
    caFile: resolve(stateDirectory, 'ca.crt'),
    untrustedCaFile: resolve(stateDirectory, 'untrusted-ca.crt'),
    expectedSpkiSha256: certificateSpkiSha256(resolve(stateDirectory, 'postgres.crt')),
    rolePasswords: rolePasswordsFromEnvironment(process.env),
  };
  const terminatingSpki = certificateSpkiSha256(resolve(stateDirectory, 'terminator.crt'));
  assert.notEqual(
    terminatingSpki,
    material.expectedSpkiSha256,
    'terminating proxy must present a different public key',
  );

  const proofs: TlsFixtureProof[] = [];
  const negativeChecks: TlsFixtureEvidence['negativeChecks'] = [];
  for (const testCase of buildTlsFixtureCases(endpoints, material)) {
    const proof = await exerciseFixtureCase(testCase);
    if (proof) proofs.push(proof);
    if (testCase.expectation !== 'success') {
      negativeChecks.push({ name: testCase.name, expectation: testCase.expectation });
    }
    process.stdout.write(`PASS ${testCase.name}: ${testCase.expectation}\n`);
  }

  const evidence: TlsFixtureEvidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    serverSpkiSha256: material.expectedSpkiSha256,
    proofs,
    negativeChecks,
  };
  assertSanitizedTlsEvidence(evidence);
  const evidenceFile = resolve(stateDirectory, 'tls-evidence.json');
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`PASS sanitized TLS evidence: ${evidence.proofs.length} proofs\n`);
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const stateDirectory = argumentValue('--state-dir');
  if (!stateDirectory) throw new Error('--state-dir is required');
  await runTlsFixtureMatrix(resolve(stateDirectory), {
    directPort: positiveIntegerEnvironment('DIRECT_PORT', 55_432),
    l4Port: positiveIntegerEnvironment('L4_PORT', 55_433),
    terminatingPort: positiveIntegerEnvironment('TERMINATING_PORT', 55_434),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${errorText(error)}\n`);
    process.exitCode = 1;
  });
}
