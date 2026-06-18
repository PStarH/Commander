/**
 * Task Complexity Analyzer
 * Based on ULTIMATE-FRAMEWORK.md design
 *
 * Core insight: Task complexity determines optimal orchestration mode
 * - Low complexity → Sequential (single agent)
 * - Medium complexity → Parallel (independent subtasks)
 * - High complexity → Handoff (expert delegation)
 * - Open exploration → Magentic (adaptive planning)
 * - High risk → Consensus (multi-model voting)
 */
export type ComplexityLevel = 'trivial' | 'simple' | 'moderate' | 'complex' | 'extreme';
export type OrchestrationMode = 'SEQUENTIAL' | 'PARALLEL' | 'HANDOFF' | 'MAGENTIC' | 'CONSENSUS';
export interface ComplexityScore {
    level: ComplexityLevel;
    score: number;
    factors: ComplexityFactors;
    recommendedMode: OrchestrationMode;
    tokenBudget: TokenBudget;
    confidence: number;
}
export interface ComplexityFactors {
    treewidth: number;
    dependencyDepth: number;
    inputSize: number;
    outputComplexity: number;
    domainKnowledge: number;
    riskLevel: number;
    uncertaintyLevel: number;
    timeConstraints: number;
}
export interface TokenBudget {
    leadAgent: number;
    specialistAgents: number;
    evaluation: number;
    overhead: number;
    total: number;
}
export interface Task {
    id: string;
    description: string;
    input?: string;
    context?: string;
    constraints?: string[];
    deadline?: Date;
    riskLevel?: 'low' | 'medium' | 'high' | 'critical';
}
export declare class TaskComplexityAnalyzer {
    private readonly WEIGHTS;
    /**
     * Analyze task complexity
     */
    analyze(task: Task): ComplexityScore;
    /**
     * Extract complexity factors from task
     */
    private extractFactors;
    /**
     * Estimate treewidth (dependency complexity)
     * Higher = more interdependent subtasks
     */
    private estimateTreewidth;
    /**
     * Estimate dependency depth
     * Higher = deeper chains of dependencies
     */
    private estimateDependencyDepth;
    /**
     * Estimate token count (approximate)
     */
    private estimateTokenCount;
    /**
     * Estimate output complexity
     */
    private estimateOutputComplexity;
    /**
     * Estimate domain knowledge needed
     */
    private estimateDomainKnowledge;
    /**
     * Estimate uncertainty level
     */
    private estimateUncertainty;
    /**
     * Estimate time pressure
     */
    private estimateTimePressure;
    /**
     * Risk level to number
     */
    private riskLevelToNumber;
    /**
     * Calculate raw complexity score (0-100)
     */
    private calculateRawScore;
    /**
     * Map score to complexity level
     */
    private scoreToLevel;
    /**
     * Select optimal orchestration mode
     */
    private selectOrchestrationMode;
    /**
     * Allocate token budget based on complexity and mode
     */
    private allocateTokenBudget;
    /**
     * Get base total budget based on complexity
     */
    private getBaseTotalBudget;
    /**
     * Calculate confidence in the analysis
     */
    private calculateConfidence;
}
export declare class BatchComplexityAnalyzer {
    private analyzer;
    constructor();
    /**
     * Analyze multiple tasks
     */
    analyzeBatch(tasks: Task[]): ComplexityScore[];
    /**
     * Get recommended orchestration for a batch
     */
    getBatchOrchestration(scores: ComplexityScore[]): {
        mode: OrchestrationMode;
        totalBudget: number;
        parallelGroups: number;
    };
}
//# sourceMappingURL=taskComplexityAnalyzer.d.ts.map