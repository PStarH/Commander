/**
 * WorkflowPopulation — genetic algorithm population for workflow evolution.
 * Extracted from evolutionaryWorkflowEngine.ts to keep modules under 500 lines.
 */
import type { TaskTreeNode } from './types';
import type { WorkflowNode, WorkflowDAG, EvolutionConfig } from './evolutionaryWorkflowTypes';
export declare class WorkflowPopulation {
    private individuals;
    private generation;
    private bestIndividual;
    fitnessHistory: number[];
    private config;
    get individualsAccessor(): WorkflowDAG[];
    set individualsAccessor(val: WorkflowDAG[]);
    get generationAccessor(): number;
    set generationAccessor(val: number);
    get bestIndividualAccessor(): WorkflowDAG | null;
    set bestIndividualAccessor(val: WorkflowDAG | null);
    constructor(config: EvolutionConfig);
    /**
     * Initialize the population — create random individuals from scratch.
     */
    initialize(taskType: string, availableNodes: WorkflowNode[]): void;
    /**
     * Initialize from an existing task tree.
     */
    initializeFromTaskTree(taskType: string, existingTree: TaskTreeNode, availableNodes: WorkflowNode[]): void;
    /**
     * Run one evolution iteration.
     */
    evolve(evaluateFn: (dag: WorkflowDAG) => Promise<number>): Promise<WorkflowDAG>;
    getBest(): WorkflowDAG | null;
    getStats(): {
        generation: number;
        populationSize: number;
        bestFitness: number;
        avgFitness: number;
        bestIndividual: WorkflowDAG | null;
        fitnessHistory: number[];
    };
    private createRandomDAG;
    private treeToDAG;
    private mutateDAG;
    private crossover;
    private selectParent;
    private checkStagnation;
    private restartPopulation;
}
//# sourceMappingURL=workflowPopulation.d.ts.map