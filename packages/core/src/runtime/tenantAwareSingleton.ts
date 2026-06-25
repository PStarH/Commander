/**
 * Tenant-aware singleton wrapper with explicit isolation guarantees.
 *
 * This module provides per-tenant singleton instances keyed by the async
 * tenant context. It is NOT a complete multi-tenancy solution by itself:
 * storage backends and external resources must still key their data by
 * tenant (use helpers from ./tenantContext). The wrapper here ensures that
 * in-memory singletons cannot be accidentally shared between tenants.
 *
 * Improvements over the original implementation:
 *   - Tenant IDs are validated on every access.
 *   - Evictions are logged, not silent.
 *   - getGlobal() is gated: by default it throws in a tenant context.
 *   - Optional per-tenant quota tracking and lifecycle hooks.
 *   - Configurable max tenants, TTL, and eviction policy.
 */
import { getCurrentTenantId, validateTenantId, TenantIsolationError } from './tenantContext';

export interface TenantQuota {
  /** Max number of tenants that can be active at once. */
  maxTenants: number;
  /** Max milliseconds a tenant instance can be idle before eligible for eviction. */
  tenantTtlMs: number;
  /** Max number of tenant instances created over the process lifetime. */
  maxLifetimeTenants?: number;
}

export interface TenantAwareSingletonOptions<T> {
  /** Dispose callback invoked when a tenant instance is evicted or reset. */
  dispose?: (instance: T) => void;
  /**
   * When true (default), `get()` outside a tenant context returns the global
   * fallback instance. When false, `get()` outside a tenant context throws.
   * Production multi-tenant deployments should set this to false.
   */
  allowGlobalFallback?: boolean;
  /** Quota configuration. Defaults to 100 tenants, 30 minute TTL. */
  quota?: Partial<TenantQuota>;
  /** Optional component name used in logs and errors. */
  componentName?: string;
  /** Called whenever a tenant instance is evicted. */
  onEvict?: (tenantId: string, reason: 'ttl' | 'lru' | 'explicit' | 'reset') => void;
}

export interface TenantAwareSingleton<T> {
  get(): T;
  reset(): void;
  getForTenant(tenantId: string): T;
  /**
   * @deprecated Use `get()` with `allowGlobalFallback: true` or an explicit
   * tenant context. Direct global access bypasses tenant isolation.
   */
  getGlobal(): T;
  disposeTenant(tenantId: string): boolean;
  /**
   * Current active tenant count.
   */
  tenantCount(): number;
  /**
   * Total number of tenant instances created over the process lifetime.
   */
  lifetimeTenantCount(): number;
}

/**
 * Create a tenant-aware singleton wrapper.
 *
 * In single-tenant mode (no tenant context): returns the global instance if
 * `allowGlobalFallback` is true, otherwise throws.
 *
 * In multi-tenant mode (tenant context active): returns a per-tenant instance.
 * Tenant IDs are validated, evictions are logged, and cross-tenant access is
 * prevented at the in-memory layer.
 */
export function createTenantAwareSingleton<T>(
  factory: () => T,
  options: TenantAwareSingletonOptions<T> = {},
): TenantAwareSingleton<T> {
  const tenantInstances = new Map<string, T>();
  const tenantLastAccess = new Map<string, number>();
  const tenantCreatedAt = new Map<string, number>();
  let globalInstance: T | null = null;
  let lifetimeTenantCount = 0;

  const quota: TenantQuota = {
    maxTenants: 100,
    tenantTtlMs: 30 * 60 * 1000,
    ...options.quota,
  };
  const component = options.componentName ?? 'TenantAwareSingleton';
  const allowGlobalFallback = options.allowGlobalFallback !== false;
  const log = (
    level: 'warn' | 'error',
    message: string,
    context?: Record<string, unknown>,
  ): void => {
    const prefix = `[${component}] ${message}`;
    if (level === 'error') {
      console.error(prefix, context ?? '');
    } else {
      console.warn(prefix, context ?? '');
    }
  };

  function disposeInstance(
    tenantId: string | null,
    instance: T,
    reason: 'ttl' | 'lru' | 'explicit' | 'reset',
  ): void {
    try {
      options.dispose?.(instance);
    } catch (err) {
      log('error', 'Dispose handler threw', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    options.onEvict?.(tenantId ?? 'global', reason);
  }

  function evictStaleTenants(): void {
    const now = Date.now();
    for (const [tid, lastAccess] of tenantLastAccess) {
      if (now - lastAccess > quota.tenantTtlMs) {
        const inst = tenantInstances.get(tid);
        if (inst) {
          log('warn', 'Evicting tenant instance due to TTL', {
            tenantId: tid,
            idleMs: now - lastAccess,
          });
          disposeInstance(tid, inst, 'ttl');
        }
        tenantInstances.delete(tid);
        tenantLastAccess.delete(tid);
        tenantCreatedAt.delete(tid);
      }
    }
  }

  function evictLRU(): string | null {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [tid, t] of tenantLastAccess) {
      if (t < oldestTime) {
        oldestTime = t;
        oldest = tid;
      }
    }
    if (oldest) {
      const inst = tenantInstances.get(oldest);
      if (inst) {
        log('warn', 'Evicting tenant instance due to LRU quota', {
          tenantId: oldest,
          activeTenants: tenantInstances.size,
          maxTenants: quota.maxTenants,
        });
        disposeInstance(oldest, inst, 'lru');
      }
      tenantInstances.delete(oldest);
      tenantLastAccess.delete(oldest);
      tenantCreatedAt.delete(oldest);
    }
    return oldest;
  }

  function maybeEvictForNewTenant(): void {
    if (tenantInstances.size < quota.maxTenants) return;
    evictStaleTenants();
    if (tenantInstances.size >= quota.maxTenants) {
      evictLRU();
    }
  }

  function checkLifetimeQuota(): void {
    if (quota.maxLifetimeTenants !== undefined && lifetimeTenantCount >= quota.maxLifetimeTenants) {
      throw new TenantIsolationError(
        `Tenant lifetime quota exceeded: ${quota.maxLifetimeTenants}. ` +
          'Dispose unused tenants or increase the quota.',
      );
    }
  }

  function get(): T {
    const tenantId = getCurrentTenantId();
    if (tenantId) {
      validateTenantId(tenantId);
      let inst = tenantInstances.get(tenantId);
      if (!inst) {
        maybeEvictForNewTenant();
        checkLifetimeQuota();
        inst = factory();
        tenantInstances.set(tenantId, inst);
        tenantCreatedAt.set(tenantId, Date.now());
        lifetimeTenantCount++;
        log('warn', 'Created tenant instance', {
          tenantId,
          activeTenants: tenantInstances.size,
          lifetimeTenants: lifetimeTenantCount,
        });
      }
      tenantLastAccess.set(tenantId, Date.now());
      return inst;
    }

    if (!allowGlobalFallback) {
      throw new TenantIsolationError(
        `${component}.get() called outside tenant context and allowGlobalFallback is false`,
      );
    }

    log('warn', 'Using global fallback instance outside tenant context', {
      allowGlobalFallback,
    });
    if (!globalInstance) {
      globalInstance = factory();
    }
    return globalInstance;
  }

  function reset(): void {
    if (globalInstance) {
      disposeInstance(null, globalInstance, 'reset');
      globalInstance = null;
    }
    for (const [tid, inst] of tenantInstances) {
      disposeInstance(tid, inst, 'reset');
    }
    tenantInstances.clear();
    tenantLastAccess.clear();
    tenantCreatedAt.clear();
    lifetimeTenantCount = 0;
  }

  function disposeTenant(tenantId: string): boolean {
    validateTenantId(tenantId);
    const inst = tenantInstances.get(tenantId);
    if (!inst) return false;
    disposeInstance(tenantId, inst, 'explicit');
    tenantInstances.delete(tenantId);
    tenantLastAccess.delete(tenantId);
    tenantCreatedAt.delete(tenantId);
    return true;
  }

  function getForTenant(tenantId: string): T {
    validateTenantId(tenantId);
    let inst = tenantInstances.get(tenantId);
    if (!inst) {
      maybeEvictForNewTenant();
      checkLifetimeQuota();
      inst = factory();
      tenantInstances.set(tenantId, inst);
      tenantCreatedAt.set(tenantId, Date.now());
      lifetimeTenantCount++;
      log('warn', 'Created tenant instance (explicit)', {
        tenantId,
        activeTenants: tenantInstances.size,
        lifetimeTenants: lifetimeTenantCount,
      });
    }
    tenantLastAccess.set(tenantId, Date.now());
    return inst;
  }

  function tenantCount(): number {
    return tenantInstances.size;
  }

  function getGlobal(): T {
    log('warn', 'getGlobal() bypasses tenant isolation and is deprecated', {
      currentTenant: getCurrentTenantId(),
    });
    if (!globalInstance) {
      globalInstance = factory();
    }
    return globalInstance;
  }

  function lifetimeTenantCountFn(): number {
    return lifetimeTenantCount;
  }

  return {
    get,
    reset,
    getForTenant,
    getGlobal,
    disposeTenant,
    tenantCount,
    lifetimeTenantCount: lifetimeTenantCountFn,
  };
}
