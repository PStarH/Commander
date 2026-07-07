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
import { AsyncLocalStorage } from 'node:async_hooks';
// NOTE: getGlobalTenantProvider is imported lazily to break a value-import
// cycle: tenantProvider → tenantContext → tenantProvider. Loading it at
// module load time creates a circular dependency. The lazy wrapper resolves
// it on first use.
let _getGlobalTenantProvider: typeof import('./tenantProvider').getGlobalTenantProvider | null =
  null;
function getGlobalTenantProviderLazy(): ReturnType<
  typeof import('./tenantProvider').getGlobalTenantProvider
> {
  if (!_getGlobalTenantProvider) {
    _getGlobalTenantProvider = require('./tenantProvider').getGlobalTenantProvider;
  }
  return _getGlobalTenantProvider!();
}

export interface TenantContextValue {
  tenantId?: string;
}

const storage = new AsyncLocalStorage<TenantContextValue>();

/** Tenant ID format: alphanumeric, hyphen, underscore, dot, colon. Must not be empty. */
const TENANT_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;

/** Characters that are safe in filesystem paths and URL segments. */
const SANITIZE_RE = /[^a-zA-Z0-9._:-]/g;

export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantIsolationError';
  }
}

let _multiTenantEnabled = false;

/**
 * Mark whether a multi-tenant provider is active. Called by tenant provider
 * lifecycle helpers; consumers should use isMultiTenantEnabled().
 */
export function setMultiTenantEnabled(enabled: boolean): void {
  _multiTenantEnabled = enabled;
}

/**
 * Returns true when a multi-tenant provider has been configured. Global
 * fallback for tenant-aware singletons is forbidden while this is true.
 */
export function isMultiTenantEnabled(): boolean {
  return _multiTenantEnabled;
}

/**
 * Validate a tenant identifier. Throws TenantIsolationError if invalid.
 */
export function validateTenantId(tenantId: string): void {
  if (typeof tenantId !== 'string' || !TENANT_ID_RE.test(tenantId)) {
    throw new TenantIsolationError(
      `Invalid tenant id: must be 1-128 chars matching ${TENANT_ID_RE.source}`,
    );
  }
}

/**
 * Run a function within a tenant context.
 * All tenant-aware singleton calls inside fn() will return tenant-scoped instances.
 */
export function runWithTenant<T>(tenantId: string | undefined, fn: () => T): T {
  if (tenantId !== undefined) {
    validateTenantId(tenantId);
  }
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
 * Get the current tenant ID or throw if not in a tenant context.
 */
export function requireCurrentTenantId(): string {
  const tenantId = getCurrentTenantId();
  if (!tenantId) {
    throw new TenantIsolationError('Tenant context required but not active');
  }
  return tenantId;
}

/**
 * Check if we're currently executing in a tenant context.
 */
export function hasTenantContext(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * Sanitize a tenant ID so it can be safely embedded in file paths, cache keys,
 * and database identifiers without traversal/injection issues.
 */
export function sanitizeTenantId(tenantId: string): string {
  validateTenantId(tenantId);
  return tenantId.replace(SANITIZE_RE, '_');
}

/**
 * Build a tenant-scoped storage key. Guarantees the returned string cannot be
 * confused with another tenant's key.
 */
export function tenantKey(tenantId: string, suffix: string): string {
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
export function tenantPathSegment(tenantId: string): string {
  validateTenantId(tenantId);
  return `tenant_${sanitizeTenantId(tenantId)}`;
}

/**
 * Assert that the given tenantId matches the current tenant context.
 * Use this in storage backends before returning data.
 * When no tenant context is active, the assertion is skipped (single-tenant mode).
 * When a tenant context IS active, it must match the requested tenantId.
 */
export function assertSameTenant(tenantId: string): void {
  validateTenantId(tenantId);
  const current = getCurrentTenantId();
  if (current !== undefined && current !== tenantId) {
    throw new TenantIsolationError(
      `Cross-tenant access blocked: requested=${tenantId}, current=${current}`,
    );
  }
}

/**
 * Compact helper that collapses the repeated
 * `getGlobalTenantProvider().getCurrentTenantId() ?? <opt> ?? undefined` pattern
 * into a single named call. Priority order matches the original inline expression:
 * global tenant provider first, then the caller's `explicitTenantId`
 * (typically `ctx.tenantId`), then undefined.
 */
export function resolveActiveTenantId(explicitTenantId?: string): string | undefined {
  return getGlobalTenantProviderLazy().getCurrentTenantId() || explicitTenantId;
}
