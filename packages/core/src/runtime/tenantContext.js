/**
 * Tenant context management.
 *
 * Provides async-context propagation of the current tenant ID plus helpers
 * for tenant validation, storage isolation, and cross-tenant access guards.
 *
 * The default mode is **best-effort isolation**: singletons created via
 * `createTenantAwareSingleton` are scoped per tenant, but storage backends
 * must still key their data by tenant. The helpers below make that easier.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { getGlobalTenantProvider } from './tenantProvider';
const storage = new AsyncLocalStorage();
/** Tenant ID format: alphanumeric, hyphen, underscore, dot, colon. Must not be empty. */
const TENANT_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
/** Characters that are safe in filesystem paths and URL segments. */
const SANITIZE_RE = /[^a-zA-Z0-9._:-]/g;
export class TenantIsolationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TenantIsolationError';
    }
}
/**
 * Validate a tenant identifier. Throws TenantIsolationError if invalid.
 */
export function validateTenantId(tenantId) {
    if (typeof tenantId !== 'string' || !TENANT_ID_RE.test(tenantId)) {
        throw new TenantIsolationError(`Invalid tenant id: must be 1-128 chars matching ${TENANT_ID_RE.source}`);
    }
}
/**
 * Run a function within a tenant context.
 * All tenant-aware singleton calls inside fn() will return tenant-scoped instances.
 */
export function runWithTenant(tenantId, fn) {
    if (tenantId !== undefined) {
        validateTenantId(tenantId);
    }
    return storage.run({ tenantId }, fn);
}
/**
 * Get the current tenant ID from the async context.
 * Returns undefined in single-tenant mode.
 */
export function getCurrentTenantId() {
    return storage.getStore()?.tenantId;
}
/**
 * Get the current tenant ID or throw if not in a tenant context.
 */
export function requireCurrentTenantId() {
    const tenantId = getCurrentTenantId();
    if (!tenantId) {
        throw new TenantIsolationError('Tenant context required but not active');
    }
    return tenantId;
}
/**
 * Check if we're currently executing in a tenant context.
 */
export function hasTenantContext() {
    return storage.getStore() !== undefined;
}
/**
<<<<<<< Updated upstream
 * Sanitize a tenant ID so it can be safely embedded in file paths, cache keys,
 * and database identifiers without traversal/injection issues.
 */
export function sanitizeTenantId(tenantId) {
    validateTenantId(tenantId);
    return tenantId.replace(SANITIZE_RE, '_');
}
/**
 * Build a tenant-scoped storage key. Guarantees the returned string cannot be
 * confused with another tenant's key.
 */
export function tenantKey(tenantId, suffix) {
    validateTenantId(tenantId);
    if (suffix.includes('\0') || suffix.includes('|')) {
        throw new TenantIsolationError('Tenant key suffix cannot contain \0 or |');
    }
    return `tenant:${sanitizeTenantId(tenantId)}|${suffix}`;
}
/**
 * Build a tenant-scoped file path segment. The returned segment is safe to join
 * into a base directory using `path.join(baseDir, tenantPathSegment(tenantId))`.
 */
export function tenantPathSegment(tenantId) {
    validateTenantId(tenantId);
    return `tenant_${sanitizeTenantId(tenantId)}`;
}
/**
 * Assert that the given tenantId matches the current tenant context.
 * Use this in storage backends before returning data.
 */
export function assertSameTenant(tenantId) {
    validateTenantId(tenantId);
    const current = getCurrentTenantId();
    if (current && current !== tenantId) {
        throw new TenantIsolationError(`Cross-tenant access blocked: requested=${tenantId}, current=${current}`);
    }
}
/**
 * Compact helper that collapses the repeated
 * `getGlobalTenantProvider().getCurrentTenantId() ?? <opt> ?? undefined` pattern
 * into a single named call. Priority order matches the original inline expression:
 * global tenant provider first, then the caller's `explicitTenantId`
 * (typically `ctx.tenantId`), then undefined.
 */
export function resolveActiveTenantId(explicitTenantId) {
    return getGlobalTenantProvider().getCurrentTenantId() || explicitTenantId;
}
