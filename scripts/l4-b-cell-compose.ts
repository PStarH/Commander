/**
 * Shared cell compose helpers — env, up, health.
 * Kept separate so cell-smoke and compensation-e2e do not import each other.
 */

import { createHash, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CELL_E2E_TENANT = 'cell-smoke-tenant';

/** Ephemeral Ed25519 materials for cell worker/adapter authority (fail-closed compose). */
export function generateCellCapabilityMaterials(): {
  COMMANDER_CAPABILITY_PRIVATE_KEY_PEM: string;
  COMMANDER_CAPABILITY_KEY_ID: string;
  COMMANDER_CAPABILITY_JWKS_JSON: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string };
  const keyId = `cell-${Date.now().toString(36)}`;
  return {
    COMMANDER_CAPABILITY_PRIVATE_KEY_PEM: pem,
    COMMANDER_CAPABILITY_KEY_ID: keyId,
    COMMANDER_CAPABILITY_JWKS_JSON: JSON.stringify({
      keys: [{ kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid: keyId }],
    }),
  };
}

/** Ephemeral Ed25519 material for the worker's retained-evidence signer. */
export function generateCellEvidenceSigningMaterials(): {
  COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM: string;
  COMMANDER_EVIDENCE_SIGNING_KEY_ID: string;
} {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM: privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    COMMANDER_EVIDENCE_SIGNING_KEY_ID: `cell-evidence-${Date.now().toString(36)}`,
  };
}

export function generateCellDatabaseTlsMaterials(): {
  COMMANDER_CELL_DATABASE_TLS_CA_HOST_FILE: string;
  COMMANDER_CELL_DATABASE_TLS_CERT_HOST_FILE: string;
  COMMANDER_CELL_DATABASE_TLS_KEY_HOST_FILE: string;
  COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: string;
} {
  const directory = mkdtempSync(join(process.cwd(), '.commander_cell_database_tls_'));
  process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
  const caKey = join(directory, 'ca.key');
  const caCert = join(directory, 'ca.crt');
  const serverKey = join(directory, 'tls.key');
  const serverCsr = join(directory, 'tls.csr');
  const serverCert = join(directory, 'tls.crt');
  const extensions = join(directory, 'server.ext');

  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-keyout',
      caKey,
      '-out',
      caCert,
      '-subj',
      '/CN=Commander Cell Database CA',
    ],
    { stdio: 'ignore' },
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      serverKey,
      '-out',
      serverCsr,
      '-subj',
      '/CN=postgres',
    ],
    { stdio: 'ignore' },
  );
  writeFileSync(
    extensions,
    'subjectAltName=DNS:postgres\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n',
    { mode: 0o600 },
  );
  execFileSync(
    'openssl',
    [
      'x509',
      '-req',
      '-days',
      '2',
      '-in',
      serverCsr,
      '-CA',
      caCert,
      '-CAkey',
      caKey,
      '-CAcreateserial',
      '-out',
      serverCert,
      '-extfile',
      extensions,
    ],
    { stdio: 'ignore' },
  );
  chmodSync(serverKey, 0o600);

  const certificate = new X509Certificate(readFileSync(serverCert));
  const spki = certificate.publicKey.export({ format: 'der', type: 'spki' });
  return {
    COMMANDER_CELL_DATABASE_TLS_CA_HOST_FILE: caCert,
    COMMANDER_CELL_DATABASE_TLS_CERT_HOST_FILE: serverCert,
    COMMANDER_CELL_DATABASE_TLS_KEY_HOST_FILE: serverKey,
    COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: createHash('sha256')
      .update(spki)
      .digest('hex'),
  };
}

const CELL_CAPABILITY_MATERIALS = generateCellCapabilityMaterials();
const CELL_EVIDENCE_SIGNING_MATERIALS = generateCellEvidenceSigningMaterials();
const CELL_DATABASE_TLS_MATERIALS = generateCellDatabaseTlsMaterials();

const COMPOSE_SECRET_DEFAULTS = {
  POSTGRES_PASSWORD: 'ci-cell-smoke',
  COMMANDER_API_KEY: 'ci-cell-smoke-api-key',
  COMMANDER_MASTER_KEY: 'ci-cell-smoke-master-key-32chars!!',
  JWT_SECRET: 'ci-cell-smoke-jwt-secret',
  // API legacy HMAC only — not worker/adapter authority.
  COMMANDER_CAPABILITY_TOKEN_KEY: 'ci-cell-smoke-capability-key',
  COMMANDER_INTEGRITY_KEY: 'ci-cell-smoke-integrity-key',
  COMMANDER_WORKER_AUTH_TOKEN: 'ci-cell-smoke-worker-token',
} as const;

type CellComposeSecretName = keyof typeof COMPOSE_SECRET_DEFAULTS;

function resolveCellComposeSecret(env: NodeJS.ProcessEnv, name: CellComposeSecretName): string {
  const value = env[name];
  if (value === undefined || value === '') return COMPOSE_SECRET_DEFAULTS[name];
  if (value.length < 16 || value.trim() !== value || /[\0\r\n]/.test(value)) {
    throw new Error(`INVALID_CELL_COMPOSE_SECRET:${name}`);
  }
  if (name === 'COMMANDER_API_KEY' && /[:;]/.test(value)) {
    throw new Error(`INVALID_CELL_COMPOSE_SECRET:${name}`);
  }
  return value;
}

export function createCellComposeConfigEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const secrets = Object.fromEntries(
    (Object.keys(COMPOSE_SECRET_DEFAULTS) as CellComposeSecretName[]).map((name) => [
      name,
      resolveCellComposeSecret(env, name),
    ]),
  ) as Record<CellComposeSecretName, string>;
  return {
    ...secrets,
    COMMANDER_WORKER_TENANTS: CELL_E2E_TENANT,
    COMMANDER_WORKER_ALLOWED_TENANTS: CELL_E2E_TENANT,
    ...CELL_CAPABILITY_MATERIALS,
    ...CELL_EVIDENCE_SIGNING_MATERIALS,
    ...CELL_DATABASE_TLS_MATERIALS,
  };
}

export const COMPOSE_CONFIG_ENV: Record<string, string> = createCellComposeConfigEnv();

/** GID of docker.sock as seen inside a container (Colima often uses 991). */
export function resolveDockerGid(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    execute?: (command: string) => string;
  } = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const execute =
    options.execute ??
    ((command: string) =>
      execSync(command, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim());
  if (env.DOCKER_GID && /^\d+$/.test(env.DOCKER_GID)) {
    return env.DOCKER_GID;
  }
  try {
    const out = execute(
      'docker run --rm -v /var/run/docker.sock:/var/run/docker.sock alpine stat -c %g /var/run/docker.sock',
    ).trim();
    if (/^\d+$/.test(out)) return out;
  } catch {
    /* fall through */
  }
  const statCommand =
    platform === 'darwin' ? 'stat -f %g /var/run/docker.sock' : 'stat -c %g /var/run/docker.sock';
  try {
    const out = execute(statCommand).trim();
    if (/^\d+$/.test(out)) return out;
  } catch {
    /* fall through */
  }
  return '0';
}

export function createCellComposeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const config = createCellComposeConfigEnv(env);
  // In-compose Postgres DSN must override any host DATABASE_URL (e.g. :5433 test PG).
  const postgresUrl = `postgres://commander:${encodeURIComponent(config.POSTGRES_PASSWORD)}@postgres:5432/commander?sslmode=verify-full`;
  return {
    ...config,
    DATABASE_URL: postgresUrl,
    COMMANDER_KERNEL_DATABASE_URL: postgresUrl,
    COMMANDER_ENABLE_DEMO_TICKET: '1',
    COMMANDER_CELL_TENANT_ID: CELL_E2E_TENANT,
    // Single-tenant cell escape hatch for v1TenantGuard (NullTenantProvider).
    COMMANDER_DEFAULT_TENANT_ID: CELL_E2E_TENANT,
    API_KEYS: `${config.COMMANDER_API_KEY}:cell-e2e:admin;actions:approve`,
    TENANT_API_KEYS: `${CELL_E2E_TENANT}:${config.COMMANDER_API_KEY}`,
    GITHUB_TOKEN: env.CELL_E2E_GITHUB_TOKEN ?? 'cell-e2e-github-token',
    DOCKER_GID: resolveDockerGid({ env }),
  };
}

export const CELL_COMPOSE_ENV: Record<string, string> = createCellComposeEnv();

export const COMPOSE_CMD =
  'docker compose -f docker-compose.yml -f docker-compose.cell.yml --profile cell';

function composeExec(script: string, service: string): boolean {
  try {
    execSync(`${COMPOSE_CMD} exec -T ${service} node -e ${JSON.stringify(script)}`, {
      cwd: process.cwd(),
      env: { ...process.env, ...CELL_COMPOSE_ENV },
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/** Ensure DockerSB probe image exists locally (Colima often lacks registry DNS). */
export function ensureCellSandboxImage(): void {
  try {
    execSync('docker image inspect node:22-slim', { stdio: 'pipe' });
    return;
  } catch {
    /* missing */
  }
  try {
    execSync('docker image inspect node:22.14.0-alpine', { stdio: 'pipe' });
    execSync('docker tag node:22.14.0-alpine node:22-slim', { stdio: 'pipe' });
    return;
  } catch {
    /* fall through to pull */
  }
  execSync('docker pull node:22-slim', { stdio: 'pipe' });
}

export function tryComposeCellUp(): { ok: boolean; error?: string } {
  // CELL_COMPOSE_ENV must win over host DATABASE_URL (local :5433 probes).
  const env = { ...process.env, ...CELL_COMPOSE_ENV };
  try {
    ensureCellSandboxImage();
    try {
      execSync(`${COMPOSE_CMD} down -v --remove-orphans`, {
        cwd: process.cwd(),
        env,
        stdio: 'pipe',
      });
    } catch {
      /* ignore — stack may not exist yet */
    }
    try {
      execSync('docker network rm l4-b_default', { stdio: 'pipe', env });
    } catch {
      /* ignore */
    }
    // Fixed container_name can survive a failed/partial up outside compose project labels.
    try {
      execSync('docker rm -f commander-postgres', { stdio: 'pipe', env });
    } catch {
      /* ignore */
    }
    execSync(`${COMPOSE_CMD} up -d --build`, {
      cwd: process.cwd(),
      env,
      stdio: 'pipe',
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export function tryComposeCellDown(
  options: {
    execute?: (command: string, env: NodeJS.ProcessEnv) => void;
  } = {},
): { ok: boolean; error?: string } {
  const env = { ...process.env, ...CELL_COMPOSE_ENV };
  const execute =
    options.execute ??
    ((command: string, runtimeEnv: NodeJS.ProcessEnv) => {
      execSync(command, { cwd: process.cwd(), env: runtimeEnv, stdio: 'pipe' });
    });
  try {
    execute(`${COMPOSE_CMD} down -v --remove-orphans`, env);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function probeOnce(baseUrl: string): Promise<Record<string, boolean>> {
  // /ready and /health are public probe paths (no Bearer — API keys as Bearer
  // are not JWTs and unauthenticated hammering used to lock out the client IP).
  const ready = await fetch(`${baseUrl}/ready`).catch(() => null);
  const health = await fetch(`${baseUrl}/health`).catch(() => null);
  const worker = composeExec(
    "fetch('http://127.0.0.1:8083/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
    'worker',
  );
  const kernelOps = composeExec(
    "const p=process.env.COMMANDER_OPS_HEALTH_PORT||'8081';fetch('http://127.0.0.1:'+p+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
    'kernel-ops',
  );
  const adapterOps = composeExec(
    "fetch('http://127.0.0.1:8082/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
    'adapter-ops',
  );
  const adapterOpsReady = composeExec(
    "fetch('http://127.0.0.1:8082/ready').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
    'adapter-ops',
  );
  return {
    apiReady: ready?.ok === true,
    apiHealth: health?.ok === true,
    workerHealth: worker,
    kernelOpsHealth: kernelOps,
    adapterOpsHealth: adapterOps,
    adapterOpsReady,
  };
}

export async function assertComposeCellHealth(
  baseUrl = 'http://localhost:4000',
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Record<string, boolean>> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 3_000;
  const start = Date.now();
  let last = await probeOnce(baseUrl);
  while (Date.now() - start < timeoutMs) {
    if (Object.values(last).every(Boolean)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await probeOnce(baseUrl);
  }
  return last;
}
