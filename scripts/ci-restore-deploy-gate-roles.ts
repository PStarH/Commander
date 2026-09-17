import { Pool } from 'pg';
import {
  DEPLOY_GATE_ROLES,
  EXPECTED_ROLE_PRIVILEGES,
  assertProvisionedCiInstance,
  formatAdmissionFailure,
  resolveRolePassword,
  sqlLiteral,
  type DeployGateRole,
  type ExpectedRolePrivileges,
} from './ci-database-scope.js';

/**
 * Restore the six deploy-gate runtime roles on a CI instance that a provisioner
 * created for this run.
 *
 * This is a MUTATING, cluster-scoped operation. It is not part of the ordinary
 * acceptance chain (`test:deploy-gates`) — see package.json. It refuses to run
 * unless the provisioned-instance admission conditions hold, it never invents a
 * password, and it verifies the resulting privilege vector rather than only
 * that the statement succeeded.
 */

const adminDsn = process.env.DATABASE_URL?.trim();
if (!adminDsn) {
  console.error('CI_ROLE_RESTORE_REFUSED: DATABASE_URL is not set');
  process.exit(1);
}

const admissionFailures = assertProvisionedCiInstance(process.env, adminDsn);
if (admissionFailures.length > 0) {
  console.error(formatAdmissionFailure(admissionFailures));
  process.exit(1);
}

const passwords = new Map<DeployGateRole, string>();
const passwordFailures: string[] = [];
for (const role of DEPLOY_GATE_ROLES) {
  const { password, failures } = resolveRolePassword(role, process.env);
  if (password === undefined) passwordFailures.push(...failures);
  else passwords.set(role, password);
}
if (passwordFailures.length > 0) {
  console.error(formatAdmissionFailure(passwordFailures));
  process.exit(1);
}

const pool = new Pool({ connectionString: adminDsn, max: 1 });

function alterRoleStatement(role: DeployGateRole, password: string): string {
  const privileges: ExpectedRolePrivileges = EXPECTED_ROLE_PRIVILEGES[role];
  return `ALTER ROLE ${role} ${privileges.login ? 'LOGIN' : 'NOLOGIN'} ${
    privileges.superuser ? 'SUPERUSER' : 'NOSUPERUSER'
  } ${privileges.createDb ? 'CREATEDB' : 'NOCREATEDB'} ${
    privileges.createRole ? 'CREATEROLE' : 'NOCREATEROLE'
  } ${privileges.inherit ? 'INHERIT' : 'NOINHERIT'} ${
    privileges.replication ? 'REPLICATION' : 'NOREPLICATION'
  } ${privileges.bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS'} PASSWORD ${sqlLiteral(password)}`;
}

interface RoleRow {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolinherit: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  has_password: boolean;
}

function privilegeMismatches(row: RoleRow): string[] {
  const expected = EXPECTED_ROLE_PRIVILEGES[row.rolname as DeployGateRole];
  if (!expected) return [`unexpected role returned: ${row.rolname}`];
  const mismatches: string[] = [];
  for (const key of [
    'rolcanlogin',
    'rolsuper',
    'rolcreatedb',
    'rolcreaterole',
    'rolinherit',
    'rolreplication',
    'rolbypassrls',
  ] as const) {
    if (row[key] !== expected[key]) {
      mismatches.push(`${row.rolname}.${key} is ${row[key]}, expected ${expected[key]}`);
    }
  }
  if (!row.has_password) {
    mismatches.push(`${row.rolname} has no password set`);
  }
  return mismatches;
}

async function main(): Promise<void> {
  try {
    await pool.query(`
      BEGIN;
      DO $do$
      BEGIN
        IF (
          SELECT count(*)
          FROM pg_catalog.pg_roles
          WHERE rolname = ANY(ARRAY[
            'commander_owner',
            'commander_app',
            'commander_tenant_authority',
            'commander_scheduler',
            'commander_worker',
            'commander_adapter_ops'
          ])
        ) <> 6 THEN
          RAISE EXCEPTION 'CI_DEPLOY_GATE_ROLE_RESTORE_INCOMPLETE';
        END IF;
      END $do$;
      ${DEPLOY_GATE_ROLES.map((role) => alterRoleStatement(role, passwords.get(role)!)).join(';\n      ')};
      COMMIT;
    `);

    // Verify the privilege vector, not merely that the statement ran. A reset
    // that silently grants CREATEROLE or BYPASSRLS is a privilege escalation.
    const { rows } = await pool.query<RoleRow>(
      `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
              rolreplication, rolbypassrls, (rolpassword IS NOT NULL) AS has_password
         FROM pg_catalog.pg_roles
        WHERE rolname = ANY($1::text[])
        ORDER BY rolname`,
      [[...DEPLOY_GATE_ROLES]],
    );

    const mismatches: string[] = [];
    if (rows.length !== DEPLOY_GATE_ROLES.length) {
      mismatches.push(`expected ${DEPLOY_GATE_ROLES.length} roles, found ${rows.length}`);
    }
    for (const row of rows) mismatches.push(...privilegeMismatches(row));

    if (mismatches.length > 0) {
      console.error(`CI_DEPLOY_GATE_ROLE_PRIVILEGE_MISMATCH:\n  - ${mismatches.join('\n  - ')}`);
      process.exitCode = 1;
      return;
    }

    console.log('CI deploy-gate runtime roles restored and privileges verified');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // Never echo driver output verbatim: it can contain the DSN or SQL text.
  console.error(
    `CI_DEPLOY_GATE_ROLE_RESTORE_FAILED: ${error instanceof Error ? error.name : 'Error'}`,
  );
  process.exitCode = 1;
});
