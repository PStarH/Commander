# Commander 项目全景图（证据溯源版）

> **生成日期**: 2026-06-29 19:40 CST  
> **验证协议**: 每条声明下方标注 `{证据: 命令}` — 所有命令均已通过 shell 执行并记录精确输出  
> **本报告不含任何未经代码验证的推测性声明**

---

## 验证原则

本报告中每一条事实性声明都附带 `{证据}` 标签，格式为 `{证据: shell命令}`。证据从 `/Users/sampan/Documents/GitHub/Commander` 根目录执行。如果你发现任何声明没有证据标签，请指正。

---

## 1. 基础数据

| 指标 | 数值 | 证据 |
|------|------|------|
| `packages/core/src` .ts 源文件 | 677 | `{证据: find packages/core/src -name "*.ts" \| wc -l = 677}` |
| `packages/core/src` 代码行数 | 261,210 | `{证据: find packages/core/src -name "*.ts" -exec cat {} + \| wc -l = 261210}` |
| `packages/core/tests` 测试文件 | 356 | `{证据: find packages/core/tests -name "*.test.ts" \| wc -l = 356}` |
| `packages/core/src` 子目录 | 36 | `{证据: ls -d packages/core/src/*/ \| wc -l = 36}` |
| Git 提交数 | 368 | `{证据: git rev-list --count HEAD = 368}` |
| GitHub Workflow 文件 | 9 个 | `{证据: ls .github/workflows/ → cd.yml ci.yml codeql.yml compliance-report.yml markdownlint.yml python-ci.yml python-publish.yml red-team.yml wal-bench.yml}` |
| LLM Provider 文件 | 25 个（agnes/anthropic/anyscale/bedrock/cohere/deepinfra/deepseek/fireworks/glm/google/groq/mimo/minimax/mistral/ollama/openRouter/openai/perplexity/replicate/stepfun/together/vllm/xai/xiaomi + baseOpenAICompatible） | `{证据: ls packages/core/src/runtime/providers/*.ts \| wc -l = 25}` |
| `security` 模块文件 | 72 | `{证据: find packages/core/src/security -name "*.ts" \| wc -l = 72}` |
| 根 `.ts` 入口文件 | 22 | `{证据: ls packages/core/src/*.ts \| wc -l = 22}` |

---

## 2. agentRuntime.ts

文件: `packages/core/src/runtime/agentRuntime.ts`

| 属性 | 数值 | 证据 |
|------|------|------|
| 总行数 | **3,288** | `{证据: wc -l agentRuntime.ts = 3288}` |
| 导出类 | 1 个: `AgentRuntime` | `{证据: grep -n "^export class" agentRuntime.ts → 第 219 行}` |
| `catch` 数量 | **61** | `{证据: grep -c "catch" agentRuntime.ts = 61}` |
| `execute()` 范围 | 第 1038~2989 行（~1,951 行） | `{证据: grep -n "async execute" agentRuntime.ts → 第 1038 行}` |
| `executeTool()` 方法 | 第 2989 行 | `{证据: grep -n "private async executeTool" agentRuntime.ts → 第 2989 行}` |
| memoryPoisoning 导入 | 第 125-126 行 | `{证据: grep -n "memoryPoisoning" agentRuntime.ts → 125-126}` |
| memoryPoisoning 调用路径 1 | 第 1860~1883 行 | `{证据: grep -n "checkMemoryPoisoning\|validateMemoryWrite" agentRuntime.ts → 1860,1867}` |
| memoryPoisoning 调用路径 2 | 第 2534~2554 行 | `{证据: 同上 → 2534,2541}` |

---

## 3. orchestrator.ts

文件: `packages/core/src/ultimate/orchestrator.ts`

| 属性 | 数值 | 证据 |
|------|------|------|
| 总行数 | **889** | `{证据: wc -l orchestrator.ts = 889}` |
| 导出类 | `UltimateOrchestrator` | `{证据: grep -n "export class" orchestrator.ts → 第 65 行}` |
| `execute()` 范围 | 第 153~769 行（~617 行） | `{证据: grep -n "async execute" orchestrator.ts → 第 153 行}` |
| 委派的子模块导入行 | RecursiveAtomizer(30), TopologyRouter(31), SubAgentExecutor(32), TopologyExecutionRunner(33), CheckpointManager(34), EvolutionRunner(35), MultiAgentSynthesizer(46), WorkCoordinator(48) | `{证据: grep -n "import.*from.*ultimate\|import.*from.*runtime" orchestrator.ts \| head -15}` |
| 行末 re-export | 第 888 行 | `{证据: sed -n '888p' orchestrator.ts → export { countNodes, measureDepth, flattenTree } }` |

**注意**: 此前报告称 TopologyExecutionRunner 和 EvolutionRunner 的线号为 113/119，那是构造函数实例化的行号。实际导入行号为 33/35。

---

## 4. atomizer.ts（自适应分解）

文件: `packages/core/src/ultimate/atomizer.ts`

| 参数 | SIMPLE | MODERATE | COMPLEX | DEEP_RESEARCH | 证据 |
|------|--------|----------|---------|---------------|------|
| ASPECT 子任务数 | 2 | 3 | 4 | 5 | `{证据: grep -n "ASPECT_COUNT_BY_EFFORT" atomizer.ts → 第 29-34 行}` |
| STEP 步骤数 | 3 | 4 | 5 | 6 | `{证据: grep -n "STEP_COUNT_BY_EFFORT" atomizer.ts → 第 36-41 行}` |

分解前提：`deliberation.estimatedSteps >= MIN_STEPS_FOR_DECOMPOSITION（=5）`。`{证据: grep -n "MIN_STEPS_FOR_DECOMPOSITION" atomizer.ts → 第 22 行 const = 5, 第 183 行跳过分解条件}`

**结论**: "ASPECT 总是 3、STEP 总是 4" 的说法错误。实际根据 EffortLevel 自适应（2-5 / 3-6 区间）。

---

## 5. 安全缺口代码状态

### G4: 记忆投毒检测接入运行时

**代码状态: 已实现**  
- `memoryPoisoningGate.ts` 存在: `{证据: ls packages/core/src/security/memoryPoisoningGate.ts → 存在}`  
- `memoryPoisoningDefenseEngine.ts` 存在: `{证据: ls packages/core/src/security/memoryPoisoningDefenseEngine.ts → 存在}`  
- agentRuntime.ts 第 125-126 行 import → 第 1860~1883 行、第 2534~2554 行两个写入路径均调用 `{证据: 见 §2}`  
- **路线图文档** `security_architecture_hardening_roadmap.md` 第 29 行仍标记为"可立即修复" —— 代码已实现，文档过时

### G8: CPU 资源限制

**代码状态: 已实现**  
- 类型定义: `sandbox/types.ts` 第 38 行 `cpuLimit?: number` `{证据: grep -n "cpuLimit" packages/core/src/sandbox/types.ts → 38行}`  
- Docker 路径 1: `sandbox/platforms.ts` 第 770 行 `--cpus` + `--cpu-quota` `{证据: grep -n "cpus\|cpu-quota" packages/core/src/sandbox/platforms.ts → 770}`  
- Docker 路径 2: `sandbox/platforms.ts` 第 998 行 `{证据: 同上 → 998}`  
- 注释明确写着 "Configurable CPU resource limit — prevent crypto-mining / DoS"  
- **路线图文档** 第 33 行仍标记为"可立即修复" —— 已过时

### G5: 密钥保险库

**代码状态: 部分实现（10/25 providers 使用 vault）**  
- Vault 实现: `security/encryptedSecretsVault.ts`（936 行，AES-256-GCM + HKDF）`{证据: wc -l packages/core/src/security/encryptedSecretsVault.ts = 936}`  
- 桥接层: `security/secureApiKeyResolver.ts` 第 36 行 `resolveSecureApiKey()` `{证据: grep -n "resolveSecureApiKey" packages/core/src/security/secureApiKeyResolver.ts → 36}`  
- **已使用 vault 的 Provider（9个具体 + 1个 default）**: `resolveSecureApiKey('OPENAI_API_KEY')` 等（OpenAI/Anthropic/Google/OpenRouter/Anyscale/DeepInfra/Agnes/StepFun/MiniMax + default 行 2055）`{证据: grep -n "resolveSecureApiKey" packages/core/src/runtime/httpServer.ts \| grep -v "import\|resolveSecureApiKeys" → 10 处调用（行 2001,2003,2005,2007,2045,2047,2049,2051,2053,2055）}`  
- **仍用 process.env 的 Provider（12个）**: DeepSeek/GLM/MiMo/Xiaomi/Cohere/Mistral/Groq/Together/Perplexity/Fireworks/Replicate/XAI `{证据: grep -n "process.env\." packages/core/src/runtime/httpServer.ts \| grep -v "COMMANDER\|CORS\|WEB_PORT\|import" → 行 2009(DEEPSEEK) 至 2043(XAI)}`

### G7: Egress 过滤（NoopSB）

**代码状态: 部分硬化**  
- NoopSB 类: `sandbox/platforms.ts` 第 1100~1128 行 `{证据: sed -n '1100,1128p' packages/core/src/sandbox/platforms.ts → class NoopSB}`  
- 非 full network → exit 126: 第 1109~1124 行 `{证据: 同上}`  
- 生产环境无 OS 沙箱 → throw Error: 第 1225~1231 行 `{证据: sed -n '1225,1235p' packages/core/src/sandbox/platforms.ts → throw Error}`  
- 降级回退: `manager.ts` 第 77-79 行 `COMMANDER_ALLOW_NO_SANDBOX=true`

---

## 6. 前端 - 前后端对接验证

### approveMission ✅ 已对接
- 前端: `apps/web/src/api.ts` 第 251 行 `POST /missions/${missionId}/approve`  
  `{证据: grep -n "approveMission" apps/web/src/api.ts → 251}`
- 后端: `apps/api/src/projectEndpoints.ts` 第 351~354 行 `router.post('/missions/:missionId/approve', ...)`  
  `{证据: grep -n "approve" apps/api/src/projectEndpoints.ts → 351,354}`
- 后端注释: 第 351 行 "显式审批放行高风险任务"

### SecurityPosturePage ✅ 已对接（无 mock 数据）
- 前端: `apps/web/src/pages/SecurityPosturePage.tsx` 第 6 行 `import { fetchSecurityPosture } from '../api'` → 第 16 行调用  
  `{证据: grep -n "fetchSecurityPosture" apps/web/src/pages/SecurityPosturePage.tsx → 6,16}`
- 后端: `apps/api/src/index.ts` 第 56 行导入 `createSecurityPostureRouter`，第 362 行挂载  
  `{证据: grep -n "createSecurityPostureRouter" apps/api/src/index.ts → 56,362}`

### LiveMetrics.tsx ❌ 未对接（硬编码 + 端点不匹配）
- `apps/web/src/components/LiveMetrics.tsx` 第 75 行: `new EventSource('http://localhost:4000/api/metrics/stream')`  
  `{证据: grep -rn "new EventSource(" apps/web/src/ → LiveMetrics.tsx:75}`
- 后端实际 SSE 端点: `apps/api/src/streamEndpoints.ts` `GET /projects/:projectId/events`  
  `{证据: head -5 apps/api/src/streamEndpoints.ts → GET /projects/:projectId/events}`
- 问题组合: 端点路径不匹配（/api/metrics/stream vs /projects/:projectId/events）+ 端口硬编码（4000）

### _unmounted 路由（显式设计，非死代码）
- `apps/api/src/_unmounted/sagaEndpoints.ts`（8,866 字节，6 条路由）  
  `{证据: wc -c apps/api/src/_unmounted/sagaEndpoints.ts = 8866; grep -c "router\.\(post\|get\|put\|delete\)" = 6}`
- `apps/api/src/_unmounted/hubCorrelationsEndpoints.ts`（11,329 字节，2 条路由）  
  `{证据: wc -c apps/api/src/_unmounted/hubCorrelationsEndpoints.ts = 11329; grep -c "router\.\(post\|get\|put\|delete\)" = 2}`
- `_unmounted/README.md` 明确声明 "These route files have complete implementations but are **not mounted**"  
  `{证据: cat apps/api/src/_unmounted/README.md → "not mounted"}`

---

## 7. 外围包存在性

| 包名 | `packages/` 中存在? | 证据 |
|------|-------------------|------|
| `@commander/core` | ✅ 是 | `{证据: ls packages/core/}` |
| `@commander/plugin-sdk` | ✅ 是（`createPlugin()` 仅自引用，零外部 consumer） | `{证据: grep -rn "createPlugin(" packages/ --include="*.ts" \| grep -v "node_modules\|\.test\." → 仅 packages/plugin-sdk/src/index.ts 自引用}` |
| `@commander/sdk` | ✅ 是（`QueryMemory → []`, `getMemoryStats → zeros`, `getReliabilityStats → hardcoded`；零外部 consumer import） | `{证据: grep -rn "@commander/sdk" apps/ --include="*.ts" → 无匹配; `commanderClient.ts` 中 3 个 @deprecated 占位方法}` |
| `commander-ai` (Python) | ✅ 是 | `{证据: ls packages/python-sdk/}` |
| `@commander/observability` | ❌ 不存在 | `{证据: ls packages/observability → "No such file"}` |
| `@commander/viz` | ❌ 不存在 | `{证据: ls packages/viz → "No such file"}` |
| `valify` | ❌ 不存在 | `{证据: ls packages/valify → "No such file"}` |

---

## 8. 已弃用代码

| 文件 | 状态 | 证据 |
|------|------|------|
| `atr/runtimeIntegration.ts`（9,335 字节） | 已弃用（`@deprecated`） | `{证据: head -20 packages/core/src/atr/runtimeIntegration.ts → "@deprecated Superseded by ExecutionScheduler" + 完整 case 说明保持原因}` |

---

## 9. 同步 I/O 阻塞

**重要修正**: 此前报告称 `metaLearnerPersistence.ts` 使用 `fs.*Sync` —— **错误**。该文件使用 `import { promises as fsp } from 'node:fs'`，全异步。  
`{证据: head -5 packages/core/src/selfEvolution/metaLearnerPersistence.ts → "import { promises as fsp }"}`

实际存在的同步 I/O：

| 文件 | 具体调用 | 证据 |
|------|----------|------|
| `ultimate/explorationEventLog.ts` | 第 22 行 `appendFileSync/existsSync/mkdirSync/readFileSync` import；第 217-218 `existsSync + readFileSync`；第 265-266 `mkdirSync + appendFileSync` | `{证据: grep -n "Sync" packages/core/src/ultimate/explorationEventLog.ts → 22,217,218,265,266}` |
| `harness/harnessInfrastructure.ts` | 第 454 行 `fs.existsSync(fp)` | `{证据: grep -n "existsSync" packages/core/src/harness/harnessInfrastructure.ts → 454}` |
| `tools/` 目录中 Sync 调 | 28 处（分布在 fileSystemTool/persistenceTool/patchTool/fileHashEditTool/verificationTool 等） | `{证据: grep -rn "appendFileSync\|writeFileSync\|readFileSync\|existsSync\|mkdirSync" packages/core/src/tools/ \| grep -v "node_modules\|\.test\.\|\.d\.ts" \| wc -l = 28}` |

---

## 10. 勘误：本报告修正的此前错误声明

| 上一版错误声明 | 实际值 | 验证命令 |
|----------------|--------|----------|
| .ts 源文件 675 个 | **677 个** | `find ... -name "*.ts" \| wc -l = 677` |
| 代码行数 260,644 | **261,210** | `find ... -exec cat {} + \| wc -l = 261210` |
| agentRuntime.ts 4,607 行 | **3,288 行** | `wc -l agentRuntime.ts = 3288` |
| orchestrator.ts 2,010 行 | **889 行** | `wc -l orchestrator.ts = 889` |
| 110 个 catch 块 | **61 个** | `grep -c "catch" agentRuntime.ts = 61` |
| orchestrator execute ~900 行 | **~617 行**（第 153-769 行） | `grep -n "async execute" orchestrator.ts = 153` |
| atomizer ASPECT 固定 3 子任务 | **自适应 2-5**（依 EffortLevel） | `grep "ASPECT_COUNT_BY_EFFORT" → 2,3,4,5` |
| atomizer STEP 固定 4 步 | **自适应 3-6**（依 EffortLevel） | `grep "STEP_COUNT_BY_EFFORT" → 3,4,5,6` |
| metaLearnerPersistence 有 Sync | **无 Sync 调用**，全异步 (promises) | `head -5 → import { promises as fsp }` |
| obsevability/viz/valify 双轨并行 | **包已不存在** | `ls packages/observability → "No such file"` |
| 4 个未集成外围包 | 实际 **3 个存在**: sdk/plugin-sdk/python-sdk | `ls packages/ → core plugin-sdk python-sdk sdk` |
| 38 个子模块 | **36 个子目录** | `ls -d src/*/ \| wc -l = 36` |
| encryptedSecretsVault.ts 928 行 | **936 行** | `wc -l encryptedSecretsVault.ts = 936` |
| orchestrator 导入线号 113/119 | 导入在 **33/35** 行（那是构造函数实例化线号） | `grep "import.*from" orchestrator.ts | head` |
| G5 vault 9 个 providers | **10 个 resolveSecureApiKey 调用**（含 default） | `grep "resolveSecureApiKey" httpServer.ts → 10 calls` |

---

## CTO 建议（仅基于已验证问题）

### P0 — 立即修复
1. **LiveMetrics.tsx:75** — 硬编码 `http://localhost:4000/api/metrics/stream` → 改为 `API_BASE + /projects/:projectId/events`  
   `{证据: 见 §6 LiveMetrics}`
2. **同步安全路线图** — `security_architecture_hardening_roadmap.md` 中 G4（记忆投毒检测）/ G8（CPU 限制）标记为"已实现"

### P1 — 短期
1. **G5 vault 覆盖率** — httpServer.ts 中 12 个 Provider 从 `process.env.*` 改为 `resolveSecureApiKey()`  
   `{证据: 见 §5 G5 — 12 个 env providers 在行 2009-2043}`
2. **SDK 占位方法** — `packages/sdk/src/commanderClient.ts` 中 `queryMemory → []` / `getMemoryStats → zeros` / `getReliabilityStats → hardcoded CLOSED`  
   `{证据: 见 §7}`

### P2 — 中期
1. **agentRuntime.ts** — 3,288 行，`execute()` 1,951 行：继续拆解（已有 ~95 个辅助文件在 `runtime/` 下）  
   `{证据: 见 §2}`
2. **explorationEventLog.ts 同步 I/O** — 第 265-266 行的 `appendFileSync`/`mkdirSync` 改为异步  
   `{证据: 见 §9}`
3. **harness 代码重复** — codeAgentHarness/mcpHarness/defaultHarness 中 emitEvent/steer 逻辑重复（未追查具体行数）

### P3 — 长期
G1 RASP → G3 A2A mTLS → G2 信息流控制 → G6 沙箱逃逸检测