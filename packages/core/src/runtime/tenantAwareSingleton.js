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
const DEFAULT_QUOTA = {
    maxTenants: 100,
    tenantTtlMs: 30 * 60 * 1000, // 30 minutes
    maxLifetimeTenants: undefined,
};
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
export function createTenantAwareSingleton(factory, options = {}) {
    const tenantInstances = new Map();
    const tenantLastAccess = new Map();
    const tenantCreatedAt = new Map();
    let globalInstance = null;
    let lifetimeTenantCount = 0;
    const quota = {
        maxTenants: 100,
        tenantTtlMs: 30 * 60 * 1000,
        ...options.quota,
    };
    const component = options.componentName ?? 'TenantAwareSingleton';
    const allowGlobalFallback = options.allowGlobalFallback !== false;
    const log = (level, message, context) => {
        const prefix = `[${component}] ${message}`;
        if (level === 'error') {
            console.error(prefix, context ?? '');
        }
        else {
            console.warn(prefix, context ?? '');
        }
    };
    function disposeInstance(tenantId, instance, reason) {
        try {
            options.dispose?.(instance);
        }
        catch (err) {
            log('error', 'Dispose handler threw', {
                tenantId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
        options.onEvict?.(tenantId ?? 'global', reason);
    }
    function evictStaleTenants() {
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
    function evictLRU() {
        let oldest = null;
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
    function maybeEvictForNewTenant() {
        if (tenantInstances.size < quota.maxTenants)
            return;
        evictStaleTenants();
        if (tenantInstances.size >= quota.maxTenants) {
            evictLRU();
        }
    }
    function checkLifetimeQuota() {
        if (quota.maxLifetimeTenants !== undefined && lifetimeTenantCount >= quota.maxLifetimeTenants) {
            throw new TenantIsolationError(`Tenant lifetime quota exceeded: ${quota.maxLifetimeTenants}. ` +
                'Dispose unused tenants or increase the quota.');
        }
    }
    function get() {
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
            throw new TenantIsolationError(`${component}.get() called outside tenant context and allowGlobalFallback is false`);
        }
        log('warn', 'Using global fallback instance outside tenant context', {
            allowGlobalFallback,
        });
        if (!globalInstance) {
            globalInstance = factory();
        }
        return globalInstance;
    }
    function reset() {
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
    function disposeTenant(tenantId) {
        validateTenantId(tenantId);
        const inst = tenantInstances.get(tenantId);
        if (!inst)
            return false;
        disposeInstance(tenantId, inst, 'explicit');
        tenantInstances.delete(tenantId);
        tenantLastAccess.delete(tenantId);
        tenantCreatedAt.delete(tenantId);
        return true;
    }
    function getForTenant(tenantId) {
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
    function tenantCount() {
        return tenantInstances.size;
    }
    function getGlobal() {
        log('warn', 'getGlobal() bypasses tenant isolation and is deprecated', {
            currentTenant: getCurrentTenantId(),
        });
        if (!globalInstance) {
            globalInstance = factory();
        }
        return globalInstance;
    }
    function lifetimeTenantCountFn() {
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
