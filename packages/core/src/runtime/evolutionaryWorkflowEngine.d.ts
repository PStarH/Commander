/**
 * EvolutionaryWorkflowEngine — Workflow self-evolution engine.
 *
 * Core engine that manages workflow evolution using genetic algorithms.
 * Types and subcomponents are extracted to separate modules for maintainability.
 */
import type { ExecutionExperience } from './types';
import type { EvolutionConfig, EvolutionResult, EvolutionOptions } from './evolutionaryWorkflowTypes';
export type { WorkflowNode, WorkflowEdge, WorkflowDAG } from './evolutionaryWorkflowTypes';
export type { EvolutionResult, EvolutionOptions, WorkflowScore } from './evolutionaryWorkflowTypes';
export { dagToTaskTree } from './dagConverter';
export declare class EvolutionaryWorkflowEngine {
    private population;
    private evaluator;
    private config;
    constructor(config?: Partial<EvolutionConfig>);
    saveToFile(filePath: string): void;
    loadFromFile(filePath: string): boolean;
    evolve(options: EvolutionOptions): Promise<EvolutionResult>;
    optimizeFromExperience(taskType: string, experiences: ExecutionExperience[]): Promise<EvolutionResult | null>;
    private evaluateDAG;
    private evaluateByHybrid;
    private evaluateByExecution;
    private generateWorkflowNodes;
    private extractToolsFromExperiences;
    private collectPopulationHistory;
}
export declare function getEvolutionEngine(config?: Partial<EvolutionConfig>): EvolutionaryWorkflowEngine;
export declare function resetEvolutionEngine(): void;
//# sourceMappingURL=evolutionaryWorkflowEngine.d.ts.map