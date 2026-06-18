/**
 * Commander Framework Integration
 * Phase 3: 将终极框架组件集成到现有 API
 */
import { AdaptiveOrchestrator } from './adaptiveOrchestrator';
import { TokenBudgetAllocator } from './tokenBudgetAllocator';
import { ThreeLayerMemory } from './threeLayerMemory';
import { ReflectionEngine } from './reflectionEngine';
import { ConsensusChecker } from './consensusCheck';
import { InspectorAgent } from './inspectorAgent';
import { Logger, MetricsCollector, getGlobalLogger, getGlobalMetrics } from './logging';
import type { OrchestrationMode } from './adaptiveOrchestrator';
export type { OrchestrationMode };
export { AdaptiveOrchestrator, TokenBudgetAllocator, ThreeLayerMemory, ReflectionEngine, ConsensusChecker, InspectorAgent, Logger, MetricsCollector, getGlobalLogger, getGlobalMetrics, };
export declare function initializeFramework(): void;
export declare function getFramework(): {
    orchestrator: AdaptiveOrchestrator;
    budgetAllocator: TokenBudgetAllocator;
    memory: ThreeLayerMemory;
    reflection: ReflectionEngine;
    consensus: ConsensusChecker;
    inspector: InspectorAgent;
    logger: Logger;
    metrics: MetricsCollector;
};
/**
 * Create an execution plan
 */
export declare function createExecutionPlan(tasks: Array<{
    id: string;
    description: string;
    priority?: 'low' | 'medium' | 'high' | 'critical';
}>, suggestedMode?: OrchestrationMode): {
    planId: string;
    mode: OrchestrationMode;
    tasks: number;
};
/**
 * Allocate budget for a task
 */
export declare function allocateBudget(mode: OrchestrationMode): {
    total: number;
    leadAgent: number;
    specialistAgents: number;
    overhead: number;
};
/**
 * Record memory in the framework
 */
export declare function recordMemory(content: string, layer: 'working' | 'episodic' | 'longterm', context?: string, importance?: number): {
    id: string;
    layer: import("./threeLayerMemory").MemoryLayer;
};
/**
 * Query framework memory
 */
export declare function queryMemory(options: {
    keywords?: string[];
    layer?: 'working' | 'episodic' | 'longterm';
    limit?: number;
}): {
    count: number;
};
/**
 * Start a reflection session
 */
export declare function startReflection(taskId: string): {
    sessionId: string;
};
/**
 * Complete a reflection session
 */
export declare function completeReflection(sessionId: string, outcome: 'success' | 'partial' | 'failure'): {
    sessionId: string;
    outcome: "success" | "partial" | "failure";
};
/**
 * Run consensus check
 */
export declare function runConsensusCheck(question: string, votes: Array<{
    modelId: string;
    modelName: string;
    decision: string;
    confidence: number;
    reasoning: string;
}>): {
    checkId: string;
    consensusLevel: import("./consensusCheck").ConsensusLevel | undefined;
    consensusScore: number | undefined;
    decision: string | undefined;
};
/**
 * Update component health
 */
export declare function updateComponentHealth(name: string, status: 'healthy' | 'degraded' | 'unhealthy', score: number): {
    name: string;
    status: "healthy" | "degraded" | "unhealthy";
    score: number;
};
/**
 * Run system inspection
 */
export declare function runInspection(): {
    overallStatus: "healthy" | "degraded" | "unhealthy";
    overallHealth: number;
    openIssues: number;
};
//# sourceMappingURL=frameworkIntegration.d.ts.map