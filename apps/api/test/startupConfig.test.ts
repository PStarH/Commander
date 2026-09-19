import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiStartupConfigurationError, resolveApiStartupConfig } from '../src/startupConfig.js';

const secureJwt = 'local-jwt-secret-that-is-at-least-thirty-two-characters';
const securePassword = 'local-admin-password-at-least-sixteen-characters';
const secureAuditChainKey = 'local-audit-chain-key-at-least-thirty-two-characters';
const secureManifestKey = 'local-manifest-key-that-is-at-least-thirty-two-chars';
const productionCredentials = { JWT_SECRET: secureJwt, ADMIN_PASSWORD: securePassword };

describe('resolveApiStartupConfig', () => {
  it('binds to loopback unless the API host is explicitly configured', () => {
    const config = resolveApiStartupConfig({ JWT_SECRET: secureJwt });

    assert.equal(config.host, '127.0.0.1');
  });

  it('honors an explicit API host for container and Kubernetes deployments', () => {
    const config = resolveApiStartupConfig({ JWT_SECRET: secureJwt, API_HOST: '0.0.0.0' });

    assert.equal(config.host, '0.0.0.0');
  });

  it('rejects a missing JWT signing secret', () => {
    assert.throws(
      () => resolveApiStartupConfig({}),
      (error: unknown) =>
        error instanceof ApiStartupConfigurationError &&
        /JWT_SECRET must be set/.test(error.message),
    );
  });

  it('rejects the previously public development JWT secret', () => {
    const publicSecret = ['commander', 'dev', 'secret', 'change', 'in', 'production'].join('-');

    assert.throws(
      () => resolveApiStartupConfig({ JWT_SECRET: publicSecret }),
      (error: unknown) =>
        error instanceof ApiStartupConfigurationError &&
        /JWT_SECRET must not use a public default/.test(error.message),
    );
  });

  it('rejects short JWT signing secrets', () => {
    assert.throws(
      () => resolveApiStartupConfig({ JWT_SECRET: 'too-short' }),
      /JWT_SECRET must be at least 32 characters long/,
    );
  });

  it('rejects public and short administrator passwords', () => {
    assert.throws(
      () => resolveApiStartupConfig({ JWT_SECRET: secureJwt, ADMIN_PASSWORD: 'commander-admin' }),
      /ADMIN_PASSWORD must not use a public default/,
    );
    assert.throws(
      () => resolveApiStartupConfig({ JWT_SECRET: secureJwt, ADMIN_PASSWORD: 'too-short' }),
      /ADMIN_PASSWORD must be at least 16 characters long/,
    );
  });

  it('rejects invalid replica counts', () => {
    assert.throws(
      () => resolveApiStartupConfig({ JWT_SECRET: secureJwt, COMMANDER_API_REPLICAS: '0' }),
      /COMMANDER_API_REPLICAS must be a positive integer/,
    );
  });

  it('requires an explicit bootstrap password in production', () => {
    assert.throws(
      () => resolveApiStartupConfig({ NODE_ENV: 'production', JWT_SECRET: secureJwt }),
      (error: unknown) =>
        error instanceof ApiStartupConfigurationError &&
        /ADMIN_PASSWORD must be set/.test(error.message),
    );
  });

  it('requires an explicit bootstrap password when multiple API replicas run', () => {
    assert.throws(
      () =>
        resolveApiStartupConfig({
          JWT_SECRET: secureJwt,
          COMMANDER_API_REPLICAS: '2',
        }),
      (error: unknown) =>
        error instanceof ApiStartupConfigurationError &&
        /ADMIN_PASSWORD must be set/.test(error.message),
    );
  });

  it('accepts explicit stable credentials for a multi-replica deployment', () => {
    const config = resolveApiStartupConfig({
      JWT_SECRET: secureJwt,
      ADMIN_PASSWORD: securePassword,
      COMMANDER_API_REPLICAS: '2',
    });

    assert.equal(config.jwtSecret, secureJwt);
    assert.equal(config.adminPassword, securePassword);
  });

  it('rejects a production deployment without an audit-chain key', () => {
    assert.throws(
      () => resolveApiStartupConfig({ NODE_ENV: 'production', ...productionCredentials }),
      (error: unknown) =>
        error instanceof ApiStartupConfigurationError &&
        /COMMANDER_AUDIT_CHAIN_KEY must be set/.test(error.message),
    );
  });

  it('rejects a public development audit-chain key and short keys', () => {
    const devKey = [
      'commander',
      'audit',
      'chain',
      'dev',
      'key',
      'DO',
      'NOT',
      'USE',
      'IN',
      'PROD',
      'v1',
    ].join('-');
    assert.throws(
      () =>
        resolveApiStartupConfig({
          NODE_ENV: 'production',
          ...productionCredentials,
          COMMANDER_AUDIT_CHAIN_KEY: devKey,
        }),
      /COMMANDER_AUDIT_CHAIN_KEY must not use a public default/,
    );
    assert.throws(
      () =>
        resolveApiStartupConfig({
          NODE_ENV: 'production',
          ...productionCredentials,
          COMMANDER_AUDIT_CHAIN_KEY: 'too-short',
        }),
      /COMMANDER_AUDIT_CHAIN_KEY must be at least 32 characters long/,
    );
  });

  it('keeps the dev-key fallback available outside production', () => {
    const config = resolveApiStartupConfig({ JWT_SECRET: secureJwt });

    assert.equal(config.host, '127.0.0.1');
  });

  it('requires a distinct manifest key once the manifest chain is enabled', () => {
    assert.throws(
      () =>
        resolveApiStartupConfig({
          JWT_SECRET: secureJwt,
          COMMANDER_AUDIT_CHAIN_KEY: secureAuditChainKey,
          COMMANDER_AUDIT_MANIFEST_DIR: '/var/lib/commander/manifest',
        }),
      /COMMANDER_MANIFEST_KEY must be set when COMMANDER_AUDIT_MANIFEST_DIR/,
    );
    assert.throws(
      () =>
        resolveApiStartupConfig({
          JWT_SECRET: secureJwt,
          COMMANDER_AUDIT_CHAIN_KEY: secureAuditChainKey,
          COMMANDER_MANIFEST_KEY: secureAuditChainKey,
        }),
      /COMMANDER_MANIFEST_KEY must be distinct from COMMANDER_AUDIT_CHAIN_KEY/,
    );
    const config = resolveApiStartupConfig({
      NODE_ENV: 'production',
      ...productionCredentials,
      COMMANDER_AUDIT_CHAIN_KEY: secureAuditChainKey,
      COMMANDER_MANIFEST_KEY: secureManifestKey,
    });

    assert.equal(config.jwtSecret, secureJwt);
  });
});
