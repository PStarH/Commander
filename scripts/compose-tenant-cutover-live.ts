#!/usr/bin/env tsx

import { execFile } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runComposeTenantCutoverCli } from './compose-tenant-cutover.js';

const executeFile = promisify(execFile);
const IMAGE = /^[^\s]+@sha256:[0-9a-f]{64}$/;
const IMAGE_ENV = [
  'COMMANDER_PRECLOSURE_API_IMAGE',
  'COMMANDER_EXPAND_API_IMAGE',
  'COMMANDER_ENFORCE_API_IMAGE',
  'COMMANDER_POSTGRES_IMAGE',
  'COMMANDER_MIGRATOR_IMAGE',
  'COMMANDER_KERNEL_OPS_IMAGE',
  'COMMANDER_WORKER_IMAGE',
  'COMMANDER_ADAPTER_OPS_IMAGE',
] as const;

function requiredImage(environment: NodeJS.ProcessEnv, name: (typeof IMAGE_ENV)[number]): string {
  const value = environment[name]?.trim();
  if (!value || !IMAGE.test(value)) throw new Error('COMPOSE_LIVE_DIGEST_IMAGE_REQUIRED');
  return value;
}

function password(): string {
  return randomBytes(32).toString('hex');
}

function databaseUrl(user: string, secret: string): string {
  const url = new URL('postgresql://postgres:5432/commander');
  url.username = user;
  url.password = secret;
  url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

async function run(
  program: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await executeFile(program, [...args], {
    cwd: REPOSITORY_ROOT,
    env: environment,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });
  return result.stdout.trim();
}

async function createCa(directory: string, name: string): Promise<{ ca: string; key: string }> {
  const ca = join(directory, `${name}-ca.crt`);
  const key = join(directory, `${name}-ca.key`);
  await run(
    'openssl',
    ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', key],
    process.env,
  );
  await run(
    'openssl',
    [
      'req',
      '-x509',
      '-new',
      '-sha256',
      '-days',
      '2',
      '-subj',
      `/CN=commander-${name}-live-ca`,
      '-key',
      key,
      '-out',
      ca,
    ],
    process.env,
  );
  return { ca, key };
}

async function createLeaf(
  directory: string,
  name: string,
  dnsName: string,
  authority: { ca: string; key: string },
): Promise<{ certificate: string; key: string }> {
  const certificate = join(directory, `${name}.crt`);
  const key = join(directory, `${name}.key`);
  const request = join(directory, `${name}.csr`);
  const extensions = join(directory, `${name}.ext`);
  await writeFile(
    extensions,
    [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=DNS:${dnsName}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  await run(
    'openssl',
    ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', key],
    process.env,
  );
  await run(
    'openssl',
    ['req', '-new', '-sha256', '-subj', `/CN=${dnsName}`, '-key', key, '-out', request],
    process.env,
  );
  await run(
    'openssl',
    [
      'x509',
      '-req',
      '-sha256',
      '-days',
      '2',
      '-in',
      request,
      '-CA',
      authority.ca,
      '-CAkey',
      authority.key,
      '-CAcreateserial',
      '-extfile',
      extensions,
      '-out',
      certificate,
    ],
    process.env,
  );
  return { certificate, key };
}

async function serverSpkiSha256(certificatePath: string): Promise<string> {
  const certificate = new X509Certificate(await readFile(certificatePath));
  const publicKey = certificate.publicKey.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(publicKey).digest('hex');
}

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function main(): Promise<void> {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    throw new Error('COMPOSE_LIVE_ROOT_REQUIRED');
  }
  const composeVersion = await run('docker', ['compose', 'version', '--short'], process.env);
  if (composeVersion !== '5.3.1') throw new Error('COMPOSE_LIVE_VERSION_MISMATCH');

  const suppliedImages = Object.fromEntries(
    IMAGE_ENV.map((name) => [name, requiredImage(process.env, name)]),
  ) as Record<(typeof IMAGE_ENV)[number], string>;
  for (const image of Object.values(suppliedImages)) {
    await run('docker', ['image', 'inspect', image], process.env);
  }

  const fixtureRoot = resolve(REPOSITORY_ROOT, '.tmp');
  await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
  const fixtureDirectory = await mkdtemp(join(fixtureRoot, 'commander-compose-cutover-live-'));
  const projectName = `commander-live-${process.pid}-${randomBytes(4).toString('hex')}`;
  const stateDirectory = resolve(REPOSITORY_ROOT, '.commander', 'tenant-cutover', projectName);
  let composeEnvironment: NodeJS.ProcessEnv | undefined;
  let composeBase: string[] | undefined;
  let evidence:
    | {
        status: 'PASS';
        operationVersion: string;
        descriptorCount: string;
        proofCount: string;
      }
    | undefined;
  let cleanupFailed = false;
  try {
    const postgresCa = await createCa(fixtureDirectory, 'postgres');
    const postgres = await createLeaf(fixtureDirectory, 'postgres', 'postgres', postgresCa);
    const apiCa = await createCa(fixtureDirectory, 'api-proof');
    const api = await createLeaf(fixtureDirectory, 'api-proof', 'api', apiCa);
    await Promise.all([
      chmod(postgresCa.ca, 0o444),
      chmod(postgres.certificate, 0o444),
      chmod(postgres.key, 0o400),
      chmod(apiCa.ca, 0o444),
      chmod(api.certificate, 0o444),
      chmod(api.key, 0o400),
    ]);

    const postgresPassword = password();
    const credentials = {
      COMMANDER_POSTGRES_SUPERUSER_PASSWORD: postgresPassword,
      COMMANDER_OWNER_DATABASE_URL: databaseUrl('commander_owner', password()),
      COMMANDER_API_DATABASE_URL: databaseUrl('commander_app', password()),
      COMMANDER_TENANT_AUTHORITY_DATABASE_URL: databaseUrl(
        'commander_tenant_authority',
        password(),
      ),
      COMMANDER_SCHEDULER_DATABASE_URL: databaseUrl('commander_scheduler', password()),
      COMMANDER_WORKER_DATABASE_URL: databaseUrl('commander_worker', password()),
      COMMANDER_ADAPTER_OPS_DATABASE_URL: databaseUrl('commander_adapter_ops', password()),
      COMMANDER_BOOTSTRAP_AUTHORITY_DATABASE_URL: databaseUrl('postgres', postgresPassword),
    };
    const cutoverEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      ...suppliedImages,
      ...credentials,
      COMPOSE_PROJECT_NAME: projectName,
      COMMANDER_ALLOWED_TENANTS: 'commander/readiness/v1',
      COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: await serverSpkiSha256(
        postgres.certificate,
      ),
      COMMANDER_POSTGRES_TLS_CA_HOST_FILE: postgresCa.ca,
      COMMANDER_POSTGRES_TLS_CERT_HOST_FILE: postgres.certificate,
      COMMANDER_POSTGRES_TLS_KEY_HOST_FILE: postgres.key,
      COMMANDER_API_PROOF_CA_HOST_FILE: apiCa.ca,
      COMMANDER_API_PROOF_CERT_HOST_FILE: api.certificate,
      COMMANDER_API_PROOF_KEY_HOST_FILE: api.key,
    };
    const enforceImage = suppliedImages.COMMANDER_ENFORCE_API_IMAGE;
    composeEnvironment = {
      ...cutoverEnvironment,
      COMMANDER_API_IMAGE: enforceImage,
      COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE: 'enforce',
      COMMANDER_TENANT_AUTHORITY_IMAGE_DIGEST: enforceImage.slice(
        enforceImage.lastIndexOf('@') + 1,
      ),
      COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256: '0'.repeat(64),
    };
    composeBase = [
      'compose',
      '--project-name',
      projectName,
      '-f',
      resolve(REPOSITORY_ROOT, 'docker-compose.prod.yml'),
      '-f',
      resolve(REPOSITORY_ROOT, 'docker-compose.prod.install.yml'),
    ];
    await run(
      'docker',
      [...composeBase, 'down', '--volumes', '--remove-orphans'],
      composeEnvironment,
    );
    const result = await runComposeTenantCutoverCli(
      ['install'],
      cutoverEnvironment,
      REPOSITORY_ROOT,
    );
    const sql = async (statement: string): Promise<string> =>
      run(
        'docker',
        [
          ...composeBase,
          'exec',
          '-T',
          'postgres',
          'psql',
          '--set',
          'ON_ERROR_STOP=1',
          '--username',
          'postgres',
          '--dbname',
          'commander',
          '--tuples-only',
          '--no-align',
          '--command',
          statement,
        ],
        composeEnvironment,
      );
    const descriptorCount = await sql(`
      SELECT count(*)::text
        FROM public.commander_kernel_migrations
       WHERE id IN (
         '2026-07-27.1.task1_helm_lifecycle_gate',
         '2026-07-27.2.task1_authenticated_tenant_authority_expand',
         '2026-07-27.3.task1_authenticated_tenant_authority_enforce'
       )
    `);
    const proofCount = await sql(`
      SELECT count(*)::text
        FROM public.commander_tenant_cutover_rollout_proofs AS proof
        JOIN public.commander_tenant_cutover_state AS state
          ON state.installation_uuid = proof.installation_uuid
         AND state.current_runtime_operation_version = proof.operation_version
       WHERE proof.rollout_proof_jcs::jsonb ->> 'format' = 'rollout-proof/v1'
         AND proof.rollout_proof_jcs::jsonb ->> 'topology' = 'compose'
         AND length(
           proof.rollout_proof_jcs::jsonb -> 'challengedResponse' ->> 'challenge'
         ) = 43
    `);
    if (descriptorCount !== '3' || proofCount !== '1') {
      throw new Error('COMPOSE_LIVE_DATABASE_EVIDENCE_INVALID');
    }
    const relayEntries = await readdir(resolve(stateDirectory, 'proof-relay')).catch(() => []);
    if (relayEntries.some((entry) => entry.endsWith('.sock'))) {
      throw new Error('COMPOSE_LIVE_RELAY_CLEANUP_FAILED');
    }
    evidence = {
      status: 'PASS',
      operationVersion: result.operation.operationVersion,
      descriptorCount,
      proofCount,
    };
  } finally {
    if (composeBase && composeEnvironment) {
      try {
        await run(
          'docker',
          [...composeBase, 'down', '--volumes', '--remove-orphans'],
          composeEnvironment,
        );
      } catch {
        cleanupFailed = true;
      }
    }
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
  if (cleanupFailed) throw new Error('COMPOSE_LIVE_CLEANUP_FAILED');
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch(() => {
    process.stderr.write('compose tenant-cutover live fixture failed\n');
    process.exitCode = 1;
  });
}
