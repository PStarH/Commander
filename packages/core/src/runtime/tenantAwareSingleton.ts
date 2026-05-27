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
}

/**
 * Create a tenant-aware singleton wrapper.
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
  let globalInstance: T | null = null;

  function get(): T {
    const tenantId = getCurrentTenantId();
    if (tenantId) {
      let inst = tenantInstances.get(tenantId);
      if (!inst) {
        inst = factory();
        tenantInstances.set(tenantId, inst);
      }
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
  }

  function getForTenant(tenantId: string): T {
    let inst = tenantInstances.get(tenantId);
    if (!inst) {
      inst = factory();
      tenantInstances.set(tenantId, inst);
    }
    return inst;
  }

  function getGlobal(): T {
    if (!globalInstance) {
      globalInstance = factory();
    }
    return globalInstance;
  }

  return { get, reset, getForTenant, getGlobal };
}
