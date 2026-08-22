import * as crypto from 'node:crypto';
import { createVerifiedPostgresPool } from '@commander/postgres-runtime';
import type { SqlClient, SqlPool } from '@commander/kernel';

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  scopes: string[];
  tenantId?: string;
  enabled: boolean;
  createdAt: string;
  revokedAt?: string;
}

export interface ApiKeyCreationResult {
  record: ApiKeyRecord;
  key: string;
}

type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  key_hash: string;
  scopes: string[];
  tenant_id: string | null;
  enabled: boolean;
  created_at: Date | string;
  revoked_at: Date | string | null;
};

type VerifiedPoolFactory = (
  input: { connectionString: string },
  env?: NodeJS.ProcessEnv,
) => SqlPool;

const KEY_PREFIX = 'cmdr_';
const KEY_BYTES = 32;
const API_KEY_COLUMNS =
  'id, name, prefix, key_hash, scopes, tenant_id, enabled, created_at, revoked_at';

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function generateKey(): string {
  return KEY_PREFIX + crypto.randomBytes(KEY_BYTES).toString('base64url');
}

function generateId(): string {
  return 'ak_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fromRow(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    hash: row.key_hash,
    scopes: row.scopes,
    tenantId: row.tenant_id ?? undefined,
    enabled: row.enabled,
    createdAt: timestamp(row.created_at),
    revokedAt: row.revoked_at === null ? undefined : timestamp(row.revoked_at),
  };
}

export interface ApiKeyStore {
  list(): Promise<Omit<ApiKeyRecord, 'hash'>[]>;
  findByHash(hash: string): Promise<ApiKeyRecord | undefined>;
  create(name: string, scopes?: string[], tenantId?: string): Promise<ApiKeyCreationResult>;
  revoke(id: string): Promise<ApiKeyRecord | undefined>;
  delete(id: string): Promise<boolean>;
}

export class PostgresApiKeyStore implements ApiKeyStore {
  constructor(private readonly pool: SqlPool) {}

  private async withClient<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await operation(client);
    } finally {
      await client.release();
    }
  }

  async list(): Promise<Omit<ApiKeyRecord, 'hash'>[]> {
    return this.withClient(async (client) => {
      const result = await client.query<ApiKeyRow>(
        'SELECT ' + API_KEY_COLUMNS + ' FROM commander_auth_api_keys ORDER BY created_at DESC',
      );
      return result.rows.map(fromRow).map(({ hash: _hash, ...record }) => record);
    });
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | undefined> {
    return this.withClient(async (client) => {
      const result = await client.query<ApiKeyRow>(
        'SELECT ' +
          API_KEY_COLUMNS +
          ' FROM commander_auth_api_keys WHERE key_hash = $1 AND enabled = true',
        [hash],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : undefined;
    });
  }

  async create(
    name: string,
    scopes: string[] = ['read', 'write'],
    tenantId?: string,
  ): Promise<ApiKeyCreationResult> {
    const key = generateKey();
    const result = await this.withClient(async (client) => {
      return client.query<ApiKeyRow>(
        'INSERT INTO commander_auth_api_keys (id, name, prefix, key_hash, scopes, tenant_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ' +
          API_KEY_COLUMNS,
        [
          generateId(),
          name.trim() || 'API Key',
          key.slice(0, 8),
          sha256(key),
          scopes.length > 0 ? scopes : ['read', 'write'],
          tenantId ?? null,
        ],
      );
    });
    return { record: fromRow(result.rows[0]!), key };
  }

  async revoke(id: string): Promise<ApiKeyRecord | undefined> {
    return this.withClient(async (client) => {
      const result = await client.query<ApiKeyRow>(
        'UPDATE commander_auth_api_keys SET enabled = false, revoked_at = clock_timestamp() WHERE id = $1 AND enabled = true RETURNING ' +
          API_KEY_COLUMNS,
        [id],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : undefined;
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.withClient(async (client) => {
      const result = await client.query('DELETE FROM commander_auth_api_keys WHERE id = $1', [id]);
      return result.rowCount === 1;
    });
  }
}

export function createApiKeyStoreFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  createPool: VerifiedPoolFactory = createVerifiedPostgresPool,
): ApiKeyStore {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('AUTH_API_KEYS_DATABASE_URL_REQUIRED');
  let role: string;
  try {
    role = decodeURIComponent(new URL(connectionString).username);
  } catch {
    throw new Error('AUTH_API_KEYS_DATABASE_URL_INVALID');
  }
  if (role !== 'commander_app') throw new Error('AUTH_API_KEYS_DATABASE_ROLE_INVALID');
  return new PostgresApiKeyStore(createPool({ connectionString }, env));
}

let storeSingleton: ApiKeyStore | undefined;

export function getApiKeyStore(): ApiKeyStore {
  storeSingleton ??= createApiKeyStoreFromEnvironment();
  return storeSingleton;
}

export function setApiKeyStoreForTesting(store: ApiKeyStore | undefined): void {
  storeSingleton = store;
}

export function resetApiKeyStore(): void {
  storeSingleton = undefined;
}
