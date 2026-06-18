# Commander Multi-Agent 优化方案

> 基于链路审计结果 + 行业最佳实践调研
> 目标：把 multi-agent 从「看起来很厉害」变成「真的比单 agent 划算」

---

## 0. 最佳实践调研摘要

| 实践 | 来源 | 核心思想 |
| :--- | :--- | :--- |
| **Per-sub-agent state isolation** | LangGraph 官方、AutoGen 0.4+ | 每次 `invoke` 使用新 `config` / `thread_id`；共享状态通过显式 reducer 合并，禁止跨 agent 共享 mutable state |
| **Router pattern (short-circuit)** | LangGraph 官方、Anthropic 工程博客 | 前置一个轻量 router agent，简单任务直接走单 agent 路径，跳过编排流水线 |
| **Pheromone / Thompson sampling** | 蚁群算法、Multi-Armed Bandit 文献 | 使用 Beta 分布后验做路由选择，每次成功/失败更新 α/β，Thompson sampling 兼顾探索与利用 |
| **Capability-based matching** | CrewAI、AutoGen | Agent registry 记录能力向量，任务到达时做语义匹配 + 成功率加权排序 |
| **Maker-Checker loop** | AutoGen、OpenAI 工程博客 | Maker 生成输出、Checker 按 rubric 评估，反馈循环直到通过质量门 |
| **Immutable state / Reducers** | LangGraph | 状态用 Pydantic/TypeScript type `extra: forbid` 严格约束，并发写入用 reducer（append/merge）而非覆盖 |

---

## 1. P0：并发子 Agent 状态隔离（最紧急）

### 问题

`SubAgentExecutor` 把所有子 agent 的 `runtime.execute(ctx)` 调用都发往**同一个 `AgentRuntime` 实例**。

`AgentRuntime` 内部有大量 per-run 可变状态：
- `promotedTools` — 幻觉门控制，后一个 agent 会覆盖前一个的
- `executedMutations` — 补偿/回滚列表，多 agent 混杂
- `runHandle` / `ledgerCtx` — 当前运行的 run 上下文
- `activeRuns` / `pausedRuns` — 全局计数器
- `geminiCache`、`semanticCache` — 缓存无隔离

### 最佳实践对标

LangGraph 的 `thread_id` 是隔离边界——每个子 agent 调用创建新 `thread_id`，状态不跨 thread 泄漏。AutoGen 0.4+ 的 `AssistantAgent` 每次 run 创建新的 `CancellationToken` 和内部 context。

### 修改方案

`SubAgentExecutor.executeAtomicNode()` 在调用 `this.runtime.execute(ctx)` 前，对每个子 agent **fork 一个独立的 AgentRuntime 实例**。父 runtime 只复制 providers 和 tools（无状态开销），子 runtime 拥有独立的 per-run mutable state。

### 修改前

```typescript
// subAgentExecutor.ts — executeAtomicNode()
// 当前：所有子 agent 共享同一个 this.runtime
execResult = await agentContext.run({ agentId: node.id, outputDir }, () =>
  this.runtime.execute(ctx),   // ← 同一个 AgentRuntime 实例！
);
```

### 修改后

```typescript
// subAgentExecutor.ts — executeAtomicNode()
// 修改：每个子 agent fork 独立 runtime，隔离 per-run state
const childRuntime = this.runtime.fork();  // ← 新增：fork 轻量子 runtime
execResult = await agentContext.run({ agentId: node.id, outputDir }, () =>
  childRuntime.execute(ctx),
);
```

### `AgentRuntime.fork()` 已存在，无需新增

```typescript
// agentRuntime.ts — 现有 fork() 实现（无需改动）
fork(): AgentRuntimeInterface {
  const child = new AgentRuntime(this.config, this.router, this.tenantProvider);
  for (const [name, provider] of this.providers) {
    child.registerProvider(name, provider);  // 共享 provider（无状态）
  }
  for (const [name, tool] of this.tools) {
    child.registerTool(name, tool);          // 共享 tool（无状态）
  }
  return child;  // child 拥有全新的 per-run mutable state
}
```

### 影响分析

| 维度 | 修改前 | 修改后 |
| :--- | :--- | :--- |
| `promotedTools` | 多 agent 竞争覆盖 | 每个 agent 独立 |
| `executedMutations` | 混杂，补偿误触发 | 每个 agent 独立 |
| `runHandle` | 后一个覆盖前一个 | 每个 agent 独立 |
| 并发安全性 | ❌ 不安全 | ✅ 安全 |
| 额外开销 | 0 | 每次 fork 创建 `new AgentRuntime()`（~1ms，构造函数本身不发起网络调用） |

---

## 2. P1：Negative-ROI 短路（简单任务跳过完整流水线）

### 问题

`UltimateOrchestrator.execute()` 对所有任务跑完整 10-phase 流水线——即使 `coordinationPolicy.ts` 的判断结果 `negativeRoi === true` 且 `fallbackTopology === 'SINGLE'`，代码仍然继续执行 Phase 4（decomposition）、Phase 5（team formation）、Phase 7（synthesis）、Phase 8（quality gates）、Phase 9（shadow mode）。

### 最佳实践对标

LangGraph 的 **Router pattern**：前端 router agent 判断任务复杂度后，简单任务走 `direct_response` 边直接跳到 `END` 节点，跳过所有编排逻辑。这是 LangGraph 官方推荐的第一级 agent 模式。

### 修改方案

在 Phase 3（Topology Routing）后插入短路判断：如果 `coordinationPolicy` 返回 `negativeRoi === true` 且 `fallbackTopology === 'SINGLE'`，直接走单 agent 执行，跳过 decomposition / team formation / synthesis / quality gates / shadow mode。

### 修改前

```typescript
// orchestrator.ts — execute() Phase 3→4 之间
// 当前：无论 coordinationPolicy 返回什么，都继续跑完整流水线
const topologyResult = this.topologyRouter.route(deliberation, taskDAG, undefined, tenantId);
const topology = params.topology ?? ... ;
ctx.topology = topology;

// Phase 4: Recursive Task Decomposition (无条件执行 ↓)
taskTree = this.atomizer.decompose(...);
```

### 修改后

```typescript
// orchestrator.ts — execute() Phase 3→4 之间
// 修改：Negative-ROI 时短路，直接走单 agent 执行
const topologyResult = this.topologyRouter.route(deliberation, taskDAG, undefined, tenantId);
const topology = params.topology ?? ... ;
ctx.topology = topology;

// ★ P1 新增：Negative-ROI 短路 ★
const shouldShortCircuit =
  topologyResult.coordination?.negativeRoi === true &&
  topologyResult.coordination?.fallbackTopology === 'SINGLE' &&
  !params.topology;  // 用户显式指定 topology 时不短路

if (shouldShortCircuit) {
  reasoning.push(`Short-circuit: negative ROI detected, using single-agent path`);
  emit('EXECUTION', 'Simple task — using single-agent path...');

  const result = await this.runtime.execute({
    agentId: params.agentId,
    projectId: params.projectId,
    goal: params.goal,
    contextData: params.contextData ?? {},
    availableTools: (params.contextData?.availableTools as string[]) ?? [],
    maxSteps: 20,
    tokenBudget: this.config.defaultBudget.hardCapTokens,
  });

  // Skip: decomposition, team formation, synthesis, quality gates, shadow mode
  return {
    id: execId,
    status: result.status === 'success' ? 'SUCCESS' : 'FAILED',
    summary: result.summary ?? '',
    synthesis: result.summary ?? '',
    artifacts: [],
    executionTree: [],
    metrics: { ...zeroMetrics, totalTokens: result.totalTokenUsage?.totalTokens ?? 0 },
    errors: result.error ? [{ nodeId: 'root', agentId: params.agentId, message: result.error, recovered: false }] : [],
    reasoning,
  };
}

// Phase 4: Recursive Task Decomposition (仅非短路时执行)
taskTree = this.atomizer.decompose(...);
```

### 影响分析

| 维度 | 修改前 | 修改后 |
| :--- | :--- | :--- |
| 简单任务 token 消耗 | 全流水线 ~5000 token | 单 agent ~800 token |
| 简单任务延迟 | deliberation + decompose + synthesis + shadow | 单 agent 直通 |
| Shadow mode 额外开销 | 固定 +10000 token | 简单任务 0 |
| Quality fix loop | 最多 2 次 × 2000 token | 简单任务 0 |

---

## 3. P1：Shadow Mode 配置开关

### 问题

`shadow mode` 在 `orchestrator.ts:630-678` 无条件执行——每次跑完主流程都额外调一次 `runtime.execute`（只读工具、maxSteps=3、tokenBudget=10000）。这是固定的一笔额外成本。

### 修改方案

在 `UltimateOrchestratorConfig` 中增加 `enableShadowMode` 字段（默认 `false`），orchestrator 在执行 shadow 前检查此开关。

### 修改前

```typescript
// orchestrator.ts:630
// 当前：无条件执行 shadow
const shadowStrategy = getMetaLearner().selectShadowStrategy(topology);
if (shadowStrategy) {
  const shadowExec = await this.runtime.execute({ ... });
  // ...
}
```

### 修改后

```typescript
// orchestrator.ts:630
// 修改：受 enableShadowMode 控制
if (this.config.enableShadowMode) {  // ← 新增开关
  const shadowStrategy = getMetaLearner().selectShadowStrategy(topology);
  if (shadowStrategy) {
    const shadowExec = await this.runtime.execute({ ... });
    // ...
  }
}
```

```typescript
// types.ts — DEFAULT_ULTIMATE_CONFIG 新增字段
export const DEFAULT_ULTIMATE_CONFIG: UltimateOrchestratorConfig = {
  // ... 现有字段 ...
  enableShadowMode: false,  // ← 新增，默认关闭
};

// types.ts — UltimateOrchestratorConfig interface 新增字段
export interface UltimateOrchestratorConfig {
  // ... 现有字段 ...
  enableShadowMode: boolean;  // ← 新增
}
```

---

## 4. P1：Pheromone 学习闭环（反馈回路接通）

### 问题

`orchestrator.ts` 已经有一段「闭环」代码（行 ~740-760），在执行结束后调用 `pheromoneRouter.recordOutcomeFor()` 和 `learnedWeights.recordSignal()`。**但这段代码位于 `Phase 7.5` 和 `Phase 8` 中间**——如果执行在 quality gate fix loop 中失败（`throw` 到 catch），则不会执行到这段反馈代码。

另外，`coordinationPolicy.ts` 中的 `evaluateCoordinationPolicy()` 已经接受 `learnedWeights` 参数来做 ROI 阈值调整、耦合度推理、breadth_gain 学习，但目前 `learnedWeights` 传入后只有初始默认值（因为 `recordSignal` 的调用在 `recordCoordinationWeight` 中没有被调用）。

### 修改方案

1. 将 Pheromone/LearnedWeights 的 `recordOutcomeFor` / `recordSignal` 调用移到 `finally` 块中，确保无论成功失败都会执行。
2. 在 `evaluateCoordinationPolicy` 调用后，将实际观察到的 coupling、gain 等值通过 `learnedWeights.recordCoordinationWeight()` 写回，实现真正的坐标权重学习闭环。

### 修改前

```typescript
// orchestrator.ts — execute() 中反馈代码的位置
// 当前：在 try 块中，如果中途异常则跳过
try {
  // Phase 7 ...
  // Phase 8 quality gates ...
  
  // 反馈代码（仅在正常路径执行）
  this.topologyRouter.getPheromoneRouter().recordOutcomeFor(...);
  this.topologyRouter.getLearnedWeights().recordSignal(...);
} finally {
  this.activeExecutions.delete(execId);
}
```

### 修改后

```typescript
// orchestrator.ts — execute()
// 修改：反馈代码移到 finally 中，always-run
let learningFeedbackDone = false;
try {
  // Phase 7-8 ...
  learningFeedbackDone = true;
} finally {
  // ★ P1：无论如何都执行学习反馈 ★
  if (learningFeedbackDone || true) {
    try {
      const actualSuccess = errors.every(e => e.recovered);
      this.topologyRouter.getPheromoneRouter().recordOutcomeFor(
        tenantId ?? '__default__',
        deliberation.taskType,
        topology,
        actualSuccess,
        finalQualityScore,
      );
      this.topologyRouter.getLearnedWeights().recordSignal(
        deliberation.taskType,
        topology,
        actualSuccess,
        finalQualityScore,
        tenantId,
      );
      // ★ 新增：将实际观察到的耦合度和 gain 写回坐标权重 ★
      if (topologyResult.coordination) {
        this.topologyRouter.getLearnedWeights().recordCoordinationWeight(
          'coupling',
          deliberation.taskType,
          topologyResult.coordination.overhead.coupling,
          tenantId,
        );
        this.topologyRouter.getLearnedWeights().recordCoordinationWeight(
          'breadth_gain',
          deliberation.taskType,
          topologyResult.coordination.gain.coverageGain,
          tenantId,
        );
      }
    } catch {
      /* best-effort */
    }
  }
  this.activeExecutions.delete(execId);
}
```

---

## 5. P1：CapabilityRegistry 接入团队组建

### 问题

`orchestrator.ts:363-371` 组队时角色按索引硬编码：
```typescript
role: i === 0 ? 'LEAD' : i % 2 === 0 ? 'RESEARCHER' : 'CODER'
```

没有利用 `CapabilityRegistry.findBestMatch()` 的能力匹配结果。agent 不按真实能力分配任务。

### 修改方案

在 Phase 5（Team Formation）中，对每个子任务调用 `capabilityRegistry.findBestMatch()` 查找最佳 agent，将匹配结果映射到角色。

### 修改前

```typescript
// orchestrator.ts:363-371
// 当前：硬编码角色分配
const members = taskTree.subtasks.map((sub, i) => ({
  agentId: sub.id,
  role: i === 0 ? ('LEAD' as const)
    : i % 2 === 0 ? ('RESEARCHER' as const)
    : ('CODER' as const),
  capabilities: sub.context.availableTools,
  status: 'IDLE' as const,
}));
```

### 修改后

```typescript
// orchestrator.ts:363-371
// 修改：基于 CapabilityRegistry 能力匹配分配角色
const members = taskTree.subtasks.map((sub, i) => {
  // 查找最匹配此子任务能力的 agent
  const requiredCaps = sub.context.availableTools ?? [];
  const matches = this.capabilityRegistry.findBestMatch(requiredCaps, {
    minSuccessRate: 0.3,  // 最低成功率阈值
  });

  // 根据能力匹配结果推断角色
  let role: TeamMember['role'] = 'SPECIALIST';  // 默认
  if (i === 0) {
    role = 'LEAD';  // 第一个永远是 lead
  } else if (matches.length > 0) {
    const best = matches[0];
    const caps = best.vector.capabilities.map(c => c.name.toLowerCase());
    if (caps.some(c => c.includes('code') || c.includes('write') || c.includes('edit'))) {
      role = 'CODER';
    } else if (caps.some(c => c.includes('review') || c.includes('analyze'))) {
      role = 'REVIEWER';
    } else if (caps.some(c => c.includes('search') || c.includes('research') || c.includes('read'))) {
      role = 'RESEARCHER';
    }
  }

  return {
    agentId: sub.id,
    role,
    capabilities: sub.context.availableTools,
    status: 'IDLE' as const,
  };
});
```

---

## 6. P2：CLI/API 暴露用户控制参数

### 修改方案

在 CLI `commander run` 和 API `POST /orchestrator/execute` 中增加以下可选参数：

| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `--topology` | auto | 显式指定拓扑（SINGLE/SEQUENTIAL/PARALLEL/HIERARCHICAL/HYBRID/DEBATE/ENSEMBLE） |
| `--effort` | auto | 显式指定 effort level（SIMPLE/MODERATE/COMPLEX/DEEP_RESEARCH） |
| `--shadow` | false | 是否启用 shadow mode |
| `--quality-fix` | true | 是否启用 quality fix loop |
| `--max-sub-agents` | 10 | 最大子 agent 数量 |
| `--enable-teams` | true | 是否启用团队组建 |

### CLI 修改

```typescript
// cli/commands/core.ts — cmdRunInternal()
// 修改：支持新的 CLI flags
const shadowEnabled = 'shadow' in flags;
const qualityFixEnabled = flags['quality-fix'] !== 'false';
const maxSubAgents = flags['max-sub-agents'] ? parseInt(flags['max-sub-agents'], 10) : undefined;
const enableTeams = flags['enable-teams'] !== 'false';
const explicitTopology = flags.topology as OrchestrationTopology | undefined;
const explicitEffort = flags.effort as EffortLevel | undefined;

const orch = new UltimateOrchestrator(telos, rt, {
  enableShadowMode: shadowEnabled,
  maxParallelSubAgents: maxSubAgents ?? 10,
  enableTeams,
  // quality fix loop toggle 暂通过 config 控制
});
```

### API 修改

```typescript
// POST /orchestrator/execute body 新增字段
{
  "goal": "...",
  "topology": "HIERARCHICAL",     // 新增
  "effortLevel": "COMPLEX",        // 已有
  "enableShadow": true,            // 新增
  "enableQualityFix": false,       // 新增
  "maxSubAgents": 5,               // 新增
  "tools": [...]                   // 已有
}
```

---

## 7. 修改优先级与预估收益

| 优先级 | 修改项 | 改动文件数 | 预估节省 | 风险 |
| :--- | :--- | :--- | :--- | :--- |
| **P0** | 子 Agent 状态隔离 | 1（subAgentExecutor.ts） | **消灭并发正确性 bug** | 低（`fork()` 已存在） |
| **P1** | Negative-ROI 短路 | 1（orchestrator.ts） | 简单任务 ~80% token | 低（不影响复杂任务） |
| **P1** | Shadow mode 开关 | 2（orchestrator.ts + types.ts） | 每次执行 ~10000 token | 低（默认关闭） |
| **P1** | Pheromone 学习闭环 | 1（orchestrator.ts） | 长期 ~15% 拓扑准确率提升 | 低 |
| **P1** | Capability 组队 | 1（orchestrator.ts） | 子任务匹配准确率提升 | 中（依赖 registry 有数据） |
| **P2** | CLI/API 参数暴露 | 3（cli + api + orchestrator） | 用户体验提升 | 低 |

**总预估改动：~150 行代码，5 个文件。**

---

## 8. 修改顺序建议

```
第 1 步（P0）：subAgentExecutor.ts → fork() 隔离
  ↓
第 2 步（P1 短路 + Shadow 开关）：orchestrator.ts → short-circuit + enableShadowMode
  ↓
第 3 步（P1 学习闭环）：orchestrator.ts → finally 中 recordOutcomeFor
  ↓
第 4 步（P1 能力组队）：orchestrator.ts → capabilityRegistry.findBestMatch
  ↓
第 5 步（P2 参数暴露）：CLI + API
```

每步独立可测、独立可回滚。
