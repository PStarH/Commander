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
 * Usage:
 *   const memSingleton = createTenantAwareSingleton(() => new ThreeLayerMemory());
 *   export function getGlobalThreeLayerMemory() { return memSingleton.get(); }
 *
 * In single-tenant mode: behaves exactly like a normal global singleton.
 * In multi-tenant mode: returns per-tenant instances based on AsyncLocalStorage context.
 */
export declare function createTenantAwareSingleton<T>(factory: () => T, options?: {
    dispose?: (instance: T) => void;
}): TenantAwareSingleton<T>;
//# sourceMappingURL=tenantAwareSingleton.d.ts.map