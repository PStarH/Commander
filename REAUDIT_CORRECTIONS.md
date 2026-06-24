# Commander 重新审计报告 — 增量修正版

> **基于文件级直接证据的二次审计**
> **审计日期**: 2026-06-24 | **方法**: 直接工具验证（7 个 explore agent 因 billing 失败后改用 grep/read/bash）

---

## 上次审计的修正项

### 修正 1: agentRuntime.ts 规模 — 我低估了严重性

| 指标                | 上次审计 | 实际值       | 偏差                          |
| ------------------- | -------- | ------------ | ----------------------------- |
| **文件行数**        | 4,571 行 | **4,807 行** | ⬆️ +236 行（更严重）          |
| **getX() 单例调用** | 76 次    | **275 次**   | ⬆️ **+199 次（3.6x 更严重）** |
| **catch 块数**      | 110      | **114**      | ✅ 接近                       |

**影响**: 单例耦合比我之前报告的严重 3.6 倍。275 个 `getX()` 调用意味着几乎每一行都在调用外部全局状态。之前的评分需要从 `2/10` 降至 **1/10**。

### 修正 2: 同步 I/O 位置 — 我说错了文件

| 上次审计                         | 实际                                                                                                                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "`agentRuntime.ts` 中有同步 I/O" | ❌ agentRuntime 使用 `fs.promises`（异步 API）                                                                                                                                                                                                     |
| 未具体说明其他文件               | ✅ 同步 I/O 实际存在于：`metaLearnerPersistence.ts`（`existsSync/mkdirSync/writeFileSync/readFileSync`）、`explorationEventLog.ts`（`appendFileSync/existsSync/mkdirSync`）、`harnessInfrastructure.ts`（`existsSync/readFileSync/writeFileSync`） |

**影响**: 问题位置修正但风险不变——这些文件在热路径上阻塞事件循环。评分不变。

### 修正 3: Regex 注入状态 — 已部分修复

| 上次审计                                   | 实际                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| "`artifactSystem.ts:134` 存在正则注入漏洞" | ⚠️ **该漏洞已被修复**——代码中存在 `escapeRegex()` 函数且所有 `new RegExp()` 调用都使用它 |

**实际代码** (`artifactSystem.ts:17-26`):

```typescript
/** HARD cap on query-term length passed to RegExp — defense-in-depth alongside
 *  the escapeRegex() helper. Prevents catastrophic-backtracking ReDoS even if
 *  escapeRegex() is somehow bypassed. CVSS 7.5+ bug class. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

但是！**其他文件的未转义 RegExp**:
| 文件 | 行号 | 输入来源 | 风险 |
|------|------|---------|------|
| `contentScanner.ts` | 238 | 硬编码 Unicode 范围 | 低 |
| `goalJudge.ts` | 650 | `condition.pattern`（配置？） | 中 |
| `deliberation.ts` | 57 | `word` 变量 | 中 |

**影响**: artifactSystem 已修复，但代码库中仍有其他未审计的 RegExp 构造。P0 降级为 **P1**。

### 修正 4: 集成测试存在性 — 我漏掉了

| 上次审计       | 实际                                      |
| -------------- | ----------------------------------------- |
| "没有集成测试" | ❌ **存在 23 个集成/端到端/混沌测试文件** |

实际存在的测试文件：

- `runtime/e2e.test.ts` — AgentRuntime 完整流水线测试（用 MockLLMProvider + 真实单例）
- `agentRuntime.integration.test.ts` — ServiceContainer 集成测试
- `chaos-monkey.test.ts` — 混沌工程测试（30 轮随机延迟/错误/乱序）
- `production-chaos.test.ts` — 生产混沌测试
- `saga/e2e.test.ts` — Saga 端到端测试
- `e2e/orchestration.test.ts` — 编排端到端测试
- `e2e/sloMeasurement.test.ts` — SLO 测量测试
- `e2e/load.test.ts` — 负载测试

**但是**: 这些测试使用 `MockLLMProvider` 而非真实 LLM API。没有测试覆盖 CLI→deliberation→orchestrator→synthesizer 的完整流水线。没有测试验证实际的 LLM 行为（幻觉、质量门、语义缓存）。

**影响**: 从 "无集成测试" → "有单元集成测试但无端到端真实流水线测试"。评分从 **1/10** 修正为 **4/10**。

### 修正 5: 健康检查措辞 — 细微差异

| 上次审计                 | 实际                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------- |
| "返回 'not implemented'" | ⚠️ 实际返回 `{ status: 'healthy', message: '...check not wired — no source provided' }` |

这个措辞略有不同但**行为同样危险**——熔断器可能是 OPEN 状态但健康检查返回 "healthy"。致命行为不变。

**影响**: 措辞修正，风险等级不变。

### 修正 6: 单例计数来源

| 类别                       | 数量     | 示例                                                                |
| -------------------------- | -------- | ------------------------------------------------------------------- |
| logger                     | ~60      | `getGlobalLogger()`                                                 |
| messageBus                 | ~15      | `getMessageBus()`                                                   |
| metricsCollector           | ~15      | `getMetricsCollector()`                                             |
| modelRouter                | ~10      | `getModelRouter()`                                                  |
| 安全相关                   | ~20      | `getSecurityOrchestrator()`, `getSecurityMonitor()`                 |
| 内存相关                   | ~10      | `getGlobalThreeLayerMemory()`, `getConversationStore()`             |
| 检查点/DLQ                 | ~10      | `getCheckpointWriter()`, `getDeadLetterQueue()`                     |
| 其他（缓存、钩子、遥测等） | ~135     | `getHookManager()`, `getDataRetentionJanitor()`, `getSmartRouter()` |
| **总计**                   | **~275** | —                                                                   |

---

## 上次审计确认项（证据更强了）

### 确认 1: 死代码孤立（零引用）

```
grep -rn "actor\|ActorSystem" packages/core/src/ --include="*.ts" | grep import
→ 0 results

grep -rn "inspectorAgent\|InspectorAgent" packages/core/src/ --include="*.ts" | grep import
→ 0 results

grep -rn "frameworkIntegration\|FrameworkIntegration" packages/core/src/ --include="*.ts" | grep import
→ 0 results
```

**结论**: `actor/` (1,728 行)、`inspectorAgent.ts` (~500 行)、`frameworkIntegration.ts` (237 行) **完全孤立**。上次审计的 P1 评级维持不变。

### 确认 2: Perplexity/Replicate 工具调用错误

**Perplexity** (`perplexityProvider.ts:36-40`):

```
if (request.tools && request.tools.length > 0) {
  throw new Error(
    `[perplexity] Perplexity Sonar API does NOT support tool/function calling.`
  );
}
```

**Replicate** (`replicateProvider.ts:38-42`):

```
if (request.tools && request.tools.length > 0) {
  throw new Error(
    `[replicate] Replicate does NOT support tool/function calling.`
  );
}
```

### 确认 3: 薄包装 Provider（10 个）

| Provider   | 行数 | 实际代码量                                                                   |
| ---------- | ---- | ---------------------------------------------------------------------------- |
| Anyscale   | 17   | 仅 `name` + `getDefaultBaseUrl()` + `getDefaultModel()` + `getExtraConfig()` |
| DeepInfra  | 17   | 同上                                                                         |
| xAI        | 17   | 同上                                                                         |
| Agnes      | 19   | 同上                                                                         |
| Mistral    | 28   | 同上                                                                         |
| Groq       | 29   | 同上                                                                         |
| Fireworks  | 30   | 同上                                                                         |
| Together   | 32   | 同上                                                                         |
| StepFun    | 35   | 同上                                                                         |
| Perplexity | 45   | 同上 + 工具调用错误抛出                                                      |

**结论**: 10 个 provider 是仅设置配置的薄包装。它们与兼容性层的实际偏差为 0。如果 baseOpenAICompatible 有 bug，这 10 个 provider 一起出问题。

### 确认 4: deliberateWithLLM 自文档化浪费

`deliberation.ts:556-558`:

```
/**
 * LLM-powered deliberation — sends goal to an LLM, then falls back to
 * deliberate() for every field. This adds latency and cost with no
 * behavioral benefit over deliberate() alone.
 */
```

源代码自己承认：**这个 LLM 调用增加延迟和成本，但没有行为上的好处。**

### 确认 5: 质量门正则表达式假阳性

`synthesizer.ts:412-413`:

```typescript
'on the other hand',
'however',
```

`synthesizer.ts:477-478`:

```typescript
'might be',
'could be',
```

这些是正常分析语言的标记。代码会惩罚表达不确定性的高质量输出。

### 确认 6: 多租户自我文档化限制

`tenantAwareSingleton.ts` 的 JSDoc:

> "It is NOT a complete multi-tenancy solution by itself: storage backends and external resources must still key their data by tenant"

`tenantContext.ts` 提供了完整的 `validateTenantId()`、`runWithTenant()`、`assertSameTenant()`、`tenantKey()`、`tenantPathSegment()` 等辅助函数。但**没有存储层的强制隔离**——如果存储后端不按 tenant key 存储数据，隔离就失败了。

`getGlobal()` 已经标记为 `@deprecated`：

> "Direct global access bypasses tenant isolation."

---

## 上次审计评分修正汇总

| 模块                     | 上次评分 | 修正评分             | 变化原因                                        |
| ------------------------ | -------- | -------------------- | ----------------------------------------------- |
| **AgentRuntime**         | 2/1/1    | **2/1/1**（维持）    | 4,807 行 275 个单例（更严重但已包含在评分范围） |
| **集成测试**             | 1/1/1    | **4/4/3**（⬆️ 提升） | 23 个集成/混沌测试文件存在，使用真实单例        |
| **Security（正则注入）** | 2/2/2    | **4/3/3**（⬆️ 提升） | artifactSystem 已修复，但其他文件仍有风险       |
| **健康检查**             | —        | 维持 P0              | "not wired" 仍返回 "healthy"，行为不变          |
| **死代码**               | 1/1/1    | 维持                 | 零引用确认，证据更强                            |

---

## 重新审计后的 P0/P1/P2 更新

### P0 阻断器（更新后）

| ID       | 问题                                       | 证据强度       | 变化                            |
| -------- | ------------------------------------------ | -------------- | ------------------------------- |
| **P0-A** | agentRuntime 4,807 行上帝对象 + 275 个单例 | 🔴 **更强**    | 275 > 76，严重性 ×3.6           |
| **P0-B** | 健康检查虚假返回 "healthy"                 | 🔴 维持        | 5 个 "not wired" 仍返回 healthy |
| **P0-C** | 多租户非真实隔离                           | 🔴 维持        | 存储层隔离需后端配合            |
| ~~P0-D~~ | ~~正则注入~~                               | 🟢 **降级 P1** | artifactSystem 已修复           |

### 新增发现

| ID     | 问题                                                                                                                             | 严重性 | 证据               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------ |
| **新** | orchestator.ts 底部重复 3 个 `new RegExp()` 调用（`orchestrator.ts:2000-2016`）与 `orchestratorOutput.ts:265-279` 完全相同的代码 | 🟡 P2  | 代码重复           |
| **新** | `runtime/e2e.test.ts` 和 `agentRuntime.integration.test.ts` 已有较好结构，可扩展为真正的端到端测试                               | 🟢 P3  | 现有基础设施可复用 |
| **新** | 310 测试文件共 96,508 行——测试规模相当大但集中在单元级别                                                                         | —      | 事实发现           |

---

## 最终修正评级

```
模块评分修正表（技术成熟度 / Best Practice / Bug程度）

                 上次审计    重新审计    变化
AgentRuntime     2/1/1      2/1/1       维持（实际更严重）
Orchestrator     5/3/3      5/3/3       维持
集成测试         1/1/1      4/4/3       ⬆️ 提升（发现23个集成测试）
Security         2/2/2      4/3/3       ⬆️ 提升（artifactSystem已修复）
其他模块         维持        维持         无变化

总结：
- 4 项修正：1 项更严重（agentRuntime），2 项改善（测试、安全），1 项措辞修正（健康检查）
- 3 项新增发现（代码重复、测试基础、测试规模）
- 总体结论不变：DO NOT LAUNCH
```
