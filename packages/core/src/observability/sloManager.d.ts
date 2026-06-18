import type { ExecutionTrace } from '../runtime/types';
interface SLODefinition {
    id: string;
    name: string;
    description?: string;
    metric: 'latency_ms' | 'cost_usd' | 'tokens' | 'error_rate' | 'success_rate';
    threshold: number;
    operator: 'lt' | 'lte' | 'gt' | 'gte' | 'eq';
    windowSize: number;
    alertChannels: string[];
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
}
interface SLOViolation {
    sloId: string;
    timestamp: string;
    runId: string;
    metric: string;
    actualValue: number;
    threshold: number;
    severity: 'warning' | 'critical';
}
interface SLOStatus {
    sloId: string;
    name: string;
    metric: string;
    threshold: number;
    currentValue: number;
    isViolating: boolean;
    violationCount: number;
    lastChecked: string;
}
export declare class SLOManager {
    private slos;
    private violations;
    createSLO(slo: Omit<SLODefinition, 'id' | 'createdAt' | 'updatedAt'>): SLODefinition;
    updateSLO(id: string, updates: Partial<SLODefinition>): SLODefinition | undefined;
    deleteSLO(id: string): boolean;
    getSLO(id: string): SLODefinition | undefined;
    listSLOs(): SLODefinition[];
    checkTrace(trace: ExecutionTrace): SLOViolation[];
    getViolations(sloId?: string): SLOViolation[];
    getStatus(): SLOStatus[];
}
export declare function getSLOManager(): SLOManager;
export declare function resetSLOManager(): void;
export {};
//# sourceMappingURL=sloManager.d.ts.map