export interface TenantContextValue {
    tenantId?: string;
}
/**
 * Run a function within a tenant context.
 * All getX() singleton calls inside fn() will return tenant-scoped instances.
 */
export declare function runWithTenant<T>(tenantId: string | undefined, fn: () => T): T;
/**
 * Get the current tenant ID from the async context.
 * Returns undefined in single-tenant mode.
 */
export declare function getCurrentTenantId(): string | undefined;
/**
 * Check if we're currently executing in a tenant context.
 */
export declare function hasTenantContext(): boolean;
//# sourceMappingURL=tenantContext.d.ts.map