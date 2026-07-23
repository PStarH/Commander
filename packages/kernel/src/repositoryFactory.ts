import type { Pool } from 'pg';
import type { KernelRepository } from './repository.js';
import { PostgresKernelRepository } from './postgres.js';
import { SqliteKernelRepository } from './sqlite.js';

export type KernelBackend = 'postgres' | 'sqlite';

export interface KernelRepositoryFactoryOptions {
  env?: NodeJS.ProcessEnv;
  /** Test-only: allow :memory: — NEVER set by commander dev */
  sqlitePath?: string;
}

export interface KernelRepositoryHandle {
  repository: KernelRepository;
  backend: KernelBackend;
  /** Postgres pool when backend=postgres; closed by {@link close}. */
  postgresPool?: Pool;
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
  return (
    env.NODE_ENV === 'production' ||
    env.COMMANDER_PROFILE === 'enterprise'
  );
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
      throw new KernelBackendMissingError('COMMANDER_KERNEL_SQLITE_PATH is required for sqlite backend');
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

  const databaseUrl =
    env.COMMANDER_KERNEL_DATABASE_URL?.trim() ??
    env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new KernelBackendMissingError('DATABASE_URL is required for postgres backend');
  }

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const schedulerMode = env.COMMANDER_KERNEL_SCHEDULER_MODE === '1';
  const repository = new PostgresKernelRepository(pool, { schedulerMode });
  await repository.initialize();
  return {
    repository,
    backend: 'postgres',
    postgresPool: pool,
    close: async () => {
      await pool.end();
    },
  };
}
