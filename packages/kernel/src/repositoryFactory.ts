import type { Pool } from 'pg';
import { createVerifiedPostgresPool } from '@commander/postgres-runtime';
import type { KernelRepository } from './repository.js';
import { PostgresKernelRepository } from './postgres.js';
import { PostgresTenantContextAuthority } from './postgres.js';
import { SqliteKernelRepository } from './sqlite.js';

export type KernelBackend = 'postgres' | 'sqlite';

export interface KernelRepositoryFactoryOptions {
  env?: NodeJS.ProcessEnv;
  /** Test-only: allow :memory: — NEVER set by commander dev */
  sqlitePath?: string;
  /** Dedicated adapter-ops runtime uses read-only owner RPCs unavailable to generic workers. */
  adapterOpsMode?: boolean;
}

export interface KernelRepositoryHandle {
  repository: KernelRepository;
  backend: KernelBackend;
  /** Postgres pool when backend=postgres; closed by {@link close}. */
  postgresPool?: Pool;
  /** Separate least-authority pool when the database-issued tenant protocol is enabled. */
  postgresAuthorityPool?: Pool;
  close(): Promise<void>;
}

/** Stable error code when production refuses sqlite */
export class KernelBackendRefusedError extends Error {
  readonly code = 'KERNEL_BACKEND_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'KernelBackendRefusedError';
  }
}

export class KernelBackendMissingError extends Error {
  readonly code = 'KERNEL_BACKEND_MISSING';
  constructor(message: string) {
    super(message);
    this.name = 'KernelBackendMissingError';
  }
}

export function resolveKernelBackend(env: NodeJS.ProcessEnv = process.env): KernelBackend | null {
  const raw = env.COMMANDER_KERNEL_BACKEND?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'postgres' || raw === 'sqlite') return raw;
  return null;
}

function refusesSqlite(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'production' || env.COMMANDER_PROFILE === 'enterprise';
}

export async function createKernelRepository(
  options: KernelRepositoryFactoryOptions = {},
): Promise<KernelRepositoryHandle> {
  const env = options.env ?? process.env;
  const backend = resolveKernelBackend(env);
  if (!backend) {
    throw new KernelBackendMissingError(
      'COMMANDER_KERNEL_BACKEND must be set to postgres or sqlite (no memory fallback)',
    );
  }

  if (backend === 'sqlite') {
    if (refusesSqlite(env)) {
      throw new KernelBackendRefusedError(
        'SQLite kernel backend is not permitted in production or enterprise profile',
      );
    }
    const path = options.sqlitePath ?? env.COMMANDER_KERNEL_SQLITE_PATH?.trim();
    if (!path) {
      throw new KernelBackendMissingError(
        'COMMANDER_KERNEL_SQLITE_PATH is required for sqlite backend',
      );
    }
    const schedulerMode = env.COMMANDER_KERNEL_SCHEDULER_MODE === '1';
    const repository = new SqliteKernelRepository({
      path,
      allowMemory: path === ':memory:',
      wal: env.COMMANDER_KERNEL_SQLITE_WAL !== '0',
      // Match Postgres factory: default worker/durable claim authz unless scheduler mode.
      schedulerMode,
    });
    await repository.initialize();
    return {
      repository,
      backend: 'sqlite',
      close: async () => repository.close(),
    };
  }

  const databaseUrl = env.COMMANDER_KERNEL_DATABASE_URL?.trim() ?? env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new KernelBackendMissingError('DATABASE_URL is required for postgres backend');
  }

  const schedulerMode = env.COMMANDER_KERNEL_SCHEDULER_MODE === '1';
  const configuredTenantContextPhase = env.COMMANDER_TENANT_CONTEXT_PHASE?.trim();
  if (
    configuredTenantContextPhase &&
    configuredTenantContextPhase !== 'expand' &&
    configuredTenantContextPhase !== 'enforce'
  ) {
    throw new KernelBackendMissingError('COMMANDER_TENANT_CONTEXT_PHASE must be expand or enforce');
  }
  // Adapter-ops authenticates as commander_adapter_ops and uses owner-owned
  // aggregate RPCs. It must never enter the app-only tenant-context protocol,
  // even when launched with a shared environment containing API settings.
  const tenantContextPhase = options.adapterOpsMode ? undefined : configuredTenantContextPhase;
  const authorityUrl = tenantContextPhase
    ? env.COMMANDER_TENANT_AUTHORITY_DATABASE_URL?.trim()
    : undefined;
  if (tenantContextPhase && !authorityUrl) {
    throw new KernelBackendMissingError(
      'COMMANDER_TENANT_AUTHORITY_DATABASE_URL is required when tenant context is enabled',
    );
  }
  const pool = createVerifiedPostgresPool({ connectionString: databaseUrl, max: 8 }, env);
  let authorityPool: Pool | undefined;
  try {
    authorityPool = tenantContextPhase
      ? createVerifiedPostgresPool(
          {
            connectionString: authorityUrl!,
            // API reads render an action from several tenant-scoped transactions
            // concurrently. Keep enough authority sessions for that fan-out while
            // retaining bounded connection and query waits during database faults.
            max: 4,
            connectionTimeoutMillis: 5_000,
            query_timeout: 5_000,
          },
          env,
        )
      : undefined;
    const repository = new PostgresKernelRepository(pool, {
      schedulerMode,
      adapterOpsMode: options.adapterOpsMode,
      tenantContextPhase: tenantContextPhase as 'expand' | 'enforce' | undefined,
      tenantContextAuthority: authorityPool
        ? new PostgresTenantContextAuthority(authorityPool)
        : undefined,
    });
    await repository.initialize();
    return {
      repository,
      backend: 'postgres',
      postgresPool: pool,
      postgresAuthorityPool: authorityPool,
      close: async () => {
        await Promise.all([pool.end(), authorityPool?.end()]);
      },
    };
  } catch (error) {
    await Promise.allSettled([pool.end(), authorityPool?.end()]);
    throw error;
  }
}
