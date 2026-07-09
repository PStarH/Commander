/**
 * WorkflowPopulation — genetic algorithm population for workflow evolution.
 * Extracted from evolutionaryWorkflowEngine.ts to keep modules under 500 lines.
 */

import type { TaskTreeNode } from './types';
import type {
  WorkflowNode,
  WorkflowEdge,
  WorkflowDAG,
  EvolutionConfig,
} from './evolutionaryWorkflowTypes';
import { getGlobalLogger } from '../logging';

export class WorkflowPopulation {
  private individuals: WorkflowDAG[] = [];
  private generation = 0;
  private bestIndividual: WorkflowDAG | null = null;
  fitnessHistory: number[] = [];
  private config: EvolutionConfig;

  get individualsAccessor(): WorkflowDAG[] {
    return this.individuals;
  }
  set individualsAccessor(val: WorkflowDAG[]) {
    this.individuals = val;
  }
  get generationAccessor(): number {
    return this.generation;
  }
  set generationAccessor(val: number) {
    this.generation = val;
  }
  get bestIndividualAccessor(): WorkflowDAG | null {
    return this.bestIndividual;
  }
  set bestIndividualAccessor(val: WorkflowDAG | null) {
    this.bestIndividual = val;
  }

  constructor(config: EvolutionConfig) {
    this.config = config;
  }

  /**
   * Initialize the population — create random individuals from scratch.
   */
  initialize(taskType: string, availableNodes: WorkflowNode[]): void {
    this.individuals = [];
    this.generation = 0;

    for (let i = 0; i < this.config.populationSize; i++) {
      const dag = this.createRandomDAG(taskType, availableNodes, i);
      this.individuals.push(dag);
    }
  }

  /**
   * Initialize from an existing task tree.
   */
  initializeFromTaskTree(
    taskType: string,
    existingTree: TaskTreeNode,
    _availableNodes: WorkflowNode[],
  ): void {
    this.individuals = [];
    this.generation = 0;

    // Individual 1: faithful to the existing tree
    this.individuals.push(this.treeToDAG(existingTree, taskType, 0));

    // Individuals 2-n: mutated versions
    for (let i = 1; i < this.config.populationSize; i++) {
      const mutated = this.mutateDAG(this.individuals[0], i);
      this.individuals.push(mutated);
    }
  }

  /**
   * Run one evolution iteration.
   */
  async evolve(evaluateFn: (dag: WorkflowDAG) => Promise<number>): Promise<WorkflowDAG> {
    // Evaluate all individuals
    for (const individual of this.individuals) {
      if (individual.executionCount === 0) {
        try {
          individual.fitness = await evaluateFn(individual);
        } catch (err) {
          getGlobalLogger().warn('EvolutionaryWorkflowEngine', 'Individual evaluation failed', {
            error: (err as Error)?.message,
            individualId: individual.id,
          });
          individual.fitness = 0;
        }
      }
    }

    // Sort by fitness
    this.individuals.sort((a, b) => b.fitness - a.fitness);

    // Track best
    const currentBest = this.individuals[0];
    if (!this.bestIndividual || currentBest.fitness > this.bestIndividual.fitness) {
      this.bestIndividual = { ...currentBest };
    }

    if (this.fitnessHistory.length > 1000)
      this.fitnessHistory.splice(0, this.fitnessHistory.length - 1000);
    this.fitnessHistory.push(currentBest.fitness);

    // Check for stagnation
    const shouldRestart = this.checkStagnation();
    if (shouldRestart) {
      this.restartPopulation();
      return this.bestIndividual!;
    }

    // Check termination conditions
    if (
      this.generation >= this.config.maxGenerations ||
      currentBest.fitness >= this.config.minFitnessThreshold
    ) {
      return this.bestIndividual!;
    }

    // Selection + crossover + mutation
    const nextGeneration: WorkflowDAG[] = [];

    // Elitism — carry over top individuals
    const eliteCount = Math.max(
      1,
      Math.floor(this.config.elitismRate * this.config.populationSize),
    );
    for (let i = 0; i < eliteCount; i++) {
      nextGeneration.push({ ...this.individuals[i] });
    }

    // Produce offspring
    while (nextGeneration.length < this.config.populationSize) {
      const parent1 = this.selectParent();
      const parent2 = this.selectParent();

      let child: WorkflowDAG;
      if (Math.random() < this.config.crossoverRate) {
        child = this.crossover(parent1, parent2);
      } else {
        child = { ...parent1 };
      }

      if (Math.random() < this.config.mutationRate) {
        child = this.mutateDAG(child, nextGeneration.length);
      }

      child.generation = this.generation + 1;
      child.id = `dag-gen${child.generation}-${nextGeneration.length}`;
      nextGeneration.push(child);
    }

    this.individuals = nextGeneration;
    this.generation++;

    return this.bestIndividual!;
  }

  getBest(): WorkflowDAG | null {
    return this.bestIndividual ?? (this.individuals.length > 0 ? this.individuals[0] : null);
  }

  getStats() {
    const fitnesses = this.individuals.map((i) => i.fitness);
    return {
      generation: this.generation,
      populationSize: this.individuals.length,
      bestFitness: Math.max(...fitnesses),
      avgFitness: fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length,
      bestIndividual: this.bestIndividual,
      fitnessHistory: [...this.fitnessHistory],
    };
  }

  // ---- Private methods ----

  private createRandomDAG(taskType: string, nodes: WorkflowNode[], index: number): WorkflowDAG {
    const shuffled = [...nodes].sort(() => Math.random() - 0.5);
    const nodeCount = Math.max(2, Math.min(shuffled.length, 3 + Math.floor(Math.random() * 4)));
    const selected = shuffled.slice(0, nodeCount);

    const dag: WorkflowDAG = {
      id: `dag-${taskType}-${index}`,
      name: `workflow-${taskType}-v${index}`,
      nodes: selected,
      edges: [],
      fitness: 0,
      generation: 0,
      taskType,
      createdAt: new Date().toISOString(),
      executionCount: 0,
      avgDurationMs: 0,
      avgQualityScore: 0,
      avgTokenCost: 0,
    };

    // Create topologically sorted edges
    for (let i = 0; i < selected.length - 1; i++) {
      if (Math.random() < 0.3 && i + 2 < selected.length) {
        dag.edges.push({
          from: selected[i].id,
          to: selected[i + 2].id,
          weight: 0.5,
        });
      }
      dag.edges.push({
        from: selected[i].id,
        to: selected[i + 1].id,
        weight: 1,
      });
    }

    return dag;
  }

  private treeToDAG(tree: TaskTreeNode, taskType: string, index: number): WorkflowDAG {
    const nodes: WorkflowNode[] = [];
    const edges: WorkflowEdge[] = [];

    const traverse = (node: TaskTreeNode, parentId?: string) => {
      const wNode: WorkflowNode = {
        id: node.id,
        type: node.subtasks.length > 0 ? 'agent' : 'tool',
        goal: node.goal,
        tools: [],
        modelTier: 'standard',
        parallelizable: true,
        timeoutMs: 120000,
        maxRetries: 2,
      };
      nodes.push(wNode);

      if (parentId) {
        edges.push({ from: parentId, to: node.id, weight: 1 });
      }

      for (const sub of node.subtasks) {
        traverse(sub, node.id);
      }
    };

    traverse(tree);

    return {
      id: `dag-tree-${index}`,
      name: `workflow-from-tree-${index}`,
      nodes,
      edges,
      fitness: 0,
      generation: 0,
      taskType,
      createdAt: new Date().toISOString(),
      executionCount: 0,
      avgDurationMs: 0,
      avgQualityScore: 0,
      avgTokenCost: 0,
    };
  }

  private mutateDAG(dag: WorkflowDAG, index: number): WorkflowDAG {
    const mutated = structuredClone(dag);
    mutated.id = `dag-mutated-${index}`;

    const mutationType = Math.random();

    if (mutationType < 0.25) {
      // Add node
      if (mutated.nodes.length < 8) {
        const newNode: WorkflowNode = {
          id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: Math.random() < 0.5 ? 'agent' : 'tool',
          goal: `auto-generated-subtask-${Math.random().toString(36).slice(2, 8)}`,
          tools: [],
          modelTier: ['eco', 'standard', 'power'][Math.floor(Math.random() * 3)],
          parallelizable: Math.random() < 0.5,
          timeoutMs: 30000 + Math.floor(Math.random() * 60000),
          maxRetries: Math.floor(Math.random() * 3) + 1,
        };
        const insertPos = Math.floor(Math.random() * (mutated.nodes.length + 1));
        mutated.nodes.splice(insertPos, 0, newNode);

        if (insertPos > 0 && insertPos < mutated.nodes.length - 1) {
          mutated.edges.push({
            from: mutated.nodes[insertPos - 1].id,
            to: newNode.id,
            weight: 1,
          });
          mutated.edges.push({
            from: newNode.id,
            to: mutated.nodes[insertPos + 1].id,
            weight: 1,
          });
        }
      }
    } else if (mutationType < 0.5) {
      // Remove node
      if (mutated.nodes.length > 2) {
        const removeIdx = Math.floor(Math.random() * (mutated.nodes.length - 2)) + 1;
        const removedId = mutated.nodes[removeIdx].id;
        mutated.nodes.splice(removeIdx, 1);
        mutated.edges = mutated.edges.filter((e) => e.from !== removedId && e.to !== removedId);
      }
    } else if (mutationType < 0.7) {
      // Change model tier
      const nodeIdx = Math.floor(Math.random() * mutated.nodes.length);
      mutated.nodes[nodeIdx].modelTier = ['eco', 'standard', 'power'][
        Math.floor(Math.random() * 3)
      ];
    } else {
      // Add parallel edge
      if (mutated.nodes.length > 3) {
        const fromIdx = Math.floor(Math.random() * (mutated.nodes.length - 1));
        const toIdx =
          fromIdx + 1 + Math.floor(Math.random() * (mutated.nodes.length - fromIdx - 1));
        mutated.edges.push({
          from: mutated.nodes[fromIdx].id,
          to: mutated.nodes[Math.min(toIdx, mutated.nodes.length - 1)].id,
          weight: 0.3 + Math.random() * 0.5,
        });
      }
    }

    return mutated;
  }

  private crossover(parent1: WorkflowDAG, parent2: WorkflowDAG): WorkflowDAG {
    const childNodes: WorkflowNode[] = [];
    const childEdges: WorkflowEdge[] = [];

    const splitPoint = Math.floor(
      Math.random() * Math.min(parent1.nodes.length, parent2.nodes.length),
    );

    childNodes.push(...parent1.nodes.slice(0, splitPoint).map((n) => ({ ...n })));
    childNodes.push(...parent2.nodes.slice(splitPoint).map((n) => ({ ...n })));

    // Re-index
    const nodeIdMap = new Map<string, string>();
    childNodes.forEach((n, i) => {
      const newId = `node-crossover-${i}`;
      nodeIdMap.set(n.id, newId);
      n.id = newId;
    });

    // Merge edges
    for (const edge of [...parent1.edges, ...parent2.edges]) {
      const from = nodeIdMap.get(edge.from);
      const to = nodeIdMap.get(edge.to);
      if (from && to && from !== to) {
        childEdges.push({ from, to, weight: edge.weight });
      }
    }

    return {
      id: `dag-crossover-${Date.now()}`,
      name: `workflow-crossover`,
      nodes: childNodes,
      edges: childEdges,
      fitness: 0,
      generation: 0,
      taskType: parent1.taskType,
      createdAt: new Date().toISOString(),
      executionCount: 0,
      avgDurationMs: 0,
      avgQualityScore: 0,
      avgTokenCost: 0,
    };
  }

  private selectParent(): WorkflowDAG {
    // Tournament selection
    const tournamentSize = Math.min(3, this.individuals.length);
    const candidates = Array.from(
      { length: tournamentSize },
      () => this.individuals[Math.floor(Math.random() * this.individuals.length)],
    );
    return candidates.sort((a, b) => b.fitness - a.fitness)[0];
  }

  private checkStagnation(): boolean {
    if (this.fitnessHistory.length < this.config.stagnationGenerations + 1) return false;

    const recent = this.fitnessHistory.slice(-this.config.stagnationGenerations);
    const improvement = recent[recent.length - 1] - recent[0];
    return Math.abs(improvement) < 0.001;
  }

  private restartPopulation(): void {
    this.generation = 0;
    this.fitnessHistory = [];

    const best = this.bestIndividual ?? this.individuals[0];
    this.individuals = [];

    for (let i = 0; i < this.config.populationSize; i++) {
      if (i === 0) {
        this.individuals.push({ ...best, id: `dag-restart-${i}` });
      } else {
        this.individuals.push(this.mutateDAG(best, i));
      }
    }
  }
}
