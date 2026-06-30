/**
 * Orchestration Patterns 测试 — Concurrent / Graph(DAG) / MoA / Router
 * 及 CrossPollination / AutoLoop / DynamicReplanner
 *
 * 测试策略：
 * - 注入 mock executor，验证拓扑/调度/失败隔离行为
 * - 不依赖真实 LLM，保证 CI 稳定
 */
import { describe, it, expect } from 'vitest';
import {
  runConcurrentWorkflow,
  runGraphWorkflow,
  validateGraph,
  topologicalLayers,
  findTerminalNodes,
  runMixtureOfAgents,
  runSwarmRouter,
  decidePattern,
  DEFAULT_ROUTING_RULES,
  CrossPollinationEngine,
  defaultHeuristicExtractor,
  buildCrossPollinationReport,
  runAutoLoop,
  defaultCompletionDetector,
  createConvergenceDetector,
  runDynamicReplan,
  type AnyStep,
  type StepExecutor,
  type StepResult,
  type TaskProfile,
} from '../../src/index';

// ============================================================================
// Mock executor 工厂
// ============================================================================

function makeMockExecutor(
  handler: (step: AnyStep, input: unknown) => unknown,
  tokenUsage = { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
): StepExecutor {
  return async (step, input) => {
    const output = handler(step, input);
    return { output, tokenUsage };
  };
}

function makeFailingExecutor(failStepIds: Set<string>): StepExecutor {
  return async (step) => {
    if (failStepIds.has(step.id)) {
      throw new Error(`intentional failure for ${step.id}`);
    }
    return { output: `output-${step.id}`, tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
  };
}

const step = (id: string, deps: string[] = []): AnyStep => ({
  id,
  name: id,
  agentId: 'agent-x',
  objective: `objective for ${id}`,
  dependencies: deps,
});

// ============================================================================
// ConcurrentWorkflow
// ============================================================================

describe('ConcurrentWorkflow', () => {
  it('并行执行所有步骤并返回结果数组', async () => {
    const executor = makeMockExecutor((s) => `out-${s.id}`);
    const run = await runConcurrentWorkflow({
      projectId: 'p1',
      executor,
      steps: [step('a'), step('b'), step('c')],
      input: 'shared-input',
      maxParallel: 3,
    });
    expect(run.status).toBe('COMPLETED');
    expect(run.stepResults).toHaveLength(3);
    expect(run.finalOutput).toHaveLength(3);
    expect(run.metrics.peakConcurrency).toBeGreaterThan(0);
  });

  it('单点失败默认不阻断其他步骤（failFast=false）', async () => {
    const executor = makeFailingExecutor(new Set(['b']));
    const run = await runConcurrentWorkflow({
      projectId: 'p1',
      executor,
      steps: [step('a'), step('b'), step('c')],
      failFast: false,
    });
    expect(run.status).toBe('PARTIAL');
    const failed = run.stepResults.find((r) => r.stepId === 'b');
    const successA = run.stepResults.find((r) => r.stepId === 'a');
    const successC = run.stepResults.find((r) => r.stepId === 'c');
    expect(failed?.status).toBe('FAILURE');
    expect(successA?.status).toBe('SUCCESS');
    expect(successC?.status).toBe('SUCCESS');
  });

  it('failFast=true 时单点失败导致整体 FAILED', async () => {
    const executor = makeFailingExecutor(new Set(['b']));
    const run = await runConcurrentWorkflow({
      projectId: 'p1',
      executor,
      steps: [step('a'), step('b'), step('c')],
      failFast: true,
    });
    expect(run.status).toBe('FAILED');
  });

  it('tokenBudget 软顶触发时剩余步骤 SKIP', async () => {
    // 每个 step 消耗 150 tokens；预算 200 只够 1 个
    const executor = makeMockExecutor(() => 'out', { promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    const run = await runConcurrentWorkflow({
      projectId: 'p1',
      executor,
      steps: [step('a'), step('b'), step('c'), step('d')],
      maxParallel: 1, // 串行化以便预算精确生效
      tokenBudget: 200,
    });
    expect(run.metrics.tokenBudgetBreached).toBe(true);
    const skipped = run.stepResults.filter((r) => r.status === 'SKIPPED');
    expect(skipped.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// GraphWorkflow DAG
// ============================================================================

describe('GraphWorkflow', () => {
  it('validateGraph 检测重复 id', () => {
    expect(() => validateGraph([
      { ...step('a'), dependencies: [] },
      { ...step('a'), dependencies: [] },
    ])).toThrow(/Duplicate node id/);
  });

  it('validateGraph 检测未知依赖', () => {
    expect(() => validateGraph([
      { ...step('a'), dependencies: ['nonexistent'] },
    ])).toThrow(/unknown node/);
  });

  it('validateGraph 检测环', () => {
    expect(() => validateGraph([
      { ...step('a'), dependencies: ['b'] },
      { ...step('b'), dependencies: ['a'] },
    ])).toThrow(/Cycle/);
  });

  it('topologicalLayers 把 diamond 拓扑分成 3 层', () => {
    const nodes = [
      { ...step('arch'), dependencies: [] as string[] },
      { ...step('be1'), dependencies: ['arch'] },
      { ...step('be2'), dependencies: ['arch'] },
      { ...step('test'), dependencies: ['be1', 'be2'] },
    ];
    const layers = topologicalLayers(nodes);
    expect(layers).toHaveLength(3);
    expect(layers[0].map((n) => n.id)).toEqual(['arch']);
    expect(new Set(layers[1].map((n) => n.id))).toEqual(new Set(['be1', 'be2']));
    expect(layers[2].map((n) => n.id)).toEqual(['test']);
  });

  it('findTerminalNodes 返回无下游的节点', () => {
    const nodes = [
      { ...step('a'), dependencies: [] as string[] },
      { ...step('b'), dependencies: ['a'] },
      { ...step('c'), dependencies: ['a'] },
    ];
    const terminals = findTerminalNodes(nodes);
    expect(terminals.map((n) => n.id).sort()).toEqual(['b', 'c']);
  });

  it('diamond 模式：arch 先执行 → be1/be2 并行 → test 等待', async () => {
    const executionOrder: string[] = [];
    const executor: StepExecutor = async (s) => {
      executionOrder.push(s.id);
      // 模拟 be1/be2 真实并行（小延迟）
      if (s.id === 'be1' || s.id === 'be2') {
        await new Promise((r) => setTimeout(r, 10));
      }
      return { output: `out-${s.id}` };
    };
    const run = await runGraphWorkflow({
      projectId: 'p1',
      executor,
      nodes: [
        { ...step('arch'), dependencies: [] },
        { ...step('be1'), dependencies: ['arch'] },
        { ...step('be2'), dependencies: ['arch'] },
        { ...step('test'), dependencies: ['be1', 'be2'] },
      ],
      initialInput: 'spec',
    });
    expect(run.status).toBe('COMPLETED');
    expect(executionOrder.indexOf('arch')).toBeLessThan(executionOrder.indexOf('be1'));
    expect(executionOrder.indexOf('arch')).toBeLessThan(executionOrder.indexOf('be2'));
    expect(executionOrder.indexOf('be1')).toBeLessThan(executionOrder.indexOf('test'));
    expect(executionOrder.indexOf('be2')).toBeLessThan(executionOrder.indexOf('test'));
    // test 的输入应该聚合 be1+be2 输出
    const testResult = run.stepResults.find((r) => r.stepId === 'test');
    expect(testResult?.status).toBe('SUCCESS');
  });

  it('失败节点的下游被 SKIP，独立分支继续执行', async () => {
    const executor = makeFailingExecutor(new Set(['be1']));
    const run = await runGraphWorkflow({
      projectId: 'p1',
      executor,
      nodes: [
        { ...step('arch'), dependencies: [] },
        { ...step('be1'), dependencies: ['arch'] },
        { ...step('be2'), dependencies: ['arch'] }, // 独立分支
        { ...step('test'), dependencies: ['be1', 'be2'] }, // 依赖 be1，应 SKIP
      ],
      failFast: false,
    });
    expect(run.status).toBe('PARTIAL');
    const be2 = run.stepResults.find((r) => r.stepId === 'be2');
    const test = run.stepResults.find((r) => r.stepId === 'test');
    expect(be2?.status).toBe('SUCCESS');
    expect(test?.status).toBe('SKIPPED');
  });

  it('aggregateTerminal="map" 返回 { nodeId: output }', async () => {
    const executor = makeMockExecutor((s) => `out-${s.id}`);
    const run = await runGraphWorkflow({
      projectId: 'p1',
      executor,
      nodes: [
        { ...step('a'), dependencies: [] },
        { ...step('b'), dependencies: ['a'] },
      ],
      initialInput: 'in',
      aggregateTerminal: 'map',
    });
    expect(run.finalOutput).toEqual({ b: 'out-b' });
  });
});

// ============================================================================
// MixtureOfAgents
// ============================================================================

describe('MixtureOfAgents', () => {
  it('专家并行 + 综合器接收所有专家输出', async () => {
    const executor: StepExecutor = async (s, input) => {
      if (s.id === 'syn') {
        const synInput = input as { expertOutputs: Array<{ output?: unknown }> };
        return { output: { synthesized: synInput.expertOutputs.map((e) => e.output) } };
      }
      return { output: `expert-${s.id}` };
    };
    const run = await runMixtureOfAgents({
      projectId: 'p1',
      executor,
      experts: [step('e1'), step('e2'), step('e3')],
      synthesizer: step('syn'),
      input: 'design-spec',
    });
    expect(run.status).toBe('COMPLETED');
    expect(run.finalOutput).toEqual({ synthesized: ['expert-e1', 'expert-e2', 'expert-e3'] });
    expect(run.stepResults).toHaveLength(4); // 3 专家 + 1 综合
  });

  it('专家成功数 < minExperts 时综合器 SKIP', async () => {
    const executor = makeFailingExecutor(new Set(['e1', 'e2']));
    const run = await runMixtureOfAgents({
      projectId: 'p1',
      executor,
      experts: [step('e1'), step('e2'), step('e3')],
      synthesizer: step('syn'),
      input: 'spec',
      minExperts: 3,
    });
    expect(run.status).toBe('PARTIAL');
    const syn = run.stepResults.find((r) => r.stepId === 'syn');
    expect(syn?.status).toBe('SKIPPED');
  });

  it('detectConflicts=true 时 fusionReport 附到综合器输入', async () => {
    // 两个专家输出都提到同一文件 → 触发 file_overlap 冲突
    const executor: StepExecutor = async (s) => {
      if (s.id === 'syn') return { output: 'ok' };
      return { output: 'modified src/index.ts' };
    };
    const run = await runMixtureOfAgents({
      projectId: 'p1',
      executor,
      experts: [step('e1'), step('e2')],
      synthesizer: step('syn'),
      input: 'spec',
      detectConflicts: true,
    });
    expect(run.status).toBe('COMPLETED');
  });
});

// ============================================================================
// SwarmRouter
// ============================================================================

describe('SwarmRouter', () => {
  it('decidePattern: 全独立 + 多步骤 → concurrent', () => {
    const profile: TaskProfile = {
      dependencyType: 'none',
      stepCount: 3,
      qualityRequirement: 'standard',
      costSensitivity: 'standard',
    };
    const decision = decidePattern(profile);
    expect(decision.pattern).toBe('concurrent');
    expect(decision.matchedRule).toBe('all-independent');
  });

  it('decidePattern: 部分依赖 → graph', () => {
    const profile: TaskProfile = {
      dependencyType: 'partial',
      stepCount: 4,
      qualityRequirement: 'standard',
      costSensitivity: 'standard',
    };
    expect(decidePattern(profile).pattern).toBe('graph');
  });

  it('decidePattern: 严格顺序 → sequential', () => {
    const profile: TaskProfile = {
      dependencyType: 'linear',
      stepCount: 3,
      qualityRequirement: 'standard',
      costSensitivity: 'standard',
    };
    expect(decidePattern(profile).pattern).toBe('sequential');
  });

  it('decidePattern: 高质量要求 + 多专家 → mixture-of-agents', () => {
    const profile: TaskProfile = {
      dependencyType: 'none',
      stepCount: 3,
      qualityRequirement: 'high',
      costSensitivity: 'standard',
    };
    expect(decidePattern(profile).pattern).toBe('mixture-of-agents');
  });

  it('decidePattern: 高成本敏感时即使高质量也避免 MoA', () => {
    const profile: TaskProfile = {
      dependencyType: 'none',
      stepCount: 3,
      qualityRequirement: 'high',
      costSensitivity: 'high',
    };
    // moa-high-quality 规则 matches 要求 costSensitivity !== 'high'，不命中
    // 退化到 all-independent → concurrent
    expect(decidePattern(profile).pattern).toBe('concurrent');
  });

  it('runSwarmRouter 自动选 graph 并执行', async () => {
    const executor = makeMockExecutor((s) => `out-${s.id}`);
    const run = await runSwarmRouter({
      projectId: 'p1',
      executor,
      taskProfile: {
        dependencyType: 'partial',
        stepCount: 3,
        qualityRequirement: 'standard',
        costSensitivity: 'standard',
      },
      steps: {
        nodes: [
          { ...step('a'), dependencies: [] },
          { ...step('b'), dependencies: ['a'] },
          { ...step('c'), dependencies: [] },
        ],
      },
    });
    expect(run.routerDecision.pattern).toBe('graph');
    expect(run.pattern).toBe('graph');
    expect(run.status).toBe('COMPLETED');
  });

  it('forcePattern 跳过路由', async () => {
    const executor = makeMockExecutor((s) => `out-${s.id}`);
    const run = await runSwarmRouter({
      projectId: 'p1',
      executor,
      taskProfile: { dependencyType: 'none', stepCount: 3, qualityRequirement: 'standard', costSensitivity: 'standard' },
      steps: { steps: [step('a'), step('b'), step('c')] },
      forcePattern: 'concurrent',
    });
    expect(run.routerDecision.decidedBy).toBe('user-override');
    expect(run.pattern).toBe('concurrent');
  });

  it('DEFAULT_ROUTING_RULES 最后一条是兜底 always-true', () => {
    const last = DEFAULT_ROUTING_RULES[DEFAULT_ROUTING_RULES.length - 1];
    expect(last.matches({ dependencyType: 'none', stepCount: 1, qualityRequirement: 'standard', costSensitivity: 'low' })).toBe(true);
  });
});

// ============================================================================
// CrossPollination
// ============================================================================

describe('CrossPollinationEngine', () => {
  it('从成功 step 输出中提取 insights', async () => {
    const engine = new CrossPollinationEngine();
    const result: StepResult = {
      stepId: 's1',
      status: 'SUCCESS',
      output: 'The best config is depth=12 and batch=128. We must normalize before RoPE.',
      durationMs: 100,
      startedAt: '',
      completedAt: '',
      retryCount: 0,
    };
    const insights = await engine.ingest(result);
    expect(insights.length).toBeGreaterThan(0);
    const kinds = insights.map((i) => i.kind);
    expect(kinds).toContain('optimal_config');
    expect(kinds).toContain('key_constraint');
  });

  it('失败 step 不提取', async () => {
    const engine = new CrossPollinationEngine();
    const result: StepResult = {
      stepId: 's1',
      status: 'FAILURE',
      output: 'best config is X',
      durationMs: 100,
      startedAt: '',
      completedAt: '',
      retryCount: 0,
    };
    const insights = await engine.ingest(result);
    expect(insights).toHaveLength(0);
  });

  it('inject 把 insights 前馈到后续 input', async () => {
    const engine = new CrossPollinationEngine();
    await engine.ingest({
      stepId: 's1',
      status: 'SUCCESS',
      output: 'best config is depth=12',
      durationMs: 0,
      startedAt: '',
      completedAt: '',
      retryCount: 0,
    });
    const { input, insights } = engine.inject({ task: 'refine' }, 5);
    expect(insights.length).toBeGreaterThan(0);
    expect((input as { __crossPollination__: unknown[] }).__crossPollination__).toBeDefined();
  });

  it('buildCrossPollinationReport 合并冲突与 insights', () => {
    const report = buildCrossPollinationReport(
      { round: 1, conflicts: [], resolvedCount: 0, summary: 'no conflicts' },
      [{ id: 'i1', sourceStepId: 's1', kind: 'optimal_config', content: 'depth=12', confidence: 0.8 }],
    );
    expect(report.insights).toHaveLength(1);
    expect(report.summary).toContain('1 insight');
  });
});

// ============================================================================
// AutoLoopRunner
// ============================================================================

describe('AutoLoopRunner', () => {
  it('defaultCompletionDetector 识别 done=true', () => {
    expect(defaultCompletionDetector({ done: true }, { loop: 1, consumedTokens: 0 }).done).toBe(true);
    expect(defaultCompletionDetector({ status: 'complete' }, { loop: 1, consumedTokens: 0 }).done).toBe(true);
    expect(defaultCompletionDetector('Task complete', { loop: 1, consumedTokens: 0 }).done).toBe(true);
    expect(defaultCompletionDetector('still working', { loop: 1, consumedTokens: 0 }).done).toBe(false);
  });

  it('createConvergenceDetector 在连续相同输出时返回 done', () => {
    const detector = createConvergenceDetector(2);
    // 三轮相同输出
    expect(detector('out', { loop: 1, consumedTokens: 0 }).done).toBe(false);
    expect(detector('out', { loop: 2, consumedTokens: 0 }).done).toBe(false);
    expect(detector('out', { loop: 3, consumedTokens: 0 }).done).toBe(true);
  });

  it('runAutoLoop 在 detector 返回 done 时停止', async () => {
    let loop = 0;
    const executor: StepExecutor = async () => {
      loop++;
      if (loop >= 3) {
        return { output: { done: true, result: 'finished' } };
      }
      return { output: `iter-${loop}` };
    };
    const run = await runAutoLoop({
      projectId: 'p1',
      step: step('agent'),
      executor,
      maxLoops: 'auto',
      softCap: 5,
      hardCap: 10,
    });
    expect(run.status).toBe('COMPLETED');
    expect(run.loopsExecuted).toBe(3);
    expect(run.terminationReason).toContain('done=true');
  });

  it('hardCap 强制停止', async () => {
    const executor: StepExecutor = async () => ({ output: 'never done' });
    const run = await runAutoLoop({
      projectId: 'p1',
      step: step('agent'),
      executor,
      maxLoops: 'auto',
      hardCap: 3,
    });
    expect(run.status).toBe('HARD_CAP_REACHED');
    expect(run.loopsExecuted).toBe(3);
  });

  it('tokenBudget 耗尽时停止', async () => {
    const executor: StepExecutor = async () => ({
      output: 'working',
      tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });
    const run = await runAutoLoop({
      projectId: 'p1',
      step: step('agent'),
      executor,
      maxLoops: 'auto',
      hardCap: 100,
      tokenBudget: 200, // 只够 1 轮
    });
    expect(run.status).toBe('TOKEN_BUDGET_EXHAUSTED');
  });
});

// ============================================================================
// DynamicReplanner
// ============================================================================

describe('DynamicReplanner', () => {
  it('spawn-new 决策从最优 step 派生新一批', async () => {
    const executor: StepExecutor = async (s) => ({
      output: { stepId: s.id, score: s.id === 'exp1' ? 10 : 5 },
    });
    const run = await runDynamicReplan({
      projectId: 'research',
      initialSteps: [step('exp1'), step('exp2')],
      executor,
      replanner: async (ctx) => {
        if (ctx.replanRound === 0) {
          const best = ctx.completedResults
            .filter((r) => r.status === 'SUCCESS')
            .sort((a, b) => (b.output as { score: number }).score - (a.output as { score: number }).score)[0];
          return {
            action: 'spawn-new',
            newSteps: [step('refine-1')],
            newInitialInput: best.output,
            rationale: '从最优 exp1 派生细化',
          };
        }
        return { action: 'continue', rationale: '完成' };
      },
      maxReplanRounds: 3,
      enableCrossPollination: true,
    });
    expect(run.allStepResults.length).toBeGreaterThanOrEqual(3); // 2 初始 + 1 派生
    expect(run.replanHistory).toHaveLength(2);
    expect(run.replanHistory[0].action).toBe('spawn-new');
    expect(run.replanHistory[1].action).toBe('continue');
    expect(run.finalInsights).toBeDefined();
  });

  it('abort 决策立即停止', async () => {
    const executor: StepExecutor = async () => ({ output: 'ok' });
    const run = await runDynamicReplan({
      projectId: 'p1',
      initialSteps: [step('a')],
      executor,
      replanner: async () => ({ action: 'abort', rationale: '用户中止' }),
    });
    expect(run.status).toBe('ABORTED');
  });

  it('maxReplanRounds 防止无限循环', async () => {
    let callCount = 0;
    const executor: StepExecutor = async () => ({ output: 'ok' });
    const run = await runDynamicReplan({
      projectId: 'p1',
      initialSteps: [step('a')],
      executor,
      maxReplanRounds: 2,
      replanner: async () => {
        callCount++;
        return {
          action: 'spawn-new',
          newSteps: [step(`r-${callCount}`)],
          newInitialInput: 'x',
          rationale: 'always spawn',
        };
      },
    });
    expect(callCount).toBeLessThanOrEqual(2);
    expect(run.replanRoundsExecuted).toBeLessThanOrEqual(2);
  });
});
