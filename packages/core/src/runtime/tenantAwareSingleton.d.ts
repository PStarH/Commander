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
export declare function createTenantAwareSingleton<T>(factory: () => T, options?: TenantAwareSingletonOptions<T>): TenantAwareSingleton<T>;
