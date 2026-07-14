import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { TenantConfig } from '../packages/core/src/runtime/tenantProvider';

export type IsolationMode = 'pool' | 'bridge' | 'silo';

/** Keep this in sync with apps/api/src/tenantProviderLoader.ts. */
export const TENANT_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;

export const DEFAULT_CONFIG_PATH = path.resolve('config', 'tenants.json');

export interface TenantConfigFile {
  tenants?: unknown[];
  description?: string;
  $schema?: string;
}

export function validateTenantId(tenantId: string): void {
  if (typeof tenantId !== 'string' || !TENANT_ID_RE.test(tenantId)) {
    throw new Error(
      `Invalid tenant id "${tenantId}": must be 1-128 chars matching ${TENANT_ID_RE.source}`,
    );
  }
}

export function parseIsolation(raw: string): IsolationMode {
  if (!['pool', 'bridge', 'silo'].includes(raw)) {
    throw new Error(`Invalid isolation "${raw}": must be one of pool, bridge, silo`);
  }
  return raw as IsolationMode;
}

export function resolveTenantPath(input: string, base = process.cwd()): string {
  if (path.isAbsolute(input)) {
    return path.normalize(input);
  }
  return path.resolve(base, input);
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureWorkspaceDirs(workspaceRoot: string): Promise<void> {
  for (const sub of ['agents', 'memories', 'conversations', 'traces', 'state']) {
    await ensureDir(path.join(workspaceRoot, sub));
  }
}

export async function ensureStorageDirs(storageRoot: string): Promise<void> {
  for (const sub of ['sqlite', 'wal']) {
    await ensureDir(path.join(storageRoot, sub));
  }
}

export function tenantDbPath(storageRoot: string, tenantId: string): string {
  return path.join(storageRoot, 'sqlite', `tenant_${tenantId}.db`);
}

/**
 * Initialize an empty SQLite database file.
 *
 * When better-sqlite3 is available we open the file once so SQLite writes its
 * header and enable WAL. If the native module is unavailable (e.g. Node version
 * mismatch) we fall back to creating a zero-byte file, which SQLite accepts as
 * an empty database on first open.
 */
export async function initTenantDatabase(dbPath: string): Promise<void> {
  await ensureDir(path.dirname(dbPath));
  try {
    const betterSqlite3 = await import('better-sqlite3');
    const Database = (betterSqlite3.default ?? betterSqlite3) as unknown as new (path: string) => {
      pragma: (sql: string) => unknown;
      close: () => void;
    };
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.close();
  } catch (err) {
    await fs.writeFile(dbPath, Buffer.alloc(0));
    console.warn(
      `better-sqlite3 unavailable (${(err as Error)?.message}); created empty database file at ${dbPath}`,
    );
  }
}

export async function generateApiKeyForTenant(
  tenantId: string,
  name?: string,
): Promise<{ key: string; prefix: string }> {
  const { ApiKeyStore } = await import('../apps/api/src/apiKeyStore');
  const store = new ApiKeyStore();
  const result = store.create(name?.trim() || `provision-${tenantId}`, ['read', 'write'], tenantId);
  return { key: result.key, prefix: result.record.prefix };
}

export async function loadTenantConfig(
  configPath: string,
): Promise<Required<Pick<TenantConfigFile, 'tenants'>> & TenantConfigFile> {
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as TenantConfigFile;
    return {
      ...parsed,
      tenants: Array.isArray(parsed.tenants) ? parsed.tenants : [],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { tenants: [] };
    }
    throw new Error(
      `Failed to parse tenant config at ${configPath}: ${(err as Error)?.message ?? String(err)}`,
    );
  }
}

export async function writeTenantConfig(
  configPath: string,
  config: TenantConfigFile,
): Promise<void> {
  await ensureDir(path.dirname(configPath));
  const tmp = `${configPath}.tmp.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  await fs.rename(tmp, configPath);
}

export function buildTenantConfigEntry(
  tenantId: string,
  isolation: IsolationMode,
  workspacePath: string,
  storagePath: string,
  overrides?: Partial<TenantConfig>,
): TenantConfig {
  const metadata: Record<string, string> = {};
  const sourceMetadata = overrides?.metadata ?? {};
  for (const [key, value] of Object.entries(sourceMetadata)) {
    metadata[key] = String(value ?? '');
  }
  metadata.isolation = isolation;
  metadata.lane = isolation === 'pool' ? 'shared' : `tenant-${tenantId}`;

  const entry: TenantConfig = {
    tenantId,
    tokenBudget: overrides?.tokenBudget ?? 0,
    maxConcurrency: overrides?.maxConcurrency ?? 0,
    maxRunsPerMinute: overrides?.maxRunsPerMinute ?? 0,
    enabled: overrides?.enabled ?? true,
    isolation,
    workspacePath,
    storagePath,
    metadata,
  };

  if (overrides?.maxStorageBytes !== undefined) {
    entry.maxStorageBytes = overrides.maxStorageBytes;
  }
  return entry;
}
