/**
 * Offline Compose + API startup configuration contract.
 *
 * Two layers, both hermetic (no docker daemon, no network, no database):
 *
 *  1. YAML contracts over docker-compose.yml / docker-compose.v2.yml /
 *     docker-compose.cell.yml, parsed with js-yaml. These encode the profile and
 *     credential policy: the base file is development/local-only (SQLite, kernel
 *     explicitly off, no injected DSNs, loopback ports) while v2/cell are
 *     production-shaped (NODE_ENV=production, kernel on, role DSNs, required
 *     key material) and never inherit the base local switches.
 *
 *  2. Actual process startup configuration checks against the real resolver
 *     (apps/api/src/startupConfig.ts) and the real kernel policy
 *     (apps/api/src/v1GatewayKernel.ts), fed the *merged* Compose environment.
 *     This is what proves the advertised SQLite/no-DB default cannot be dressed
 *     up as NODE_ENV=production, and that a production DSN cannot silently
 *     inherit the base `COMMANDER_KERNEL_ENABLED=0` switch.
 *
 * Compose interpolation semantics matter here: `docker compose` interpolates
 * every service of every loaded file, including services whose profile is
 * inactive. That is why the base file keeps `${VAR:-}` for profile-gated
 * services and the v2/cell overrides re-impose `${VAR:?}`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';

import { isProductionEnv } from '../apps/api/src/envSignal.js';
import {
  ApiStartupConfigurationError,
  resolveApiHost,
  resolveApiStartupConfig,
} from '../apps/api/src/startupConfig.js';
import {
  isCommanderKernelEnabled,
  isCommanderKernelExplicitlyDisabled,
} from '../apps/api/src/v1GatewayKernel.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BASE_FILE = 'docker-compose.yml';
const V2_FILE = 'docker-compose.v2.yml';
const CELL_FILE = 'docker-compose.cell.yml';
// The v2/cell profiles are kernel-on, so they are always invoked with this third
// fragment: it carries the pinned database TLS material AND the sslmode=verify-full
// role DSNs. `include:` is not used because `docker compose up` rejects the merge.
const KERNEL_TLS_FILE = 'docker-compose.kernel-tls.yml';
const KERNEL_OPS_DOCKERFILE = 'packages/kernel/Dockerfile.ops';

const ED25519_KEYS = [
  'COMMANDER_CAPABILITY_PRIVATE_KEY_PEM',
  'COMMANDER_CAPABILITY_KEY_ID',
  'COMMANDER_CAPABILITY_JWKS_JSON',
  'COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM',
  'COMMANDER_EVIDENCE_SIGNING_KEY_ID',
] as const;

/** Startup credentials the API must always require, local profile included. */
const REQUIRED_API_CREDENTIALS = [
  'COMMANDER_API_KEY',
  'COMMANDER_MASTER_KEY',
  'JWT_SECRET',
  'COMMANDER_CAPABILITY_TOKEN_KEY',
  'COMMANDER_INTEGRITY_KEY',
  'ADMIN_PASSWORD',
] as const;

interface ComposeService {
  environment?: Record<string, string | number> | string[];
  profiles?: string[];
  ports?: string[];
  volumes?: string[];
  depends_on?: Record<string, { condition?: string } | null>;
  build?: { args?: string[] };
  entrypoint?: string[];
  command?: string[];
  user?: string;
}

interface ComposeFile {
  services?: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
}

function readText(file: string): string {
  return readFileSync(resolve(ROOT, file), 'utf8');
}

function readCompose(file: string): ComposeFile {
  return load(readText(file)) as ComposeFile;
}

function service(file: ComposeFile, name: string): ComposeService {
  const found = file.services?.[name];
  assert.ok(found, `${name} service must be defined`);
  return found;
}

/** Compose environment (list or map form) → plain map. */
function envMap(entry: ComposeService | undefined): Record<string, string> {
  const raw = entry?.environment;
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const at = item.indexOf('=');
      if (at === -1) {
        out[item] = '';
        continue;
      }
      out[item.slice(0, at)] = item.slice(at + 1);
    }
    return out;
  }
  for (const [key, value] of Object.entries(raw)) out[key] = String(value);
  return out;
}

/**
 * Expand a compose file's `include:` entries, depth-first, returning included
 * fragments before the file itself — the order Compose merges them in, so the
 * including file wins on a per-key basis.
 */
function withIncludes(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const out: string[] = [];
  for (const m of readText(file).matchAll(/^ {2}-\s+(\S+\.ya?ml)\s*$/gm)) {
    const resolved = relative(ROOT, resolve(ROOT, dirname(file), m[1].replace(/^\.\//, '')))
      .split(sep)
      .join('/');
    out.push(...withIncludes(resolved, seen));
  }
  return [...out, file];
}

/**
 * Compose override merge for one service's environment: later files win per
 * key, exactly like `docker compose -f base -f override`. `include:`d fragments
 * are part of their parent, so they are merged too — reading only the named
 * files would let a fragment contribute a variable nothing observes.
 */
function mergedEnv(...files: Array<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [file, name] of files) {
    for (const path of withIncludes(file)) {
      Object.assign(out, envMap(readCompose(path).services?.[name]));
    }
  }
  return out;
}

/**
 * Expand compose interpolation for a single value against a host environment.
 * `:?` values resolve to the sentinel `__REQUIRED__` when the host var is unset
 * so callers can assert the guard exists rather than crash on it.
 */
function resolveValue(value: string, host: Record<string, string>): string {
  const match = /^\$\{([A-Z0-9_]+)(?::([-?])([^}]*))?\}$/.exec(value);
  if (!match) return value;
  const [, name, kind, fallback = ''] = match;
  const provided = host[name];
  if (provided !== undefined && provided !== '') return provided;
  return kind === '?' ? '__REQUIRED__' : fallback;
}

function resolveEnv(
  env: Record<string, string>,
  host: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) out[key] = resolveValue(value, host);
  return out;
}

/** Env keys whose value carries a required-var guard (`${VAR:?...}`). */
function requiredGuardKeys(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([, value]) => /:\?/.test(value))
    .map(([key]) => key)
    .sort();
}

const base = readCompose(BASE_FILE);
const v2 = readCompose(V2_FILE);
const cell = readCompose(CELL_FILE);

/** Host environment supplying the required base credentials for startup checks. */
const HOST_ENV: Record<string, string> = {
  COMMANDER_API_KEY: 'a'.repeat(64),
  COMMANDER_MASTER_KEY: 'b'.repeat(64),
  JWT_SECRET: 'c'.repeat(48),
  COMMANDER_CAPABILITY_TOKEN_KEY: 'd'.repeat(64),
  COMMANDER_INTEGRITY_KEY: 'e'.repeat(64),
  COMMANDER_AUDIT_CHAIN_KEY: 'g'.repeat(64),
  ADMIN_PASSWORD: 'f'.repeat(24),
};

describe('base compose is development/local-only', () => {
  const api = service(base, 'api');
  const apiEnv = envMap(api);

  it('declares NODE_ENV=development and kernel explicitly disabled', () => {
    assert.equal(resolveValue(apiEnv.NODE_ENV, HOST_ENV), 'development');
    assert.equal(resolveValue(apiEnv.COMMANDER_KERNEL_ENABLED, HOST_ENV), '0');
  });

  it('injects no DATABASE_URL and no kernel DSN', () => {
    assert.equal(apiEnv.DATABASE_URL, undefined, 'base api must not inject DATABASE_URL');
    assert.equal(
      apiEnv.COMMANDER_KERNEL_DATABASE_URL,
      undefined,
      'base api must not inject COMMANDER_KERNEL_DATABASE_URL',
    );
  });

  it('keeps SQLite as the default API store', () => {
    assert.equal(resolveValue(apiEnv.API_STORE_BACKEND, HOST_ENV), 'sqlite');
  });

  it('keeps every strong API startup credential required', () => {
    for (const key of REQUIRED_API_CREDENTIALS) {
      assert.ok(apiEnv[key], `base api must set ${key}`);
      assert.match(
        apiEnv[key]!,
        /:\?/,
        `base api must require ${key} (the api service is always active, so a :? guard is safe)`,
      );
    }
    assert.equal(requiredGuardKeys(apiEnv).length, REQUIRED_API_CREDENTIALS.length);
  });

  it('publishes api and web only on loopback', () => {
    assert.deepEqual(api.ports, ['127.0.0.1:4000:4000']);
    assert.deepEqual(service(base, 'web').ports, ['127.0.0.1:3000:80']);
  });

  it('backs the <cwd>/.commander SQLite state with a named volume', () => {
    assert.ok(
      api.volumes?.includes('commander_local_state:/app/.commander'),
      'base api must mount the .commander state dir on a named volume',
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(base.volumes ?? {}, 'commander_local_state'),
      'commander_local_state must be declared in the top-level volumes map',
    );
    assert.match(
      readText('apps/api/Dockerfile'),
      /mkdir -p \/app\/\.commander\s[\s\S]*?chown -R commander:commander \/app/,
      'image must initialize local SQLite state ownership before the named volume is created',
    );
  });

  it('keeps profile-gated services free of ${VAR:?} guards', () => {
    // Compose interpolates inactive services too: a required guard outside the
    // always-active api service would break an unrelated `docker compose up`.
    const guarded = Object.entries(base.services ?? {})
      .filter(([, svc]) => requiredGuardKeys(envMap(svc)).length > 0)
      .map(([name]) => name)
      .sort();
    assert.deepEqual(guarded, ['api']);
  });

  it('relaxes only the profile-gated Ed25519 and postgres guards', () => {
    for (const name of ['worker', 'adapter-ops']) {
      const env = envMap(base.services?.[name]);
      for (const key of ED25519_KEYS) {
        assert.ok(env[key], `${name} must still declare ${key}`);
        assert.doesNotMatch(env[key]!, /:\?/, `${name} must not use a :? guard for ${key}`);
      }
    }
    const postgresPassword = envMap(base.services?.postgres).POSTGRES_PASSWORD;
    assert.ok(postgresPassword);
    assert.match(postgresPassword, /:-}/, 'base postgres must not hard-require POSTGRES_PASSWORD');
    assert.doesNotMatch(postgresPassword, /:\?/);
  });
});

describe('compose files stay scannable by the deployment verifier', () => {
  it('never spells out required-guard syntax inside comments', () => {
    // scripts/verify-deployment-integrity.ts scans the raw text for required-var
    // guards and fails when the var is not documented in .env.example, so a
    // documentation comment containing the literal syntax would be a false
    // positive there.
    const literal = /\$\{[A-Z][A-Z0-9_]*:\?/;
    for (const file of [BASE_FILE, V2_FILE, CELL_FILE]) {
      const lines = readText(file).split('\n');
      for (const [index, line] of lines.entries()) {
        if (!line.trimStart().startsWith('#')) continue;
        assert.doesNotMatch(
          line,
          literal,
          `${file}:${index + 1}: a comment must not contain a required-var guard literal`,
        );
      }
    }
  });
});

describe('base worker plane is Postgres-backed and migration-gated', () => {
  it('runs the worker only after the owner migration completes', () => {
    const worker = service(base, 'worker');
    assert.equal(worker.depends_on?.postgres?.condition, 'service_healthy');
    assert.equal(
      worker.depends_on?.['kernel-migrate']?.condition,
      'service_completed_successfully',
    );
  });

  it('includes postgres in the worker profile', () => {
    const profiles = service(base, 'postgres').profiles ?? [];
    for (const required of ['database', 'worker', 'v2']) {
      assert.ok(profiles.includes(required), `postgres profile must include ${required}`);
    }
  });

  it('seeds explicit worker tenants from the base migration', () => {
    const env = envMap(service(base, 'kernel-migrate'));
    for (const key of ['COMMANDER_WORKER_TENANTS', 'COMMANDER_WORKER_ALLOWED_TENANTS']) {
      assert.ok(env[key], `base kernel-migrate must set ${key}`);
      assert.doesNotMatch(env[key]!, /\*/, `${key} must never be '*'`);
    }
    const workerTenants = envMap(service(base, 'worker')).COMMANDER_WORKER_TENANTS;
    assert.ok(workerTenants, 'base worker must set COMMANDER_WORKER_TENANTS');
    assert.doesNotMatch(workerTenants, /\*/, 'base worker tenants must never be *');
  });
});

describe('owner migration applies the Task-1 closure in every service-based path', () => {
  // A service-started kernel-migrate has no `docker compose run` argument
  // override, so it must carry the closure action and phase itself. Without
  // them, main() resolves closurePhase=undefined and runKernelMigrations stops
  // at KERNEL_TASK1_BASELINE_MIGRATIONS — which excludes the auth-persistence
  // schema the API queries at first boot, so the Gateway dies with
  // `relation "commander_auth_users" does not exist` after reporting a
  // successful migration.
  const CLOSURE_ACTION = 'tenant-cutover-migrate';

  it('base kernel-migrate passes the closure action', () => {
    assert.deepEqual(
      service(base, 'kernel-migrate').command,
      [CLOSURE_ACTION],
      'base kernel-migrate must run the phase-bound closure action, not the bare baseline',
    );
  });

  it('base kernel-migrate supplies a closure phase with a safe default', () => {
    const env = envMap(service(base, 'kernel-migrate'));
    const phase = env.COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE;
    assert.ok(phase, 'base kernel-migrate must set COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE');
    // A default rather than a `:?` guard: the service is profile-gated and
    // Compose interpolates inactive services too.
    assert.match(phase, /:-/, 'the phase must carry a default for the local profile');
    assert.doesNotMatch(phase, /:\?/, 'the phase must not be a required-var guard');
    assert.equal(
      resolveValue(phase, HOST_ENV),
      'enforce',
      'the default must be the fresh-install enforce phase, matching the chart default',
    );
    assert.equal(
      resolveValue(phase, { ...HOST_ENV, COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE: 'expand' }),
      'expand',
      'a legacy upgrade must be able to sequence the expand phase first',
    );
  });

  it('v2 and cell keep the closure action and a resolvable phase', () => {
    for (const [label, overrideFile, override] of [
      ['v2', V2_FILE, v2],
      ['cell', CELL_FILE, cell],
    ] as const) {
      const command =
        override.services?.['kernel-migrate']?.command ?? service(base, 'kernel-migrate').command;
      assert.deepEqual(
        command,
        [CLOSURE_ACTION],
        `${label} kernel-migrate must keep the closure action`,
      );

      const env = mergedEnv([BASE_FILE, 'kernel-migrate'], [overrideFile, 'kernel-migrate']);
      const phase = env.COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE;
      assert.ok(phase, `${label} kernel-migrate must resolve a closure phase`);
      assert.equal(
        resolveValue(phase, HOST_ENV),
        'enforce',
        `${label} phase must default to enforce`,
      );
    }
  });

  it('the production driver keeps passing the action and phase explicitly', () => {
    // docker-compose.prod.yml deliberately omits the action: the production
    // path supplies it through the `compose run` override in
    // scripts/compose-tenant-cutover.ts. Pin that contract so a refactor cannot
    // silently drop it and reintroduce the baseline-only migration.
    const driver = readText('scripts/compose-tenant-cutover.ts');
    assert.ok(
      driver.includes("'tenant-cutover-migrate'"),
      'the production driver must pass the closure action to compose run',
    );
    assert.ok(
      driver.includes('COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE=${operation.phase}'),
      'the production driver must pass the operation phase to compose run',
    );
  });
});

describe('v2 override is production-shaped and re-imposes guards', () => {
  it('forces NODE_ENV=production and kernel on for every activated service', () => {
    for (const name of ['api', 'worker', 'kernel-ops', 'adapter-ops']) {
      const env = envMap(v2.services?.[name]);
      assert.equal(env.NODE_ENV, 'production', `v2 ${name} must set NODE_ENV=production`);
      assert.equal(
        env.COMMANDER_KERNEL_ENABLED,
        '1',
        `v2 ${name} must set COMMANDER_KERNEL_ENABLED=1 so it cannot inherit the base local switch`,
      );
    }
  });

  it('waits for the owner migration before the api starts', () => {
    const dependsOn = service(v2, 'api').depends_on ?? {};
    assert.equal(dependsOn.postgres?.condition, 'service_healthy');
    assert.equal(
      dependsOn['kernel-migrate']?.condition,
      'service_completed_successfully',
      'v2 api must depend on completed migrations, not merely a healthy postgres',
    );
  });

  it('re-imposes the Ed25519 guards on worker and adapter-ops', () => {
    for (const name of ['worker', 'adapter-ops']) {
      const env = envMap(v2.services?.[name]);
      for (const key of ED25519_KEYS) {
        assert.match(env[key] ?? '', /:\?/, `v2 ${name} must require ${key}`);
      }
    }
  });

  it('requires POSTGRES_PASSWORD with no public default', () => {
    const env = envMap(v2.services?.postgres);
    assert.match(env.POSTGRES_PASSWORD ?? '', /:\?/, 'v2 postgres must require POSTGRES_PASSWORD');
    assert.doesNotMatch(
      env.POSTGRES_PASSWORD ?? '',
      /:-/,
      'v2 postgres must not default the password',
    );
  });
});

describe('cell override is production-shaped and re-imposes guards', () => {
  it('forces NODE_ENV=production on api, migrations and kernel-ops', () => {
    for (const name of ['api', 'kernel-migrate', 'kernel-ops', 'worker', 'adapter-ops']) {
      assert.equal(
        envMap(cell.services?.[name]).NODE_ENV,
        'production',
        `cell ${name} must set NODE_ENV=production explicitly`,
      );
    }
    assert.equal(envMap(cell.services?.api).COMMANDER_KERNEL_ENABLED, '1');
  });

  it('requires POSTGRES_PASSWORD explicitly', () => {
    const env = envMap(cell.services?.postgres);
    assert.match(
      env.POSTGRES_PASSWORD ?? '',
      /:\?/,
      'cell postgres must require POSTGRES_PASSWORD',
    );
    assert.doesNotMatch(
      env.POSTGRES_PASSWORD ?? '',
      /:-/,
      'cell postgres must not default the password',
    );
  });

  it('re-imposes the Ed25519 guards on adapter-ops (evidence keys included)', () => {
    for (const name of ['worker', 'adapter-ops']) {
      const env = envMap(cell.services?.[name]);
      for (const key of ED25519_KEYS) {
        assert.match(env[key] ?? '', /:\?/, `cell ${name} must require ${key}`);
      }
    }
  });

  it('gates the api on the owner migration completing', () => {
    assert.equal(
      service(cell, 'api').depends_on?.['kernel-migrate']?.condition,
      'service_completed_successfully',
    );
  });
});

describe('kernel ops image ships the migration JSON manifests', () => {
  it('copies packages/kernel/src/*.json into the production stage', () => {
    const dockerfile = readText(KERNEL_OPS_DOCKERFILE);
    assert.match(
      dockerfile,
      /^COPY --from=build \/app\/packages\/kernel\/src\/\*\.json \.\/packages\/kernel\/src\/$/m,
      'Dockerfile.ops production stage must copy the kernel src manifests read at migration import',
    );
  });
});

describe('actual process startup configuration', () => {
  it('base api env boots as a non-production, kernel-off, loopback process', () => {
    const env = resolveEnv(mergedEnv([BASE_FILE, 'api']), HOST_ENV);

    assert.equal(isProductionEnv(env), false, 'base api must not be a production process');
    assert.equal(resolveApiHost(env), '0.0.0.0', 'api binds 0.0.0.0 for docker port publishing');
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.COMMANDER_KERNEL_DATABASE_URL, undefined);
    assert.equal(isCommanderKernelExplicitlyDisabled(env), true);
    assert.equal(
      isCommanderKernelEnabled(env),
      false,
      'SQLite/no-DB default must keep /v1 kernel off',
    );

    const config = resolveApiStartupConfig(env);
    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.jwtSecret, HOST_ENV.JWT_SECRET);
    assert.equal(config.adminPassword, HOST_ENV.ADMIN_PASSWORD);
  });

  it('base api cannot be relabelled as production without a durable kernel', () => {
    const env = resolveEnv(mergedEnv([BASE_FILE, 'api']), HOST_ENV);
    const asProduction = { ...env, NODE_ENV: 'production' };

    // Base pins COMMANDER_KERNEL_ENABLED=0, so a relabel to production hits the
    // first production refusal in apps/api/src/index.ts (explicit disable).
    assert.equal(isProductionEnv(asProduction), true);
    assert.equal(isCommanderKernelExplicitlyDisabled(asProduction), true);
    assert.equal(isCommanderKernelEnabled(asProduction), false);

    // With the switch removed, production implies kernel-on but the base file
    // still injects no DSN — the second refusal branch (no durable kernel).
    const withoutSwitch = Object.fromEntries(
      Object.entries(asProduction).filter(([key]) => key !== 'COMMANDER_KERNEL_ENABLED'),
    );
    assert.equal(
      isCommanderKernelEnabled(withoutSwitch),
      true,
      'production alone implies kernel on',
    );
    assert.equal(
      withoutSwitch.COMMANDER_KERNEL_DATABASE_URL ?? withoutSwitch.DATABASE_URL,
      undefined,
      'a production relabel would have no kernel DSN to initialize',
    );

    // The startup resolver still enforces the production admin credential,
    // proving the local profile never weakens production requirements.
    assert.throws(
      () => resolveApiStartupConfig({ ...asProduction, ADMIN_PASSWORD: '' }),
      ApiStartupConfigurationError,
    );
  });

  it('v2 and cell merged api env are production kernel-on with app-role DSNs', () => {
    for (const [label, overrideFile, override] of [
      ['v2', V2_FILE, v2],
      ['cell', CELL_FILE, cell],
    ] as const) {
      const env = resolveEnv(
        mergedEnv([BASE_FILE, 'api'], [overrideFile, 'api'], [KERNEL_TLS_FILE, 'api']),
        HOST_ENV,
      );

      assert.equal(
        env.COMMANDER_TENANT_CONTEXT_PHASE,
        'enforce',
        `${label} api must bind authenticated tenant context`,
      );
      const authority = new URL(env.COMMANDER_TENANT_AUTHORITY_DATABASE_URL ?? 'http://missing');
      assert.equal(authority.username, 'commander_tenant_authority');
      assert.equal(authority.searchParams.get('sslmode'), 'verify-full');
      assert.equal(env.NODE_ENV, 'production', `${label} api must be production`);
      assert.equal(env.COMMANDER_KERNEL_ENABLED, '1', `${label} api must set the kernel on`);
      assert.equal(isProductionEnv(env), true);
      assert.equal(isCommanderKernelEnabled(env), true);
      assert.equal(isCommanderKernelExplicitlyDisabled(env), false);
      assert.match(
        env.COMMANDER_KERNEL_DATABASE_URL ?? '',
        /commander_app/,
        `${label} api must use the least-privilege commander_app DSN`,
      );
      assert.match(
        envMap(service(override, 'api')).COMMANDER_AUDIT_CHAIN_KEY ?? '',
        /:\?/,
        `${label} api must require COMMANDER_AUDIT_CHAIN_KEY (production refuses the dev key)`,
      );

      const config = resolveApiStartupConfig(env);
      assert.equal(config.host, '0.0.0.0');
    }
  });

  it('production DSNs never inherit the base local disabled switch', () => {
    // Without the override's explicit =1, the merged env would carry the base
    // `0` and the real policy would disable the kernel under a production DSN.
    const inherited = resolveEnv(mergedEnv([BASE_FILE, 'api']), HOST_ENV);
    inherited.COMMANDER_KERNEL_DATABASE_URL =
      'postgres://commander_app:commander_app@postgres:5432/commander';
    assert.equal(
      isCommanderKernelEnabled(inherited),
      false,
      'the base local switch must stay authoritative for the base file alone',
    );
    assert.equal(
      isCommanderKernelEnabled({ ...inherited, COMMANDER_KERNEL_ENABLED: '1' }),
      true,
      'the overrides must flip the switch explicitly',
    );
  });
});
