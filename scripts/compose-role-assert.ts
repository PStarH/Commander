#!/usr/bin/env tsx
/**
 * Compose role / tenant authority assertions.
 *
 * Usage:
 *   docker compose -f docker-compose.yml -f docker-compose.cell.yml --profile cell config --format json \
 *     | pnpm exec tsx scripts/compose-role-assert.ts --profile cell
 *   docker compose -f docker-compose.yml -f docker-compose.v2.yml --profile v2 config --format json \
 *     | pnpm exec tsx scripts/compose-role-assert.ts --profile v2
 *   pnpm exec tsx scripts/compose-role-assert.ts --file /tmp/compose.json --profile cell
 *   pnpm exec tsx scripts/compose-role-assert.ts --file /tmp/v2.json --profile v2-bench
 */

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

export type ComposeRoleProfile = 'cell' | 'base' | 'v2' | 'v2-bench';

/** Service name → expected Postgres LOGIN role (DSN username). */
export const SERVICE_ROLE_MAP: Readonly<Record<string, string>> = {
  'kernel-migrate': 'commander_owner',
  migrate: 'commander_owner',
  api: 'commander_app',
  'api-1': 'commander_app',
  'api-2': 'commander_app',
  'kernel-ops': 'commander_scheduler',
  worker: 'commander_worker',
  'adapter-ops': 'commander_worker',
};

const OWNER_ROLE = 'commander_owner';
const MIGRATION_SERVICES = new Set(['kernel-migrate', 'migrate']);
const APP_ROLE_APIS = new Set(['api', 'api-1', 'api-2']);
const ISOLATED_LEGACY_STORE_PROFILES = new Set<ComposeRoleProfile>([
  'cell',
  'v2',
  'v2-bench',
]);

/** Default COMMANDER_WORKER_TENANTS expected per topology. */
export const EXPECTED_WORKER_TENANTS: Readonly<Record<ComposeRoleProfile, string>> = {
  cell: 'local',
  base: 'tenant-local',
  v2: 'tenant-local',
  'v2-bench': 'tenant-0,tenant-1,tenant-2,tenant-3,tenant-4',
};

export interface ComposeConfig {
  services?: Record<string, ComposeService | undefined>;
}

export interface ComposeService {
  environment?: Record<string, string | number | boolean | null> | string[] | null;
  profiles?: string[];
}

function parseArgs(): {
  file: string | null;
  profile: ComposeRoleProfile;
  stdin: boolean;
} {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  const profileIdx = args.indexOf('--profile');
  const profileRaw = (profileIdx >= 0 ? args[profileIdx + 1] : 'cell') ?? 'cell';
  const allowed: ComposeRoleProfile[] = ['cell', 'base', 'v2', 'v2-bench'];
  if (!allowed.includes(profileRaw as ComposeRoleProfile)) {
    throw new Error(`Unknown --profile ${profileRaw}; expected one of ${allowed.join(', ')}`);
  }
  return {
    file: fileIdx >= 0 ? args[fileIdx + 1] ?? null : null,
    profile: profileRaw as ComposeRoleProfile,
    stdin: !process.stdin.isTTY && fileIdx < 0,
  };
}

/** Normalize compose environment (object or KEY=value array) to a string map. */
export function normalizeEnvironment(
  env: ComposeService['environment'],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  if (Array.isArray(env)) {
    for (const entry of env) {
      const eq = entry.indexOf('=');
      if (eq <= 0) {
        out[entry] = '';
        continue;
      }
      out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return out;
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === null || value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

/** Extract LOGIN role (username) from a postgres DSN. */
export function dsnRole(dsn: string | undefined): string | null {
  if (!dsn) return null;
  // postgres://user:pass@host/db  |  postgresql://user@host/db
  const m = dsn.match(/^(?:postgres|postgresql):\/\/([^:/?@]+)(?::[^@]*)?@/i);
  return m?.[1] ?? null;
}

/** Prefer DATABASE_URL, then COMMANDER_KERNEL_DATABASE_URL. */
export function serviceDsn(env: Record<string, string>): string | undefined {
  return env.DATABASE_URL || env.COMMANDER_KERNEL_DATABASE_URL || undefined;
}

function normalizeTenantList(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function tenantListsEqual(a: string, b: string): boolean {
  const left = normalizeTenantList(a);
  const right = normalizeTenantList(b);
  if (left.length !== right.length) return false;
  return left.every((t, i) => t === right[i]);
}

export function assertComposeRoles(
  config: ComposeConfig,
  profile: ComposeRoleProfile,
): void {
  const services = config.services ?? {};
  const present = Object.keys(services).filter((name) => name in SERVICE_ROLE_MAP);

  assert.ok(present.length > 0, 'compose config has no known authority services');

  if (profile === 'cell') {
    for (const name of ['kernel-migrate', 'api', 'kernel-ops', 'worker', 'adapter-ops'] as const) {
      assert.ok(services[name], `cell profile missing service ${name}`);
    }
  }

  if (profile === 'v2') {
    for (const name of ['kernel-migrate', 'api', 'kernel-ops', 'worker'] as const) {
      assert.ok(services[name], `v2 profile missing service ${name}`);
    }
  }

  if (profile === 'v2-bench') {
    assert.ok(services.migrate || services['kernel-migrate'], 'v2-bench missing migrate service');
    assert.ok(services.worker, 'v2-bench missing worker service');
    assert.ok(services['kernel-ops'], 'v2-bench missing kernel-ops service');
    assert.ok(
      services['api-1'] || services['api-2'] || services.api,
      'v2-bench missing api service',
    );
  }

  for (const [name, service] of Object.entries(services)) {
    const expectedRole = SERVICE_ROLE_MAP[name];
    if (!expectedRole || !service) continue;

    const env = normalizeEnvironment(service.environment);
    const dsn = serviceDsn(env);
    assert.ok(dsn, `${name}: missing DATABASE_URL / COMMANDER_KERNEL_DATABASE_URL`);

    const role = dsnRole(dsn);
    assert.equal(
      role,
      expectedRole,
      `${name}: expected DSN role ${expectedRole}, got ${role ?? '(unparsed)'} (${dsn})`,
    );

    // Migration alone may use owner; every other mapped service must not.
    if (!MIGRATION_SERVICES.has(name)) {
      assert.notEqual(
        role,
        OWNER_ROLE,
        `${name}: must not authenticate as ${OWNER_ROLE}`,
      );
      assert.ok(
        !dsn.includes(`${OWNER_ROLE}:`) && !dsn.includes(`://${OWNER_ROLE}@`),
        `${name}: DSN must not embed ${OWNER_ROLE} credentials`,
      );
    }

    if (APP_ROLE_APIS.has(name) && ISOLATED_LEGACY_STORE_PROFILES.has(profile)) {
      assert.equal(
        env.API_STORE_BACKEND,
        'memory',
        `${name}: expected API_STORE_BACKEND=memory; PostgreSQL legacy stores perform runtime DDL outside commander_app authority`,
      );
      assert.equal(
        env.COMMANDER_MEMORY_STORE,
        'in-memory',
        `${name}: expected COMMANDER_MEMORY_STORE=in-memory; PostgreSQL legacy memory is not canonical /v1 authority`,
      );
    }

    if (name === 'worker' || name === 'adapter-ops') {
      // Same fail-closed tenant scope as worker-plane resolveWorkerTenantScope.
      const tenants = env.COMMANDER_WORKER_TENANTS;
      assert.ok(
        tenants !== undefined && tenants.trim() !== '',
        `${name}: COMMANDER_WORKER_TENANTS must be a non-empty explicit list`,
      );
      assert.notEqual(
        tenants.trim(),
        '*',
        `${name}: COMMANDER_WORKER_TENANTS=* is forbidden`,
      );
      assert.ok(
        !normalizeTenantList(tenants).includes('*'),
        `${name}: COMMANDER_WORKER_TENANTS must not contain *`,
      );

      const expectedTenants =
        profile === 'cell'
          ? env.COMMANDER_CELL_TENANT_ID?.trim() || EXPECTED_WORKER_TENANTS[profile]
          : EXPECTED_WORKER_TENANTS[profile];
      assert.ok(
        tenantListsEqual(tenants, expectedTenants),
        `${name}: expected COMMANDER_WORKER_TENANTS=${expectedTenants}, got ${tenants}`,
      );
    }
  }

  // Global sweep: no rendered worker env may contain wildcard tenants.
  for (const [name, service] of Object.entries(services)) {
    if (!service) continue;
    const env = normalizeEnvironment(service.environment);
    const tenants = env.COMMANDER_WORKER_TENANTS;
    if (tenants === undefined) continue;
    assert.notEqual(
      tenants.trim(),
      '*',
      `${name}: COMMANDER_WORKER_TENANTS=* is forbidden`,
    );
    assert.ok(
      !normalizeTenantList(tenants).includes('*'),
      `${name}: COMMANDER_WORKER_TENANTS must not contain *`,
    );
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const { file, profile, stdin } = parseArgs();
  let raw: string;
  if (file) {
    raw = readFileSync(file, 'utf-8');
  } else if (stdin) {
    raw = await readStdin();
  } else {
    console.error('Provide --file or pipe `docker compose … config --format json` on stdin');
    process.exit(1);
  }

  const config = JSON.parse(raw) as ComposeConfig;
  assertComposeRoles(config, profile);
  console.log(`compose-role-assert: PASS (${profile})`);
}

import { pathToFileURL } from 'node:url';

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
