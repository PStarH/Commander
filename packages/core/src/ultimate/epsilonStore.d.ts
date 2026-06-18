export interface EpsilonOverride {
    tenantId: string;
    epsilon: number;
    /** ISO-8601 timestamp the override was set. */
    setAt: string;
}
export declare class EpsilonStore {
    private readonly overrides;
    /**
     * Set the per-tenant ε override. Clamps to [0, 1]; NaN → fallback.
     * Overwrites any existing override for the tenant.
     */
    set(tenantId: string, epsilon: number): EpsilonOverride;
    /**
     * Get the per-tenant ε override. Returns undefined when no
     * override is set — the router then falls back to its constructor
     * default.
     */
    get(tenantId: string): EpsilonOverride | undefined;
    /**
     * Resolve the effective ε for a tenant: override → fallback.
     * Pure read; never throws and never mutates.
     */
    resolve(tenantId: string, fallback?: number): number;
    /**
     * List all overrides, sorted by tenantId ascending for stable
     * dashboard rendering. Returns a defensive copy so callers can't
     * mutate the store.
     */
    list(): EpsilonOverride[];
    /**
     * Clear one tenant's override. Returns true if an entry was
     * removed, false if there was nothing to clear.
     */
    clear(tenantId: string): boolean;
    /** Clear all overrides. */
    clearAll(): number;
    /** Number of tenants with an active override. */
    size(): number;
}
//# sourceMappingURL=epsilonStore.d.ts.map