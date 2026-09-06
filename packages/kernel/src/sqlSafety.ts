/**
 * AUDIT-K5/K6: helpers for the two remaining places where kernel SQL is built
 * by string composition.
 *
 * The repository layer is fully parameterised; these cover migration-owner
 * DDL that PostgreSQL cannot parameterise (CREATE/ALTER ROLE), so they fail
 * closed on anything outside the known-safe shape instead of interpolating.
 */

const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * AUDIT-K5: `ALTER ROLE "<rolname>" BYPASSRLS` interpolated a pg_roles
 * rolname into double quotes without rejecting `"`. PostgreSQL role names
 * may contain quotes; a hostile role name would execute attacker DDL via the
 * multi-statement simple-query protocol. Migration-owner roles are always
 * simple identifiers (commander_owner, postgres, …) — anything else refuses.
 */
export function assertSafeSqlIdentifier(name: string, label: string): void {
  if (!SAFE_SQL_IDENTIFIER.test(name)) {
    throw new Error(
      `${label} must match ${SAFE_SQL_IDENTIFIER.source} (got length ${name.length}); ` +
        'refusing to interpolate into DDL',
    );
  }
}

/**
 * AUDIT-K6: the adapter-ops login password was embedded inside a
 * `DO $role$ ... $role$` block after only single-quote escaping — a password
 * containing the literal `$role$` would terminate the dollar-quoted body and
 * inject arbitrary SQL as migration owner. Pick a dollar-quote tag that does
 * not occur anywhere in the password; if every candidate occurs, refuse
 * (fail closed) rather than emit breakable SQL.
 */
const DOLLAR_TAG_ATTEMPTS = 32;

function chooseDollarTag(password: string): string {
  for (let i = 0; i < DOLLAR_TAG_ATTEMPTS; i++) {
    const tag = `cmdr_pwd_${i}`;
    if (!password.includes(`$${tag}$`)) return tag;
  }
  throw new Error(
    'COMMANDER_ADAPTER_OPS_PASSWORD is not representable safely in a dollar-quoted SQL body; ' +
      'refusing to build the role-init statement',
  );
}

export function buildAdapterOpsLoginSql(password: string): string {
  if (!password) throw new Error('COMMANDER_ADAPTER_OPS_PASSWORD must be non-empty');
  const tag = chooseDollarTag(password);
  const quoted = `'${password.replace(/'/g, "''")}'`;
  return `
    DO $${tag}$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='commander_adapter_ops') THEN
        CREATE ROLE commander_adapter_ops WITH LOGIN PASSWORD ${quoted} NOBYPASSRLS NOCREATEROLE;
      ELSE
        ALTER ROLE commander_adapter_ops WITH LOGIN PASSWORD ${quoted} NOBYPASSRLS NOCREATEROLE;
      END IF;
    END
    $${tag}$;
  `;
}
