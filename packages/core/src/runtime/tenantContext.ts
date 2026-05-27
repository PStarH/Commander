import { AsyncLocalStorage } from 'async_hooks';

export interface TenantContextValue {
  tenantId?: string;
}

const storage = new AsyncLocalStorage<TenantContextValue>();

/**
 * Run a function within a tenant context.
 * All getX() singleton calls inside fn() will return tenant-scoped instances.
 */
export function runWithTenant<T>(tenantId: string | undefined, fn: () => T): T {
  return storage.run({ tenantId }, fn);
}

/**
 * Get the current tenant ID from the async context.
 * Returns undefined in single-tenant mode.
 */
export function getCurrentTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}

/**
 * Check if we're currently executing in a tenant context.
 */
export function hasTenantContext(): boolean {
  return storage.getStore() !== undefined;
}
