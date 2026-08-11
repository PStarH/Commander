#!/usr/bin/env tsx
/**
 * L4-B cell stack up + health assert (D1/D2/D3/D6 evidence).
 *
 *   pnpm cell:up-assert [--keep] [--help]
 *
 * Adversarial default: DOCKER_GID=0 (no host sock GID auto-detect).
 * Always `docker compose … down -v` in finally unless --keep.
 */

import { execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CELL_E2E_TENANT,
  COMPOSE_CMD,
  ensureCellSandboxImage,
  generateCellCapabilityMaterials,
} from './l4-b-cell-compose.js';

export const CELL_UP_ASSERT_SERVICES = [
  'api',
  'worker',
  'kernel-ops',
  'adapter-ops',
  'postgres',
] as const;

const HELP = `L4-B cell up-assert — compose cell profile health + anonymous /ready hammer

Usage:
  pnpm cell:up-assert [--keep] [--help]

Options:
  --keep   Skip compose down -v after run (debug only)
  --help   Show this message

Env (optional — generated when unset):
  POSTGRES_PASSWORD, COMMANDER_API_KEY, COMMANDER_MASTER_KEY, JWT_SECRET,
  COMMANDER_CAPABILITY_TOKEN_KEY (API HMAC only — not worker/adapter authority),
  COMMANDER_INTEGRITY_KEY,
  COMMANDER_WORKER_AUTH_TOKEN,
  COMMANDER_CAPABILITY_PRIVATE_KEY_PEM / COMMANDER_CAPABILITY_KEY_ID /
  COMMANDER_CAPABILITY_JWKS_JSON (worker/adapter Ed25519; openssl/node when unset)

DOCKER_GID is forced to 0 for this harness (adversarial deploy default).
`;

function opensslHex(byteCount: number): string {
  return execSync(`openssl rand -hex ${byteCount}`, { encoding: 'utf-8' }).trim();
}

/** Compose env for up-assert: random secrets, DOCKER_GID=0 (never resolveDockerGid). */
export function buildCellUpAssertEnv(): Record<string, string> {
  const apiKey = process.env.COMMANDER_API_KEY ?? opensslHex(32);
  const postgresPassword = process.env.POSTGRES_PASSWORD ?? opensslHex(16);
  const masterKey = process.env.COMMANDER_MASTER_KEY ?? `${opensslHex(16)}!!`;
  const jwtSecret = process.env.JWT_SECRET ?? opensslHex(32);
  const capabilityKey = process.env.COMMANDER_CAPABILITY_TOKEN_KEY ?? opensslHex(32);
  const integrityKey = process.env.COMMANDER_INTEGRITY_KEY ?? opensslHex(32);
  const workerToken = process.env.COMMANDER_WORKER_AUTH_TOKEN ?? opensslHex(32);

  const capability =
    process.env.COMMANDER_CAPABILITY_PRIVATE_KEY_PEM &&
    process.env.COMMANDER_CAPABILITY_KEY_ID &&
    process.env.COMMANDER_CAPABILITY_JWKS_JSON
      ? {
          COMMANDER_CAPABILITY_PRIVATE_KEY_PEM: process.env.COMMANDER_CAPABILITY_PRIVATE_KEY_PEM,
          COMMANDER_CAPABILITY_KEY_ID: process.env.COMMANDER_CAPABILITY_KEY_ID,
          COMMANDER_CAPABILITY_JWKS_JSON: process.env.COMMANDER_CAPABILITY_JWKS_JSON,
        }
      : generateCellCapabilityMaterials();

  return {
    POSTGRES_PASSWORD: postgresPassword,
    COMMANDER_API_KEY: apiKey,
    COMMANDER_MASTER_KEY: masterKey,
    JWT_SECRET: jwtSecret,
    COMMANDER_CAPABILITY_TOKEN_KEY: capabilityKey,
    COMMANDER_INTEGRITY_KEY: integrityKey,
    COMMANDER_WORKER_AUTH_TOKEN: workerToken,
    COMMANDER_WORKER_TENANTS: CELL_E2E_TENANT,
    COMMANDER_WORKER_ALLOWED_TENANTS: CELL_E2E_TENANT,
    ...capability,
    COMMANDER_ENABLE_DEMO_TICKET: '1',
    COMMANDER_CELL_TENANT_ID: CELL_E2E_TENANT,
    COMMANDER_DEFAULT_TENANT_ID: CELL_E2E_TENANT,
    API_KEYS: `${apiKey}:cell-e2e:admin;actions:approve`,
    TENANT_API_KEYS: `${CELL_E2E_TENANT}:${apiKey}`,
    GITHUB_TOKEN: process.env.CELL_E2E_GITHUB_TOKEN ?? 'cell-e2e-github-token',
    DOCKER_GID: '0',
  };
}

type ComposePsRow = { Service?: string; Health?: string; State?: string };

export function parseComposePsHealth(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  const trimmed = stdout.trim();
  if (!trimmed) return map;
  const lines = trimmed.startsWith('[') ? (JSON.parse(trimmed) as ComposePsRow[]) : null;
  if (lines) {
    for (const row of lines) {
      if (row.Service) map.set(row.Service, row.Health ?? '');
    }
    return map;
  }
  for (const line of trimmed.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as ComposePsRow;
    if (row.Service) map.set(row.Service, row.Health ?? '');
  }
  return map;
}

export function allServicesHealthy(healthByService: Map<string, string>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const svc of CELL_UP_ASSERT_SERVICES) {
    out[svc] = healthByService.get(svc) === 'healthy';
  }
  return out;
}

export async function pollComposeDockerHealthy(
  composeEnv: Record<string, string>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ ok: boolean; last: Record<string, boolean> }> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const intervalMs = options.intervalMs ?? 3_000;
  const env = { ...process.env, ...composeEnv };
  const start = Date.now();
  let last = allServicesHealthy(new Map());

  while (Date.now() - start < timeoutMs) {
    try {
      const stdout = execSync(`${COMPOSE_CMD} ps --format json`, {
        cwd: process.cwd(),
        env,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const healthMap = parseComposePsHealth(stdout);
      last = allServicesHealthy(healthMap);
      if (Object.values(last).every(Boolean)) return { ok: true, last };
    } catch {
      /* stack still starting */
    }
    await sleep(intervalMs);
  }
  return { ok: false, last };
}

export async function assertAnonymousReadyHammer(
  baseUrl: string,
  count = 10,
): Promise<{ ok: boolean; statuses: number[] }> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) {
    const res = await fetch(`${baseUrl}/ready`).catch(() => null);
    statuses.push(res?.status ?? 0);
  }
  return { ok: statuses.every((s) => s === 200), statuses };
}

export function probeWorkerPid1User(composeEnv: Record<string, string>): {
  ok: boolean;
  raw: string;
  pid1User?: string;
} {
  const env = { ...process.env, ...composeEnv };
  try {
    const script =
      "const fs=require('fs');const uid=fs.readFileSync('/proc/1/status','utf8').match(/^Uid:\\s+(\\d+)/m)[1];const user=(fs.readFileSync('/etc/passwd','utf8').split('\\n').find(l=>l.split(':')[2]===uid)||'').split(':')[0];console.log(user);";
    const raw = execSync(`${COMPOSE_CMD} exec -T worker node -e ${JSON.stringify(script)}`, {
      cwd: process.cwd(),
      env,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const pid1User = raw.split('\n').pop()?.trim() ?? '';
    const ok = pid1User === 'commander';
    return { ok, raw, pid1User };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, raw: message };
  }
}

export interface CellUpAssertResult {
  verdict: 'PASS' | 'BLOCKED';
  passed: boolean;
  dockerGid: string;
  composeServicesHealthy: Record<string, boolean>;
  readyHammer: { ok: boolean; statuses: number[] };
  workerPid1: { ok: boolean; raw: string; pid1User?: string };
  dockerError?: string;
  artifactPath: string;
  elapsedMs: number;
}

export async function runCellUpAssert(options: {
  keepStack?: boolean;
  baseUrl?: string;
  composeEnv?: Record<string, string>;
}): Promise<CellUpAssertResult> {
  const started = Date.now();
  const composeEnv = options.composeEnv ?? buildCellUpAssertEnv();
  const baseUrl = options.baseUrl ?? 'http://localhost:4000';
  const env = { ...process.env, ...composeEnv };
  delete env.DOCKER_GID;
  const runtimeEnv = { ...env, ...composeEnv };

  let dockerError: string | undefined;
  let composeServicesHealthy: Record<string, boolean> = Object.fromEntries(
    CELL_UP_ASSERT_SERVICES.map((s) => [s, false]),
  );
  let readyHammer = { ok: false, statuses: [] as number[] };
  let workerPid1 = { ok: false, raw: '' };
  let passed = false;

  try {
    ensureCellSandboxImage();
    try {
      execSync(`${COMPOSE_CMD} down -v --remove-orphans`, {
        cwd: process.cwd(),
        env: runtimeEnv,
        stdio: 'pipe',
      });
    } catch {
      /* no prior stack */
    }

    execSync(`${COMPOSE_CMD} up -d --build`, {
      cwd: process.cwd(),
      env: runtimeEnv,
      stdio: 'inherit',
    });

    const healthPoll = await pollComposeDockerHealthy(composeEnv);
    composeServicesHealthy = healthPoll.last;
    if (!healthPoll.ok) {
      dockerError = `compose services not healthy within timeout: ${JSON.stringify(composeServicesHealthy)}`;
    } else {
      readyHammer = await assertAnonymousReadyHammer(baseUrl);
      workerPid1 = probeWorkerPid1User(composeEnv);
      passed = readyHammer.ok && workerPid1.ok;
      if (!readyHammer.ok) {
        dockerError = `anonymous /ready hammer failed: ${readyHammer.statuses.join(',')}`;
      } else if (!workerPid1.ok) {
        dockerError = `worker PID1 user must be commander (got ${workerPid1.pid1User ?? 'unknown'})`;
      }
    }
  } catch (err) {
    dockerError = err instanceof Error ? err.message : String(err);
    passed = false;
  } finally {
    if (!options.keepStack) {
      try {
        execSync(`${COMPOSE_CMD} down -v --remove-orphans`, {
          cwd: process.cwd(),
          env: runtimeEnv,
          stdio: 'pipe',
        });
      } catch {
        /* best effort */
      }
    }
  }

  const outDir = join(process.cwd(), 'artifacts');
  await mkdir(outDir, { recursive: true });
  const artifactPath = join(outDir, `l4-b-cell-up-assert-${Date.now()}.json`);
  const result: CellUpAssertResult = {
    verdict: passed ? 'PASS' : 'BLOCKED',
    passed,
    dockerGid: composeEnv.DOCKER_GID,
    composeServicesHealthy,
    readyHammer,
    workerPid1,
    dockerError,
    artifactPath,
    elapsedMs: Date.now() - started,
  };
  await writeFile(artifactPath, JSON.stringify(result, null, 2));

  return result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }
  const keepStack = args.includes('--keep');

  const result = await runCellUpAssert({ keepStack });
  console.log(
    `Cell up-assert ${result.verdict} ${result.passed ? 'PASS' : 'FAIL'} → ${result.artifactPath}`,
  );
  if (result.dockerError) console.error(result.dockerError);
  if (!result.passed) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
