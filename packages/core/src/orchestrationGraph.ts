/**
 * GraphWorkflow — DAG 编排模式
 *
 * 把步骤组织为有向无环图，独立分支自动并行，依赖分支按拓扑序串行。
 * 企业效率场景：软件构建、流水线编排、fan-out/fan-in、diamond 依赖。
 *
 * 设计要点（基于 LangGraph DAG + swarms GraphWorkflow best practice）：
 * - Kahn 算法分层：同层无依赖节点全部并发，层间串行
 * - 入口节点（无 dependencies）从 initialInput 取数据
 * - 非入口节点的 input = 依赖节点输出的聚合（数组/对象）
 * - 终端节点（无下游）的输出聚合为 finalOutput
 * - 失败隔离：默认 failFast=false，失败节点的下游标记 SKIPPED（依赖无法满足），
 *   但独立分支继续执行 — 这是与 Sequential 的关键差异
 */

import type {
  AnyStep,
  BaseOrchestrationConfig,
  ExecutionContext,
  OrchestrationRun,
  StepExecutor,
  StepResult,
} from './orchestrationPatterns';
import {
  computePatternMetrics,
  executeStepWithRetry,
  mergeTokenUsage,
  runWithConcurrencyLimit,
} from './orchestrationPatterns';

export interface GraphWorkflowConfig extends BaseOrchestrationConfig {
  /** 必填：图中的所有节点 */
  nodes: GraphNode[];
  /** 初始输入（喂给入口节点） */
  initialInput?: unknown;
  /**
   * 终端节点的输出如何聚合为 finalOutput。
   * - 'array'（默认）: 按节点声明顺序输出数组
   * - 'map': { [nodeId]: output }
   * - 'last': 最后完成的终端节点输出
   * - custom 函数
   */
  aggregateTerminal?: 'array' | 'map' | 'last' | ((terminalResults: StepResult[]) => unknown);
}

/**
 * 图节点 — 在 AnyStep 基础上允许显式声明 dependencies。
 * 与 swarms 的 Node(id, type, agent) 等价。
 */
export interface GraphNode extends AnyStep {
  /** 必填：上游依赖节点 id 列表（入口节点为空数组） */
  dependencies: string[];
}

/**
 * 图结构校验错误。
 */
export class GraphValidationError extends Error {
  constructor(
    message: string,
    public readonly code:
      'DUPLICATE_NODE_ID' | 'UNKNOWN_DEPENDENCY' | 'CYCLE_DETECTED' | 'NO_NODES',
  ) {
    super(message);
    this.name = 'GraphValidationError';
  }
}

/**
 * 校验 DAG 结构。失败则抛 GraphValidationError。
 */
export function validateGraph(nodes: GraphNode[]): void {
  if (nodes.length === 0) {
    throw new GraphValidationError('Graph has no nodes', 'NO_NODES');
  }
  const idSet = new Set<string>();
  for (const n of nodes) {
    if (idSet.has(n.id)) {
      throw new GraphValidationError(`Duplicate node id: ${n.id}`, 'DUPLICATE_NODE_ID');
    }
    idSet.add(n.id);
  }
  for (const n of nodes) {
    for (const dep of n.dependencies) {
      if (!idSet.has(dep)) {
        throw new GraphValidationError(
          `Node ${n.id} depends on unknown node ${dep}`,
          'UNKNOWN_DEPENDENCY',
        );
      }
    }
  }
  // 环检测：DFS + onStack
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const dfs = (id: string): void => {
    if (onStack.has(id)) {
      throw new GraphValidationError(`Cycle detected involving node ${id}`, 'CYCLE_DETECTED');
    }
    if (visited.has(id)) return;
    onStack.add(id);
    const n = nodeMap.get(id)!;
    for (const dep of n.dependencies) dfs(dep);
    onStack.delete(id);
    visited.add(id);
  };
  for (const n of nodes) dfs(n.id);
}

/**
 * Kahn 算法分层 — 返回每一层可并发的节点。
 * 入口（无依赖）为第 0 层，每往上一层的节点依赖至少一个下一层节点。
 */
export function topologicalLayers(nodes: GraphNode[]): GraphNode[][] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    inDegree.set(n.id, n.dependencies.length);
    dependents.set(n.id, []);
  }
  for (const n of nodes) {
    for (const dep of n.dependencies) {
      dependents.get(dep)!.push(n.id);
    }
  }
  const layers: GraphNode[][] = [];
  let currentLayer = nodes.filter((n) => inDegree.get(n.id) === 0);
  while (currentLayer.length > 0) {
    layers.push(currentLayer);
    const nextLayer: GraphNode[] = [];
    for (const n of currentLayer) {
      for (const depId of dependents.get(n.id) ?? []) {
        const d = inDegree.get(depId)! - 1;
        inDegree.set(depId, d);
        if (d === 0) nextLayer.push(nodeMap.get(depId)!);
      }
    }
    currentLayer = nextLayer;
  }
  return layers;
}

/**
 * 获取终端节点（无下游消费其输出）。
 */
export function findTerminalNodes(nodes: GraphNode[]): GraphNode[] {
  const referenced = new Set<string>();
  for (const n of nodes) {
    for (const dep of n.dependencies) referenced.add(dep);
  }
  return nodes.filter((n) => !referenced.has(n.id));
}

/**
 * 为节点构造输入：入口节点用 initialInput，否则聚合依赖节点输出。
 */
function buildNodeInput(
  node: GraphNode,
  initialInput: unknown,
  results: Map<string, StepResult>,
): unknown {
  if (node.dependencies.length === 0) {
    return initialInput;
  }
  // 把所有依赖节点的 output 收集为数组（保持 dependencies 声明顺序）
  const depOutputs = node.dependencies.map((depId) => results.get(depId)?.output);
  // 同时附 map 形式便于 inputTransform 取用
  const depMap: Record<string, unknown> = {};
  for (const depId of node.dependencies) {
    depMap[depId] = results.get(depId)?.output;
  }
  // 约定：单依赖直接传 output；多依赖传 { array, map }
  if (node.dependencies.length === 1) {
    return depOutputs[0];
  }
  return { array: depOutputs, map: depMap };
}

/**
 * 执行 DAG。
 *
 * @example diamond 模式
 * ```ts
 * const run = await runGraphWorkflow({
 *   projectId: 'p1',
 *   executor: myExecutor,
 *   initialInput: 'design spec',
 *   nodes: [
 *     { id: 'arch',  name: 'arch',  agentId: 'a1', objective: '...', dependencies: [] },
 *     { id: 'be1',   name: 'be1',   agentId: 'a2', objective: '...', dependencies: ['arch'] },
 *     { id: 'be2',   name: 'be2',   agentId: 'a3', objective: '...', dependencies: ['arch'] },
 *     { id: 'test',  name: 'test',  agentId: 'a4', objective: '...', dependencies: ['be1', 'be2'] },
 *   ],
 * });
 * // arch 先执行 → be1/be2 自动并行 → test 等两者完成
 * ```
 */
export async function runGraphWorkflow(config: GraphWorkflowConfig): Promise<OrchestrationRun> {
  const {
    nodes,
    initialInput,
    aggregateTerminal = 'array',
    projectId,
    executor,
    maxParallel = 8,
    failFast = false,
    timeoutMs,
    tokenBudget,
    abortSignal,
    metadata,
    onEvent,
  } = config;

  validateGraph(nodes);

  const runId = `graph-${projectId}-${Date.now()}`;
  const startedAtMs = Date.now();
  const startedAt = new Date().toISOString();
  const context: ExecutionContext = { runId, projectId, abortSignal, metadata };

  onEvent?.({ type: 'RUN_STARTED', pattern: 'graph', runId, projectId });

  const layers = topologicalLayers(nodes);
  const terminalNodes = findTerminalNodes(nodes);
  const terminalIds = new Set(terminalNodes.map((n) => n.id));

  const allResults = new Map<string, StepResult>();
  const failedIds = new Set<string>();
  const skippedIds = new Set<string>();
  let consumedTokens = 0;
  let budgetBreached = false;
  let peakConcurrency = 0;
  let currentlyActive = 0;

  // 全局超时
  const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;

  outer: for (const layer of layers) {
    if (abortSignal?.aborted) break;
    if (Date.now() >= deadline) break;

    // 跳过依赖已失败的节点（在 layer 内逐个判定）
    const runnable = layer.filter((node) => {
      if (skippedIds.has(node.id) || failedIds.has(node.id)) return false;
      const depFailed = node.dependencies.some((d) => failedIds.has(d) || skippedIds.has(d));
      if (depFailed) {
        const skipped: StepResult = {
          stepId: node.id,
          status: 'SKIPPED',
          error: 'upstream dependency failed or was skipped',
          durationMs: 0,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          retryCount: 0,
        };
        allResults.set(node.id, skipped);
        skippedIds.add(node.id);
        onEvent?.({
          type: 'STEP_SKIPPED',
          pattern: 'graph',
          runId,
          stepId: node.id,
          reason: 'upstream failed',
        });
        return false;
      }
      return true;
    });

    // 预算耗尽：本层及后续全 skip
    if (tokenBudget && tokenBudget > 0 && consumedTokens >= tokenBudget) {
      budgetBreached = true;
      for (const node of [...runnable, ...layers.flat().filter((n) => !allResults.has(n.id))]) {
        if (allResults.has(node.id)) continue;
        const skipped: StepResult = {
          stepId: node.id,
          status: 'SKIPPED',
          error: 'TOKEN_BUDGET_EXHAUSTED',
          durationMs: 0,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          retryCount: 0,
        };
        allResults.set(node.id, skipped);
        skippedIds.add(node.id);
        onEvent?.({
          type: 'STEP_SKIPPED',
          pattern: 'graph',
          runId,
          stepId: node.id,
          reason: 'token budget exhausted',
        });
      }
      break outer;
    }

    // 为本层可运行节点构造任务
    const tasks = runnable.map((node) => async (): Promise<StepResult> => {
      currentlyActive++;
      if (currentlyActive > peakConcurrency) peakConcurrency = currentlyActive;
      try {
        const input = buildNodeInput(node, initialInput, allResults);
        const result = await executeStepWithRetry(node, input, context, executor, onEvent, 'graph');
        if (result.tokenUsage) {
          consumedTokens = mergeTokenUsage(
            { promptTokens: consumedTokens, completionTokens: 0, totalTokens: consumedTokens },
            result.tokenUsage,
          ).totalTokens;
          if (tokenBudget && tokenBudget > 0 && consumedTokens >= tokenBudget) {
            budgetBreached = true;
          }
        }
        return result;
      } finally {
        currentlyActive--;
      }
    });

    const settled = await runWithConcurrencyLimit(tasks, maxParallel);
    for (let i = 0; i < runnable.length; i++) {
      const node = runnable[i];
      const s = settled[i];
      let result: StepResult;
      if (s.status === 'fulfilled') {
        result = s.value as StepResult;
      } else {
        result = {
          stepId: node.id,
          status: 'FAILURE',
          error: (s.reason as Error)?.message ?? 'unknown',
          errorClass: 'transient',
          durationMs: 0,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          retryCount: 0,
        };
      }
      allResults.set(node.id, result);
      if (result.status === 'FAILURE') {
        failedIds.add(node.id);
        if (failFast) {
          // 标记剩余所有节点为 SKIPPED 并退出
          for (const remaining of layers.flat()) {
            if (!allResults.has(remaining.id)) {
              allResults.set(remaining.id, {
                stepId: remaining.id,
                status: 'SKIPPED',
                error: 'fail-fast triggered',
                durationMs: 0,
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                retryCount: 0,
              });
              skippedIds.add(remaining.id);
            }
          }
          break outer;
        }
      }
    }
  }

  const orderedResults = nodes.map((n) => allResults.get(n.id)!).filter(Boolean);
  const terminalResults = terminalNodes
    .map((n) => allResults.get(n.id))
    .filter((r): r is StepResult => r !== undefined);

  // 聚合终端输出
  let finalOutput: unknown;
  if (typeof aggregateTerminal === 'function') {
    finalOutput = aggregateTerminal(terminalResults);
  } else if (aggregateTerminal === 'map') {
    finalOutput = Object.fromEntries(terminalResults.map((r) => [r.stepId, r.output]));
  } else if (aggregateTerminal === 'last') {
    finalOutput = terminalResults[terminalResults.length - 1]?.output;
  } else {
    // 'array'
    finalOutput = terminalResults.map((r) => r.output);
  }

  const successCount = orderedResults.filter((r) => r.status === 'SUCCESS').length;
  const failedCount = orderedResults.filter((r) => r.status === 'FAILURE').length;
  const skippedCount = orderedResults.filter((r) => r.status === 'SKIPPED').length;

  let status: OrchestrationRun['status'];
  if (abortSignal?.aborted) {
    status = 'CANCELLED';
  } else if (successCount === 0) {
    status = 'FAILED';
  } else if (failedCount > 0 || skippedCount > 0) {
    status = 'PARTIAL';
  } else {
    status = 'COMPLETED';
  }

  const completedAt = new Date().toISOString();
  const metrics = computePatternMetrics(
    orderedResults,
    startedAtMs,
    Date.now(),
    peakConcurrency,
    budgetBreached,
  );

  onEvent?.({ type: 'RUN_COMPLETED', pattern: 'graph', runId, status });

  return {
    pattern: 'graph',
    runId,
    projectId,
    status,
    stepResults: orderedResults,
    finalOutput,
    startedAt,
    completedAt,
    metrics,
  };
}

/**
 * Builder — 流式 API。
 */
export class GraphWorkflowBuilder {
  private nodes: GraphNode[] = [];
  private config: Omit<GraphWorkflowConfig, 'nodes' | 'executor'>;
  private executor?: StepExecutor;

  constructor(projectId: string) {
    this.config = { projectId, maxParallel: 8, failFast: false };
  }

  addNode(node: GraphNode): this {
    this.nodes.push(node);
    return this;
  }

  /** 便捷方法：声明节点 + 一条边 */
  addNodeWithDeps(
    id: string,
    deps: string[],
    partial: Omit<GraphNode, 'id' | 'dependencies'>,
  ): this {
    this.nodes.push({ id, dependencies: deps, ...partial });
    return this;
  }

  withInitialInput(input: unknown): this {
    this.config.initialInput = input;
    return this;
  }

  withAggregateTerminal(mode: NonNullable<GraphWorkflowConfig['aggregateTerminal']>): this {
    this.config.aggregateTerminal = mode;
    return this;
  }

  withMaxParallel(n: number): this {
    this.config.maxParallel = n;
    return this;
  }

  withFailFast(failFast: boolean): this {
    this.config.failFast = failFast;
    return this;
  }

  withTimeout(ms: number): this {
    this.config.timeoutMs = ms;
    return this;
  }

  withTokenBudget(budget: number): this {
    this.config.tokenBudget = budget;
    return this;
  }

  withAbortSignal(signal: AbortSignal): this {
    this.config.abortSignal = signal;
    return this;
  }

  withExecutor(executor: StepExecutor): this {
    this.executor = executor;
    return this;
  }

  withMetadata(metadata: Record<string, unknown>): this {
    this.config.metadata = metadata;
    return this;
  }

  withEventHandler(handler: GraphWorkflowConfig['onEvent']): this {
    this.config.onEvent = handler;
    return this;
  }

  async run(): Promise<OrchestrationRun> {
    if (!this.executor) {
      throw new Error('GraphWorkflowBuilder: executor is required (call withExecutor)');
    }
    return runGraphWorkflow({
      ...this.config,
      nodes: this.nodes,
      executor: this.executor,
    });
  }
}
