import type { CapabilityVector } from './types';
export declare class CapabilityRegistry {
    private registry;
    register(agentId: string, vector: Omit<CapabilityVector, 'agentId' | 'version' | 'lastUpdated'>): CapabilityVector;
    update(agentId: string, updates: Partial<CapabilityVector>): CapabilityVector | null;
    get(agentId: string): CapabilityVector | null;
    findBestMatch(requiredCapabilities: string[], constraints?: {
        maxCostPerToken?: number;
        minSuccessRate?: number;
    }): Array<{
        agentId: string;
        matchScore: number;
        vector: CapabilityVector;
    }>;
    private calculateMatchScore;
    /**
     * Compute fuzzy match score between two strings using Levenshtein distance.
     * Returns a score between 0 (no match) and 1 (exact match).
     */
    private fuzzyMatchScore;
    /**
     * Compute Levenshtein distance between two strings.
     */
    private levenshteinDistance;
    getStats(): {
        totalAgents: number;
        totalCapabilities: number;
        topCapabilities: Array<{
            name: string;
            count: number;
        }>;
    };
    deregister(agentId: string): boolean;
    /** Evict agents not updated within the given TTL (default 30 minutes) */
    evictStale(ttlMs?: number): number;
    clear(): void;
}
export declare function getCapabilityRegistry(): CapabilityRegistry;
export declare function resetCapabilityRegistry(): void;
//# sourceMappingURL=capabilityRegistry.d.ts.map