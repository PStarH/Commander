# 算法效果证明平台设计文档

> **目标：** 建立一套可复用的算法/策略效果验证框架，用实际 API 调用和统计对照实验证明 `packages/core` 中每个理论模块（如 Thompson Sampling、Topology Router、Effort Scaler 等）是否真正让 LLM 表现更好。

**日期：** 2026-07-09  
**范围：** `packages/core` 中所有带算法/策略性质的模块，首批聚焦 10 个核心模块。  
**优先级：** A（功能正确性/覆盖率）> B（性能）> C（安全/韧性）。

---

## 1. 背景与问题

`packages/core` 包含 60 余个算法/策略模块，涵盖记忆选择、Bandit、拓扑路由、努力缩放、模型路由、群体共识、成本预测等领域。这些模块大多基于统计学或强化学习理论，但当前存在以下问题：

- 部分模块缺少独立单元测试（如 `adaptiveStopping.ts`、`courtEval.ts`、`bpdDetector.ts`）。
- 有测试的模块多为白盒测试，未与真实 LLM 输出建立因果证明。
- 没有系统性的 A/B 对照框架来回答"启用该算法是否比禁用/基线更好"。

本设计要建立一个可复用的 **Algorithmic Effectiveness Benchmark Suite**，让每个模块都能被独立、可重复、统计显著地验证。

---

## 2. 设计原则

1. **证据驱动**：每个结论必须基于 A/B 对照实验，不允许主观断言。
2. **可复现**：所有实验支持 `seed`，脚本化模式完全确定。
3. **可扩展**：新增一个模块的验证只需写一个 registry entry，不改动框架。
4. **双模式**：`scripted` 模式用于 CI 回归，`live` 模式用于真实 API 效果证明。
5. **统计严谨**：默认 N=30，使用 Wilcoxon 符号秩检验，p<0.05 才判定显著。

---

## 3. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│         Algorithmic Effectiveness Benchmark Suite           │
├─────────────────────────────────────────────────────────────┤
│  Registry                                                     │
│    - moduleId, modulePath                                     │
│    - baselineFactory: () => 禁用该策略的简单实现               │
│    - treatmentFactory: () => 真实算法实现                      │
│    - taskSuite: 验证任务集                                    │
│    - metrics: successRate, cost, latency, llmScore           │
├─────────────────────────────────────────────────────────────┤
│  Runner                                                       │
│    - 对 Baseline 和 Treatment 各跑 N 次                       │
│    - 支持 scripted / live 两种 LLM 模式                       │
│    - 自动配对、错误处理和重试                                 │
├─────────────────────────────────────────────────────────────┤
│  Evaluator                                                    │
│    - 任务成功判定（规则 + LLM-as-Judge）                      │
│    - 成本/延迟聚合                                            │
│    - Wilcoxon 符号秩检验                                      │
├─────────────────────────────────────────────────────────────┤
│  Reporter                                                     │
│    - JSON / Markdown / HTML 报告                              │
│    - 每个模块：baseline vs treatment 对比表                   │
│    - 结论：显著提升 / 无显著差异 / 劣于基线 / 测试不稳定      │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. 文件结构

```
packages/core/
├── src/
│   └── benchmarks/
│       └── algorithmicEffectiveness/
│           ├── index.ts                 # 对外入口：runBenchmark, runAll
│           ├── types.ts                 # BenchmarkModule, Task, RunResult 类型
│           ├── registry.ts              # 模块注册表
│           ├── runner.ts                # A/B Runner
│           ├── evaluator.ts             # 成功判定 + 统计检验
│           ├── reporter.ts              # 报告生成
│           ├── scriptedLLM.ts           # 脚本化/确定性 LLM 客户端
│           ├── liveLLM.ts               # 真实 LLM API 客户端
│           └── modules/                 # 每个模块的验证配置
│               ├── thompsonMemory.ts
│               ├── strategySelector.ts
│               ├── topologyRouter.ts
│               ├── effortScaler.ts
│               ├── modelRouter.ts
│               ├── fusionEngine.ts
│               ├── parameterController.ts
│               ├── tokenGovernor.ts
│               ├── bm25ToolDiscovery.ts
│               └── speculativeExecutor.ts
└── tests/
    └── benchmarks/
        └── algorithmicEffectiveness/
            ├── runner.test.ts
            ├── evaluator.test.ts
            ├── reporter.test.ts
            └── modules/
                ├── thompsonMemory.test.ts
                └── strategySelector.test.ts
```

---

## 5. 核心类型定义

```typescript
// types.ts
export interface Task {
  id: string;
  prompt: string;
  expected?: string | RegExp | ((output: string) => boolean);
  judge?: (output: string, ctx: { llm: LLMClient }) => Promise<number>;
  category?: string;
}

export interface LLMClient {
  complete(prompt: string, options?: SamplingOptions): Promise<{ text: string; tokens: TokenUsage }>;
}

export interface SamplingOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  model?: string;
}

export interface BenchmarkModule {
  id: string;
  name: string;
  description: string;
  path: string;
  baselineFactory: (ctx: { llm: LLMClient }) => unknown;
  treatmentFactory: (ctx: { llm: LLMClient }) => unknown;
  runTrial: (args: {
    implementation: unknown;
    task: Task;
    llm: LLMClient;
  }) => Promise<{ output: string; tokenUsage: TokenUsage; latencyMs: number }>;
  taskSuite: Task[];
  metrics: MetricKey[];
}

export interface ComparisonResult {
  moduleId: string;
  mode: 'scripted' | 'live';
  n: number;
  baseline: MetricSummary;
  treatment: MetricSummary;
  pValues: Record<MetricKey, number>;
  effectSizes: Record<MetricKey, number>;
  conclusion: Conclusion;
  errors: { side: 'baseline' | 'treatment'; taskId: string; message: string }[];
}

export type MetricKey = 'successRate' | 'cost' | 'latency' | 'llmScore';
export type Conclusion =
  | 'SIGNIFICANTLY_BETTER'
  | 'NO_SIGNIFICANT_DIFFERENCE'
  | 'WORSE_THAN_BASELINE'
  | 'TEST_UNSTABLE';

export interface MetricSummary {
  mean: number;
  median: number;
  p95: number;
  stdDev: number;
  raw: number[];
}
```

---

## 6. Runner 详细行为

### 6.1 入口

```typescript
const result = await runComparison({
  moduleId: 'thompsonMemory',
  mode: 'scripted',
  n: 30,
  seed: 42,
});
```

### 6.2 执行流程

1. 从 `registry.ts` 查找 `moduleId`，找不到抛出 `ModuleNotFoundError`。
2. 根据 `mode` 初始化 `LLMClient`：
   - `scripted`：使用 `scriptedLLM`，基于规则或预置响应映射返回确定性输出。
   - `live`：使用 `liveLLM`，调用真实 OpenAI / Anthropic API。
3. 实例化 Baseline 和 Treatment。
4. 对 `taskSuite` 中每个任务跑 N 次，Baseline 和 Treatment 使用相同任务顺序和相同 seed 的随机扰动。
5. 记录每次的 `output`、`tokenUsage`、`latencyMs`、是否错误。
6. 如果某 side 的错误率超过 20%，标记为 `TEST_UNSTABLE`。

### 6.3 错误处理

- Treatment 或 Baseline 单次崩溃：记录 `ERROR`，该次 metric 按失败处理。
- LLM API 超时（live 模式）：按 `ResourceGovernor.withTimeout` 包装，默认 30s。
- 网络错误：重试 2 次，仍失败则该次标记失败。

---

## 7. Evaluator 详细行为

### 7.1 指标计算

| 指标 | 计算方式 |
|---|---|
| `successRate` | 成功 trial 数 / 总 trial 数 |
| `cost` | 基于 `TokenUsage` 和 `CostModel` 计算 USD |
| `latency` | `Date.now()` 差值，毫秒 |
| `llmScore` | 可选裁判模型对 output 质量打分（0-10） |

### 7.2 成功判定

优先级：
1. 如果 `task.expected` 是函数，调用函数返回 boolean。
2. 如果 `task.expected` 是 RegExp，匹配 output。
3. 如果 `task.expected` 是字符串，做模糊包含匹配。
4. 如果未提供 `expected` 但提供 `task.judge`，使用 LLM-as-Judge 返回 >= 6 为成功。
5. 否则默认失败。

### 7.3 统计检验

- 使用 **Wilcoxon 符号秩检验**（配对样本，非正态分布友好）。
- 显著性水平 α = 0.05。
- 输出 effect size（r = Z / sqrt(N)）。
- 当 N < 10 时跳过统计检验，仅输出均值对比。

### 7.4 结论规则

```
if 任一 side 合法运行率 < 80%:
  -> TEST_UNSTABLE
else if p < 0.05 and treatment 均值优于 baseline:
  -> SIGNIFICANTLY_BETTER
else if p < 0.05 and treatment 均值劣于 baseline:
  -> WORSE_THAN_BASELINE
else:
  -> NO_SIGNIFICANT_DIFFERENCE
```

---

## 8. Reporter 输出格式

### 8.1 Markdown 单模块报告

```markdown
# Algorithmic Effectiveness: ThompsonMemoryScorer

| Metric | Baseline | Treatment | Δ | p-value | Effect Size | Conclusion |
|---|---|---|---|---|---|---|
| Success Rate | 62.0% | 78.0% | +16.0% | 0.003 | 0.42 | SIGNIFICANTLY_BETTER |
| Avg Cost | $0.0120 | $0.0150 | +$0.003 | 0.041 | 0.28 | SIGNIFICANTLY_WORSE |
| Avg Latency | 420ms | 410ms | -10ms | 0.612 | 0.05 | NO_SIGNIFICANT_DIFFERENCE |
| LLM Score | 6.4 | 7.2 | +0.8 | 0.008 | 0.38 | SIGNIFICANTLY_BETTER |

**Overall:** Thompson sampling improves retrieval relevance but slightly increases cost.

**Errors:** baseline=0, treatment=1 (3.3%)
```

### 8.2 JSON 聚合报告

```json
{
  "suite": "algorithmic-effectiveness",
  "mode": "scripted",
  "timestamp": "2026-07-09T10:00:00Z",
  "modules": [
    {
      "moduleId": "thompsonMemory",
      "conclusion": "SIGNIFICANTLY_BETTER",
      "significantMetrics": ["successRate", "llmScore"],
      "degradedMetrics": ["cost"]
    }
  ]
}
```

---

## 9. 首批验证模块清单

| 优先级 | 模块 | 文件路径 | 基线 | 验证任务类型 |
|---|---|---|---|---|
| P0 | ThompsonMemoryScorer | `memory/thompsonMemoryScorer.ts` | 固定分数 Top-K | 记忆检索相关性 |
| P0 | StrategySelector | `selfEvolution/strategySelector.ts` | ε-greedy / 固定策略 | 策略选择累计奖励 |
| P0 | TopologyRouter | `ultimate/topologyRouter.ts` | 全部走 SEQUENTIAL | 任务完成率/成本 |
| P1 | EffortScaler | `ultimate/effortScaler.ts` | 固定 effort=standard | 复杂任务成功率 |
| P1 | ModelRouter | `runtime/modelRouter.ts` | 固定 cheapest 模型 | 成本/质量权衡 |
| P1 | FusionEngine | `swarm/fusionEngine.ts` | 简单多数投票 | 多智能体答案一致性 |
| P1 | ParameterController | `runtime/parameterController.ts` | 固定 temperature=0.7 | 创意vs事实任务准确率 |
| P2 | TokenGovernor | `runtime/tokenGovernor.ts` | 无预算限制 | 长任务完成率 |
| P2 | BM25ToolDiscovery | `runtime/bm25ToolDiscovery.ts` | 随机工具选择 | 工具召回率 |
| P2 | SpeculativeExecutor | `runtime/speculativeExecutor.ts` | 无推测执行 | 延迟/命中率 |

---

## 10. 测试策略

### 10.1 框架自身测试

- `runner.test.ts`：用模拟 `BenchmarkModule` 验证 A/B 配对、错误处理和 seed 可复现性。
- `evaluator.test.ts`：用已知分布数据验证 Wilcoxon 检验、结论判定和 TEST_UNSTABLE 场景。
- `reporter.test.ts`：验证 Markdown/JSON 输出包含预期字段。

### 10.2 模块验证测试

- `thompsonMemory.test.ts`：验证在 scripted 模式下 Thompson Sampling 显著优于固定 Top-K。
- `strategySelector.test.ts`：验证 Beta-TS 策略选择优于固定策略。

### 10.3 CI 集成

- 新增 `pnpm test:algorithmic` 命令，默认跑 `scripted` 模式。
- live 模式通过 `pnpm benchmark:algorithmic:live` 手动触发，需要配置 API key。
- CI 中要求所有 P0/P1 模块结论不为 `WORSE_THAN_BASELINE` 或 `TEST_UNSTABLE`。

---

## 11. 安全与工程约束

1. **Local-First**：所有报告和中间结果默认落盘到 `.commander/benchmarks/`，不上传。
2. **API Key 安全**：live 模式只读取环境变量，绝不写入日志或报告。
3. **成本控制**：live 模式默认 N=30，提供 `--dry-run` 先估算成本。
4. **资源治理**：所有 live LLM 调用通过 `ResourceGovernor.withTimeout` 包装，30s 超时。
5. **PII 脱敏**：报告中的 prompt/completion 必须经过 `UniversalSanitizer` 处理。
6. **vitest 串行**：测试配置沿用 `pool: 'threads', threads: false, fileParallelism: false`。

---

## 12. 成功标准

1. 框架代码合入后，新增 `runBenchmark` 可独立运行。
2. 首批 10 个模块中，至少 8 个能在 scripted 模式下产出稳定结论。
3. 至少 3 个模块（ThompsonMemory、StrategySelector、TopologyRouter）在 live 模式下得到 `SIGNIFICANTLY_BETTER` 结论，或明确发现缺陷并修复。
4. 所有新增代码测试覆盖率 >= 80%。
5. 报告生成后，用户能清楚看到每个模块"是否让 LLM 更好"的证据。

---

## 13. 后续扩展

1. 把剩余 50+ 算法模块逐步加入 registry。
2. 支持多 provider 对比（OpenAI vs Anthropic vs 本地模型）。
3. 与 `chaos-runner` 集成，在故障注入下验证算法鲁棒性。
4. 历史趋势跟踪，检测算法效果随时间漂移。
