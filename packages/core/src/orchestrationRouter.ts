/**
 * SwarmRouter — 元编排：运行时按任务特征动态选择最优编排架构
 *
 * 企业效率的最大杠杆：让一个任务该并发却走了串行 = 浪费 token 与时间。
 * Router 接收任务特征（依赖度/并行度/成本敏感度/质量要求），输出最合适的
 * OrchestrationPattern，并委托给对应模式的执行函数。
 *
 * 设计要点（基于 swarms SwarmRouter + LangGraph supervisor + RouteGuard best practice）：
 * - 路由决策可由 heuristic（基于 TaskProfile 的规则）或 LLM（高级）给出
 * - 默认 heuristic 零成本、确定性、可审计；LLM 路由作为可选增强
 * - 路由决策记入 run.metadata.routerDecision，便于复盘与调优
 * - 支持路由覆盖（用户强制指定 pattern）— 用于已知最优场景
 */

import type {
  AnyStep,
  BaseOrchestrationConfig,
  OrchestrationRun,
  StepExecutor,
} from './orchestrationPatterns';
import type { GraphNode } from './orchestrationGraph';
import { runConcurrentWorkflow, type ConcurrentWorkflowConfig } from './orchestrationConcurrent';
import { runGraphWorkflow, type GraphWorkflowConfig } from './orchestrationGraph';
import { runMixtureOfAgents, type MixtureOfAgentsConfig } from './orchestrationMixture';

// ============================================================================
// 任务画像
// ============================================================================

/**
 * 任务画像 — Router 据此选 pattern。
 * 字段参考 Microsoft Azure AI Agent Design Patterns 的 task-decomposition 维度。
 */
export interface TaskProfile {
  /**
   * 步骤间是否有依赖关系。
   * - 'none': 全独立（→ concurrent）
   * - 'linear': 严格顺序（→ sequential）
   * - 'partial': 部分依赖、部分独立（→ graph）
   */
  dependencyType: 'none' | 'linear' | 'partial';
  /** 步骤数（专家数 / 节点数） */
  stepCount: number;
  /**
   * 质量要求 — 是否需要多视角综合以提升决策质量。
   * - 'standard': 单路足够
   * - 'high': 需要多专家综合（→ mixture-of-agents）
   */
  qualityRequirement: 'standard' | 'high';
  /**
   * 成本敏感度 — 影响并发上限与是否启用昂贵模式。
   * - 'low': 不在意成本，优先质量/速度
   * - 'standard': 平衡
   * - 'high': 严格控成本，避免冗余并行
   */
  costSensitivity: 'low' | 'standard' | 'high';
  /** 预估每步平均 token（影响 tokenBudget 软顶设置） */
  estimatedTokensPerStep?: number;
  /** 总 token 预算（来自上层 Commander tokenBudget） */
  totalTokenBudget?: number;
}

/**
 * Router 决策记录 — 写入 run.metadata 便于审计与调优。
 */
export interface RouterDecision {
  /** 选中的 pattern */
  pattern: OrchestrationRun['pattern'] | 'sequential';
  /** 决策来源 */
  decidedBy: 'heuristic' | 'llm' | 'user-override';
  /** 决策理由（人类可读） */
  reasoning: string;
  /** 命中的规则 id（heuristic 模式） */
  matchedRule?: string;
  /** 决策时的 TaskProfile 快照 */
  taskProfile: TaskProfile;
  /** 备选 pattern（若主选失败可降级） */
  fallback?: OrchestrationRun['pattern'] | 'sequential';
}

// ============================================================================
// 路由策略
// ============================================================================

/**
 * Heuristic 路由规则集 — 按优先级顺序评估，首条命中即返回。
 *
 * 规则设计依据（best practice）：
 * 1. 质量优先 + 多专家 → MoA（together.ai MoA 论文：多模型聚合显著提升质量）
 * 2. 严格顺序 → Sequential（无并行机会）
 * 3. 全独立 → Concurrent（最大吞吐）
 * 4. 部分依赖 → Graph DAG（自动并行独立分支）
 * 5. 默认兜底 → Sequential（最保守）
 *
 * 成本敏感度会调整：high 时避免 MoA（除非用户显式要求高质量），
 * 改用更便宜的模式。
 */
export interface RoutingRule {
  id: string;
  description: string;
  matches: (profile: TaskProfile) => boolean;
  decide: (profile: TaskProfile) => Pick<RouterDecision, 'pattern' | 'reasoning' | 'fallback'>;
}

export const DEFAULT_ROUTING_RULES: RoutingRule[] = [
  {
    id: 'moa-high-quality',
    description: '质量要求高且非高成本敏感 → 多专家综合',
    matches: (p) =>
      p.qualityRequirement === 'high' && p.costSensitivity !== 'high' && p.stepCount >= 2,
    decide: () => ({
      pattern: 'mixture-of-agents',
      reasoning:
        'high quality requirement with multiple experts → MixtureOfAgents synthesizes parallel expert outputs',
      fallback: 'concurrent',
    }),
  },
  {
    id: 'strict-sequential',
    description: '严格顺序依赖 → 串行',
    matches: (p) => p.dependencyType === 'linear',
    decide: () => ({
      pattern: 'sequential',
      reasoning: 'linear dependency chain → Sequential avoids wasted parallel slots',
      fallback: 'graph',
    }),
  },
  {
    id: 'all-independent',
    description: '全独立步骤 → 并发',
    matches: (p) => p.dependencyType === 'none' && p.stepCount >= 2,
    decide: () => ({
      pattern: 'concurrent',
      reasoning: 'all steps independent → ConcurrentWorkflow maximizes throughput',
      fallback: 'graph',
    }),
  },
  {
    id: 'partial-dependency',
    description: '部分依赖 → DAG 自动并行',
    matches: (p) => p.dependencyType === 'partial',
    decide: () => ({
      pattern: 'graph',
      reasoning:
        'partial dependencies → GraphWorkflow auto-parallels independent branches while respecting deps',
      fallback: 'sequential',
    }),
  },
  {
    id: 'single-step',
    description: '单步骤 → 退化为 sequential',
    matches: (p) => p.stepCount <= 1,
    decide: () => ({
      pattern: 'sequential',
      reasoning: 'single step → no orchestration overhead needed',
    }),
  },
  {
    id: 'default-fallback',
    description: '默认兜底 → 串行（最保守）',
    matches: () => true,
    decide: () => ({
      pattern: 'sequential',
      reasoning: 'no rule matched → Sequential as safe default',
    }),
  },
];

/**
 * LLM 路由器接口 — 可选增强。Commander 现有 LLM provider 可注入。
 */
export interface LLMRouter {
  (
    profile: TaskProfile,
    availableSteps: AnyStep[],
  ): Promise<Pick<RouterDecision, 'pattern' | 'reasoning'>>;
}

// ============================================================================
// Router 配置与执行
// ============================================================================

/**
 * 路由后的步骤集 — 用户必须提供对应 pattern 的步骤。
 * Router 只接受一组步骤，按选中 pattern 派发。
 */
export interface RoutedSteps {
  /** 通用步骤（concurrent/graph/sequential 用） */
  steps?: AnyStep[];
  /** 图节点（graph pattern 专用，dependencies 必填） */
  nodes?: GraphNode[];
  /** MoA 专家 */
  experts?: AnyStep[];
  /** MoA 综合器 */
  synthesizer?: AnyStep;
}

export interface SwarmRouterConfig extends BaseOrchestrationConfig {
  /** 必填：任务画像（决定路由） */
  taskProfile: TaskProfile;
  /** 必填：步骤集（按 pattern 取对应字段） */
  steps: RoutedSteps;
  /** 共享输入 */
  input?: unknown;
  /**
   * 强制 pattern — 用户显式指定时跳过路由。
   * 用于已知最优的场景。
   */
  forcePattern?: OrchestrationRun['pattern'] | 'sequential';
  /** 自定义路由规则（默认用 DEFAULT_ROUTING_RULES） */
  routingRules?: RoutingRule[];
  /** LLM 路由器（可选，未提供则只用 heuristic） */
  llmRouter?: LLMRouter;
  /** 是否启用 LLM 路由（默认 false — heuristic 零成本优先） */
  useLLMRouter?: boolean;
}

/**
 * 运行 SwarmRouter — 路由 + 委托。
 *
 * @example
 * ```ts
 * const run = await runSwarmRouter({
 *   projectId: 'p1',
 *   executor: myExecutor,
 *   taskProfile: {
 *     dependencyType: 'partial',
 *     stepCount: 4,
 *     qualityRequirement: 'standard',
 *     costSensitivity: 'standard',
 *   },
 *   steps: {
 *     nodes: [
 *       { id: 'a', name: 'a', agentId: 'x', objective: '...', dependencies: [] },
 *       { id: 'b', name: 'b', agentId: 'y', objective: '...', dependencies: ['a'] },
 *       { id: 'c', name: 'c', agentId: 'z', objective: '...', dependencies: [] },
 *     ],
 *     input: 'spec',
 *   },
 * });
 * // Router 自动选择 graph pattern，因为 dependencyType=partial
 * ```
 */
export async function runSwarmRouter(
  config: SwarmRouterConfig,
): Promise<OrchestrationRun & { routerDecision: RouterDecision }> {
  const {
    taskProfile,
    steps,
    input,
    forcePattern,
    routingRules = DEFAULT_ROUTING_RULES,
    llmRouter,
    useLLMRouter = false,
    projectId,
    executor,
    maxParallel,
    failFast,
    timeoutMs,
    tokenBudget,
    abortSignal,
    metadata,
    onEvent,
  } = config;

  // ============ 1. 路由决策 ============
  let decision: RouterDecision;
  if (forcePattern) {
    decision = {
      pattern: forcePattern,
      decidedBy: 'user-override',
      reasoning: 'pattern explicitly set by caller; routing skipped',
      taskProfile,
    };
  } else if (useLLMRouter && llmRouter) {
    const allSteps = [
      ...(steps.steps ?? []),
      ...(steps.nodes ?? []),
      ...(steps.experts ?? []),
      ...(steps.synthesizer ? [steps.synthesizer] : []),
    ];
    const llmDecision = await llmRouter(taskProfile, allSteps);
    decision = {
      ...llmDecision,
      decidedBy: 'llm',
      taskProfile,
    };
  } else {
    // heuristic — default-fallback 规则保证总会命中
    let heuristicDecision: RouterDecision | undefined;
    for (const rule of routingRules) {
      if (rule.matches(taskProfile)) {
        const r = rule.decide(taskProfile);
        heuristicDecision = {
          ...r,
          decidedBy: 'heuristic',
          matchedRule: rule.id,
          taskProfile,
        };
        break;
      }
    }
    decision = heuristicDecision ?? {
      pattern: 'sequential',
      decidedBy: 'heuristic',
      matchedRule: 'default-fallback',
      reasoning: 'no rule matched → Sequential',
      taskProfile,
    };
  }

  // ============ 2. 委托给对应 pattern ============
  const baseConfig = {
    projectId,
    executor,
    maxParallel,
    failFast,
    timeoutMs,
    tokenBudget,
    abortSignal,
    metadata: { ...metadata, routerDecision: decision },
    onEvent,
  };

  let run: OrchestrationRun;
  switch (decision.pattern) {
    case 'concurrent': {
      if (!steps.steps || steps.steps.length === 0) {
        throw new RouterConfigError(
          'concurrent pattern requires steps[]. Provide config.steps.steps.',
        );
      }
      run = await runConcurrentWorkflow({
        ...baseConfig,
        steps: steps.steps,
        input,
      } as ConcurrentWorkflowConfig);
      break;
    }
    case 'graph': {
      if (!steps.nodes || steps.nodes.length === 0) {
        throw new RouterConfigError(
          'graph pattern requires nodes[] with dependencies. Provide config.steps.nodes.',
        );
      }
      run = await runGraphWorkflow({
        ...baseConfig,
        nodes: steps.nodes,
        initialInput: input,
      } as GraphWorkflowConfig);
      break;
    }
    case 'mixture-of-agents': {
      if (!steps.synthesizer) {
        throw new RouterConfigError(
          'mixture-of-agents pattern requires synthesizer. Provide config.steps.synthesizer.',
        );
      }
      if (!steps.experts || steps.experts.length === 0) {
        throw new RouterConfigError(
          'mixture-of-agents pattern requires experts[]. Provide config.steps.experts.',
        );
      }
      run = await runMixtureOfAgents({
        ...baseConfig,
        experts: steps.experts,
        synthesizer: steps.synthesizer,
        input,
      } as MixtureOfAgentsConfig);
      break;
    }
    case 'sequential': {
      // Sequential 委托给现有 SequentialPipeline。
      // Router 只做拓扑判定，不重写 Sequential 执行器，避免重复实现。
      // 调用方拿到 pattern='sequential' 的 run，自行调用现有 runSequentialPipeline。
      // 这里我们返回一个轻量提示 run，避免循环依赖。
      run = {
        pattern: 'sequential',
        runId: `router-sequential-${projectId}-${Date.now()}`,
        projectId,
        status: 'COMPLETED',
        stepResults: [],
        finalOutput: {
          hint: 'delegate_to_sequential',
          steps: steps.steps ?? [],
          input,
        },
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        metrics: {
          totalSteps: 0,
          completedSteps: 0,
          failedSteps: 0,
          skippedSteps: 0,
          totalDurationMs: 0,
          totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          peakConcurrency: 0,
          stepDurationSumMs: 0,
          timeoutSteps: 0,
          retryCount: 0,
          tokenBudgetBreached: false,
        },
      };
      break;
    }
    default: {
      // 不应该到这里 — 'router' pattern 不可被路由到自身
      throw new RouterConfigError(
        `Router selected unsupported pattern: ${String(decision.pattern)}`,
      );
    }
  }

  return { ...run, routerDecision: decision };
}

/**
 * Router 配置错误。
 */
export class RouterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouterConfigError';
  }
}

/**
 * 便捷函数：仅做路由判定，不执行。
 * 用于审计、可观测性、dry-run。
 */
export function decidePattern(
  profile: TaskProfile,
  rules: RoutingRule[] = DEFAULT_ROUTING_RULES,
): RouterDecision {
  for (const rule of rules) {
    if (rule.matches(profile)) {
      const r = rule.decide(profile);
      return {
        ...r,
        decidedBy: 'heuristic',
        matchedRule: rule.id,
        taskProfile: profile,
      };
    }
  }
  return {
    pattern: 'sequential',
    decidedBy: 'heuristic',
    matchedRule: 'default-fallback',
    reasoning: 'no rule matched → Sequential',
    taskProfile: profile,
  };
}

/**
 * Builder。
 */
export class SwarmRouterBuilder {
  private config: Partial<SwarmRouterConfig> = {};
  private steps: RoutedSteps = {};

  constructor(projectId: string) {
    this.config = { projectId, routingRules: DEFAULT_ROUTING_RULES, useLLMRouter: false };
  }

  withTaskProfile(profile: TaskProfile): this {
    this.config.taskProfile = profile;
    return this;
  }

  withSteps(steps: AnyStep[]): this {
    this.steps.steps = steps;
    return this;
  }

  withNodes(nodes: GraphNode[]): this {
    this.steps.nodes = nodes;
    return this;
  }

  withExperts(experts: AnyStep[]): this {
    this.steps.experts = experts;
    return this;
  }

  withSynthesizer(synthesizer: AnyStep): this {
    this.steps.synthesizer = synthesizer;
    return this;
  }

  withInput(input: unknown): this {
    this.config.input = input;
    return this;
  }

  withForcePattern(pattern: NonNullable<SwarmRouterConfig['forcePattern']>): this {
    this.config.forcePattern = pattern;
    return this;
  }

  withLLMRouter(router: LLMRouter): this {
    this.config.llmRouter = router;
    this.config.useLLMRouter = true;
    return this;
  }

  withMaxParallel(n: number): this {
    this.config.maxParallel = n;
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
    this.config.executor = executor;
    return this;
  }

  withMetadata(metadata: Record<string, unknown>): this {
    this.config.metadata = metadata;
    return this;
  }

  withEventHandler(handler: SwarmRouterConfig['onEvent']): this {
    this.config.onEvent = handler;
    return this;
  }

  /** Dry-run：只返回决策不执行 */
  decide(): RouterDecision {
    if (!this.config.taskProfile) {
      throw new RouterConfigError('taskProfile is required (call withTaskProfile)');
    }
    return decidePattern(this.config.taskProfile, this.config.routingRules);
  }

  async run(): Promise<OrchestrationRun & { routerDecision: RouterDecision }> {
    if (!this.config.executor) {
      throw new RouterConfigError('executor is required (call withExecutor)');
    }
    if (!this.config.taskProfile) {
      throw new RouterConfigError('taskProfile is required (call withTaskProfile)');
    }
    return runSwarmRouter({
      projectId: this.config.projectId!,
      executor: this.config.executor,
      taskProfile: this.config.taskProfile,
      steps: this.steps,
      input: this.config.input,
      forcePattern: this.config.forcePattern,
      routingRules: this.config.routingRules,
      llmRouter: this.config.llmRouter,
      useLLMRouter: this.config.useLLMRouter,
      maxParallel: this.config.maxParallel,
      timeoutMs: this.config.timeoutMs,
      tokenBudget: this.config.tokenBudget,
      abortSignal: this.config.abortSignal,
      metadata: this.config.metadata,
      onEvent: this.config.onEvent,
    } as SwarmRouterConfig);
  }
}
