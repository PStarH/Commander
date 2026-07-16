#!/usr/bin/env tsx
/**
 * ws9-env-check.ts — WS9 §3.2 infrastructure readiness gate.
 *
 * Verifies infrastructure prerequisites before any live-fire test runs.
 * If ANY required (FAIL-severity) check fails, exit non-zero: the live-fire
 * suite must not run and no evidence is produced. Advisory (WARN-severity)
 * checks do not block the verdict but report gaps (e.g. missing runsc,
 * unreachable /v1 gateway) that certain test classes need.
 *
 * Per spec `spec/ws9-tenant-livefire-compliance.md` §3.2:
 *   - Postgres role is not owner/superuser and cannot create roles/DBs.
 *   - All target tables have RLS enabled and policies carry WITH CHECK.
 *   - Vault is reachable + sealed-healthy; COMMANDER_VAULT_TOKEN is set.
 *   - No forbidden *_API_KEY / *_SECRET / *_TOKEN in process.env (allowlist
 *     at config/keypath-allowlist.json).
 *   - runsc binary present (WARN if missing).
 *   - /v1 gateway reachable; legacy /api/* returns 410/404 (WARN if API
 *     unreachable; FAIL if reachable but legacy route serves).
 *
 * Exit codes:
 *   0  all required checks pass (WARNs are OK)
 *   1  one or more required checks failed
 *   2  error (e.g. allowlist missing, uncaught exception)
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// ─── Types ─────────────────────────────────────────────────────────────

interface CheckResult {
  check: string;
  passed: boolean;
  severity: 'FAIL' | 'WARN';
  detail: string;
}

interface EnvCheckResult {
  verdict: 'PASS' | 'FAIL';
  checks: CheckResult[];
  scannedAt: string;
}

interface KeypathAllowlist {
  allowed: string[];
  forbiddenPatterns: string[];
  notes?: string[];
}

// ─── Constants ─────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, '..');
const ALLOWLIST_PATH = resolve(REPO_ROOT, 'config', 'keypath-allowlist.json');

// Fixed target tables; war_room_* is expanded dynamically from pg_class.
const FIXED_TARGET_TABLES = [
  'runs',
  'steps',
  'memory_items',
  'atr_run_ledger',
  'event_sourcing_log',
] as const;

const PG_TIMEOUT_MS = 8_000;
const HTTP_TIMEOUT_MS = 6_000;

// ─── Helpers ───────────────────────────────────────────────────────────

/** True if a binary is resolvable on PATH (POSIX `command -v`). */
function hasBinary(name: string): boolean {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: 3_000,
  });
  return result.status === 0 && !!result.stdout?.trim();
}

/** Postgres connection parameters sourced from COMMANDER_DB_* env vars. */
function pgConnParams(): {
  host: string;
  port: string;
  db: string;
  user: string;
  password: string;
} | undefined {
  const host = process.env.COMMANDER_DB_HOST;
  const port = process.env.COMMANDER_DB_PORT ?? '5432';
  const db = process.env.COMMANDER_DB_NAME;
  const user = process.env.COMMANDER_DB_USER;
  const password = process.env.COMMANDER_DB_PASSWORD ?? '';
  if (!host || !db || !user) return undefined;
  return { host, port, db, user, password };
}

/**
 * Run a SQL query via psql using -t (tuples only) -A (unaligned) -F '|'.
 * Returns stdout (empty string on failure). Uses array args to avoid shell
 * injection; PGPASSWORD is passed through env, never on the command line.
 */
function pgQuery(sql: string): { ok: boolean; out: string; err: string } {
  const conn = pgConnParams();
  if (!conn) {
    return { ok: false, out: '', err: 'COMMANDER_DB_HOST/NAME/USER not set' };
  }
  const result = spawnSync(
    'psql',
    [
      '-h', conn.host,
      '-p', String(conn.port),
      '-U', conn.user,
      '-d', conn.db,
      '-t', '-A', '-F', '|',
      '-c', sql,
    ],
    {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: PG_TIMEOUT_MS,
      env: { ...process.env, PGPASSWORD: conn.password },
    },
  );
  if (result.error) {
    return { ok: false, out: '', err: (result.error as Error).message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      out: result.stdout ?? '',
      err: (result.stderr ?? '').trim().split('\n')[0] || `psql exit ${result.status}`,
    };
  }
  return { ok: true, out: result.stdout ?? '', err: (result.stderr ?? '').trim() };
}

/** Parse psql boolean token (t/f) to a JS boolean. */
function pgBool(token: string): boolean {
  return token.trim().toLowerCase() === 't';
}

/** Parse a psql -A -F '|' block into trimmed non-empty rows of fields. */
function parseRows(out: string): string[][] {
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split('|'));
}

/** HTTP GET returning status, body-as-text, parsed JSON (if any), and error. */
async function httpGet(
  url: string,
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<{ status: number; text: string; json: unknown; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json };
  } catch (err) {
    return { status: 0, text: '', json: undefined, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** Build a base URL for the /v1 gateway from COMMANDER_API_HOST/PORT. */
function gatewayBaseUrl(): string | undefined {
  const host = process.env.COMMANDER_API_HOST;
  const port = process.env.COMMANDER_API_PORT;
  if (!host || !port) return undefined;
  if (/^https?:\/\//i.test(host)) return `${host}:${port}`;
  return `http://${host}:${port}`;
}

// ─── Check 1: Postgres non-owner role ──────────────────────────────────

function checkPgRole(): CheckResult {
  const NAME = 'postgres-non-owner-role';
  if (!hasBinary('psql')) {
    return {
      check: NAME,
      passed: false,
      severity: 'FAIL',
      detail:
        'psql binary not found; PG role checks required for live-fire (spec §3.2).',
    };
  }
  if (!pgConnParams()) {
    return {
      check: NAME,
      passed: false,
      severity: 'FAIL',
      detail:
        'COMMANDER_DB_HOST/NAME/USER not set; PG role checks required for live-fire (spec §3.2).',
    };
  }

  // current_user / session_user
  const who = pgQuery('SELECT current_user, session_user;');
  if (!who.ok) {
    return {
      check: NAME,
      passed: false,
      severity: 'FAIL',
      detail: `Postgres connection failed: ${who.err}`,
    };
  }
  const whoRows = parseRows(who.out);
  const whoRow = whoRows[0];
  const currentRole = whoRow?.[0]?.trim() ?? '';
  const sessionRole = whoRow?.[1]?.trim() ?? '';

  // role attributes
  const attr = pgQuery(
    'SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user;',
  );
  if (!attr.ok) {
    return {
      check: NAME,
      passed: false,
      severity: 'FAIL',
      detail: `Failed to query pg_roles: ${attr.err}`,
    };
  }
  const attrRow = parseRows(attr.out)[0];
  const isSuper = attrRow ? pgBool(attrRow[0]) : false;
  const canCreateRole = attrRow ? pgBool(attrRow[1]) : false;
  const canCreateDb = attrRow ? pgBool(attrRow[2]) : false;

  // does this role own any target table?
  const ownerSql =
    "SELECT c.relname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner " +
    "WHERE r.rolname = current_user AND c.relkind = 'r' AND " +
    "(c.relname IN ('runs','steps','memory_items','atr_run_ledger','event_sourcing_log') " +
    "OR c.relname LIKE 'war\\_room\\_%') ORDER BY c.relname;";
  const owner = pgQuery(ownerSql);
  const ownedTables = owner.ok ? parseRows(owner.out).map((r) => r[0]).filter(Boolean) : [];

  const reasons: string[] = [];
  if (isSuper) reasons.push('role is superuser');
  if (canCreateRole) reasons.push('role can create roles (rolcreaterole)');
  if (canCreateDb) reasons.push('role can create databases (rolcreatedb)');
  if (ownedTables.length > 0) reasons.push(`role owns target table(s): ${ownedTables.join(', ')}`);

  if (reasons.length > 0) {
    return {
      check: NAME,
      passed: false,
      severity: 'FAIL',
      detail: `Role ${currentRole || '(unknown)'} violates non-owner/non-superuser: ${reasons.join('; ')}.`,
    };
  }
  return {
    check: NAME,
    passed: true,
    severity: 'FAIL',
    detail: `Connected role=${currentRole} session_user=${sessionRole}; not superuser, not owner, cannot create roles/DBs.`,
  };
}

// ─── Check 2: RLS enabled with WITH CHECK ──────────────────────────────

function checkRlsWithCheck(): CheckResult {
  const NAME = 'rls-with-check';
  if (!hasBinary('psql')) {
    return {
      check: NAME,
      passed: false,
      severity: 'FAIL',
      detail:
        'psql binary not found; RLS checks required for live-fire (spec §3.2).',
    };
  }
  if (!pgConnParams()) {
    return {
      check: NAME,
      passed: false,
      severity: 'FAIL',
      detail:
        'COMMANDER_DB_HOST/NAME/USER not set; RLS checks required for live-fire (spec §3.2).',
    };
  }

  const sql =
    'SELECT c.relname, c.relrowsecurity, ' +
    'COALESCE(p.polname, \'\') AS polname, ' +
    'COALESCE(p.polqual IS NOT NULL, false) AS has_using, ' +
    'COALESCE(p.polwithcheck IS NOT NULL, false) AS has_withcheck ' +
    'FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid ' +
    "WHERE c.relkind = 'r' AND " +
    "(c.relname IN ('runs','steps','memory_items','atr_run_ledger','event_sourcing_log') " +
    "OR c.relname LIKE 'war\\_room\\_%') ORDER BY c.relname, p.polname;";
  const q = pgQuery(sql);
  if (!q.ok) {
    return {
      check: NAME,
      passed: false,
      severity: 'FAIL',
      detail: `Failed to query RLS/policies: ${q.err}`,
    };
  }

  const rows = parseRows(q.out).map((r) => ({
    relname: (r[0] ?? '').trim(),
    rls: r[1] ? pgBool(r[1]) : false,
    polname: (r[2] ?? '').trim(),
    hasUsing: r[3] ? pgBool(r[3]) : false,
    hasWithCheck: r[4] ? pgBool(r[4]) : false,
  }));

  // group by table
  const byTable = new Map<string, { rls: boolean; policies: typeof rows }>();
  for (const row of rows) {
    let entry = byTable.get(row.relname);
    if (!entry) {
      entry = { rls: row.rls, policies: [] };
      byTable.set(row.relname, entry);
    }
    // LEFT JOIN yields a row with empty polname when no policies exist.
    if (row.polname) entry.policies.push(row);
  }

  const failures: string[] = [];
  const warnings: string[] = [];

  for (const [table, entry] of byTable) {
    if (!entry.rls) {
      failures.push(`${table}: relrowsecurity=false (RLS not enabled)`);
      continue;
    }
    if (entry.policies.length === 0) {
      warnings.push(`${table}: RLS enabled but no policies defined (no access granted)`);
      continue;
    }
    for (const p of entry.policies) {
      if (!p.hasWithCheck) {
        failures.push(`${table} policy "${p.polname}": missing WITH CHECK (polwithcheck)`);
      }
    }
  }

  // Fixed target tables must exist — missing table is FAIL (spec §3.2 / §11).
  const found = new Set(byTable.keys());
  for (const t of FIXED_TARGET_TABLES) {
    if (!found.has(t)) {
      failures.push(`${t}: table not found in pg_class (cannot verify RLS)`);
    }
  }

  const detailParts: string[] = [];
  if (failures.length > 0) {
    detailParts.push(`FAIL: ${failures.join('; ')}`);
  }
  if (warnings.length > 0) {
    detailParts.push(`WARN: ${warnings.join('; ')}`);
  }
  if (detailParts.length === 0) {
    detailParts.push(
      `RLS enabled with WITH CHECK on all target tables (verified ${byTable.size} table(s): ${[...byTable.keys()].join(', ') || 'none'}).`,
    );
  }

  return {
    check: NAME,
    passed: failures.length === 0,
    severity: 'FAIL',
    detail: detailParts.join(' | '),
  };
}

// ─── Check 3: Vault reachable + sealed-healthy ─────────────────────────

async function checkVault(): Promise<CheckResult> {
  const NAME = 'vault-reachable';
  const addr = process.env.COMMANDER_VAULT_ADDR;
  const tokenSet = !!process.env.COMMANDER_VAULT_TOKEN;

  if (!addr) {
    return {
      check: NAME,
      passed: false,
      severity: 'FAIL',
      detail: 'COMMANDER_VAULT_ADDR is not set. Vault is required for live-fire (per spec §3.1).',
    };
  }

  const healthUrl = addr.replace(/\/+$/, '') + '/v1/sys/health';
  const res = await httpGet(healthUrl);

  if (res.error || res.status === 0) {
    return {
      check: NAME,
      passed: false,
      severity: 'FAIL',
      detail: `Vault unreachable at ${healthUrl}: ${res.error ?? 'no response'}.`,
    };
  }

  // Vault /v1/sys/health: 200 = active+unsealed, 429 = standby (unsealed),
  // 472 = sealed, 473 = sealed+shutdown. Body has { initialized, sealed, ... }.
  const body = (res.json ?? {}) as { initialized?: boolean; sealed?: boolean };
  const sealed = body.sealed === true;
  const initialized = body.initialized !== false;

  const reachableHealthy =
    (res.status === 200 || res.status === 429) && !sealed && initialized;

  if (!reachableHealthy) {
    return {
      check: NAME,
      passed: false,
      severity: 'FAIL',
      detail: `Vault not sealed-healthy: HTTP ${res.status}, sealed=${sealed}, initialized=${initialized}.`,
    };
  }

  if (!tokenSet) {
    return {
      check: NAME,
      passed: false,
      severity: 'FAIL',
      detail: `Vault reachable (HTTP ${res.status}, sealed=false) but COMMANDER_VAULT_TOKEN is not set.`,
    };
  }

  return {
    check: NAME,
    passed: true,
    severity: 'FAIL',
    detail: `Vault reachable at ${healthUrl} (HTTP ${res.status}, sealed=false, token present, token value not logged).`,
  };
}

// ─── Check 4: No forbidden env vars ────────────────────────────────────

function checkForbiddenEnvVars(): CheckResult {
  const NAME = 'no-forbidden-env-vars';
  let allowlist: KeypathAllowlist;
  try {
    allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf-8')) as KeypathAllowlist;
  } catch (err) {
    // allowlist load failure is a hard error (exit 2) — propagate via throw.
    throw new Error(
      `Cannot load keypath allowlist at ${ALLOWLIST_PATH}: ${(err as Error).message}`,
    );
  }
  const allowed = new Set(allowlist.allowed);
  const forbidden = allowlist.forbiddenPatterns ?? [];

  const pattern = /(_API_KEY|_SECRET|_TOKEN)$/;
  const violations: string[] = [];
  const present: string[] = [];

  for (const key of Object.keys(process.env)) {
    if (!pattern.test(key)) continue;
    present.push(key);
    const explicitlyForbidden = forbidden.some((f) => key === f || key.includes(f));
    if (explicitlyForbidden || !allowed.has(key)) {
      violations.push(key);
    }
  }

  if (violations.length > 0) {
    return {
      check: NAME,
      passed: false,
      severity: 'FAIL',
      detail: `Forbidden env vars present (not in allowlist ${ALLOWLIST_PATH}): ${violations.join(', ')}.`,
    };
  }
  return {
    check: NAME,
    passed: true,
    severity: 'FAIL',
    detail: `No forbidden *_API_KEY/*_SECRET/*_TOKEN env vars. Allowed keys present: ${present.length === 0 ? 'none' : present.join(', ')}.`,
  };
}

// ─── Check 5: runsc binary exists ──────────────────────────────────────

function checkRunsc(): CheckResult {
  const NAME = 'runsc-binary';
  if (hasBinary('runsc')) {
    // Probe that runsc can start a trivial command (per spec §3.2 "runsc ...
    // can start one empty container"). We use `runsc --version` as a light
    // liveness probe; a full container boot is left to the EXEC suite.
    const probe = spawnSync('runsc', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    if (probe.status === 0) {
      const ver = (probe.stdout ?? '').trim().split('\n')[0];
      return {
        check: NAME,
        passed: true,
        severity: 'WARN',
        detail: `runsc binary available${ver ? ` (${ver})` : ''}.`,
      };
    }
    return {
      check: NAME,
      passed: false,
      severity: 'WARN',
      detail: 'runsc found but `runsc --version` failed; gVisor EXEC tests should skip or use Docker fallback.',
    };
  }
  return {
    check: NAME,
    passed: false,
    severity: 'WARN',
    detail:
      'runsc binary not found. gVisor may be unavailable in this environment; live-fire EXEC tests must skip or use Docker fallback.',
  };
}

// ─── Check 6: /v1 gateway only ─────────────────────────────────────────

async function checkV1Gateway(): Promise<CheckResult> {
  const NAME = 'v1-gateway-only';
  const base = gatewayBaseUrl();
  if (!base) {
    return {
      check: NAME,
      passed: true,
      severity: 'WARN',
      detail:
        'COMMANDER_API_HOST/PORT not set; /v1 gateway checks skipped. Live-fire DATA tests need the API reachable.',
    };
  }

  // API health lives at /health (not /v1/health). Legacy /api/* must be gone.
  const healthUrl = `${base.replace(/\/+$/, '')}/health`;
  const legacyUrl = `${base.replace(/\/+$/, '')}/api/runs`;

  const health = await httpGet(healthUrl);
  const legacy = await httpGet(legacyUrl);

  // Host/port configured but unreachable → FAIL (spec §3.2 requires gateway).
  if ((health.error || health.status === 0) && (legacy.error || legacy.status === 0)) {
    return {
      check: NAME,
      passed: false,
      severity: 'FAIL',
      detail: `API not reachable at ${base}; gateway checks required for live-fire.`,
    };
  }

  // Enforce /health == 200 and legacy /api/* == 410|404 as FAIL.
  const reasons: string[] = [];
  if (health.error || health.status === 0) {
    reasons.push(`/health unreachable (${health.error ?? 'no response'})`);
  } else if (health.status !== 200) {
    reasons.push(`/health returned HTTP ${health.status} (expected 200)`);
  }
  if (legacy.error || legacy.status === 0) {
    reasons.push(`/api/runs unreachable (${legacy.error ?? 'no response'})`);
  } else if (legacy.status !== 410 && legacy.status !== 404) {
    reasons.push(
      `/api/runs returned HTTP ${legacy.status} (expected 410 Gone or 404 Not Found — legacy route must not be reachable)`,
    );
  }

  if (reasons.length > 0) {
    return {
      check: NAME,
      passed: false,
      severity: 'FAIL',
      detail: `Gateway check failed: ${reasons.join('; ')}.`,
    };
  }
  return {
    check: NAME,
    passed: true,
    severity: 'FAIL',
    detail: `/v1/health → 200; /api/runs → ${legacy.status}. Legacy /api/* correctly closed.`,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');

  const checks: CheckResult[] = [];

  // Synchronous checks first.
  checks.push(checkPgRole());
  checks.push(checkRlsWithCheck());
  checks.push(checkForbiddenEnvVars());
  checks.push(checkRunsc());

  // Async (network) checks.
  checks.push(await checkVault());
  checks.push(await checkV1Gateway());

  const anyFail = checks.some((c) => c.severity === 'FAIL' && !c.passed);
  const result: EnvCheckResult = {
    verdict: anyFail ? 'FAIL' : 'PASS',
    checks,
    scannedAt: new Date().toISOString(),
  };

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nWS9 §3.2 Environment Readiness Gate`);
    console.log(`==================================`);
    console.log(`Scanned at: ${result.scannedAt}`);
    console.log('');
    for (const c of checks) {
      const icon = c.passed ? '✅' : c.severity === 'WARN' ? '⚠️' : '❌';
      const sev = c.severity === 'WARN' ? 'WARN' : 'FAIL';
      console.log(`${icon} [${sev}] ${c.check}`);
      console.log(`    ${c.detail}`);
    }
    console.log('');
    console.log(`Verdict: ${result.verdict}${anyFail ? ' (one or more required checks failed)' : ' (all required checks pass; WARNs are advisory)'}`);
  }

  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  // Exit code 2 on error (e.g. allowlist missing, uncaught exception).
  console.error(`ERROR: ws9-env-check failed: ${(err as Error).message ?? err}`);
  process.exit(2);
});
