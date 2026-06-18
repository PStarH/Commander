# Commander 模型路由 & 学习系统优化方案

> 日期：2026-06-17 | 基于当前代码审计 + FrugalGPT/LiteLLM/LangGraph 最佳实践

---

## 现状诊断总结

经过对全部 12 个核心文件的逐行审计，发现以下**已正确实现**的功能（原报告中的部分问题已在此前修复）：

| 原报告问题 | 实际状态 |
|:---|:---|
| SmartModelRouter 学习不持久 | ✅ **已修复** — `recordOutcome()` 已写入 `ModelPerformanceStore`，构造函数已从 store seed |
| 拓扑学习死闭环 | ✅ **已修复** — `finally` 块中 `pheromoneRouter.recordOutcomeFor()` + `learnedWeights.recordSignal()` |
| TokenSentinel 月度上限写死 $50 | ✅ **已修复** — `resolveMonthlyCostLimit()` 读取 `COMMANDER_MONTHLY_COST_LIMIT_USD` 环境变量 |
| TopologyRouter 未暴露学习 API | ✅ **已有** — `getPheromoneRouter()` 和 `getLearnedWeights()` 早已存在 |

**仍需修复的 4 个问题：**

---

## P1.1 升级级联质量门 — HeuristicEvaluator → HybridEvaluator

### 问题
`HeuristicEvaluator`（`telos/evaluator.ts`）只用结构信号判断是否升级：
- `correctness`: `status === 'success' ? 0.9 : 0.2` — 完全不懂内容
- `grounding`: 有没有 tool_call
- `completeness`: 输出长度
- `safety`: 正则匹配恶意关键词

导致：模型答错但长度够 → 门通过（省钱但质量差）；模型答对但太短 → 门失败（无效升级烧钱）。

### 最佳实践
FrugalGPT + LiteLLM 的级联模式：
1. **快速筛选**：先用启发式信号过滤明显错误（零成本）
2. **关键验证**：对高价值任务用 LLM judge 做语义质量评估
3. **自适应阈值**：根据任务类型和历史成功率动态调整门限

### 修改方案

**修改前**（只支持 HeuristicEvaluator）：
```typescript
// ModelCascadeController 只用 HeuristicEvaluator
const evaluation = this.evaluator.evaluateWithThreshold(result, this.threshold);
```

**修改后**（支持 Hybrid 模式）：
```typescript
// ModelCascadeController 支持可选的 LLM judge 作为二级验证
// 1. 先用 HeuristicEvaluator 做快速筛选
// 2. 对边界情况（score 在 threshold ± 0.1）用 LLM judge 做语义验证
// 3. 可通过 config 开关控制 LLM judge 的使用范围
```

### 具体改动

**文件：`packages/core/src/telos/evaluator.ts`**
- 新增 `LLMJudgeEvaluator` 类：接收 LLM provider，用 judge prompt 评估输出质量
- 实现 `HybridEvaluator` 装饰器：先用启发式快速筛选，边界情况用 LLM judge

**文件：`packages/core/src/telos/modelCascadeController.ts`**
- `executeCascade()` 接受可选的 `LLMJudgeEvaluator`
- 对 `score ∈ [threshold-0.1, threshold)` 的边界情况，调用 LLM judge 二次验证
- 避免「模型答对了但太短 → 误升级」和「模型答错了但很长 → 误通过」

**优化对比**：
| 场景 | 修改前 | 修改后 |
|:---|:---|:---|
| 便宜模型答对了但输出短（200 字） | 门失败 → 升级贵模型，浪费 $0.01 | LLM judge 判定内容正确 → 通过，省 $0.01 |
| 便宜模型答错了但输出长（500 字） | status=success → 门通过，用户拿错结果 | LLM judge 判定内容错误 → 升级，确保质量 |
| 便宜模型答对了且输出长（正常） | 门通过 ✅ | 跳过 LLM judge，零额外成本 ✅ |

---

## P1.2 持久化 CostEstimator / TokenGovernor 学习数据

### 问题
- `CostEstimator` 有 `exportHistory()` / `importHistory()` 方法，但**无人调用**。每次重启回到冷启动。
- `TokenGovernor` 的策略 effectiveness ring buffer 纯内存，重启丢失。

### 最佳实践
LangGraph 的 `BaseStore` / LiteLLM 的 metrics DB：每个组件独立管理自己的持久化，不依赖上层调用者。

### 修改方案

**CostEstimator**：启动时从磁盘 load，每次 recordActualCost 后 auto-flush

**修改前**：
```typescript
const estimatorSingleton = createTenantAwareSingleton(() => new CostEstimator());
```

**修改后**：
```typescript
const estimatorSingleton = createTenantAwareSingleton(() => {
  const estimator = new CostEstimator();
  const loaded = loadEstimatorHistory(); // 从 NDJSON 加载
  if (loaded.length > 0) estimator.importHistory(loaded);
  return estimator;
});
// recordActualCost 中追加 auto-flush 到 NDJSON
```

**TokenGovernor**：启动时从磁盘 load strategy effectiveness，定期 auto-flush

**修改前**：
```typescript
private history: Array<{ strategy: string; effective: boolean; timestamp: number }>;
```

**修改后**：
```typescript
private history: Array<{ strategy: string; effective: boolean; timestamp: number }>;
// 启动时 loadStrategyEffectiveness() 填充 history
// recordOutcome 后 auto-flush 最后 100 条
```

**优化对比**：
| 场景 | 修改前 | 修改后 |
|:---|:---|:---|
| 重启后成本预测 | 冷启动，置信度 0 | 继承历史估值，置信度 > 0.5 |
| 重启后策略选择 | 「压缩」策略无历史 → 中性 0.5 | 继承上周的「压缩有效」数据 → 0.8 boost |
| 磁盘成本 | 0 | ~5KB NDJSON，读写 < 1ms |

---

## P1.3 ProviderPool 接入主执行路径

### 问题
`ProviderPool`（`telos/providerPool.ts`）实现了健康检查、加权选择、自动恢复，但**只被 `TELOSOrchestrator` 使用**。主执行路径 `AgentRuntime → ProviderFallbackChain` 是简单的顺序/错误 fallback，无健康感知。

### 最佳实践
LiteLLM Router 的 Deployment-Centric 模式：
- 每个 provider+model 组合是一个 deployment
- 健康状态由实际调用结果驱动（不主动 ping）
- Fallback 时跳过不健康的 deployment

### 修改方案

**ProviderFallbackChain 增强**：接受可选的 `ProviderPool` 引用，在执行前检查 provider 健康状态。

**修改前**：
```typescript
// ProviderFallbackChain: 纯顺序 fallback，不管健康
for (const [name, fn] of providers) {
  try { return await fn(); } catch { continue; }
}
```

**修改后**：
```typescript
// 增强：跳过被 ProviderPool 标记为 'down' 的 provider
for (const [name, fn] of providers) {
  if (this.pool && this.pool.isProviderDown(name)) continue; // ← 新增健康检查
  try { return await fn(); } catch (e) {
    this.pool?.recordFailure(name, modelId); // ← 通知 ProviderPool
    continue;
  }
}
```

**AgentRuntime 构造函数**：注入 ProviderPool 到 ProviderFallbackChain

**优化对比**：
| 场景 | 修改前 | 修改后 |
|:---|:---|:---|
| OpenAI 连续 5 次 429 → 后续请求 | 每次都先试 OpenAI → 429 → 再 fallback | 直接跳过 OpenAI，节省 5×500ms = 2.5s |
| Anthropic 恢复后 | 永远不会重试（fallback chain 顺序固定） | ProviderPool 2 分钟后自动恢复 → 下次可用 |
| 成本 | 每次 429 浪费一次 HTTP round-trip | 零浪费 |

---

## P1.4 清理 Dead Path — ModelRouter.routeBatch()

### 问题
`ModelRouter.routeBatch()` 要求 `supportsBatchAPI: true`，但 `DEFAULT_MODELS` 中**没有任何模型带此 flag**。`isBatchEligible()` 判断了半天，实际永远选不出 batch 模型。

### 修改方案

给 `DEFAULT_MODELS` 中支持 Batch API 的模型添加 `supportsBatchAPI: true`：
- OpenAI: `gpt-4o-mini`, `gpt-4o`, `gpt-5`
- Anthropic: `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-8`
- Google: `gemini-2-flash`

**修改前**：
```typescript
{ id: 'gpt-4o-mini', ..., supportsBatchAPI: false } // 默认 false
```

**修改后**：
```typescript
{ id: 'gpt-4o-mini', ..., supportsBatchAPI: true } // OpenAI 支持 Batch
```

**优化对比**：
| 场景 | 修改前 | 修改后 |
|:---|:---|:---|
| 非紧急评估任务 | 实时调用，全价 | Batch API，50% off |
| `isBatchEligible()` 返回 true | 无 batch 模型可选 → 走实时调用 | 有 batch 模型 → 半价执行 |

---

## 实施文件清单

| 文件 | 改动类型 | 改动量 |
|:---|:---|:---|
| `packages/core/src/telos/evaluator.ts` | 新增 `LLMJudgeEvaluator` + `HybridEvaluator` | ~80 行 |
| `packages/core/src/telos/modelCascadeController.ts` | 支持可选 LLM judge 二次验证 | ~30 行 |
| `packages/core/src/runtime/costEstimator.ts` | 添加 NDJSON 持久化 | ~50 行 |
| `packages/core/src/runtime/tokenGovernor.ts` | 添加 strategy effectiveness 持久化 | ~40 行 |
| `packages/core/src/runtime/providerFallbackChain.ts` | 集成 ProviderPool 健康检查 | ~30 行 |
| `packages/core/src/runtime/agentRuntime.ts` | 注入 ProviderPool 到 fallback chain | ~5 行 |
| `packages/core/src/runtime/modelRouter.ts` | 添加 supportsBatchAPI 到默认模型 | ~15 行 |

**总改动量**：~250 行，7 个文件
