/**
 * TenantProvider — Multi-tenant isolation for Commander.
 *
 * Defines the contract for tenant identification, configuration, and
 * resource quota enforcement. Two built-in implementations:
 *  - NullTenantProvider: single-tenant mode, no isolation (default)
 *  - SimpleTenantProvider: static config map for multi-tenant deployments
 */
import { ThreeLayerMemory } from '../threeLayerMemory';
export interface TenantConfig {
    tenantId: string;
    /** Max tokens per run. 0 = inherit runtime default. */
    tokenBudget: number;
    /** Max concurrent runs for this tenant. 0 = inherit runtime default. */
    maxConcurrency: number;
    /** Max runs per minute (rate limit). 0 = unlimited. */
    maxRunsPerMinute: number;
    /** Enables quota enforcement for this tenant. */
    enabled: boolean;
    /** Optional workspace root for file operations (chroot-like). */
    workspacePath?: string;
    /** Optional override for storage base directory. */
    storagePath?: string;
    /** Arbitrary metadata (labels, tags, billing code). */
    metadata?: Record<string, string>;
}
export interface TenantProvider {
    /** Look up tenant config by tenant ID. Returns undefined if unknown. */
    getTenantConfig(tenantId: string): TenantConfig | undefined;
    /** List all known tenant IDs. */
    getKnownTenants(): string[];
    /** Current tenant ID from tenant context (single-tenant returns undefined). */
    getCurrentTenantId(): string | undefined;
}
export declare class NullTenantProvider implements TenantProvider {
    getTenantConfig(_tenantId: string): TenantConfig | undefined;
    getKnownTenants(): string[];
    getCurrentTenantId(): string | undefined;
}
export declare class SimpleTenantProvider implements TenantProvider {
    private tenants;
    constructor(tenants?: TenantConfig[]);
    getTenantConfig(tenantId: string): TenantConfig | undefined;
    getKnownTenants(): string[];
    getCurrentTenantId(): string | undefined;
    addTenant(config: TenantConfig): void;
    removeTenant(tenantId: string): void;
}
export declare class ThreeLayerMemoryRegistry {
    private instances;
    private defaultInstance;
    private static readonly MAX_INSTANCES;
    /** Get or create a memory instance for a tenant. */
    getOrCreate(tenantId?: string): ThreeLayerMemory;
    /** Remove a tenant's memory instance (free memory). */
    remove(tenantId: string): void;
    /** Get count of tenant-specific instances (excludes default). */
    getTenantCount(): number;
}
export declare function getGlobalTenantProvider(): TenantProvider;
export declare function setGlobalTenantProvider(provider: TenantProvider): void;
export declare function resetGlobalTenantProvider(): void;
export declare function getGlobalMemoryRegistry(): ThreeLayerMemoryRegistry;
export declare function resetGlobalMemoryRegistry(): void;
//# sourceMappingURL=tenantProvider.d.ts.map