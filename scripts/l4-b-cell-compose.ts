/**
 * Shared cell compose helpers — env, up, health.
 * Kept separate so cell-smoke and compensation-e2e do not import each other.
 */

import { generateKeyPairSync } from 'node:crypto';
import { execSync } from 'node:child_process';

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

const CELL_CAPABILITY_MATERIALS = generateCellCapabilityMaterials();

export const COMPOSE_CONFIG_ENV: Record<string, string> = {
  POSTGRES_PASSWORD: 'ci-cell-smoke',
  COMMANDER_API_KEY: 'ci-cell-smoke-api-key',
  COMMANDER_MASTER_KEY: 'ci-cell-smoke-master-key-32chars!!',
  JWT_SECRET: 'ci-cell-smoke-jwt-secret',
  // API legacy HMAC only — not worker/adapter authority.
  COMMANDER_CAPABILITY_TOKEN_KEY: 'ci-cell-smoke-capability-key',
  COMMANDER_INTEGRITY_KEY: 'ci-cell-smoke-integrity-key',
  COMMANDER_WORKER_AUTH_TOKEN: 'ci-cell-smoke-worker-token',
  ...CELL_CAPABILITY_MATERIALS,
};

/** GID of docker.sock as seen inside a container (Colima often uses 991). */
export function resolveDockerGid(): string {
  if (process.env.DOCKER_GID && /^\d+$/.test(process.env.DOCKER_GID)) {
    return process.env.DOCKER_GID;
  }
  try {
    const out = execSync(
      'docker run --rm -v /var/run/docker.sock:/var/run/docker.sock alpine stat -c %g /var/run/docker.sock',
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (/^\d+$/.test(out)) return out;
  } catch {
    /* fall through */
  }
  try {
    const out = execSync('stat -c %g /var/run/docker.sock', { encoding: 'utf-8' }).trim();
    if (/^\d+$/.test(out)) return out;
  } catch {
    /* fall through */
  }
  return '0';
}

/** In-compose Postgres DSN — must override any host DATABASE_URL (e.g. :5433 test PG). */
const CELL_POSTGRES_URL = `postgres://commander:${COMPOSE_CONFIG_ENV.POSTGRES_PASSWORD}@postgres:5432/commander`;

export const CELL_COMPOSE_ENV: Record<string, string> = {
  ...COMPOSE_CONFIG_ENV,
  // Fail-closed vs host leakage: compose ${DATABASE_URL:-…} otherwise picks up
  // a local probe URL (127.0.0.1:5433) and kernel-migrate gets ECONNREFUSED.
  DATABASE_URL: CELL_POSTGRES_URL,
  COMMANDER_KERNEL_DATABASE_URL: CELL_POSTGRES_URL,
  COMMANDER_ENABLE_DEMO_TICKET: '1',
  COMMANDER_CELL_TENANT_ID: CELL_E2E_TENANT,
  // Single-tenant cell escape hatch for v1TenantGuard (NullTenantProvider).
  COMMANDER_DEFAULT_TENANT_ID: CELL_E2E_TENANT,
  API_KEYS: `${COMPOSE_CONFIG_ENV.COMMANDER_API_KEY}:cell-e2e:admin;actions:approve`,
  TENANT_API_KEYS: `${CELL_E2E_TENANT}:${COMPOSE_CONFIG_ENV.COMMANDER_API_KEY}`,
  GITHUB_TOKEN: process.env.CELL_E2E_GITHUB_TOKEN ?? 'cell-e2e-github-token',
  DOCKER_GID: resolveDockerGid(),
};

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
  return {
    apiReady: ready?.ok === true,
    apiHealth: health?.ok === true,
    workerHealth: worker,
    kernelOpsHealth: kernelOps,
    adapterOpsHealth: adapterOps,
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
