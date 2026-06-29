# Commander 修复清单（按难度从高向低排列）

> **生成**: 2026-06-29 19:50 CST  
> **每条声明均附带验证证据**

---

## 1. agentRuntime God Object 拆解（难度：极高 ★★★★★）

**问题**: `agentRuntime.ts` 3,288 行，`execute()` 方法占 ~1,951 行（第 1038~2989 行）。`catch` 块 61 个。已有 ~95 个辅助文件抽离至 `runtime/` 下，但核心类仍臃肿。

**证据**: `wc -l agentRuntime.ts = 3288`; `grep -n "async execute" agentRuntime.ts → 1038`; `grep -c "catch" agentRuntime.ts = 61`

**风险**: 极高。AgentRuntime 是整个引擎的心脏，拆解需要对所有消费者导入路径做回归测试。`{证据: grep -rn "from.*agentRuntime\|import.*AgentRuntime" packages/core/src/ --include="*.ts" | grep -v "\.test\." | wc -l}`（大量内部消费者）

---

## 2. tools/ 28 处同步 I/O 改为异步（难度：高 ★★★★）

**问题**: `packages/core/src/tools/` 下 7+ 个工具文件共 28 处 `fs.*Sync` 调用（fileSystemTool.ts / persistenceTool.ts / patchTool.ts / fileHashEditTool.ts / verificationTool.ts 等），阻塞事件循环。

**证据**: `{证据: grep -rn "appendFileSync\|writeFileSync\|readFileSync\|existsSync\|mkdirSync" packages/core/src/tools/ | grep -v node_modules | grep -v ".test." | grep -v ".d.ts" | wc -l = 28}`

**涉及文件**:
| 文件 | Sync 调用示例 |
|------|--------------|
| `fileSystemTool.ts` | `existsSync` 多处（搜索、目录检查） |
| `persistenceTool.ts` | `mkdirSync` / `writeFileSync` / `readFileSync` |
| `patchTool.ts` | `writeFileSync` / `existsSync` |
| `fileHashEditTool.ts` | `existsSync` / `readFileSync` |
| `verificationTool.ts` | `existsSync` 多处 |
| `multimodal/visionTool.ts` | `existsSync` / `readFileSync` |
| `multimodal/pdfTool.ts` | `existsSync` / `readFileSync` |
| `multimodal/screenshotTool.ts` | `existsSync` / `mkdirSync` |

---

## 3. G5 密钥保险库覆盖率不全（难度：高 ★★★★）

**问题**: Vault 实现完好（`encryptedSecretsVault.ts` 936 行，AES-256-GCM + HKDF），但 `httpServer.ts` 中仅 10/25 个 Provider 使用 `resolveSecureApiKey()`，其余 12 个仍直接读 `process.env.*`。

**证据**: `{证据: grep -n "resolveSecureApiKey" packages/core/src/runtime/httpServer.ts → 2001(OpenAI),2003(Anthropic),2005(Google),2007(OpenRouter),2045(Anyscale),2047(DeepInfra),2049(Agnes),2051(StepFun),2053(MiniMax),2055(default) = 10处}`

**仍用 env 的 12 个 Provider**（行 2009-2043）:
DeepSeek(2009), GLM(2011), MiMo(2013), Xiaomi(2015), Cohere(2022), Mistral(2025), Groq(2027), Together(2029), Perplexity(2032), Fireworks(2035), Replicate(2038), XAI(2043)

`{证据: grep -n "process\.env\." packages/core/src/runtime/httpServer.ts | grep -v "COMMANDER\|CORS\|WEB_PORT\|import" → 12 lines}`

---

## 4. @commander/sdk 占位方法需实现（难度：中 ★★★）

**问题**: `packages/sdk/src/commanderClient.ts` 中有 3 个 `@deprecated` 占位方法返回硬编码值。更关键的是：**零外部 consumer**——`apps/web/src/api.ts` 和 `apps/api/src/index.ts` 均未 import `@commander/sdk`。

**证据**: 
- `queryMemory()` → 返回 `[]` `{证据: cat commanderClient.ts | grep -A5 "queryMemory" → "return []"}`
- `getMemoryStats()` → 返回 `{workingCount:0, episodicCount:0, ...}` `{证据: cat | grep -A5 "getMemoryStats" → return zeros}`
- `getReliabilityStats()` → 返回 `{circuitState:'CLOSED', ...}` `{证据: cat 内嵌返回}`

---

## 5. Harness 三个执行器行为重复（难度：中 ★★★）

**问题**: `codeAgentHarness.ts`(909 行) / `mcpHarness.ts`(510 行) / `defaultHarness.ts`(498 行) 各自实现 `emitEvent()` 和 steering 逻辑。虽然继承自 `BaseHarness`，但事件分发和错误处理模式高度重复。

**证据**: `{证据: grep -n "emitEvent\|steer" codeAgentHarness.ts | wc -l = 13; grep -n "emitEvent" mcpHarness.ts | wc -l = 5; grep -n "emitEvent" defaultHarness.ts | wc -l}`（约 5+）

**文件**:
```bash
# harness/ 目录结构
baseHarness.ts        # 基类
codeAgentHarness.ts   # 909 行 — 完整 Oh My Pi + Codex CLI 模式
mcpHarness.ts         # 510 行 — MCP 协议模式
defaultHarness.ts     # 498 行 — 默认模式
```

---

## 6. _unmounted 路由决议（难度：中 ★★★）

**问题**: `apps/api/src/_unmounted/` 下有两组完整实现但未挂载的路由。README 说明是"有意设计，保持 API 表面整洁"。但 8,866 字节 + 11,329 字节的代码被闲置。

**证据**: `{证据: ls apps/api/src/_unmounted/ → README.md, sagaEndpoints.ts(8866字节), hubCorrelationsEndpoints.ts(11329字节)}`

| 文件 | 路由数 | 功能 |
|------|--------|------|
| `sagaEndpoints.ts` | 6 条 | Saga 补偿（list/run/timeline/resume/fork/stream） |
| `hubCorrelationsEndpoints.ts` | 2 条 | Tier-0 关联事件可观测性（SSE + REST） |

`{证据: grep -c "router\.\(post\|get\|put\|delete\|patch\)" sagaEndpoints.ts = 6; hubCorrelationsEndpoints.ts = 2}`

**选项**: 挂载、归档、或正式标记"未来激活"

---

## 7. @deprecated 代码清理计划（难度：低中 ★★☆）

**问题**: 核心模块共 10 处 `@deprecated` 标记。

**证据**: `{证据: grep -rn "@deprecated" packages/core/src/ --include="*.ts" | grep -v node_modules | grep -v ".test." | grep -v ".d.ts"}`

| 文件 | 行 | 说明 |
|------|---|------|
| `security/rotationSignoffVerifier.ts` | 439,773,934 | 3 处 sync→async 迁移（advisory，代码保留） |
| `threeLayerMemory.ts` | 1021 | 工厂函数迁移 |
| `pluginManager.ts` | 231 | 权限声明加载方式变更 |
| `runtime/tenantAwareSingleton.ts` | 50 | get() 参数变更 |
| `saga/sagaCoordinator.ts` | 475 | 方法名变更 |
| `ultimate/types.ts` | 52 | 类型别名（2 版本迁移窗口） |
| **`atr/runtimeIntegration.ts`** | 文件头 | **9,335 字节整文件废弃** |

---

## 8. 前端 LiveMetrics.tsx 硬编码 URL（难度：低 ★）

**问题**: `LiveMetrics.tsx` 第 75 行硬编码 `http://localhost:4000/api/metrics/stream`，这个端点后端不存在。

**证据**: 
- `{证据: grep -rn "new EventSource(" apps/web/src/ → LiveMetrics.tsx:75: "http://localhost:4000/api/metrics/stream"}`
- 后端实际 SSE 端点: `{证据: head -5 apps/api/src/streamEndpoints.ts → "GET /projects/:projectId/events"}`
- 其他 3 处 EventSource 已正确使用 `API_BASE` 或 `PROJECT_ID`: `{证据: grep -rn "new EventSource(" apps/web/src/ → useSSE.ts:18, useWarRoom.ts:74, ChatPage.tsx:55}`

**修复**: `API_BASE + /projects/${projectId}/events`

---

## 9. explorationEventLog.ts 同步 I/O（难度：低 ★）

**问题**: `ultimate/explorationEventLog.ts` 使用 `appendFileSync` / `existsSync` / `mkdirSync` / `readFileSync`，阻塞事件循环。

**证据**: `{证据: grep -n "Sync" packages/core/src/ultimate/explorationEventLog.ts → 22行import, 217-218行, 265-266行}`

| 行号 | 调用 |
|------|------|
| 22 | `import { appendFileSync, existsSync, mkdirSync, readFileSync }` |
| 217 | `existsSync(this.persistPath)` |
| 218 | `readFileSync(this.persistPath, 'utf-8')` |
| 265 | `existsSync(dir)` → `mkdirSync(dir, ...)` |
| 266 | `appendFileSync(this.persistPath, ...)` |

---

## 10. harnessInfrastructure.ts 单行 existsSync（难度：低 ★）

**问题**: `harnessInfrastructure.ts` 第 454 行调用 `fs.existsSync(fp)`。

**证据**: `{证据: grep -n "existsSync" packages/core/src/harness/harnessInfrastructure.ts → 454}`

**修复**: 单行替换为 `import { access } from 'node:fs/promises'` + try/catch。

---

## 11. 安全路线图文档不同步（难度：极低）

**问题**: `security_architecture_hardening_roadmap.md` 第 29 行（G4）和第 33 行（G8）仍标注为"可立即修复"，但代码中这两项**已实现**。

**证据**:
- G4: `{证据: grep -n "checkMemoryPoisoning\|getMemoryPoisoningDefenseEngine" packages/core/src/runtime/agentRuntime.ts → 125-126 import, 1860+1867/2534+2541 calls}`
- G8: `{证据: grep -n "cpuLimit" packages/core/src/sandbox/types.ts → 38行; grep -n "cpus\|cpu-quota" packages/core/src/sandbox/platforms.ts → 770,998}`

**修复**: 将 G4/G8 从"可立即修复"改为"已实现"，或更新路线图时间线。

---

## 12. @commander/plugin-sdk 零外部消费（难度：极低）

**问题**: `packages/plugin-sdk` 的 `createPlugin()` 只在自身 `index.ts` 中定义和注释中引用，无外部代码调用。

**证据**: `{证据: grep -rn "createPlugin(" packages/ --include="*.ts" | grep -v node_modules | grep -v ".test." | grep -v ".d.ts" → 仅 packages/plugin-sdk/src/index.ts 自引用}`

**注意**: 这不一定需要修复——SDK 设计本为接口规范，当前无外部插件生态是正常的。但这个现状应被正式记录。

---

## 优先修复路线

| 优先级 | 条目 | 预计工时 | 风险 |
|--------|------|----------|------|
| **P0** | 8. LiveMetrics 硬编码 | ~0.5h | 低 |
| **P0** | 11. 安全路线图同步 | ~0.25h | 极低 |
| **P1** | 3. G5 vault 覆盖率 | ~2h | 中 |
| **P1** | 9. explorationEventLog 同步 I/O | ~1h | 低 |
| **P1** | 10. harnessInfrastructure 同步 I/O | ~0.25h | 低 |
| **P2** | 4. @commander/sdk 占位方法 | ~4h | 中 |
| **P2** | 6. _unmounted 决议 | ~1h | 低 |
| **P2** | 7. @deprecated 清理 | ~2h | 低 |
| **P3** | 2. tools/ 28 处异步化 | ~8h | 高 |
| **P3** | 5. harness 行为合并 | ~4h | 中 |
| **P4** | 1. agentRuntime God Object | ~40h+ | 极高 |

---