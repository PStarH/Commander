import { getCurrentTenantId } from './tenantContext';

/**
 * Factory result for a tenant-aware singleton.
 *
 * - `get()`: Returns the instance for the current tenant context.
 *            Falls back to a global default when no tenant context is active.
 *            This means ZERO call-site changes for single-tenant mode.
 * - `reset()`: Clears all instances (global + per-tenant). For test isolation.
 * - `getForTenant(tenantId)`: Explicit per-tenant access without AsyncLocalStorage.
 * - `getGlobal()`: Direct access to the global fallback instance.
 */
export interface TenantAwareSingleton<T> {
  get(): T;
  reset(): void;
  getForTenant(tenantId: string): T;
  getGlobal(): T;
  disposeTenant(tenantId: string): boolean;
}

/**
 * Create a tenant-aware singleton wrapper.
 *
 * WARNING: This is NOT true multi-tenancy. Tenant isolation is in-process
 * context scoping only. There is zero data isolation at the storage layer.
 * Tenant state is silently lost after 30 minutes of inactivity (TTL eviction).
 * MAX_TENANTS = 100 with LRU eviction when exceeded. getGlobal() explicitly
 * bypasses all tenant isolation.
 *
 * Usage:
 *   const memSingleton = createTenantAwareSingleton(() => new ThreeLayerMemory());
 *   export function getGlobalThreeLayerMemory() { return memSingleton.get(); }
 *
 * In single-tenant mode: behaves exactly like a normal global singleton.
 * In multi-tenant mode: returns per-tenant instances based on AsyncLocalStorage context.
 */
export function createTenantAwareSingleton<T>(
  factory: () => T,
  options?: { dispose?: (instance: T) => void },
): TenantAwareSingleton<T> {
  const tenantInstances = new Map<string, T>();
  const tenantLastAccess = new Map<string, number>();
  let globalInstance: T | null = null;
  const MAX_TENANTS = 100;
  const TENANT_TTL_MS = 30 * 60 * 1000; // 30 minutes

  function evictStaleTenants(): void {
    const now = Date.now();
    for (const [tid, lastAccess] of tenantLastAccess) {
      if (now - lastAccess > TENANT_TTL_MS) {
        const inst = tenantInstances.get(tid);
        if (inst && options?.dispose) options.dispose(inst);
        tenantInstances.delete(tid);
        tenantLastAccess.delete(tid);
      }
    }
  }

  function evictLRU(): void {
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
      if (inst && options?.dispose) options.dispose(inst);
      tenantInstances.delete(oldest);
      tenantLastAccess.delete(oldest);
    }
  }

  function get(): T {
    const tenantId = getCurrentTenantId();
    if (tenantId) {
      let inst = tenantInstances.get(tenantId);
      if (!inst) {
        if (tenantInstances.size >= MAX_TENANTS) {
          evictStaleTenants();
          // If all tenants are still active (within TTL), force-evict LRU
          if (tenantInstances.size >= MAX_TENANTS) evictLRU();
        }
        inst = factory();
        tenantInstances.set(tenantId, inst);
      }
      tenantLastAccess.set(tenantId, Date.now());
      return inst;
    }
    if (!globalInstance) {
      globalInstance = factory();
    }
    return globalInstance;
  }

  function reset(): void {
    if (options?.dispose) {
      if (globalInstance) options.dispose(globalInstance);
      for (const inst of tenantInstances.values()) {
        options.dispose(inst);
      }
    }
    globalInstance = null;
    tenantInstances.clear();
    tenantLastAccess.clear();
  }

  function disposeTenant(tenantId: string): boolean {
    const inst = tenantInstances.get(tenantId);
    if (!inst) return false;
    if (options?.dispose) options.dispose(inst);
    tenantInstances.delete(tenantId);
    tenantLastAccess.delete(tenantId);
    return true;
  }

  function getForTenant(tenantId: string): T {
    let inst = tenantInstances.get(tenantId);
    if (!inst) {
      if (tenantInstances.size >= MAX_TENANTS) evictStaleTenants();
      inst = factory();
      tenantInstances.set(tenantId, inst);
    }
    tenantLastAccess.set(tenantId, Date.now());
    return inst;
  }

  function getGlobal(): T {
    if (!globalInstance) {
      globalInstance = factory();
    }
    return globalInstance;
  }

  return { get, reset, getForTenant, getGlobal, disposeTenant };
}
