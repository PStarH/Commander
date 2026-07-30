import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { renderTask1PostgresInit } from './task1PostgresInitMaterialize.js';

const markers = ['OWNER', 'APP', 'TENANT_AUTHORITY', 'SCHEDULER', 'WORKER', 'ADAPTER_OPS'] as const;

function template(): string {
  return markers
    .map(
      (name) =>
        `CREATE ROLE x PASSWORD '__COMMANDER_${name}_PASSWORD__'; -- __COMMANDER_${name}_PASSWORD__`,
    )
    .join('\n');
}

function sixRoleEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    (
      [
        ['OWNER', 'commander_owner'],
        ['APP', 'commander_app'],
        ['TENANT_AUTHORITY', 'commander_tenant_authority'],
        ['SCHEDULER', 'commander_scheduler'],
        ['WORKER', 'commander_worker'],
        ['ADAPTER_OPS', 'commander_adapter_ops'],
      ] as const
    ).map(([name, login]) => [
      `COMMANDER_${name}_DATABASE_URL`,
      `postgres://${login}:secret-${name.toLowerCase()}@db/commander`,
    ]),
  );
}

describe('Task 1 PostgreSQL init materializer', () => {
  it('materializes the bundled initializer with all six exact login-role envelopes', () => {
    const source = readFileSync(
      new URL('../../../deploy/docker/postgres-init.sql', import.meta.url),
      'utf8',
    );
    const rendered = renderTask1PostgresInit(source, sixRoleEnv());
    const roleAttributes = {
      commander_owner:
        'LOGIN PASSWORD .* NOSUPERUSER NOCREATEDB CREATEROLE INHERIT NOREPLICATION BYPASSRLS',
      commander_app:
        'LOGIN PASSWORD .* NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      commander_scheduler:
        'LOGIN PASSWORD .* NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS',
      commander_worker:
        'LOGIN PASSWORD .* NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      commander_adapter_ops:
        'LOGIN PASSWORD .* NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      commander_tenant_authority:
        'LOGIN PASSWORD .* NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
    } as const;
    for (const [login, attributes] of Object.entries(roleAttributes)) {
      assert.match(rendered, new RegExp(`CREATE ROLE ${login} WITH ${attributes};`, 'i'));
      assert.match(rendered, new RegExp(`ALTER ROLE ${login} WITH ${attributes};`, 'i'));
    }
    assert.doesNotMatch(rendered, /__COMMANDER_[A-Z_]+__/);
  });

  it('derives the six exact role passwords from DSNs and SQL-escapes them', () => {
    const env: NodeJS.ProcessEnv = {};
    const roles = [
      ['OWNER', 'commander_owner'],
      ['APP', 'commander_app'],
      ['TENANT_AUTHORITY', 'commander_tenant_authority'],
      ['SCHEDULER', 'commander_scheduler'],
      ['WORKER', 'commander_worker'],
      ['ADAPTER_OPS', 'commander_adapter_ops'],
    ] as const;
    for (const [name, login] of roles) {
      env[`COMMANDER_${name}_DATABASE_URL`] =
        `postgres://${login}:${encodeURIComponent(`secret-${name.toLowerCase()}'`)}@db/commander`;
    }
    const rendered = renderTask1PostgresInit(template(), env);
    assert.doesNotMatch(rendered, /__COMMANDER_/);
    assert.match(rendered, /secret-owner''/);
    assert.equal((rendered.match(/PASSWORD '/g) ?? []).length, 6);
  });

  it('rejects a role swap and an incomplete template', () => {
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      markers.map((name) => [
        `COMMANDER_${name}_DATABASE_URL`,
        `postgres://commander_${name.toLowerCase()}:secret@db/commander`,
      ]),
    );
    env.COMMANDER_OWNER_DATABASE_URL = 'postgres://commander_app:secret@db/commander';
    assert.throws(() => renderTask1PostgresInit(template(), env), /CREDENTIAL_INVALID/);
    assert.throws(
      () => renderTask1PostgresInit(template().replaceAll('__COMMANDER_OWNER_PASSWORD__', ''), env),
      /TEMPLATE_INVALID/,
    );
  });

  it('rejects password reuse and malformed encoding instead of deriving a new-role credential', () => {
    const env = sixRoleEnv();
    env.COMMANDER_TENANT_AUTHORITY_DATABASE_URL =
      'postgres://commander_tenant_authority:secret-tenant-authority@db/commander';
    env.COMMANDER_ADAPTER_OPS_DATABASE_URL =
      'postgres://commander_adapter_ops:secret-worker@db/commander';
    assert.throws(() => renderTask1PostgresInit(template(), env), /CREDENTIAL_INVALID/);

    env.COMMANDER_ADAPTER_OPS_DATABASE_URL =
      'postgres://commander_adapter_ops:explicit-adapter-password@db/commander';
    env.COMMANDER_TENANT_AUTHORITY_DATABASE_URL =
      'postgres://commander_tenant_authority:bad%ZZ@db/commander';
    assert.throws(() => renderTask1PostgresInit(template(), env), /CREDENTIAL_INVALID/);
  });

  it('does not rewrite the inherited v8 credential contract', () => {
    const env = sixRoleEnv();
    env.COMMANDER_APP_DATABASE_URL = 'postgres://commander_app:secret-owner@db/commander';
    assert.doesNotThrow(() => renderTask1PostgresInit(template(), env));
  });
});
