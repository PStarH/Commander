import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Parity gate for the two Postgres role-init files.
 *
 * `deploy/docker/postgres-init.sql` ships placeholder password literals for
 * production substitution; `deploy/docker/postgres-init.bench.sql` ships fixed
 * local passwords for the benchmark/dev stack. After normalizing password
 * literals, the two files MUST define exactly the same roles, attributes,
 * role memberships, and database/schema grants. Any drift (a role added to one
 * file only, a changed attribute, a missing grant) fails this test.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const PROD = join(repoRoot, 'deploy', 'docker', 'postgres-init.sql');
const BENCH = join(repoRoot, 'deploy', 'docker', 'postgres-init.bench.sql');

const EXPECTED_ROLES = ['commander_owner', 'commander_app', 'commander_scheduler', 'commander_worker'];

interface RoleFacts {
  roles: string[];
  memberships: string[];
  grants: string[];
}

function stripComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

function normalizePasswords(sql: string): string {
  return sql.replace(/PASSWORD\s+'[^']*'/gi, "PASSWORD '<redacted>'");
}

function extractFacts(rawSql: string): RoleFacts {
  const sql = normalizePasswords(stripComments(rawSql));
  const roles = new Set<string>();
  const memberships = new Set<string>();
  const grants = new Set<string>();

  // Role definitions with attributes (CREATE and ALTER both count; deduped).
  const roleRe = /(?:CREATE|ALTER)\s+ROLE\s+(\w+)\s+WITH\s+([^;]+?)(?=;)/gi;
  for (const m of sql.matchAll(roleRe)) {
    const name = m[1];
    const attrs = m[2]
      .replace(/PASSWORD\s+'<redacted>'/i, ' ')
      .split(/\s+/)
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean)
      .sort();
    roles.add(`${name}:${attrs.join(',')}`);
  }

  // Role membership grants: GRANT <role> TO <role> [WITH ADMIN OPTION].
  // Privilege grants (which always contain ON) are excluded by the pattern.
  const memRe = /GRANT\s+(\w+)\s+TO\s+(\w+)(\s+WITH\s+ADMIN\s+OPTION)?/gi;
  for (const m of sql.matchAll(memRe)) {
    memberships.add(`${m[1]}->${m[2]}${m[3] ? ':ADMIN' : ''}`);
  }

  // Privilege grants on DATABASE/SCHEMA objects.
  const privRe = /GRANT\s+([^;]+?)\s+ON\s+(DATABASE|SCHEMA)\s+(\w+)\s+TO\s+(\w+)/gi;
  for (const m of sql.matchAll(privRe)) {
    const privs = m[1]
      .split(',')
      .map((p) => p.trim().toUpperCase())
      .sort()
      .join(',');
    grants.add(`${privs} ON ${m[2].toUpperCase()} ${m[3]} -> ${m[4]}`);
  }

  return {
    roles: [...roles].sort(),
    memberships: [...memberships].sort(),
    grants: [...grants].sort(),
  };
}

describe('postgres role-init parity', () => {
  const prod = extractFacts(readFileSync(PROD, 'utf-8'));
  const bench = extractFacts(readFileSync(BENCH, 'utf-8'));

  it('both files define all four Commander roles', () => {
    for (const role of EXPECTED_ROLES) {
      assert.ok(
        prod.roles.some((r) => r.startsWith(`${role}:`)),
        `postgres-init.sql must define role ${role}`,
      );
      assert.ok(
        bench.roles.some((r) => r.startsWith(`${role}:`)),
        `postgres-init.bench.sql must define role ${role}`,
      );
    }
  });

  it('role attributes match after password normalization', () => {
    assert.deepEqual(bench.roles, prod.roles);
  });

  it('role memberships match', () => {
    assert.deepEqual(bench.memberships, prod.memberships);
  });

  it('database/schema grants match', () => {
    assert.deepEqual(bench.grants, prod.grants);
  });

  it('only commander_scheduler carries BYPASSRLS; owner is the only CREATEROLE', () => {
    const workerLine = prod.roles.find((r) => r.startsWith('commander_worker:'));
    const appLine = prod.roles.find((r) => r.startsWith('commander_app:'));
    const schedulerLine = prod.roles.find((r) => r.startsWith('commander_scheduler:'));
    assert.ok(workerLine?.includes('NOBYPASSRLS'), 'commander_worker must be NOBYPASSRLS');
    assert.ok(appLine?.includes('NOBYPASSRLS'), 'commander_app must be NOBYPASSRLS');
    assert.ok(schedulerLine?.includes('BYPASSRLS') && !schedulerLine.includes('NOBYPASSRLS'),
      'commander_scheduler must carry BYPASSRLS');
    assert.ok(workerLine?.includes('NOCREATEROLE'), 'commander_worker must be NOCREATEROLE');
  });
});
