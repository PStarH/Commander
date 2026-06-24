/**
 * TenantProvider — Multi-tenant isolation for Commander.
 *
 * Defines the contract for tenant identification, configuration, and
 * resource quota enforcement. Two built-in implementations:
 *  - NullTenantProvider: single-tenant mode, no isolation (default)
 *  - SimpleTenantProvider: static config map for multi-tenant deployments
 */
import * as path from 'path';
import { ThreeLayerMemory, getGlobalThreeLayerMemory } from '../threeLayerMemory';
import { getCurrentTenantId as readCurrentTenantId } from './tenantContext';
// ============================================================================
// NullTenantProvider — single-tenant mode, no isolation
// ============================================================================
export class NullTenantProvider {
    getTenantConfig(_tenantId) {
        return undefined;
    }
    getKnownTenants() {
        return [];
    }
    getCurrentTenantId() {
        return readCurrentTenantId();
    }
    validateWorkspacePath(_tenantId, _filePath) {
        return true;
    }
}
// ============================================================================
// SimpleTenantProvider — static config map
// ============================================================================
export class SimpleTenantProvider {
    tenants;
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
        return readCurrentTenantId();
    }
    validateWorkspacePath(tenantId, filePath) {
        const config = this.tenants.get(tenantId);
        if (!config?.workspacePath)
            return true;
        const resolved = path.resolve(filePath);
        const workspace = path.resolve(config.workspacePath);
        return resolved === workspace || resolved.startsWith(workspace + path.sep);
    }
    addTenant(config) {
        this.tenants.set(config.tenantId, config);
    }
    removeTenant(tenantId) {
        this.tenants.delete(tenantId);
    }
}
// ============================================================================
// ThreeLayerMemory Registry — per-tenant memory isolation
// ============================================================================
export class ThreeLayerMemoryRegistry {
    instances = new Map();
    defaultInstance = null;
    static MAX_INSTANCES = 50;
    /** Get or create a memory instance for a tenant. */
    getOrCreate(tenantId) {
        if (!tenantId) {
            if (!this.defaultInstance) {
                this.defaultInstance = getGlobalThreeLayerMemory();
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
            mem = new ThreeLayerMemory();
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
// ============================================================================
// Global singleton
// ============================================================================
import { createTenantAwareSingleton } from './tenantAwareSingleton';
let globalTenantProvider = new NullTenantProvider();
export function getGlobalTenantProvider() {
    return globalTenantProvider;
}
export function setGlobalTenantProvider(provider) {
    globalTenantProvider = provider;
}
export function resetGlobalTenantProvider() {
    globalTenantProvider = new NullTenantProvider();
}
const memoryRegistrySingleton = createTenantAwareSingleton(() => new ThreeLayerMemoryRegistry());
export function getGlobalMemoryRegistry() {
    return memoryRegistrySingleton.get();
}
export function resetGlobalMemoryRegistry() {
    memoryRegistrySingleton.reset();
}
