/**
 * data-isolation.test.ts — WS9 §4.1 cross-tenant data isolation live-fire.
 *
 *   DATA-1: A queries B's tables → RLS rejects; 0 rows (real PG via psql).
 *   DATA-2: A forges X-Tenant-ID → JWT subject wins (needs /v1 + auth harness).
 *   DATA-3: A INSERT with tenant_id=tenant-b → WITH CHECK rejects (real PG).
 *   DATA-4: assertSameTenant blocks cross-tenant (in-process → simulated).
 *   DATA-5: GDPR Art 17 delete for B → rejected (needs /v1 harness).
 *   DATA-6: Cross-store tenant keys/paths (in-process → simulated).
 *
 * Honesty: only real PG adversarial steps write evidenceLevel=live.
 * Unimplemented /v1 harness cases produce NO evidence (missing ≠ PASS).
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  runWithTenant,
  assertSameTenant,
  tenantKey,
  tenantPathSegment,
  TenantIsolationError,
} from '../../src/runtime/tenantContext';
import { AuditChainLedger, collectPersistedEntries } from '../../src/security/auditChainLedger';
import {
  probePostgres,
  probeV1Gateway,
  describeIf,
  writePass,
  writeBreach,
  TENANT_A,
  TENANT_B,
} from './_evidence';

const TEST_KEY = 'x'.repeat(64);

let tmpCounter = 0;
function makeTmp(): { dir: string; cleanup: () => void } {
  const dir = path.join(os.tmpdir(), `ws9-data-${process.pid}-${Date.now()}-${++tmpCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* swallow */
      }
    },
  };
}

/** Run SQL as commander_app with optional app.tenant_id GUC. */
function pgAsTenant(
  tenantId: string | null,
  sql: string,
): { ok: boolean; out: string; err: string; status: number | null } {
  const host = process.env.COMMANDER_DB_HOST;
  const port = process.env.COMMANDER_DB_PORT ?? '5432';
  const db = process.env.COMMANDER_DB_NAME;
  const user = process.env.COMMANDER_DB_USER;
  const password = process.env.COMMANDER_DB_PASSWORD ?? '';
  if (!host || !db || !user) {
    return { ok: false, out: '', err: 'COMMANDER_DB_* not set', status: null };
  }
  const prefix =
    tenantId === null
      ? ''
      : `SELECT set_config('app.tenant_id', '${tenantId.replace(/'/g, "''")}', false); `;
  const result = spawnSync(
    'psql',
    [
      '-h',
      host,
      '-p',
      port,
      '-U',
      user,
      '-d',
      db,
      '-v',
      'ON_ERROR_STOP=1',
      '-t',
      '-A',
      '-c',
      prefix + sql,
    ],
    {
      encoding: 'utf-8',
      env: { ...process.env, PGPASSWORD: password },
      timeout: 15_000,
    },
  );
  return {
    ok: result.status === 0,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim(),
    status: result.status,
  };
}

// ─── DATA-1: A queries B's tables → RLS rejects (needs real PG) ─────────

describeIf(probePostgres)('WS9 DATA-1 (live PG): A queries B\'s tables → RLS rejects', () => {
  it('commander_app as tenant-a cannot see tenant-b runs', () => {
    const artifacts: string[] = [];
    const asA = pgAsTenant(TENANT_A, "SELECT id FROM runs WHERE id = 'run-b-1';");
    const ownA = pgAsTenant(TENANT_A, "SELECT id FROM runs WHERE id = 'run-a-1';");
    const asB = pgAsTenant(TENANT_B, "SELECT id FROM runs WHERE id = 'run-b-1';");

    try {
      expect(asA.ok, `tenant-a query failed: ${asA.err}`).toBe(true);
      expect(asA.out).toBe(''); // RLS hides B's row
      expect(ownA.ok).toBe(true);
      expect(ownA.out).toBe('run-a-1');
      expect(asB.ok).toBe(true);
      expect(asB.out).toBe('run-b-1');

      writePass(
        'DATA-1',
        `Postgres RLS: tenant-a SELECT run-b-1 → 0 rows; tenant-a can read run-a-1; ` +
          `tenant-b can read run-b-1. commander_app role + app.tenant_id GUC.`,
        artifacts,
        'live',
      );
    } catch (err) {
      writeBreach(
        'DATA-1',
        `RLS isolation failed: A saw B=${JSON.stringify(asA)}; ownA=${JSON.stringify(ownA)}; ` +
          `asB=${JSON.stringify(asB)}. ${(err as Error).message}`,
        artifacts,
        'live',
      );
      throw err;
    }
  });
});

describeIf(!probePostgres.available)('WS9 DATA-1 (skipped: PG unavailable)', () => {
  it('skipped — Postgres not available', () => {
    // No evidence (spec §9.2).
  });
});

// ─── DATA-2: needs authenticated /v1 harness (not yet wired) ───────────

describeIf(probeV1Gateway)('WS9 DATA-2 (live /v1): A forges X-Tenant-ID → JWT subject wins', () => {
  it('requires JWT auth harness — no evidence until implemented', () => {
    // Honest skip: gateway is up but we lack a signed tenant-a JWT fixture
    // and a tenant-scoped /v1 read endpoint assertion in this suite yet.
    // Do NOT writePass — missing evidence keeps livefire FAIL until built.
  });
});

describeIf(!probeV1Gateway.available)('WS9 DATA-2 (skipped: /v1 unavailable)', () => {
  it('skipped — /v1 gateway not available', () => {});
});

// ─── DATA-3: WITH CHECK rejects cross-tenant INSERT ────────────────────

describeIf(probePostgres)('WS9 DATA-3 (live PG): A INSERT with tenant_id=tenant-b → WITH CHECK rejects', () => {
  it('RLS WITH CHECK prevents A from writing B\'s tenant_id', () => {
    const artifacts: string[] = [];
    const insertId = `run-x-${Date.now()}`;
    const cross = pgAsTenant(
      TENANT_A,
      `INSERT INTO runs (id, tenant_id, status) VALUES ('${insertId}', '${TENANT_B}', 'pending');`,
    );
    const verify = pgAsTenant(TENANT_B, `SELECT id FROM runs WHERE id = '${insertId}';`);

    try {
      expect(cross.ok).toBe(false);
      expect(cross.err + cross.out).toMatch(/row-level security|policy|violat/i);
      expect(verify.out).toBe('');

      writePass(
        'DATA-3',
        `WITH CHECK rejected cross-tenant INSERT (tenant_id=${TENANT_B} from ${TENANT_A} session). ` +
          `psql status=${cross.status}; err=${cross.err.slice(0, 160)}`,
        artifacts,
        'live',
      );
    } catch (err) {
      writeBreach(
        'DATA-3',
        `WITH CHECK did not reject cross-tenant INSERT: ok=${cross.ok} err=${cross.err}. ` +
          `${(err as Error).message}`,
        artifacts,
        'live',
      );
      throw err;
    }
  });
});

describeIf(!probePostgres.available)('WS9 DATA-3 (skipped: PG unavailable)', () => {
  it('skipped — Postgres not available', () => {});
});

// ─── DATA-4: in-process tenant scope (simulated) ───────────────────────

describe('WS9 DATA-4: tenant_scope=\'*\' path blocked; must use caller tenant', () => {
  it('assertSameTenant rejects cross-tenant access from * scope', () => {
    const artifacts: string[] = [];
    try {
      let blocked = false;
      runWithTenant(TENANT_A, () => {
        try {
          assertSameTenant(TENANT_B);
        } catch (err) {
          blocked = err instanceof TenantIsolationError;
        }
      });
      expect(blocked).toBe(true);

      let blockedReverse = false;
      runWithTenant(TENANT_B, () => {
        try {
          assertSameTenant(TENANT_A);
        } catch (err) {
          blockedReverse = err instanceof TenantIsolationError;
        }
      });
      expect(blockedReverse).toBe(true);

      let allowed = false;
      runWithTenant(TENANT_A, () => {
        try {
          assertSameTenant(TENANT_A);
          allowed = true;
        } catch {
          allowed = false;
        }
      });
      expect(allowed).toBe(true);

      writePass(
        'DATA-4',
        `Cross-tenant access blocked by assertSameTenant (in-process PEP). ` +
          `A→B blocked=${blocked}, B→A blocked=${blockedReverse}, same-tenant allowed=${allowed}.`,
        artifacts,
        'simulated',
      );
    } catch (err) {
      writeBreach(
        'DATA-4',
        `Cross-tenant access NOT blocked by assertSameTenant. ${(err as Error).message ?? ''}`,
        artifacts,
        'simulated',
      );
      throw err;
    }
  });
});

// ─── DATA-5: needs /v1 GDPR harness ────────────────────────────────────

describeIf(probeV1Gateway)('WS9 DATA-5 (live /v1): A calls GDPR Art 17 delete for B → rejected', () => {
  it('requires GDPR delete harness — no evidence until implemented', () => {
    // No writePass (honesty).
  });
});

describeIf(!probeV1Gateway.available)('WS9 DATA-5 (skipped: /v1 unavailable)', () => {
  it('skipped — /v1 gateway not available', () => {});
});

// ─── DATA-6: Cross-store isolation (simulated) ─────────────────────────

describe('WS9 DATA-6: Cross-store isolation — A cannot read/write B', () => {
  let env: { dir: string; cleanup: () => void };
  beforeEach(() => {
    env = makeTmp();
  });
  afterEach(() => env.cleanup());

  it('audit chain: A\'s entries isolated from B; file store keyed by tenant', () => {
    const artifacts: string[] = [];
    const ledger = new AuditChainLedger({
      persistDir: env.dir,
      masterKey: Buffer.from(TEST_KEY, 'utf-8'),
    });

    runWithTenant(TENANT_A, () =>
      ledger.logEvent({
        type: 'content_threat',
        severity: 'high',
        source: 'ws9-data-6',
        message: 'tenant-a event',
      }),
    );
    runWithTenant(TENANT_B, () =>
      ledger.logEvent({
        type: 'content_threat',
        severity: 'high',
        source: 'ws9-data-6',
        message: 'tenant-b event',
      }),
    );

    const entries = collectPersistedEntries(env.dir);
    const aEntries = entries.filter((e) => e.tenantId === TENANT_A);
    const bEntries = entries.filter((e) => e.tenantId === TENANT_B);

    try {
      expect(aEntries.length).toBe(1);
      expect(bEntries.length).toBe(1);
      expect(aEntries[0]?.message).toBe('tenant-a event');
      expect(bEntries[0]?.message).toBe('tenant-b event');

      const keyA = tenantKey(TENANT_A, 'memory');
      const keyB = tenantKey(TENANT_B, 'memory');
      expect(keyA).not.toBe(keyB);

      const pathA = tenantPathSegment(TENANT_A);
      const pathB = tenantPathSegment(TENANT_B);
      expect(pathA).not.toBe(pathB);

      writePass(
        'DATA-6',
        `Cross-store isolation (in-process): audit A=${aEntries.length} B=${bEntries.length}; ` +
          `tenantKey/path segments disjoint.`,
        artifacts,
        'simulated',
      );
    } catch (err) {
      writeBreach(
        'DATA-6',
        `Cross-store isolation breach: A=${aEntries.length} B=${bEntries.length}. ` +
          `${(err as Error).message ?? ''}`,
        artifacts,
        'simulated',
      );
      throw err;
    }
  });
});
