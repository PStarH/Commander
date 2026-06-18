import type { AgentRuntimeInterface } from '../runtime';
import type { TELOSPlanContext, TELOSConfig } from './types';
import { TokenSentinel } from './tokenSentinel';
import { ProviderPool } from './providerPool';
export declare class TELOSOrchestrator {
    private runtime;
    private sentinel;
    private pool;
    private config;
    private activePlans;
    constructor(runtime: AgentRuntimeInterface, config?: Partial<TELOSConfig>, sentinel?: TokenSentinel, pool?: ProviderPool);
    getConfig(): TELOSConfig;
    plan(params: {
        projectId: string;
        agentId: string;
        goal: string;
        contextData?: Record<string, unknown>;
    }): TELOSPlanContext;
    preflight(planId: string): {
        allowed: boolean;
        reason?: string;
    };
    execute(planId: string): Promise<{
        status: 'success' | 'failed' | 'cancelled';
        results: Array<{
            agentId: string;
            summary: string;
            status: string;
        }>;
        totalCostUsd: number;
        totalTokens: number;
        error?: string;
    }>;
    planAndExecute(params: {
        projectId: string;
        agentId: string;
        goal: string;
        contextData?: Record<string, unknown>;
    }): Promise<{
        plan: TELOSPlanContext;
        status: 'success' | 'failed' | 'cancelled';
        results: Array<{
            agentId: string;
            summary: string;
            status: string;
        }>;
        totalCostUsd: number;
        totalTokens: number;
    }>;
    getPlan(planId: string): TELOSPlanContext | undefined;
    listPlans(): TELOSPlanContext[];
    getSentinel(): TokenSentinel;
}
//# sourceMappingURL=telosOrchestrator.d.ts.map