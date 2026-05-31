/**
 * EvolutionaryWorkflowEngine — Workflow self-evolution engine.
 *
 * Core engine that manages workflow evolution using genetic algorithms.
 * Types and subcomponents are extracted to separate modules for maintainability.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentExecutionContext, AgentExecutionResult, ExecutionExperience } from './types';
import type { TaskTreeNode } from '../ultimate/types';
import { getMetaLearner } from '../selfEvolution/metaLearner';
import { getGlobalReflectionEngine } from '../reflectionEngine';
import { getGlobalLogger } from '../logging';
import type { WorkflowNode, WorkflowDAG, EvolutionConfig, EvolutionResult, EvolutionOptions, WorkflowScore } from './evolutionaryWorkflowTypes';
import { DEFAULT_EVOLUTION_CONFIG } from './evolutionaryWorkflowTypes';
import { WorkflowPopulation } from './workflowPopulation';
import { dagToTaskTree } from './dagConverter';

// Re-export for backward compatibility
export type { WorkflowNode, WorkflowEdge, WorkflowDAG } from './evolutionaryWorkflowTypes';
export type { EvolutionResult, EvolutionOptions, WorkflowScore } from './evolutionaryWorkflowTypes';
export { dagToTaskTree } from './dagConverter';

// ============================================================================
// Workflow evaluator (internal)
// ============================================================================

class WorkflowEvaluator {
  constructor(public readonly config: import('./evolutionaryWorkflowTypes').WorkflowEvaluatorConfig = {}) {}

  evaluateFromHistory(dag: WorkflowDAG, experiences: ExecutionExperience[]): WorkflowScore {
    const relevant = experiences.filter(
      e => e.taskType === dag.taskType || dag.taskType === 'general'
    );

    if (relevant.length === 0) {
      const nodeCount = dag.nodes.length;
      const avgModelCost = dag.nodes.reduce((sum, n) => {
        const tierCost = n.modelTier === 'eco' ? 1 : n.modelTier === 'standard' ? 3 : 10;
        return sum + tierCost;
      }, 0) / nodeCount;

      return {
        overall: Math.max(0, 1 - avgModelCost / 20 - (nodeCount - 2) * 0.05),
        quality: 0.5,
        cost: Math.max(0, 1 - avgModelCost / 15),
        speed: Math.max(0, 1 - nodeCount * 0.1),
        reliability: 0.5,
      };
    }

    const avgSuccessRate = relevant.reduce((sum, e) => sum + (e.success ? 1 : 0), 0) / relevant.length;
    const avgDuration = relevant.reduce((sum, e) => sum + e.durationMs, 0) / relevant.length;
    const avgTokenCost = relevant.reduce((sum, e) => sum + e.tokenCost, 0) / relevant.length;

    const qualityScore = avgSuccessRate;
    const costScore = Math.max(0, 1 - avgTokenCost / 100000);
    const speedScore = Math.max(0, 1 - avgDuration / 60000);
    const reliability = avgSuccessRate;

    const cw = this.config.costWeight ?? 0.3;
    const qw = this.config.qualityWeight ?? 0.4;
    const sw = this.config.speedWeight ?? 0.15;
    const rw = 1 - cw - qw - sw;

    const overall = qw * qualityScore + cw * costScore + sw * speedScore + rw * reliability;

    return {
      overall: Math.min(1, Math.max(0, overall)),
      quality: qualityScore,
      cost: costScore,
      speed: speedScore,
      reliability,
    };
  }
}

// ============================================================================
// Main engine
// ============================================================================

export class EvolutionaryWorkflowEngine {
  private population: WorkflowPopulation;
  private evaluator: WorkflowEvaluator;
  private config: EvolutionConfig;

  constructor(config?: Partial<EvolutionConfig>) {
    this.config = { ...DEFAULT_EVOLUTION_CONFIG, ...config };
    this.population = new WorkflowPopulation(this.config);
    this.evaluator = new WorkflowEvaluator();
  }

  saveToFile(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = {
      config: this.config,
      individuals: this.population['individualsAccessor'],
      generation: this.population['generationAccessor'],
      bestIndividual: this.population['bestIndividualAccessor'],
      fitnessHistory: this.population['fitnessHistory'],
    };
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }

  loadFromFile(filePath: string): boolean {
    try {
      if (!fs.existsSync(filePath)) return false;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      if (data.config) this.config = { ...this.config, ...data.config };
      if (data.individuals) this.population['individualsAccessor'] = data.individuals;
      if (data.generation !== undefined) this.population['generationAccessor'] = data.generation;
      if (data.bestIndividual) this.population['bestIndividualAccessor'] = data.bestIndividual;
      if (data.fitnessHistory) this.population['fitnessHistory'] = data.fitnessHistory;
      return true;
    } catch {
      getGlobalLogger().warn('EvolutionaryWorkflowEngine', 'Failed to load population state', { filePath });
      return false;
    }
  }

  async evolve(options: EvolutionOptions): Promise<EvolutionResult> {
    const { taskType, availableTools, existingTree, maxDurationSeconds = 300 } = options;
    const startTime = Date.now();

    const workflowNodes = this.generateWorkflowNodes(taskType, availableTools);

    if (existingTree) {
      this.population.initializeFromTaskTree(taskType, existingTree, workflowNodes);
    } else {
      this.population.initialize(taskType, workflowNodes);
    }

    const maxGenerations = options.generations ?? this.config.maxGenerations;
    const improvements: string[] = [];
    let previousBest = 0;

    for (let gen = 0; gen < maxGenerations; gen++) {
      if ((Date.now() - startTime) / 1000 > maxDurationSeconds) {
        improvements.push(`Timeout reached at generation ${gen}`);
        break;
      }

      let best: WorkflowDAG;
      try {
        best = await this.population.evolve(async (dag) => {
          return this.evaluateDAG(dag, availableTools, taskType);
        });
      } catch (err) {
        getGlobalLogger().error(
          'EvolutionaryWorkflowEngine',
          'Population evolution iteration failed',
          err instanceof Error ? err : new Error(String(err)),
          { generation: gen },
        );
        improvements.push(`Gen ${gen}: evolution error, using previous best`);
        const currentBest = this.population.getBest();
        if (!currentBest) throw new Error('Evolution failed: no viable individuals');
        best = currentBest;
      }

      const stats = this.population.getStats();

      if (stats.bestFitness > previousBest + 0.01) {
        improvements.push(
          `Gen ${gen}: New best fitness ${stats.bestFitness.toFixed(3)} ` +
          `(was ${previousBest.toFixed(3)})`
        );
        previousBest = stats.bestFitness;
      }

      if (stats.bestFitness >= this.config.minFitnessThreshold) {
        improvements.push(`Early termination at generation ${gen}: fitness target reached`);
        break;
      }
    }

    const finalBest = this.population.getBest()!;
    return {
      bestDag: finalBest,
      generations: this.population.getStats().generation,
      populationStats: this.collectPopulationHistory(),
      taskTree: dagToTaskTree(finalBest),
      improvements,
    };
  }

  async optimizeFromExperience(
    taskType: string,
    experiences: ExecutionExperience[],
  ): Promise<EvolutionResult | null> {
    const metaLearner = getMetaLearner();
    const reflections = getGlobalReflectionEngine();

    const taskExperiences = experiences.filter(e => e.taskType === taskType);
    if (taskExperiences.length < 3) return null;

    const stats = metaLearner.getStrategyPerformance();

    const bestStrategy = Array.from(stats.values())
      .sort((a, b) => b.successRate - a.successRate)[0];

    if (!bestStrategy || bestStrategy.totalRuns < 5) return null;

    const engine = new EvolutionaryWorkflowEngine({
      ...this.config,
      populationSize: Math.min(8, this.config.populationSize),
      maxGenerations: Math.min(20, this.config.maxGenerations),
    });

    return engine.evolve({
      taskType,
      availableTools: this.extractToolsFromExperiences(taskExperiences),
      generations: 10,
    });
  }

  private async evaluateDAG(
    dag: WorkflowDAG,
    availableTools: string[],
    taskType: string,
  ): Promise<number> {
    if (this.config.evaluationMethod === 'execution') {
      return this.evaluateByExecution(dag, availableTools);
    }
    return this.evaluateByHybrid(dag, availableTools, taskType);
  }

  private async evaluateByHybrid(
    dag: WorkflowDAG,
    availableTools: string[],
    taskType: string,
  ): Promise<number> {
    let score = 0.5;

    // O(n) edge counting: build adjacency counts, check for shared endpoints
    const endpointCounts = new Map<string, number>();
    for (const e of dag.edges) {
      endpointCounts.set(e.from, (endpointCounts.get(e.from) ?? 0) + 1);
      endpointCounts.set(e.to, (endpointCounts.get(e.to) ?? 0) + 1);
    }
    const hasParallelism = dag.edges.some(
      e => (endpointCounts.get(e.from) ?? 0) > 1 || (endpointCounts.get(e.to) ?? 0) > 1
    );
    if (hasParallelism) score += 0.1;

    const nodeCount = dag.nodes.length;
    if (nodeCount >= 2 && nodeCount <= 6) score += 0.15;

    const availableSet = new Set(availableTools);
    const usedTools = new Set(dag.nodes.flatMap(n => n.tools));
    const validTools = usedTools.size > 0 && [...usedTools].every(t => availableSet.has(t));
    if (validTools) score += 0.1;

    const tiers = new Set(dag.nodes.map(n => n.modelTier));
    if (tiers.size > 1) score += 0.05;

    const metaLearner = getMetaLearner();
    const strategy = `${dag.taskType}_${dag.nodes.length}node`;
    const scores = metaLearner.getStrategyScores(strategy);
    if (scores.length > 0) {
      const bestScore = scores[0].score;
      score = score * 0.6 + bestScore * 0.4;
    }

    return Math.min(1, Math.max(0, score));
  }

  private async evaluateByExecution(dag: WorkflowDAG, availableTools: string[]): Promise<number> {
    let score = 0.5;
    const nodeCount = dag.nodes.length;

    if (nodeCount >= 2 && nodeCount <= 8) score += 0.2;

    const edgeRatio = dag.edges.length / Math.max(1, nodeCount);
    if (edgeRatio >= 0.5 && edgeRatio <= 2) score += 0.1;

    const availableSet = new Set(availableTools);
    const allToolsValid = dag.nodes.every(n =>
      n.tools.length === 0 || n.tools.every(t => availableSet.has(t))
    );
    if (allToolsValid) score += 0.15;

    const tiers = new Set(dag.nodes.map(n => n.modelTier));
    if (tiers.size >= 2) score += 0.05;

    let parallelNodes = 0;
    for (const n of dag.nodes) {
      if (n.parallelizable) parallelNodes++;
    }
    if (parallelNodes >= Math.ceil(nodeCount / 2)) score += 0.1;

    return Math.min(1, Math.max(0, score));
  }

  private generateWorkflowNodes(taskType: string, availableTools: string[]): WorkflowNode[] {
    const nodes: WorkflowNode[] = [];

    nodes.push({
      id: `research-${taskType}`,
      type: 'agent',
      goal: `Research and gather information for the task`,
      tools: availableTools.filter(t => t.includes('search') || t.includes('fetch')),
      modelTier: 'standard',
      parallelizable: true,
      timeoutMs: 30000,
      maxRetries: 2,
    });

    nodes.push({
      id: `analyze-${taskType}`,
      type: 'agent',
      goal: `Analyze gathered information and synthesize insights`,
      tools: availableTools.filter(t => t.includes('memory') || t.includes('recall')),
      modelTier: 'power',
      parallelizable: false,
      timeoutMs: 60000,
      maxRetries: 2,
    });

    nodes.push({
      id: `execute-${taskType}`,
      type: 'agent',
      goal: `Execute the concrete actions based on analysis`,
      tools: availableTools.filter(t => !t.includes('search') && !t.includes('fetch')),
      modelTier: 'standard',
      parallelizable: true,
      timeoutMs: 45000,
      maxRetries: 3,
    });

    nodes.push({
      id: `verify-${taskType}`,
      type: 'agent',
      goal: `Verify results and ensure quality`,
      tools: availableTools.slice(0, 3),
      modelTier: 'power',
      parallelizable: false,
      timeoutMs: 30000,
      maxRetries: 1,
    });

    return nodes;
  }

  private extractToolsFromExperiences(experiences: ExecutionExperience[]): string[] {
    const tools = new Set<string>();
    for (const exp of experiences) {
      if (exp.toolsUsed) {
        exp.toolsUsed.forEach(t => tools.add(t));
      }
    }
    return [...tools];
  }

  private collectPopulationHistory(): Array<{ generation: number; bestFitness: number; avgFitness: number }> {
    const stats = this.population.getStats();
    return stats.fitnessHistory.map((fitness, generation) => ({
      generation,
      bestFitness: fitness,
      avgFitness: 0,
    }));
  }
}

import { createTenantAwareSingleton } from './tenantAwareSingleton';

let _evolutionConfig: Partial<EvolutionConfig> | undefined;

const evolutionEngineSingleton = createTenantAwareSingleton(() => new EvolutionaryWorkflowEngine(_evolutionConfig));

export function getEvolutionEngine(config?: Partial<EvolutionConfig>): EvolutionaryWorkflowEngine {
  if (config) _evolutionConfig = config;
  return evolutionEngineSingleton.get();
}

export function resetEvolutionEngine(): void {
  evolutionEngineSingleton.reset();
}