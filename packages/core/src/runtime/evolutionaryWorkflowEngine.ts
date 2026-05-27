/**
 * EvolutionaryWorkflowEngine — 工作流自进化引擎
 *
 * 基于前沿研究成果：
 * - SEW (Self-Evolving Workflows, arXiv 2505.18646): 自动生成和优化多Agent工作流
 * - HyEvo (Hybrid Evolution, arXiv 2603.19639): 混合LLM+确定性节点的进化策略
 * - Polymath (arXiv 2508.02959): 动态层级工作流优化
 * - EvoMAS (arXiv 2605.08769): 执行时工作流构建
 *
 * 与Hermes的skill.md方案不同，本引擎的核心创新：
 * 1. 工作流 = DAG而非线性序列（支持并行/条件分支）
 * 2. 进化发生在执行后（offline），不影响当前执行延迟
 * 3. 使用Commander已有的Reflexion+MetaLearner基础设施
 * 4. 支持工作流拓扑+节点逻辑的联合优化
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  AgentExecutionContext,
  AgentExecutionResult,
  ExecutionExperience,
} from './types';
import type { OrchestrationTopology, TaskTreeNode, ROMARole } from '../ultimate/types';
import { getMetaLearner } from '../selfEvolution/metaLearner';
import { getGlobalReflectionEngine } from '../reflectionEngine';
import { getGlobalLogger } from '../logging';

// ============================================================================
// 工作流基因编码
// ============================================================================

/**
 * 工作流节点 — 代表一个子任务或工具调用
 */
export interface WorkflowNode {
  id: string;
  type: 'agent' | 'tool' | 'condition' | 'merge';
  goal: string;
  tools: string[];
  modelTier: string;
  parallelizable: boolean;
  timeoutMs: number;
  maxRetries: number;
}

/**
 * 工作流边 — 节点间的依赖关系
 */
export interface WorkflowEdge {
  from: string;
  to: string;
  condition?: string; // 条件分支的表达式
  weight: number;     // 边的权重（表示依赖强度）
}

/**
 * 工作流DAG — 完整的进化个体
 */
export interface WorkflowDAG {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  fitness: number;          // 适应度评分 [0-1]
  generation: number;       // 代数
  taskType: string;         // 适用的任务类型
  createdAt: string;
  lastEvaluatedAt?: string;
  executionCount: number;
  avgDurationMs: number;
  avgQualityScore: number;
  avgTokenCost: number;
}

// ============================================================================
// 进化参数
// ============================================================================

interface EvolutionConfig {
  populationSize: number;           // 种群大小
  maxGenerations: number;           // 最大代数
  mutationRate: number;             // 变异率
  crossoverRate: number;            // 交叉率
  elitismRate: number;              // 精英保留率
  minFitnessThreshold: number;      // 最小适应度阈值
  stagnationGenerations: number;    // 停滞代数（无改进则重启）
  evaluationMethod: 'simulation' | 'execution' | 'hybrid';
}

const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  populationSize: 10,
  maxGenerations: 50,
  mutationRate: 0.15,
  crossoverRate: 0.7,
  elitismRate: 0.2,
  minFitnessThreshold: 0.7,
  stagnationGenerations: 10,
  evaluationMethod: 'hybrid',
};

// ============================================================================
// 工作流种群
// ============================================================================

class WorkflowPopulation {
  private individuals: WorkflowDAG[] = [];
  private generation = 0;
  private bestIndividual: WorkflowDAG | null = null;
  private fitnessHistory: number[] = [];

  constructor(public readonly config: EvolutionConfig) {}

  /**
   * 初始化种群 — 从零或从已有经验中创建
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
   * 从已有任务树创建初始种群
   */
  initializeFromTaskTree(
    taskType: string,
    existingTree: TaskTreeNode,
    availableNodes: WorkflowNode[],
  ): void {
    this.individuals = [];
    this.generation = 0;

    // 个体1：忠实于现有树
    this.individuals.push(this.treeToDAG(existingTree, taskType, 0));

    // 个体2-n：变异版本
    for (let i = 1; i < this.config.populationSize; i++) {
      const mutated = this.mutateDAG(this.individuals[0], i);
      this.individuals.push(mutated);
    }
  }

  /**
   * 执行一次进化迭代
   */
  async evolve(evaluateFn: (dag: WorkflowDAG) => Promise<number>): Promise<WorkflowDAG> {
    // 评估所有个体
    for (const individual of this.individuals) {
      if (individual.executionCount === 0) {
        try {
          individual.fitness = await evaluateFn(individual);
        } catch (err) {
          getGlobalLogger().warn('EvolutionaryWorkflowEngine', 'Individual evaluation failed', { error: (err as Error)?.message, individualId: individual.id });
          individual.fitness = 0;
        }
      }
    }

    // 排序
    this.individuals.sort((a, b) => b.fitness - a.fitness);

    // 记录最佳
    const currentBest = this.individuals[0];
    if (!this.bestIndividual || currentBest.fitness > this.bestIndividual.fitness) {
      this.bestIndividual = { ...currentBest };
    }

    this.fitnessHistory.push(currentBest.fitness);

    // 检查停滞
    const shouldRestart = this.checkStagnation();
    if (shouldRestart) {
      this.restartPopulation();
      return this.bestIndividual!;
    }

    // 检查终止条件
    if (
      this.generation >= this.config.maxGenerations ||
      currentBest.fitness >= this.config.minFitnessThreshold
    ) {
      return this.bestIndividual!;
    }

    // 选择 + 交叉 + 变异
    const nextGeneration: WorkflowDAG[] = [];

    // 精英保留
    const eliteCount = Math.max(1, Math.floor(this.config.elitismRate * this.config.populationSize));
    for (let i = 0; i < eliteCount; i++) {
      nextGeneration.push({ ...this.individuals[i] });
    }

    // 产生后代
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

  /**
   * 获取当前最佳工作流
   */
  getBest(): WorkflowDAG | null {
    return this.bestIndividual ?? (this.individuals.length > 0 ? this.individuals[0] : null);
  }

  /**
   * 获取种群统计信息
   */
  getStats() {
    const fitnesses = this.individuals.map(i => i.fitness);
    return {
      generation: this.generation,
      populationSize: this.individuals.length,
      bestFitness: Math.max(...fitnesses),
      avgFitness: fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length,
      bestIndividual: this.bestIndividual,
      fitnessHistory: [...this.fitnessHistory],
    };
  }

  // ---- 私有方法 ----

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

    // 创建拓扑排序的边
    for (let i = 0; i < selected.length - 1; i++) {
      // 允许一定程度的并行性
      if (Math.random() < 0.3 && i + 2 < selected.length) {
        // 并行边
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
        timeoutMs: 60000,
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
    const mutated = JSON.parse(JSON.stringify(dag)) as WorkflowDAG;
    mutated.id = `dag-mutated-${index}`;

    const mutationType = Math.random();

    if (mutationType < 0.25) {
      // 添加节点
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

        // 更新边
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
      // 移除节点
      if (mutated.nodes.length > 2) {
        const removeIdx = Math.floor(Math.random() * (mutated.nodes.length - 2)) + 1;
        const removedId = mutated.nodes[removeIdx].id;
        mutated.nodes.splice(removeIdx, 1);
        mutated.edges = mutated.edges.filter(
          e => e.from !== removedId && e.to !== removedId
        );
      }
    } else if (mutationType < 0.7) {
      // 更改模型层级
      const nodeIdx = Math.floor(Math.random() * mutated.nodes.length);
      mutated.nodes[nodeIdx].modelTier = ['eco', 'standard', 'power'][Math.floor(Math.random() * 3)];
    } else {
      // 添加并行边
      if (mutated.nodes.length > 3) {
        const fromIdx = Math.floor(Math.random() * (mutated.nodes.length - 1));
        const toIdx = fromIdx + 1 + Math.floor(Math.random() * (mutated.nodes.length - fromIdx - 1));
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

    const splitPoint = Math.floor(Math.random() * Math.min(parent1.nodes.length, parent2.nodes.length));

    // Deep clone parent nodes to avoid mutating originals in the population
    childNodes.push(...parent1.nodes.slice(0, splitPoint).map(n => ({ ...n })));
    childNodes.push(...parent2.nodes.slice(splitPoint).map(n => ({ ...n })));

    // 重新索引
    const nodeIdMap = new Map<string, string>();
    childNodes.forEach((n, i) => {
      const newId = `node-crossover-${i}`;
      nodeIdMap.set(n.id, newId);
      n.id = newId;
    });

    // 合并边
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
    // 锦标赛选择
    const tournamentSize = Math.min(3, this.individuals.length);
    const candidates = Array.from(
      { length: tournamentSize },
      () => this.individuals[Math.floor(Math.random() * this.individuals.length)]
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

    // 基于最佳个体创建新种群
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

// ============================================================================
// 工作流评估器
// ============================================================================

interface WorkflowEvaluatorConfig {
  maxSimulationSteps?: number;
  costWeight?: number;       // 成本权重
  qualityWeight?: number;    // 质量权重
  speedWeight?: number;      // 速度权重
}

export interface WorkflowScore {
  overall: number;           // 综合评分 [0-1]
  quality: number;           // 质量评分
  cost: number;              // 成本评分
  speed: number;             // 速度评分
  reliability: number;       // 可靠性评分
}

class WorkflowEvaluator {
  constructor(public readonly config: WorkflowEvaluatorConfig = {}) {}

  /**
   * 基于历史执行数据评估工作流
   */
  evaluateFromHistory(dag: WorkflowDAG, experiences: ExecutionExperience[]): WorkflowScore {
    const relevant = experiences.filter(
      e => e.taskType === dag.taskType || dag.taskType === 'general'
    );

    if (relevant.length === 0) {
      // 没有历史数据，使用默认评估
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

    // 基于历史数据的统计
    const avgSuccessRate = relevant.reduce((sum, e) => sum + (e.success ? 1 : 0), 0) / relevant.length;
    const avgDuration = relevant.reduce((sum, e) => sum + e.durationMs, 0) / relevant.length;
    const avgTokenCost = relevant.reduce((sum, e) => sum + e.tokenCost, 0) / relevant.length;

    // 计算各维度分数
    const qualityScore = avgSuccessRate;
    const costScore = Math.max(0, 1 - avgTokenCost / 100000); // 归一化
    const speedScore = Math.max(0, 1 - avgDuration / 60000);   // 归一化到60s
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
// 工作流与TaskTreeNode的转换器
// ============================================================================

export function dagToTaskTree(dag: WorkflowDAG): TaskTreeNode {
if (dag.nodes.length === 0) {
     return {
       id: 'root',
       goal: 'empty',
       parentId: null,
       role: 'EXECUTOR' as ROMARole,
       isAtomic: true,
       status: 'PENDING' as const,
       subtasks: [],
       dependencies: [],
       context: {
         systemPrompt: '',
         availableTools: [],
         estimatedTokens: 0,
       },
     };
   }

// 拓扑排序
   const topoOrder = topologicalSort(dag);

   const buildNode = (workflowNode: WorkflowNode, index: number): TaskTreeNode => ({
     id: workflowNode.id,
     parentId: null,
     goal: workflowNode.goal,
     role: 'EXECUTOR' as ROMARole,
     isAtomic: true,
     status: 'PENDING' as const,
     subtasks: [],
     dependencies: dag.edges
       .filter(e => e.to === workflowNode.id)
       .map(e => e.from),
     context: {
       systemPrompt: `You are a task executor for: ${workflowNode.goal}`,
       availableTools: workflowNode.tools,
       estimatedTokens: 1000,
     },
   });

  // 递归构建树结构
  const nodes = topoOrder.map((wn, i) => buildNode(wn, i));

  // 构建层级关系
  for (const node of nodes) {
    const children = dag.edges
      .filter(e => e.from === node.id)
      .map(e => nodes.find(n => n.id === e.to))
      .filter(Boolean) as TaskTreeNode[];
    node.subtasks = children;
  }

  // 返回根节点
  const roots = nodes.filter(
    n => !dag.edges.some(e => e.to === n.id)
  );

  if (roots.length === 1) return roots[0];

// 多根节点 — 创建虚拟根
   return {
     id: 'root',
     goal: dag.name,
     parentId: null,
     role: 'EXECUTOR' as ROMARole,
     isAtomic: false,
     status: 'PENDING' as const,
     subtasks: roots,
     dependencies: [],
     context: {
       systemPrompt: `Root orchestrator for: ${dag.name}`,
       availableTools: [],
       estimatedTokens: 1000,
     },
   };
}

function topologicalSort(dag: WorkflowDAG): WorkflowNode[] {
  const visited = new Set<string>();
  const result: WorkflowNode[] = [];
  const nodeMap = new Map(dag.nodes.map(n => [n.id, n]));

  function visit(nodeId: string, stack: Set<string>) {
    if (visited.has(nodeId)) return;
    if (stack.has(nodeId)) return; // 环检测

    stack.add(nodeId);

    const outgoing = dag.edges.filter(e => e.from === nodeId);
    for (const edge of outgoing) {
      visit(edge.to, stack);
    }

    stack.delete(nodeId);
    visited.add(nodeId);
    const node = nodeMap.get(nodeId);
    if (node) result.push(node);
  }

  for (const node of dag.nodes) {
    visit(node.id, new Set());
  }

  return result.reverse();
}

// ============================================================================
// 主引擎
// ============================================================================

export interface EvolutionResult {
  bestDag: WorkflowDAG;
  generations: number;
  populationStats: Array<{
    generation: number;
    bestFitness: number;
    avgFitness: number;
  }>;
  taskTree: TaskTreeNode;
  improvements: string[];
}

export interface EvolutionOptions {
  taskType: string;
  availableTools: string[];
  existingTree?: TaskTreeNode;
  generations?: number;
  populationSize?: number;
  maxDurationSeconds?: number;
}

export class EvolutionaryWorkflowEngine {
  private population: WorkflowPopulation;
  private evaluator: WorkflowEvaluator;
  private config: EvolutionConfig;

  constructor(config?: Partial<EvolutionConfig>) {
    this.config = { ...DEFAULT_EVOLUTION_CONFIG, ...config };
    this.population = new WorkflowPopulation(this.config);
    this.evaluator = new WorkflowEvaluator();
  }

  /**
   * Save the current population state to a JSON file.
   * Enables crash recovery and workflow reuse across sessions.
   */
  saveToFile(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = {
      config: this.config,
      individuals: this.population['individuals'],
      generation: this.population['generation'],
      bestIndividual: this.population['bestIndividual'],
      fitnessHistory: this.population['fitnessHistory'],
    };
    // Atomic write: write to tmp then rename
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * Load a previously saved population state from a JSON file.
   * Returns true on success, false if the file does not exist or is corrupt.
   */
  loadFromFile(filePath: string): boolean {
    try {
      if (!fs.existsSync(filePath)) return false;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      // Restore config
      if (data.config) this.config = { ...this.config, ...data.config };
      // Restore population internals
      if (data.individuals) this.population['individuals'] = data.individuals;
      if (data.generation !== undefined) this.population['generation'] = data.generation;
      if (data.bestIndividual) this.population['bestIndividual'] = data.bestIndividual;
      if (data.fitnessHistory) this.population['fitnessHistory'] = data.fitnessHistory;
      return true;
    } catch {
      getGlobalLogger().warn('EvolutionaryWorkflowEngine', 'Failed to load population state', { filePath });
      return false;
    }
  }

  /**
   * 执行工作流进化过程
   */
  async evolve(options: EvolutionOptions): Promise<EvolutionResult> {
    const { taskType, availableTools, existingTree, maxDurationSeconds = 300 } = options;
    const startTime = Date.now();

    // 定义工作流节点
    const workflowNodes = this.generateWorkflowNodes(taskType, availableTools);

    // 初始化种群
    if (existingTree) {
      this.population.initializeFromTaskTree(taskType, existingTree, workflowNodes);
    } else {
      this.population.initialize(taskType, workflowNodes);
    }

    const maxGenerations = options.generations ?? this.config.maxGenerations;
    const improvements: string[] = [];
    let previousBest = 0;

    // 主进化循环
    for (let gen = 0; gen < maxGenerations; gen++) {
      // 超时检查
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

      // 提前终止
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

  /**
   * 根据历史经验优化现有工作流
   */
  async optimizeFromExperience(
    taskType: string,
    experiences: ExecutionExperience[],
  ): Promise<EvolutionResult | null> {
    const metaLearner = getMetaLearner();
    const reflections = getGlobalReflectionEngine();

    // 分析历史经验，找出模式
    const taskExperiences = experiences.filter(e => e.taskType === taskType);
    if (taskExperiences.length < 3) return null; // 数据不足

    const stats = metaLearner.getStrategyPerformance();

    // 检查是否有足够的数据进行优化
    const bestStrategy = Array.from(stats.values())
      .sort((a, b) => b.successRate - a.successRate)[0];

    if (!bestStrategy || bestStrategy.totalRuns < 5) return null;

    // 创建进化引擎并运行
    const engine = new EvolutionaryWorkflowEngine({
      ...this.config,
      populationSize: Math.min(8, this.config.populationSize), // 经验较少时减小种群
      maxGenerations: Math.min(20, this.config.maxGenerations),
    });

    return engine.evolve({
      taskType,
      availableTools: this.extractToolsFromExperiences(taskExperiences),
      generations: 10,
    });
  }

  // ---- 私有方法 ----

  private async evaluateDAG(
    dag: WorkflowDAG,
    availableTools: string[],
    taskType: string,
  ): Promise<number> {
    // 根据配置选择评估方法
    if (this.config.evaluationMethod === 'execution') {
      return this.evaluateByExecution(dag, availableTools);
    }

    // 默认使用混合评估
    return this.evaluateByHybrid(dag, availableTools, taskType);
  }

  private async evaluateByHybrid(
    dag: WorkflowDAG,
    availableTools: string[],
    taskType: string,
  ): Promise<number> {
    // 启发式评估：基于DAG结构质量的快速评分
    let score = 0.5; // 基础分

    // 结构质量
    const hasParallelism = dag.edges.some(
      e => dag.edges.filter(e2 => e2.from === e.from || e2.to === e.to).length > 1
    );
    if (hasParallelism) score += 0.1;

    // 节点数量适中
    const nodeCount = dag.nodes.length;
    if (nodeCount >= 2 && nodeCount <= 6) score += 0.15;

    // 工具选择合理性
    const usedTools = new Set(dag.nodes.flatMap(n => n.tools));
    const validTools = usedTools.size > 0 && [...usedTools].every(t => availableTools.includes(t));
    if (validTools) score += 0.1;

    // 模型层级多样性
    const tiers = new Set(dag.nodes.map(n => n.modelTier));
    if (tiers.size > 1) score += 0.05; // 适度的多样性

    // 基于MetaLearner的历史表现
    const metaLearner = getMetaLearner();
    const strategy = `${dag.taskType}_${dag.nodes.length}node`;
    const scores = metaLearner.getStrategyScores(strategy);
    if (scores.length > 0) {
      const bestScore = scores[0].score;
      score = score * 0.6 + bestScore * 0.4; // 混合历史数据
    }

    return Math.min(1, Math.max(0, score));
  }

  private async evaluateByExecution(dag: WorkflowDAG, availableTools: string[]): Promise<number> {
    let score = 0.5;
    const nodeCount = dag.nodes.length;

    if (nodeCount >= 2 && nodeCount <= 8) score += 0.2;

    const edgeRatio = dag.edges.length / Math.max(1, nodeCount);
    if (edgeRatio >= 0.5 && edgeRatio <= 2) score += 0.1;

    const allToolsValid = dag.nodes.every(n =>
      n.tools.length === 0 || n.tools.every(t => availableTools.includes(t))
    );
    if (allToolsValid) score += 0.15;

    const tiers = new Set(dag.nodes.map(n => n.modelTier));
    if (tiers.size >= 2) score += 0.05;

    const parallelNodes = dag.nodes.filter(n => n.parallelizable).length;
    if (parallelNodes >= Math.ceil(nodeCount / 2)) score += 0.1;

    return Math.min(1, Math.max(0, score));
  }

  private generateWorkflowNodes(taskType: string, availableTools: string[]): WorkflowNode[] {
    // 根据任务类型和可用工具生成候选节点
    const nodes: WorkflowNode[] = [];

    // 通用节点
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