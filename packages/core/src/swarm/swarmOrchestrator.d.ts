import type { LLMProvider } from '../runtime/types';
import type { SwarmConfig, SwarmResult } from './types';
export declare class SwarmOrchestrator {
    private provider;
    private config;
    private model;
    private fusionEngine;
    private rootNodes;
    private depth;
    private fusionReports;
    constructor(provider: LLMProvider, config?: Partial<SwarmConfig>, depth?: number);
    execute(goal: string): Promise<SwarmResult>;
    /**
     * FISSION: recursively decompose complex sub-goals into child SwarmOrchestrators.
     */
    private processFission;
    /**
     * Make continuation decision — same logic as GoalOrchestrator.
     */
    private makeDecision;
    private managerDecompose;
    private managerReview;
    private workerExecute;
    private criticEvaluate;
    private buildSwarmTree;
    private getPendingNodes;
    private applyReview;
    private buildSummary;
}
//# sourceMappingURL=swarmOrchestrator.d.ts.map