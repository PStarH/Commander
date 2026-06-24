export interface TenantContextValue {
    tenantId?: string;
}
export declare class TenantIsolationError extends Error {
    constructor(message: string);
}
/**
 * Validate a tenant identifier. Throws TenantIsolationError if invalid.
 */
export declare function validateTenantId(tenantId: string): void;
/**
 * Run a function within a tenant context.
 * All tenant-aware singleton calls inside fn() will return tenant-scoped instances.
 */
export declare function runWithTenant<T>(tenantId: string | undefined, fn: () => T): T;
/**
 * Get the current tenant ID from the async context.
 * Returns undefined in single-tenant mode.
 */
export declare function getCurrentTenantId(): string | undefined;
/**
 * Get the current tenant ID or throw if not in a tenant context.
 */
export declare function requireCurrentTenantId(): string;
/**
 * Check if we're currently executing in a tenant context.
 */
export declare function hasTenantContext(): boolean;
/**
<<<<<<< Updated upstream
 * Sanitize a tenant ID so it can be safely embedded in file paths, cache keys,
 * and database identifiers without traversal/injection issues.
 */
export declare function sanitizeTenantId(tenantId: string): string;
/**
 * Build a tenant-scoped storage key. Guarantees the returned string cannot be
 * confused with another tenant's key.
 */
export declare function tenantKey(tenantId: string, suffix: string): string;
/**
 * Build a tenant-scoped file path segment. The returned segment is safe to join
 * into a base directory using `path.join(baseDir, tenantPathSegment(tenantId))`.
 */
export declare function tenantPathSegment(tenantId: string): string;
/**
 * Assert that the given tenantId matches the current tenant context.
 * Use this in storage backends before returning data.
 */
export declare function assertSameTenant(tenantId: string): void;
/**
 * Compact helper that collapses the repeated
 * `getGlobalTenantProvider().getCurrentTenantId() ?? <opt> ?? undefined` pattern
 * into a single named call. Priority order matches the original inline expression:
 * global tenant provider first, then the caller's `explicitTenantId`
 * (typically `ctx.tenantId`), then undefined.
 */
export declare function resolveActiveTenantId(explicitTenantId?: string): string | undefined;
