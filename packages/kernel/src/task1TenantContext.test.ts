import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  APP_TENANT_CONTEXT_VERSION,
  BEGIN_APP_TENANT_TRANSACTION_SQL,
  KERNEL_TASK1_AUTHENTICATED_TENANT_AUTHORITY_ENFORCE_SQL,
  KERNEL_TASK1_ENFORCED_TENANT_RELATIONS,
  KERNEL_TASK1_PRODUCT_TENANT_PREDICATE_SQL,
  KERNEL_TASK1_TENANT_CONTEXT_SQL,
  KERNEL_TASK1_TENANT_CONTEXT_BIND_MONOTONICITY_SQL,
  KERNEL_TASK1_TENANT_CONTEXT_CLOCK_SAFETY_SQL,
  READ_APP_TENANT_TRANSACTION_TARGET_SQL,
  buildBindAppTenantContextQuery,
  buildCloseAppTenantContextQuery,
  buildIssueAppTenantContextQuery,
  buildSetLegacyTenantScopeQuery,
} from './task1TenantContext.js';

describe('Task 1 authenticated tenant context', () => {
  it('pins the app transaction target before issuing an opaque context', () => {
    assert.equal(APP_TENANT_CONTEXT_VERSION, 'commander.app-tenant-context/v1');
    assert.equal(BEGIN_APP_TENANT_TRANSACTION_SQL, 'BEGIN ISOLATION LEVEL READ COMMITTED');
    assert.match(READ_APP_TENANT_TRANSACTION_TARGET_SQL, /pg_backend_pid\(\)/i);
    assert.match(READ_APP_TENANT_TRANSACTION_TARGET_SQL, /pg_current_xact_id\(\)::text/i);
    assert.match(READ_APP_TENANT_TRANSACTION_TARGET_SQL, /pg_database[\s\S]*current_database\(\)/i);
  });

  it('uses bind parameters for issue, bind, compatibility scope, and close', () => {
    assert.deepEqual(
      buildIssueAppTenantContextQuery('tenant-a', {
        databaseOid: 16384,
        backendPid: 90210,
        xid: '18446744073709551615',
      }),
      {
        text: 'SELECT context_id::text, expires_at FROM public.issue_app_tenant_context($1::text, $2::oid, $3::integer, $4::xid8)',
        values: ['tenant-a', 16384, 90210, '18446744073709551615'],
      },
    );
    assert.deepEqual(buildBindAppTenantContextQuery('00000000-0000-4000-8000-000000000001'), {
      text: 'SELECT tenant_id, replayed, expires_at FROM public.bind_app_tenant_context($1::uuid)',
      values: ['00000000-0000-4000-8000-000000000001'],
    });
    assert.deepEqual(buildSetLegacyTenantScopeQuery('tenant-a'), {
      text: "SELECT pg_catalog.set_config('app.tenant_scope', $1, true)",
      values: ['tenant-a'],
    });
    assert.deepEqual(buildCloseAppTenantContextQuery('00000000-0000-4000-8000-000000000001'), {
      text: 'SELECT public.close_app_tenant_context($1::uuid)',
      values: ['00000000-0000-4000-8000-000000000001'],
    });
  });

  it('retains closed contexts and enforces one context per database/backend/xid target', () => {
    assert.match(
      KERNEL_TASK1_TENANT_CONTEXT_SQL,
      /UNIQUE\s*\(target_database_oid,\s*target_backend_pid,\s*target_xid\)/i,
    );
    assert.match(KERNEL_TASK1_TENANT_CONTEXT_SQL, /closed_at\s+timestamptz/i);
    const closeFunction =
      KERNEL_TASK1_TENANT_CONTEXT_SQL.match(
        /CREATE OR REPLACE FUNCTION public\.close_app_tenant_context[\s\S]*?\$function\$;/i,
      )?.[0] ?? '';
    assert.match(closeFunction, /SET closed_at = pg_catalog\.clock_timestamp\(\)/i);
    assert.doesNotMatch(closeFunction, /DELETE\s+FROM/i);
  });

  it('uses a forward clock-safety repair without changing the pinned closure descriptor', () => {
    assert.match(
      KERNEL_TASK1_TENANT_CONTEXT_CLOCK_SAFETY_SQL,
      /CREATE OR REPLACE FUNCTION public\.close_app_tenant_context[\s\S]*SET closed_at = GREATEST\(pg_catalog\.clock_timestamp\(\),\s*context\.bound_at\)/i,
    );
    assert.doesNotMatch(KERNEL_TASK1_TENANT_CONTEXT_CLOCK_SAFETY_SQL, /DELETE\s+FROM/i);
  });

  it('keeps bind timestamps at or after the issued timestamp after a wall-clock step', () => {
    assert.match(
      KERNEL_TASK1_TENANT_CONTEXT_BIND_MONOTONICITY_SQL,
      /CREATE OR REPLACE FUNCTION public\.bind_app_tenant_context[\s\S]*SET bound_at = GREATEST\(pg_catalog\.clock_timestamp\(\),\s*context\.issued_at\)/i,
    );
    assert.doesNotMatch(KERNEL_TASK1_TENANT_CONTEXT_BIND_MONOTONICITY_SQL, /DELETE\s+FROM/i);
  });

  it('binds and resolves only the exact app database, backend PID, and xid8', () => {
    for (const functionName of [
      'bind_app_tenant_context',
      'commander_authenticated_app_tenant',
      'close_app_tenant_context',
    ]) {
      const body =
        KERNEL_TASK1_TENANT_CONTEXT_SQL.match(
          new RegExp(
            `CREATE OR REPLACE FUNCTION public\\.${functionName}[\\s\\S]*?\\$function\\$;`,
            'i',
          ),
        )?.[0] ?? '';
      assert.match(body, /session_user\s*<>\s*'commander_app'/i);
      assert.match(body, /target_database_oid/i);
      assert.match(body, /target_backend_pid/i);
      assert.match(body, /target_xid/i);
      assert.match(body, /closed_at\s+IS\s+NULL/i);
      assert.match(body, /expires_at\s*>\s*pg_catalog\.statement_timestamp\(\)/i);
      assert.match(body, /TENANT_CONTEXT_INVALID/i);
    }
    assert.match(KERNEL_TASK1_TENANT_CONTEXT_SQL, /pg_current_xact_id_if_assigned\(\)/i);
    assert.match(
      KERNEL_TASK1_TENANT_CONTEXT_SQL,
      /set_config\(\s*'app\.authenticated_tenant_context_id'/i,
    );
  });

  it('issues only as tenant authority with database-generated UUID and fixed expiry', () => {
    const issueFunction =
      KERNEL_TASK1_TENANT_CONTEXT_SQL.match(
        /CREATE OR REPLACE FUNCTION public\.issue_app_tenant_context[\s\S]*?\$function\$;/i,
      )?.[0] ?? '';
    assert.match(issueFunction, /session_user\s*<>\s*'commander_tenant_authority'/i);
    assert.match(issueFunction, /pg_catalog\.gen_random_uuid\(\)/i);
    assert.match(issueFunction, /interval\s+'60 seconds'/i);
    assert.match(
      issueFunction,
      /FOR UPDATE SKIP LOCKED[\s\S]*LIMIT 100|LIMIT 100[\s\S]*FOR UPDATE SKIP LOCKED/i,
    );
    assert.match(issueFunction, /bound_at\s+IS\s+NULL/i);
    assert.match(issueFunction, /closed_at\s+IS\s+NULL/i);
  });

  it('keeps readiness outside the product tenant grammar while allowing authority self-checks', () => {
    assert.equal(
      KERNEL_TASK1_PRODUCT_TENANT_PREDICATE_SQL,
      "tenant_id ~ '^[a-zA-Z0-9._:-]{1,128}$' AND tenant_id <> 'commander/readiness/v1'",
    );
    const allowlistTable =
      KERNEL_TASK1_TENANT_CONTEXT_SQL.match(
        /CREATE TABLE public\.commander_tenant_authority_allowed_tenants[\s\S]*?\);/i,
      )?.[0] ?? '';
    assert.match(allowlistTable, /commander\/readiness\/v1/);
    assert.match(
      KERNEL_TASK1_TENANT_CONTEXT_SQL,
      /tenant_id = 'commander\/readiness\/v1'\s+OR\s+tenant_id ~ '\^\[a-zA-Z0-9\._:-\]\{1,128\}\$'/i,
    );
  });

  it('closes table privileges and grants only the documented RPC surface', () => {
    assert.match(
      KERNEL_TASK1_TENANT_CONTEXT_SQL,
      /ALTER TABLE public\.commander_tenant_authority_allowed_tenants OWNER TO commander_owner/i,
    );
    assert.match(
      KERNEL_TASK1_TENANT_CONTEXT_SQL,
      /ALTER TABLE public\.commander_app_tenant_contexts OWNER TO commander_owner/i,
    );
    assert.match(KERNEL_TASK1_TENANT_CONTEXT_SQL, /SECURITY DEFINER/g);
    assert.match(KERNEL_TASK1_TENANT_CONTEXT_SQL, /SET search_path = pg_catalog/g);
    assert.match(
      KERNEL_TASK1_TENANT_CONTEXT_SQL,
      /REVOKE ALL ON TABLE public\.commander_tenant_authority_allowed_tenants,\s*public\.commander_app_tenant_contexts\s+FROM PUBLIC, commander_app, commander_worker, commander_adapter_ops, commander_scheduler, commander_tenant_authority/i,
    );
    assert.match(
      KERNEL_TASK1_TENANT_CONTEXT_SQL,
      /GRANT EXECUTE ON FUNCTION public\.issue_app_tenant_context\(text, oid, integer, xid8\) TO commander_tenant_authority/i,
    );
    assert.match(
      KERNEL_TASK1_TENANT_CONTEXT_SQL,
      /GRANT EXECUTE ON FUNCTION public\.bind_app_tenant_context\(uuid\),\s*public\.commander_authenticated_app_tenant\(\),\s*public\.close_app_tenant_context\(uuid\)\s+TO commander_app/i,
    );
    assert.match(
      KERNEL_TASK1_TENANT_CONTEXT_SQL,
      /GRANT EXECUTE ON FUNCTION public\.commander_database_identity\(\),\s*public\.commander_runtime_configuration_identity\(\)\s+TO commander_tenant_authority/i,
    );
    assert.match(KERNEL_TASK1_TENANT_CONTEXT_SQL, /REVOKE TEMPORARY ON DATABASE/i);
    assert.match(
      KERNEL_TASK1_TENANT_CONTEXT_SQL,
      /ALTER ROLE commander_app SET statement_timeout = '55s'/i,
    );
    assert.match(
      KERNEL_TASK1_TENANT_CONTEXT_SQL,
      /ALTER ROLE commander_app SET idle_in_transaction_session_timeout = '10s'/i,
    );
  });

  it('enforces only the closed committed tenant relation inventory', () => {
    assert.equal(KERNEL_TASK1_ENFORCED_TENANT_RELATIONS.length, 17);
    assert.doesNotMatch(
      KERNEL_TASK1_AUTHENTICATED_TENANT_AUTHORITY_ENFORCE_SQL,
      /pg_catalog\.pg_class|information_schema|relname LIKE/i,
    );
    for (const relation of KERNEL_TASK1_ENFORCED_TENANT_RELATIONS) {
      assert.match(
        KERNEL_TASK1_AUTHENTICATED_TENANT_AUTHORITY_ENFORCE_SQL,
        new RegExp(`CREATE POLICY commander_app_authenticated_tenant ON public\\.${relation}`),
      );
      assert.match(
        KERNEL_TASK1_AUTHENTICATED_TENANT_AUTHORITY_ENFORCE_SQL,
        new RegExp(`CREATE POLICY commander_worker_tenant_scope ON public\\.${relation}`),
      );
    }
  });
});
