/**
 * Shared authentication-failure authority.
 *
 * Production requires Redis so lockouts are consistent across API replicas.
 * Development and tests use the explicitly named process-local implementation
 * when no Redis URL is configured.
 */

import { isProductionEnv } from './envSignal.js';

export interface AuthFailureEntry {
  count: number;
  firstFailureAt: number;
  lastFailureAt: number;
  lockedUntil: number;
}

export interface AuthFailureStore {
  get(ip: string): Promise<AuthFailureEntry | undefined>;
  set(ip: string, entry: AuthFailureEntry): Promise<void>;
  delete(ip: string): Promise<void>;
  cleanup(now: number, windowMs: number): Promise<void>;
}

interface RedisClient {
  connect(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<string | null>;
  del(key: string): Promise<number>;
  on?(event: 'error', listener: (error: Error) => void): unknown;
}

interface RedisModule {
  createClient(options: {
    url: string;
    disableOfflineQueue: true;
    socket: { connectTimeout: number; reconnectStrategy: false };
  }): RedisClient;
}

const REDIS_CONNECT_ATTEMPTS = 6;
const REDIS_CONNECT_RETRY_DELAY_MS = 1_000;

export type RedisModuleLoader = () => Promise<RedisModule>;

export interface CreateAuthFailureStoreOptions {
  environment?: NodeJS.ProcessEnv;
  loadRedis?: RedisModuleLoader;
}

class InMemoryAuthFailureStore implements AuthFailureStore {
  private readonly map = new Map<string, AuthFailureEntry>();

  async get(ip: string): Promise<AuthFailureEntry | undefined> {
    return this.map.get(ip);
  }

  async set(ip: string, entry: AuthFailureEntry): Promise<void> {
    this.map.set(ip, entry);
  }

  async delete(ip: string): Promise<void> {
    this.map.delete(ip);
  }

  async cleanup(now: number, windowMs: number): Promise<void> {
    for (const [ip, entry] of this.map) {
      if (entry.lockedUntil < now && entry.lastFailureAt < now - windowMs) {
        this.map.delete(ip);
      }
    }
  }
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseAuthFailureEntry(raw: string): AuthFailureEntry {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('Redis auth failure entry is malformed', { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Redis auth failure entry is malformed');
  }
  const entry = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(entry.count) ||
    !isNonNegativeFiniteNumber(entry.count) ||
    !isNonNegativeFiniteNumber(entry.firstFailureAt) ||
    !isNonNegativeFiniteNumber(entry.lastFailureAt) ||
    !isNonNegativeFiniteNumber(entry.lockedUntil)
  ) {
    throw new Error('Redis auth failure entry is malformed');
  }
  return {
    count: entry.count,
    firstFailureAt: entry.firstFailureAt,
    lastFailureAt: entry.lastFailureAt,
    lockedUntil: entry.lockedUntil,
  };
}

async function loadRedisModule(): Promise<RedisModule> {
  return import('redis');
}

class RedisAuthFailureStore implements AuthFailureStore {
  private readonly clientPromise: Promise<RedisClient>;

  constructor(
    url: string,
    loadRedis: RedisModuleLoader,
    private readonly prefix = 'commander:auth-failures:',
  ) {
    this.clientPromise = this.connect(url, loadRedis);
    // Startup awaits readiness, but keep a failed lazy connection from
    // becoming an unhandled rejection if the caller has not reached that
    // gate yet.
    void this.clientPromise.catch(() => undefined);
  }

  private async connect(url: string, loadRedis: RedisModuleLoader): Promise<RedisClient> {
    const redis = await loadRedis();
    let lastError: unknown;
    for (let attempt = 1; attempt <= REDIS_CONNECT_ATTEMPTS; attempt += 1) {
      const client = redis.createClient({
        url,
        disableOfflineQueue: true,
        socket: { connectTimeout: 5_000, reconnectStrategy: false },
      });
      client.on?.('error', (error) => {
        process.stderr.write(`[Auth] Redis auth failure store error: ${error.message}\n`);
      });
      try {
        await client.connect();
        return client;
      } catch (error) {
        lastError = error;
        if (attempt < REDIS_CONNECT_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, REDIS_CONNECT_RETRY_DELAY_MS));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Redis connection unavailable');
  }

  async ready(): Promise<void> {
    await this.clientPromise;
  }

  private key(ip: string): string {
    return `${this.prefix}${ip}`;
  }

  async get(ip: string): Promise<AuthFailureEntry | undefined> {
    const client = await this.clientPromise;
    const raw = await client.get(this.key(ip));
    return raw === null ? undefined : parseAuthFailureEntry(raw);
  }

  async set(ip: string, entry: AuthFailureEntry): Promise<void> {
    const client = await this.clientPromise;
    const ttlSeconds =
      entry.lockedUntil > Date.now() ? Math.ceil((entry.lockedUntil - Date.now()) / 1000) : 60 * 60;
    await client.set(this.key(ip), JSON.stringify(entry), { EX: Math.max(ttlSeconds, 1) });
  }

  async delete(ip: string): Promise<void> {
    const client = await this.clientPromise;
    await client.del(this.key(ip));
  }

  async cleanup(_now: number, _windowMs: number): Promise<void> {
    // Redis TTL owns expiration. Awaiting the connection still surfaces an
    // unavailable authority to the caller's cleanup error reporting.
    await this.clientPromise;
  }
}

let sharedStore: AuthFailureStore | null = null;

export function getAuthFailureStore(): AuthFailureStore {
  if (!sharedStore) {
    sharedStore = createAuthFailureStore();
  }
  return sharedStore;
}

export async function ensureAuthFailureStoreReady(): Promise<void> {
  const store = getAuthFailureStore();
  if (store instanceof RedisAuthFailureStore) await store.ready();
}

export function createAuthFailureStore(
  options: CreateAuthFailureStoreOptions = {},
): AuthFailureStore {
  const environment = options.environment ?? process.env;
  const redisUrl = environment.AUTH_FAILURE_REDIS_URL;
  if (redisUrl) {
    return new RedisAuthFailureStore(redisUrl, options.loadRedis ?? loadRedisModule);
  }
  if (isProductionEnv(environment)) {
    throw new Error('AUTH_FAILURE_REDIS_URL is required in production');
  }
  return new InMemoryAuthFailureStore();
}

export function setAuthFailureStore(store: AuthFailureStore): void {
  sharedStore = store;
}

export function resetAuthFailureStoreForTesting(): void {
  sharedStore = null;
}
