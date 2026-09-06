/**
 * AUDIT-K5/K6 regressions: migration-owner DDL must fail closed on any input
 * outside the known-safe shape instead of interpolating it into SQL.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { assertSafeSqlIdentifier, buildAdapterOpsLoginSql } from './sqlSafety.js';

describe('assertSafeSqlIdentifier (AUDIT-K5)', () => {
  for (const ok of ['commander_owner', 'postgres', 'commander_app', 'a_1']) {
    test(`${ok} accepted`, () => {
      assert.doesNotThrow(() => assertSafeSqlIdentifier(ok, 'rolname'));
    });
  }

  test('role name containing a double quote refuses (baseline: SQL injection)', () => {
    // FAILING before the fix: `x"; CREATE ROLE evil SUPERUSER;--` was
    // interpolated into ALTER ROLE "..." BYPASSRLS verbatim.
    assert.throws(
      () => assertSafeSqlIdentifier('x"; CREATE ROLE evil SUPERUSER;--', 'rolname'),
      /must match/,
    );
  });

  for (const bad of ['has space', 'semi;colon', 'dash-name', '1starts_numeric']) {
    test(`${JSON.stringify(bad)} refuses (no leak of the value in the error)`, () => {
      try {
        assertSafeSqlIdentifier(bad, 'rolname');
        assert.fail('should have thrown');
      } catch (err) {
        assert.ok(!String((err as Error).message).includes(bad));
      }
    });
  }

  test('empty role name refuses', () => {
    assert.throws(() => assertSafeSqlIdentifier('', 'rolname'), /must match/);
  });
});

describe('buildAdapterOpsLoginSql (AUDIT-K6)', () => {
  test('normal password produces the parameterised-shape DO block', () => {
    const sql = buildAdapterOpsLoginSql('s3cret-pass');
    assert.match(sql, /DO \$cmdr_pwd_\d+\$/);
    assert.match(sql, /CREATE ROLE commander_adapter_ops WITH LOGIN PASSWORD/);
  });

  test('single quotes are escaped', () => {
    const sql = buildAdapterOpsLoginSql("o'brien");
    assert.ok(sql.includes("'o''brien'"));
  });

  test('password containing $role$ cannot terminate the DO block (baseline hole)', () => {
    // The legacy builder hard-coded $role$ … $role$; this password would close
    // the body and inject "CREATE ROLE evil SUPERUSER;" as migration owner.
    const hostile = `x$role$; CREATE ROLE evil SUPERUSER;--`;
    const sql = buildAdapterOpsLoginSql(hostile);
    // The chosen dollar tag must not appear inside the password region: the
    // hostile payload appears only as escaped body text, never as a terminator.
    const tags = [...sql.matchAll(/\$(cmdr_pwd_\d+)\$/g)].map((m) => m[1]);
    assert.ok(tags.length >= 2, 'opening and closing tag present');
    assert.equal(new Set(tags).size, 1, 'one consistent tag');
    const body = sql.slice(
      sql.indexOf(`$${tags[0]}$`) + tags[0].length + 2,
      sql.lastIndexOf(`$${tags[0]}$`),
    );
    assert.ok(!body.includes(`$${tags[0]}$`), 'tag must not occur inside the body');
    assert.ok(body.includes(hostile.replace(/'/g, "''")), 'payload stays literal text');
  });

  test('password quoting every candidate tag refuses (fail closed)', () => {
    const hostile = Array.from({ length: 40 }, (_, i) => `$cmdr_pwd_${i}$`).join('');
    assert.throws(() => buildAdapterOpsLoginSql(hostile), /not representable safely/);
  });

  test('empty password refuses', () => {
    assert.throws(() => buildAdapterOpsLoginSql(''), /non-empty/);
  });
});
