import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEPLOY_GATE_ROLES,
  EXPECTED_ROLE_PRIVILEGES,
  INSTANCE_ID_ENV,
  MUTATION_OPT_IN_ENV,
  PROVISION_TOKEN_ENV,
  ROLE_PASSWORD_ENV,
  assertProvisionedCiInstance,
  formatAdmissionFailure,
  hostOfDsn,
  isLoopbackOrPrivateHost,
  resolveRolePassword,
  sqlLiteral,
} from './ci-database-scope.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const READ = (relative: string): string => readFileSync(join(REPO_ROOT, relative), 'utf8');

/** A complete, admitted environment. Each test removes one thing from it. */
const ADMITTED: NodeJS.ProcessEnv = {
  [MUTATION_OPT_IN_ENV]: 'yes',
  [INSTANCE_ID_ENV]: 'gha-1234567890-1',
  [PROVISION_TOKEN_ENV]: 'provisioner-token-0123456789',
};

const LOOPBACK_DSN = 'postgres://commander:commander@127.0.0.1:1/nope';

function runScript(
  relative: string,
  env: NodeJS.ProcessEnv,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', join(REPO_ROOT, relative)], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 120_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('ci-database-scope — admission conditions', () => {
  it('refuses when nothing is supplied: no ambient signal counts as authorization', () => {
    const failures = assertProvisionedCiInstance({}, LOOPBACK_DSN);
    assert.equal(failures.length, 3);
    assert.ok(failures.some((f) => f.startsWith('CI_INSTANCE_MUTATION_NOT_AUTHORIZED')));
    assert.ok(failures.some((f) => f.startsWith('CI_INSTANCE_ID_REQUIRED')));
    assert.ok(failures.some((f) => f.startsWith('CI_PROVISION_TOKEN_REQUIRED')));
  });

  it('does not accept CI=true or a loopback target as authorization', () => {
    const failures = assertProvisionedCiInstance({ CI: 'true' }, LOOPBACK_DSN);
    assert.ok(failures.some((f) => f.startsWith('CI_INSTANCE_MUTATION_NOT_AUTHORIZED')));
  });

  it('requires an explicit opt-in value, not just presence', () => {
    assert.ok(
      assertProvisionedCiInstance({ ...ADMITTED, [MUTATION_OPT_IN_ENV]: '1' }, LOOPBACK_DSN).some(
        (f) => f.startsWith('CI_INSTANCE_MUTATION_NOT_AUTHORIZED'),
      ),
    );
    assert.ok(
      assertProvisionedCiInstance(
        { ...ADMITTED, [MUTATION_OPT_IN_ENV]: 'true' },
        LOOPBACK_DSN,
      ).some((f) => f.startsWith('CI_INSTANCE_MUTATION_NOT_AUTHORIZED')),
    );
  });

  it('rejects a too-short instance id or provision token', () => {
    assert.ok(
      assertProvisionedCiInstance({ ...ADMITTED, [INSTANCE_ID_ENV]: 'short' }, LOOPBACK_DSN).some(
        (f) => f.startsWith('CI_INSTANCE_ID_REQUIRED'),
      ),
    );
    assert.ok(
      assertProvisionedCiInstance(
        { ...ADMITTED, [PROVISION_TOKEN_ENV]: 'tiny' },
        LOOPBACK_DSN,
      ).some((f) => f.startsWith('CI_PROVISION_TOKEN_REQUIRED')),
    );
  });

  it('refuses a non-isolated target host even when fully admitted', () => {
    const failures = assertProvisionedCiInstance(ADMITTED, 'postgres://u:p@db.prod.example:5432/x');
    assert.deepEqual(failures, [
      'CI_TARGET_NOT_ISOLATED: the target host is not loopback/private; refusing to mutate it',
    ]);
  });

  it('admits only when every condition holds', () => {
    assert.deepEqual(assertProvisionedCiInstance(ADMITTED, LOOPBACK_DSN), []);
    assert.deepEqual(assertProvisionedCiInstance(ADMITTED), []);
  });

  it('classifies hosts conservatively', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      '10.0.0.5',
      '192.168.1.9',
      '172.16.4.4',
      '172.31.255.1',
    ]) {
      assert.equal(isLoopbackOrPrivateHost(host), true, `${host} should be private`);
    }
    for (const host of ['', '  ', 'db.example.com', '172.32.0.1', '11.0.0.1', '8.8.8.8']) {
      assert.equal(isLoopbackOrPrivateHost(host), false, `${host} should not be private`);
    }
    assert.equal(hostOfDsn('postgres://u:p@127.0.0.1:5432/db'), '127.0.0.1');
    assert.equal(hostOfDsn('not a dsn'), undefined);
  });

  it('formats a stable, secret-free refusal message', () => {
    const message = formatAdmissionFailure(['A_ONE', 'B_TWO']);
    assert.equal(message, 'CI_DATABASE_MUTATION_REFUSED:\n  - A_ONE\n  - B_TWO');
  });
});

describe('ci-database-scope — role passwords', () => {
  it('has an env var name for every deploy-gate role', () => {
    for (const role of DEPLOY_GATE_ROLES) {
      assert.equal(typeof ROLE_PASSWORD_ENV[role], 'string');
      assert.ok(ROLE_PASSWORD_ENV[role].startsWith('COMMANDER_CI_PASSWORD_'));
    }
  });

  it('never invents a password', () => {
    for (const role of DEPLOY_GATE_ROLES) {
      const { password, failures } = resolveRolePassword(role, {});
      assert.equal(password, undefined);
      assert.equal(failures.length, 1);
      assert.match(failures[0]!, /^CI_ROLE_PASSWORD_REQUIRED/);
    }
  });

  it('rejects the historical public defaults', () => {
    for (const role of DEPLOY_GATE_ROLES) {
      const { password, failures } = resolveRolePassword(role, {
        [ROLE_PASSWORD_ENV[role]]: role,
      });
      assert.equal(password, undefined);
      assert.match(failures[0]!, /^CI_ROLE_PASSWORD_INSECURE/);
    }
    const { failures } = resolveRolePassword('commander_app', {
      [ROLE_PASSWORD_ENV.commander_app]: 'commander',
    });
    assert.match(failures[0]!, /^CI_ROLE_PASSWORD_INSECURE/);
  });

  it('rejects short and out-of-charset passwords', () => {
    assert.match(
      resolveRolePassword('commander_app', { [ROLE_PASSWORD_ENV.commander_app]: 'short' })
        .failures[0]!,
      /^CI_ROLE_PASSWORD_TOO_SHORT/,
    );
    assert.match(
      resolveRolePassword('commander_app', {
        [ROLE_PASSWORD_ENV.commander_app]: "has'quote-and-is-long",
      }).failures[0]!,
      /^CI_ROLE_PASSWORD_CHARSET_INVALID/,
    );
  });

  it('accepts a run-scoped generated password', () => {
    const { password, failures } = resolveRolePassword('commander_worker', {
      [ROLE_PASSWORD_ENV.commander_worker]: 'Xk9_2fQz!7mLp0Rt',
    });
    assert.deepEqual(failures, []);
    assert.equal(password, 'Xk9_2fQz!7mLp0Rt');
  });

  it('sqlLiteral rejects NUL and any non-allowlisted character', () => {
    assert.equal(sqlLiteral('Xk9_2fQz!7mLp0Rt'), "'Xk9_2fQz!7mLp0Rt'");
    assert.throws(() => sqlLiteral('a\u0000b'), /SQL_LITERAL_NUL_REJECTED/);
    assert.throws(() => sqlLiteral("a'b"), /SQL_LITERAL_CHARSET_REJECTED/);
    assert.throws(() => sqlLiteral('a\\b'), /SQL_LITERAL_CHARSET_REJECTED/);
    assert.throws(() => sqlLiteral('café1234567890ab'), /SQL_LITERAL_CHARSET_REJECTED/);
  });
});

describe('ci-database-scope — the privilege vector is checked, not just the password', () => {
  it('declares an exact privilege vector for every deploy-gate role', () => {
    assert.deepEqual(Object.keys(EXPECTED_ROLE_PRIVILEGES).sort(), [...DEPLOY_GATE_ROLES].sort());
    // Only the owner may create roles; only owner + scheduler may bypass RLS.
    assert.deepEqual(
      DEPLOY_GATE_ROLES.filter((role) => EXPECTED_ROLE_PRIVILEGES[role].createRole),
      ['commander_owner'],
    );
    assert.deepEqual(
      DEPLOY_GATE_ROLES.filter((role) => EXPECTED_ROLE_PRIVILEGES[role].bypassRls).sort(),
      ['commander_owner', 'commander_scheduler'],
    );
    for (const role of DEPLOY_GATE_ROLES) {
      assert.equal(
        EXPECTED_ROLE_PRIVILEGES[role].superuser,
        false,
        `${role} must not be superuser`,
      );
      assert.equal(EXPECTED_ROLE_PRIVILEGES[role].createDb, false, `${role} must not create DBs`);
      assert.equal(EXPECTED_ROLE_PRIVILEGES[role].replication, false, `${role} must not replicate`);
    }
  });

  it('the restore script derives statements from the shared vector and verifies the result', () => {
    const source = READ('scripts/ci-restore-deploy-gate-roles.ts');
    assert.match(source, /EXPECTED_ROLE_PRIVILEGES/);
    assert.match(source, /sqlLiteral\(password\)/);
    assert.match(source, /CI_DEPLOY_GATE_ROLE_PRIVILEGE_MISMATCH/);
    assert.match(source, /rolbypassrls/);
    assert.match(source, /rolcreaterole/);
    // The historical public defaults must be gone.
    assert.doesNotMatch(source, /PASSWORD\s+'commander_/);
    assert.doesNotMatch(source, /PASSWORD\s+'commander'/);
  });
});

describe('ci-database-scope — mutating entry points are admission-gated', () => {
  it('the ordinary acceptance chain no longer mutates the database', () => {
    const pkg = JSON.parse(READ('package.json')) as { scripts: Record<string, string> };
    const chain = pkg.scripts['test:deploy-gates']!;
    assert.doesNotMatch(chain, /ci-restore-deploy-gate-roles/);
    assert.doesNotMatch(chain, /ci-bootstrap-deploy-gates/);
    assert.doesNotMatch(chain, /proof:authority/);
    assert.match(chain, /scripts\/ci-database-scope\.test\.ts/);

    // The mutating steps still exist, but only behind an explicit entry point.
    assert.match(pkg.scripts['test:deploy-gates:prepare']!, /ci-restore-deploy-gate-roles/);
    assert.match(pkg.scripts['test:deploy-gates:prepare']!, /ci-bootstrap-deploy-gates/);
    assert.match(pkg.scripts['test:deploy-gates:isolated']!, /proof:authority/);
  });

  it('every mutating script consults the shared guard', () => {
    for (const file of [
      'scripts/ci-restore-deploy-gate-roles.ts',
      'scripts/ci-bootstrap-deploy-gates.ts',
      'scripts/authority-closure-proof.ts',
    ]) {
      const source = READ(file);
      assert.match(source, /assertProvisionedCiInstance/, `${file} must call the guard`);
      assert.match(source, /from '\.\/ci-database-scope\.js'/, `${file} must import the guard`);
    }
  });

  it('the proof gates admission before it opens a connection or migrates', () => {
    const source = READ('scripts/authority-closure-proof.ts');
    const guardAt = source.indexOf('const admissionFailures = [');
    const connectAt = source.indexOf('ownerPool = new Pool(');
    const migrateAt = source.indexOf('await runKernelMigrations(ownerPool)');
    const roleAt = source.indexOf('await ensureRoleLogin(ownerPool');
    assert.ok(guardAt > 0 && connectAt > guardAt, 'guard must precede the first connection');
    assert.ok(migrateAt > guardAt, 'guard must precede migrations');
    assert.ok(roleAt > guardAt, 'guard must precede role mutation');

    // No implicit public DSN or default password may remain.
    assert.doesNotMatch(source, /FALLBACK_DSN/);
    assert.doesNotMatch(source, /postgres:\/\/commander:commander@/);
    assert.doesNotMatch(source, /\?\?\s*'commander_app'/);
    assert.doesNotMatch(source, /\?\?\s*'commander_worker'/);
    assert.doesNotMatch(source, /\?\?\s*'commander_scheduler'/);
    assert.doesNotMatch(source, /\?\?\s*'commander_adapter_ops'/);
  });
});

describe('ci-database-scope — offline negative paths touch nothing', () => {
  it('the role restore refuses before connecting when not admitted', () => {
    const { status, stderr } = runScript('scripts/ci-restore-deploy-gate-roles.ts', {
      DATABASE_URL: LOOPBACK_DSN,
    });
    assert.equal(status, 1);
    assert.match(stderr, /CI_DATABASE_MUTATION_REFUSED/);
    assert.match(stderr, /CI_INSTANCE_MUTATION_NOT_AUTHORIZED/);
    // No connection was attempted, so no driver-level failure appears.
    assert.doesNotMatch(stderr, /ECONNREFUSED|connect ECONN/i);
    // And no password material is echoed.
    assert.doesNotMatch(stderr, /COMMANDER_CI_PASSWORD_/);
  });

  it('the role restore refuses when the DSN is absent', () => {
    const env = { ...process.env, ...ADMITTED };
    delete env.DATABASE_URL;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(REPO_ROOT, 'scripts/ci-restore-deploy-gate-roles.ts')],
      { cwd: REPO_ROOT, env, encoding: 'utf-8', timeout: 120_000 },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CI_ROLE_RESTORE_REFUSED/);
  });

  it('the role restore refuses when a role password is missing, even when admitted', () => {
    const { status, stderr } = runScript('scripts/ci-restore-deploy-gate-roles.ts', {
      ...ADMITTED,
      DATABASE_URL: LOOPBACK_DSN,
      [ROLE_PASSWORD_ENV.commander_app]: 'app-pw-0123456789abcdef',
    });
    assert.equal(status, 1);
    assert.match(stderr, /CI_ROLE_PASSWORD_REQUIRED/);
    assert.doesNotMatch(stderr, /ECONNREFUSED|connect ECONN/i);
  });

  it('the role restore does not leak passwords when the admitted connection fails', () => {
    const password = 'app-pw-0123456789abcdef';
    const { status, stderr } = runScript('scripts/ci-restore-deploy-gate-roles.ts', {
      ...ADMITTED,
      DATABASE_URL: LOOPBACK_DSN,
      [ROLE_PASSWORD_ENV.commander_owner]: 'own-pw-0123456789abcdef',
      [ROLE_PASSWORD_ENV.commander_app]: password,
      [ROLE_PASSWORD_ENV.commander_tenant_authority]: 'ta-pw-0123456789abcdef',
      [ROLE_PASSWORD_ENV.commander_scheduler]: 'sch-pw-0123456789abcdef',
      [ROLE_PASSWORD_ENV.commander_worker]: 'wrk-pw-0123456789abcdef',
      [ROLE_PASSWORD_ENV.commander_adapter_ops]: 'ao-pw-0123456789abcdef',
    });
    assert.equal(status, 1);
    assert.match(stderr, /CI_DEPLOY_GATE_ROLE_RESTORE_FAILED/);
    assert.doesNotMatch(stderr, new RegExp(password));
    assert.doesNotMatch(stderr, /ALTER ROLE/);
  });

  it('the bootstrap refuses before connecting when not admitted', () => {
    const { status, stderr } = runScript('scripts/ci-bootstrap-deploy-gates.ts', {
      COMMANDER_OWNER_DATABASE_URL: LOOPBACK_DSN,
    });
    assert.equal(status, 1);
    assert.match(stderr, /CI_DATABASE_MUTATION_REFUSED/);
    assert.doesNotMatch(stderr, /ECONNREFUSED|connect ECONN/i);
  });

  it('the bootstrap refuses when the owner DSN is absent', () => {
    const env = { ...process.env, ...ADMITTED };
    delete env.COMMANDER_OWNER_DATABASE_URL;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(REPO_ROOT, 'scripts/ci-bootstrap-deploy-gates.ts'), 'full'],
      { cwd: REPO_ROOT, env, encoding: 'utf-8', timeout: 120_000 },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CI_DEPLOY_GATES_BOOTSTRAP_REFUSED/);
  });
});
