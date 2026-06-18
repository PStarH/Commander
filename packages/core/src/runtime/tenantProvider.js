"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ThreeLayerMemoryRegistry = exports.SimpleTenantProvider = exports.NullTenantProvider = void 0;
exports.getGlobalTenantProvider = getGlobalTenantProvider;
exports.setGlobalTenantProvider = setGlobalTenantProvider;
exports.resetGlobalTenantProvider = resetGlobalTenantProvider;
exports.getGlobalMemoryRegistry = getGlobalMemoryRegistry;
exports.resetGlobalMemoryRegistry = resetGlobalMemoryRegistry;
/**
 * TenantProvider — Multi-tenant isolation for Commander.
 *
 * Defines the contract for tenant identification, configuration, and
 * resource quota enforcement. Two built-in implementations:
 *  - NullTenantProvider: single-tenant mode, no isolation (default)
 *  - SimpleTenantProvider: static config map for multi-tenant deployments
 */
const threeLayerMemory_1 = require("../threeLayerMemory");
const tenantContext_1 = require("./tenantContext");
// ============================================================================
// NullTenantProvider — single-tenant mode, no isolation
// ============================================================================
class NullTenantProvider {
    getTenantConfig(_tenantId) {
        return undefined;
    }
    getKnownTenants() {
        return [];
    }
    getCurrentTenantId() {
        return (0, tenantContext_1.getCurrentTenantId)();
    }
}
exports.NullTenantProvider = NullTenantProvider;
// ============================================================================
// SimpleTenantProvider — static config map
// ============================================================================
class SimpleTenantProvider {
    constructor(tenants = []) {
        this.tenants = new Map(tenants.map((t) => [t.tenantId, t]));
    }
    getTenantConfig(tenantId) {
        return this.tenants.get(tenantId);
    }
    getKnownTenants() {
        return Array.from(this.tenants.keys());
    }
    getCurrentTenantId() {
        return (0, tenantContext_1.getCurrentTenantId)();
    }
    addTenant(config) {
        this.tenants.set(config.tenantId, config);
    }
    removeTenant(tenantId) {
        this.tenants.delete(tenantId);
    }
}
exports.SimpleTenantProvider = SimpleTenantProvider;
// ============================================================================
// ThreeLayerMemory Registry — per-tenant memory isolation
// ============================================================================
class ThreeLayerMemoryRegistry {
    constructor() {
        this.instances = new Map();
        this.defaultInstance = null;
    }
    /** Get or create a memory instance for a tenant. */
    getOrCreate(tenantId) {
        if (!tenantId) {
            if (!this.defaultInstance) {
                this.defaultInstance = (0, threeLayerMemory_1.getGlobalThreeLayerMemory)();
            }
            return this.defaultInstance;
        }
        let mem = this.instances.get(tenantId);
        if (!mem) {
            if (this.instances.size >= ThreeLayerMemoryRegistry.MAX_INSTANCES) {
                // Evict the first (oldest) entry
                const firstKey = this.instances.keys().next().value;
                if (firstKey)
                    this.instances.delete(firstKey);
            }
            mem = new threeLayerMemory_1.ThreeLayerMemory();
            this.instances.set(tenantId, mem);
        }
        return mem;
    }
    /** Remove a tenant's memory instance (free memory). */
    remove(tenantId) {
        this.instances.delete(tenantId);
    }
    /** Get count of tenant-specific instances (excludes default). */
    getTenantCount() {
        return this.instances.size;
    }
}
exports.ThreeLayerMemoryRegistry = ThreeLayerMemoryRegistry;
ThreeLayerMemoryRegistry.MAX_INSTANCES = 50;
// ============================================================================
// Global singleton
// ============================================================================
const tenantAwareSingleton_1 = require("./tenantAwareSingleton");
let globalTenantProvider = new NullTenantProvider();
function getGlobalTenantProvider() {
    return globalTenantProvider;
}
function setGlobalTenantProvider(provider) {
    globalTenantProvider = provider;
}
function resetGlobalTenantProvider() {
    globalTenantProvider = new NullTenantProvider();
}
const memoryRegistrySingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new ThreeLayerMemoryRegistry());
function getGlobalMemoryRegistry() {
    return memoryRegistrySingleton.get();
}
function resetGlobalMemoryRegistry() {
    memoryRegistrySingleton.reset();
}
