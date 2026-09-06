import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import {
  buildVerifiedPostgresPoolConfig,
  type VerifiedPostgresPoolInput,
} from '@commander/postgres-runtime';
import type { PoolConfig } from 'pg';

export interface ShadowStartupConfig {
  databaseUrl: string;
  poolConfig: PoolConfig;
  tenantId: string;
  retentionDays: number;
  trustedManifestPublicKeys: ReadonlyMap<string, KeyObject>;
  reportSigningKeyId: string;
  reportSigningPrivateKey: KeyObject;
  cleanupFreshnessMinutes: number;
}

const IDENTIFIER = /^[\x21-\x7e]{1,128}$/;
const PLACEHOLDER = /^(?:replace[_-]?me|change[_-]?me|example|placeholder|public)$/i;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function identifier(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!IDENTIFIER.test(value)) throw new Error(`${name}_INVALID`);
  if (PLACEHOLDER.test(value)) throw new Error(`${name}_PLACEHOLDER`);
  return value;
}

function boundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const raw = required(env, name);
  if (!/^\d+$/.test(raw)) throw new Error(`${name}_INVALID`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

function manifestKeys(env: NodeJS.ProcessEnv): ReadonlyMap<string, KeyObject> {
  const raw = required(env, 'COMMANDER_SHADOW_TRUSTED_MANIFEST_KEYS_JSON');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('COMMANDER_SHADOW_TRUSTED_MANIFEST_KEYS_JSON_INVALID');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('COMMANDER_SHADOW_TRUSTED_MANIFEST_KEYS_JSON_INVALID');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) throw new Error('COMMANDER_SHADOW_TRUSTED_MANIFEST_KEYS_JSON_INVALID');
  const result = new Map<string, KeyObject>();
  for (const [keyId, pem] of entries) {
    if (!IDENTIFIER.test(keyId) || PLACEHOLDER.test(keyId) || typeof pem !== 'string') {
      throw new Error('COMMANDER_SHADOW_MANIFEST_KEY_INVALID');
    }
    try {
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong type');
      result.set(keyId, key);
    } catch {
      throw new Error('COMMANDER_SHADOW_MANIFEST_KEY_INVALID');
    }
  }
  return result;
}

export function loadShadowStartupConfig(env: NodeJS.ProcessEnv = process.env): ShadowStartupConfig {
  const databaseUrl = required(env, 'COMMANDER_SHADOW_DATABASE_URL');
  const poolInput: VerifiedPostgresPoolInput = { connectionString: databaseUrl, max: 4 };
  const poolConfig = buildVerifiedPostgresPoolConfig(poolInput, env);
  const reportSigningKeyId = identifier(env, 'COMMANDER_SHADOW_REPORT_SIGNING_KEY_ID');
  let reportSigningPrivateKey: KeyObject;
  try {
    reportSigningPrivateKey = createPrivateKey(
      required(env, 'COMMANDER_SHADOW_REPORT_SIGNING_PRIVATE_KEY_PEM'),
    );
    if (reportSigningPrivateKey.asymmetricKeyType !== 'ed25519') throw new Error('wrong type');
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'COMMANDER_SHADOW_REPORT_SIGNING_PRIVATE_KEY_PEM_REQUIRED'
    )
      throw error;
    throw new Error('COMMANDER_SHADOW_REPORT_SIGNING_PRIVATE_KEY_PEM_INVALID');
  }
  return {
    databaseUrl,
    poolConfig,
    tenantId: identifier(env, 'COMMANDER_SHADOW_TENANT_ID'),
    retentionDays: boundedInteger(env, 'COMMANDER_SHADOW_RETENTION_DAYS', 1, 30),
    trustedManifestPublicKeys: manifestKeys(env),
    reportSigningKeyId,
    reportSigningPrivateKey,
    cleanupFreshnessMinutes: boundedInteger(
      env,
      'COMMANDER_SHADOW_CLEANUP_FRESHNESS_MINUTES',
      1,
      120,
    ),
  };
}
