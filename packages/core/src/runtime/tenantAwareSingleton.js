"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTenantAwareSingleton = createTenantAwareSingleton;
const tenantContext_1 = require("./tenantContext");
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
function createTenantAwareSingleton(factory, options) {
    const tenantInstances = new Map();
    const tenantLastAccess = new Map();
    let globalInstance = null;
    const MAX_TENANTS = 100;
    const TENANT_TTL_MS = 30 * 60 * 1000; // 30 minutes
    function evictStaleTenants() {
        const now = Date.now();
        for (const [tid, lastAccess] of tenantLastAccess) {
            if (now - lastAccess > TENANT_TTL_MS) {
                const inst = tenantInstances.get(tid);
                if (inst && (options === null || options === void 0 ? void 0 : options.dispose))
                    options.dispose(inst);
                tenantInstances.delete(tid);
                tenantLastAccess.delete(tid);
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
            if (inst && (options === null || options === void 0 ? void 0 : options.dispose))
                options.dispose(inst);
            tenantInstances.delete(oldest);
            tenantLastAccess.delete(oldest);
        }
    }
    function get() {
        const tenantId = (0, tenantContext_1.getCurrentTenantId)();
        if (tenantId) {
            let inst = tenantInstances.get(tenantId);
            if (!inst) {
                if (tenantInstances.size >= MAX_TENANTS) {
                    evictStaleTenants();
                    // If all tenants are still active (within TTL), force-evict LRU
                    if (tenantInstances.size >= MAX_TENANTS)
                        evictLRU();
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
    function reset() {
        if (options === null || options === void 0 ? void 0 : options.dispose) {
            if (globalInstance)
                options.dispose(globalInstance);
            for (const inst of tenantInstances.values()) {
                options.dispose(inst);
            }
        }
        globalInstance = null;
        tenantInstances.clear();
        tenantLastAccess.clear();
    }
    function disposeTenant(tenantId) {
        const inst = tenantInstances.get(tenantId);
        if (!inst)
            return false;
        if (options === null || options === void 0 ? void 0 : options.dispose)
            options.dispose(inst);
        tenantInstances.delete(tenantId);
        tenantLastAccess.delete(tenantId);
        return true;
    }
    function getForTenant(tenantId) {
        let inst = tenantInstances.get(tenantId);
        if (!inst) {
            if (tenantInstances.size >= MAX_TENANTS)
                evictStaleTenants();
            inst = factory();
            tenantInstances.set(tenantId, inst);
        }
        tenantLastAccess.set(tenantId, Date.now());
        return inst;
    }
    function getGlobal() {
        if (!globalInstance) {
            globalInstance = factory();
        }
        return globalInstance;
    }
    return { get, reset, getForTenant, getGlobal, disposeTenant };
}
