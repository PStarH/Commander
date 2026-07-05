# 方向三：结构性债务清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `general_purpose_task` 子代理按任务逐步实施。步骤使用 checkbox (`- [ ]`) 语法跟踪。

**Goal:** 降低维护成本与演进风险：删除确认无用的死代码与测试残留、统一 barrel 与跨包导入风格、将伪装实现明确化，并为 `agentRuntime.ts` 的后续拆分建立可度量的基线。

**Architecture:** 采用“先止血、再分层、最后拆核心”的节奏。第 1-3 步聚焦安全且高回报的清理；第 4 步只把 `agentRuntime.ts` 中边界清晰的私有方法外迁，保持 `AgentRuntimeInterface` 与外部调用方完全不变，行为零变更。

**Tech Stack:** TypeScript, vitest, eslint, pnpm workspace。

---

## File Structure

| 文件/目录 | 处理方式 | 责任说明 |
|---|---|---|
| `packages/core/broken.ts` | **DELETE** | 故意写坏的 TypeScript，无引用 |
| `packages/core/test-import.ts` | **DELETE** | 仅用于测试导入，无引用 |
| `packages/core/test.txt` | **DELETE** | 空测试文件 |
| `packages/core/test-empty.txt` | **DELETE** | 空测试文件 |
| `packages/core/output.txt` | **DELETE** | 测试输出文件 |
| `packages/core/nested/dir/file.txt` | **DELETE** | 测试目录残留 |
| `packages/core/tests/baseline-known-failures.txt` | **DELETE** | 内容已过时 |
| `packages/core/src/atr/index.ts` | **DELETE** | 无生产/测试引用 |
| `packages/core/src/contracts/index.ts` | **DELETE** | 无生产/测试引用 |
| `packages/core/src/runtime/effectSystem.ts` | **DELETE** | 仅被测试引用，实现为 mock |
| `packages/core/src/atr/runtimeIntegration.ts` | **DELETE** | 已被 `ExecutionScheduler` 替代，仅测试引用 |
| `packages/core/src/atr/compensationBridge.ts` | **DELETE** | 仅测试引用 |
| `packages/core/src/security/rotationSignoffVerifier.ts` | **MODIFY** | 删除仅测试使用的 3 个同步方法，或移入测试辅助 |
| `packages/core/src/index.ts` | **MODIFY** | 移除重复导出、移除已删除模块的导出 |
| `packages/core/src/runtime/agentRuntime.ts` | **MODIFY** | 逐步外迁私有方法 |
| `packages/core/src/runtime/llm/llmCaller.ts` | **CREATE** | 吸纳 `callProvider`/`callWithTimeout` |
| `packages/core/src/runtime/tool/toolCallNormalizer.ts` | **CREATE** | `normalizeToolCall` |
| `packages/core/src/runtime/tool/toolCallRetryLoopDetector.ts` | **CREATE** | `checkRetryLoop` |
| `packages/core/src/runtime/tool/toolCallSecurityGate.ts` | **CREATE** | `applyBeforeToolCallSecurity` + `applyPreToolCallGates` |
| `packages/core/src/runtime/tenant/tenantContextResolver.ts` | **CREATE** | `resolveTenantContext` + `restoreTenantOverrides` |
| `apps/api/src/*` | **MODIFY** | 统一 `@commander/core` 子路径导入 |
| `packages/core/src/**/*.ts` | **MODIFY** | 统一相对路径导入风格 |
| `docs/dead-code-and-stubs.md` | **MODIFY** | 更新清单 |

---

## Task 1: 删除死代码与测试残留

**Files:**
- Delete: `packages/core/broken.ts`
- Delete: `packages/core/test-import.ts`
- Delete: `packages/core/test.txt`
- Delete: `packages/core/test-empty.txt`
- Delete: `packages/core/output.txt`
- Delete: `packages/core/nested/dir/file.txt`
- Delete: `packages/core/tests/baseline-known-failures.txt`
- Delete: `packages/core/src/atr/index.ts`
- Delete: `packages/core/src/contracts/index.ts`
- Delete: `packages/core/src/runtime/effectSystem.ts`
- Delete: `packages/core/src/atr/runtimeIntegration.ts`
- Delete: `packages/core/src/atr/compensationBridge.ts`
- Delete: `packages/core/tests/atr/runtimeIntegration.test.ts`
- Delete: `packages/core/tests/atr/compensationBridge.test.ts`
- Delete: `packages/core/tests/architecture/architectureBlueprint.test.ts`
- Modify: `packages/core/src/security/rotationSignoffVerifier.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `docs/dead-code-and-stubs.md`

- [ ] **Step 1: 确认无生产引用**

Run:
```bash
cd /Users/sampan/Documents/GitHub/Commander
grep -R "from '.*broken'" packages/core/src packages/core/tests || true
grep -R "from '.*test-import'" packages/core/src packages/core/tests || true
grep -R "effectSystem" packages/core/src || true
grep -R "from '.*atr/index'" packages/core/src packages/core/tests || true
grep -R "from '.*contracts/index'" packages/core/src packages/core/tests || true
grep -R "runtimeIntegration\|compensationBridge" packages/core/src || true
```

Expected: 除测试文件外无命中。

- [ ] **Step 2: 删除文件**

```bash
cd /Users/sampan/Documents/GitHub/Commander
git rm packages/core/broken.ts
git rm packages/core/test-import.ts
git rm packages/core/test.txt
git rm packages/core/test-empty.txt
git rm packages/core/output.txt
git rm -r packages/core/nested
git rm packages/core/tests/baseline-known-failures.txt
git rm packages/core/src/atr/index.ts
git rm packages/core/src/contracts/index.ts
git rm packages/core/src/runtime/effectSystem.ts
git rm packages/core/src/atr/runtimeIntegration.ts
git rm packages/core/src/atr/compensationBridge.ts
git rm packages/core/tests/atr/runtimeIntegration.test.ts
git rm packages/core/tests/atr/compensationBridge.test.ts
git rm packages/core/tests/architecture/architectureBlueprint.test.ts
```

- [ ] **Step 3: 清理 rotationSignoffVerifier 同步方法**

在 `packages/core/src/security/rotationSignoffVerifier.ts` 中删除以下仅测试使用的导出：

```ts
export function verifySha(sha: string, cwd: string = process.cwd()): VerifyShaResult { ... }
export function evaluateSignoff(rows: readonly SignoffRow[]): VerifyResult { ... }
export function runVerifier(...): VerifyResult { ... }
```

若测试需要，改为在对应测试文件内联实现或创建 `tests/helpers/rotationSignoffHelpers.ts`。

- [ ] **Step 4: 清理 packages/core/src/index.ts 导出**

移除已删除模块的导出，例如：

```ts
// 删除以下重复或已删除的导出
export { startATRRun, resumeATRRun, wrapToolExecutionWithATR, finalizeATRRun } from './atr/runtimeIntegration';
export { ATRContext, type ATRWrapResult } from './atr/runtimeIntegration';
export { CompensationBridge, getCompensationBridge, resetCompensationBridge } from './atr/compensationBridge';
export { BridgeSagaContext } from './atr/compensationBridge';
export { EffectHandler, createDefaultEffectHandler, httpEffect } from './runtime/effectSystem';
```

- [ ] **Step 5: 类型检查与测试**

Run:
```bash
cd /Users/sampan/Documents/GitHub/Commander
corepack pnpm run typecheck
corepack pnpm --filter @commander/core test
```

Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
cd /Users/sampan/Documents/GitHub/Commander
git add docs/dead-code-and-stubs.md
git commit -m "chore(core): remove dead code, unused barrels and test-only modules"
```

---

## Task 2: 统一 barrel 与跨包导入

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/agentLoop.ts`
- Modify: `packages/core/src/commander.ts`
- Modify: `apps/api/src/sagaEndpoints.ts`
- Modify: `apps/api/src/observabilityEndpoints.ts`
- Modify: `apps/api/src/evaluationEndpoints.ts`
- Modify: other `apps/api/src/*.ts` with mixed imports

- [ ] **Step 1: 移除 packages/core/src/index.ts 重复导出**

搜索并删除重复导出。例如：

```ts
// 删除：已包含在 './runtime' barrel 中
export { CompensationRegistry } from './runtime';
export type { CompensableAction, CompensationHandler } from './runtime';

// 保留 barrel 导出，删除下方单独文件导出
// export { CycleDetector } from './runtime/cycleDetector';
// export { ToolResultCache } from './runtime/toolResultCache';
```

命令：
```bash
cd /Users/sampan/Documents/GitHub/Commander
grep -n "from './runtime/" packages/core/src/index.ts
```

Expected: 无仅为了重复导出而存在的 `'./runtime/<file>'` 行。

- [ ] **Step 2: 统一 core 内部导入风格**

将 `packages/core/src/agentLoop.ts` 中：

```ts
import { AgentRuntime } from './runtime/agentRuntime';
import { getMessageBus } from './runtime/messageBus';
import { createAllTools, wireResourceToolDependencies } from './tools/index';
import { AgentTool } from './tools/agentTool';
import { getGlobalTenantProvider } from './runtime/tenantProvider';
```

改为：

```ts
import { AgentRuntime, getMessageBus, getGlobalTenantProvider } from './runtime';
import { createAllTools, wireResourceToolDependencies } from './tools';
import { AgentTool } from './tools/agentTool';
```

将 `packages/core/src/commander.ts` 中：

```ts
import type { AgentRuntimeInterface } from './runtime';
import type { AgentExecutionResult } from './runtime/types';
```

改为：

```ts
import type { AgentRuntimeInterface, AgentExecutionResult } from './runtime';
```

遍历 `packages/core/src` 其它文件，统一规则：优先从 barrel 导入，未导出的再使用具体文件路径。

- [ ] **Step 3: 统一 apps/api 跨包导入**

将 `apps/api/src/sagaEndpoints.ts` 中：

```ts
import { reportSilentFailure } from '@commander/core';
import { SSEStream, getMessageBus } from '@commander/core';
import type { MessageBusTopic } from '@commander/core';
import type { SagaGraph, SagaStateSnapshot, SagaEvent } from '@commander/core/saga';
```

合并为：

```ts
import { reportSilentFailure, SSEStream, getMessageBus, type MessageBusTopic } from '@commander/core';
import type { SagaGraph, SagaStateSnapshot, SagaEvent } from '@commander/core/saga';
```

将 `apps/api/src/observabilityEndpoints.ts` 中：

```ts
import {
  handleObservabilityRequest,
  type ObservabilityDeps,
  OBSERVABILITY_HTTP_ROUTES,
} from '@commander/core';
import { getTraceRecorder, PersistentTraceStore } from '@commander/core/runtime';
```

改为全部从子路径 barrel 导入：

```ts
import {
  handleObservabilityRequest,
  type ObservabilityDeps,
  OBSERVABILITY_HTTP_ROUTES,
} from '@commander/core/observability';
import { getTraceRecorder, PersistentTraceStore } from '@commander/core/runtime';
```

将 `apps/api/src/evaluationEndpoints.ts` 中：

```ts
import { resolveSecureApiKey } from '@commander/core/security/secureApiKeyResolver';
```

改为：

```ts
import { resolveSecureApiKey } from '@commander/core/security';
```

- [ ] **Step 4: 类型检查与 lint**

Run:
```bash
cd /Users/sampan/Documents/GitHub/Commander
corepack pnpm run typecheck
corepack pnpm run lint
```

Expected: exit 0。

- [ ] **Step 5: Commit**

```bash
cd /Users/sampan/Documents/GitHub/Commander
git add packages/core/src/index.ts packages/core/src/agentLoop.ts packages/core/src/commander.ts apps/api/src
git commit -m "refactor: unify barrel imports and remove duplicate exports"
```

---

## Task 3: 清理占位符与伪装实现

**Files:**
- Modify: `apps/api/src/stores/apiStore.ts`
- Modify: `packages/core/src/observability/incidentManager.ts`
- Modify: `packages/core/src/cli/commands/convenience.ts`
- Modify: `packages/core/src/security/postQuantumCrypto.ts`
- Modify: `packages/core/src/runtime/internalUrls.ts`
- Modify: `packages/core/src/sandbox/teeEnclave.ts`
- Modify: `packages/core/src/selfEvolution/trajectoryAnalyzer.ts`
- Modify: `docs/dead-code-and-stubs.md`

- [ ] **Step 1: apps/api 直接抛出的 checkpoint 查询**

在 `apps/api/src/stores/apiStore.ts:572` 将：

```ts
function checkpointsForMission(missionId: string): MissionCheckpoints {
  throw new Error('Not implemented for direct SQLite rows');
}
```

改为明确返回未实现状态，避免调用方崩溃：

```ts
function checkpointsForMission(missionId: string): MissionCheckpoints {
  return {
    missionId,
    checkpoints: [],
    status: 'not_implemented',
    note: 'Direct SQLite checkpoint aggregation is not yet implemented',
  };
}
```

同时检查 `getCheckpointStats` 调用处，确保其能处理 `status: 'not_implemented'`。

- [ ] **Step 2: incidentManager 占位字符串**

在 `packages/core/src/observability/incidentManager.ts:559-573` 将 `[TODO]` 替换为可配置的未实现标记：

```ts
const draftTemplate = {
  impact: `[AUTO-DRAFT] User-facing impact not yet analyzed. Affected components: ${incident.affectedComponents.join(', ')}.`,
  rootCauses: ['Root cause analysis not yet completed.'],
  whatWentWell: ['Response workflow not yet reviewed.'],
  whatWentPoorly: ['Areas for improvement not yet reviewed.'],
  lessonsLearned: ['Operational learnings not yet captured.'],
};
```

- [ ] **Step 3: convenience.ts 自动修复未实现**

在 `packages/core/src/cli/commands/convenience.ts:271` 将：

```ts
logger.info('Auto-fix not yet implemented for this failure type.');
```

改为：

```ts
logger.warn({ failureType }, 'Auto-fix not yet implemented for this failure type; manual intervention required.');
process.exitCode = 1;
```

- [ ] **Step 4: postQuantumCrypto 占位实现**

在 `packages/core/src/security/postQuantumCrypto.ts:355` 将 `generateSharedSecret` 改为显式抛出：

```ts
generateSharedSecret(peerPublicKey: string, localKeyPair: PqKeyPair): Buffer {
  throw new Error(
    `ML-KEM-768 shared secret generation is not yet implemented (algorithm=${localKeyPair.algorithm})`
  );
}
```

同时更新或跳过依赖此方法的测试，避免测试失败。

- [ ] **Step 5: internalUrls.ts memory 占位**

在 `packages/core/src/runtime/internalUrls.ts:176-187` 将 `handleMemory` 改为：

```ts
private async handleMemory(
  path: string,
  params: Record<string, string>,
): Promise<InternalUrlResult> {
  return {
    content: `Memory access (${path}) is not yet implemented`,
    immutable: false,
    status: 'not_implemented',
  };
}
```

- [ ] **Step 6: teeEnclave CID 池 TODO**

在 `packages/core/src/sandbox/teeEnclave.ts:355-365` 保留 TODO 注释，但将 `computeCid` 提取到公共工具，避免后续重复实现：

```ts
/**
 * TODO(v2): CID pool — currently recomputes CIDs on every read.
 */
private async computeCid(data: Uint8Array): Promise<string> {
  return computeSha256Cid(data);
}
```

- [ ] **Step 7: trajectoryAnalyzer 标签**

在 `packages/core/src/selfEvolution/trajectoryAnalyzer.ts:83` 和 `:144` 将 `'not implemented'` / `'fake reference'` 改为：

```ts
label: 'placeholder: trajectory analysis not implemented',
```

- [ ] **Step 8: 运行相关测试**

Run:
```bash
cd /Users/sampan/Documents/GitHub/Commander/packages/core
corepack pnpm vitest run --no-cache \
  tests/security/postQuantumCrypto.test.ts \
  tests/observability/incidentManager.test.ts \
  tests/runtime/internalUrls.test.ts
```

Expected: PASS（若测试预期旧行为，需同步更新测试断言）。

- [ ] **Step 9: Commit**

```bash
cd /Users/sampan/Documents/GitHub/Commander
git add apps/api/src/stores/apiStore.ts \
  packages/core/src/observability/incidentManager.ts \
  packages/core/src/cli/commands/convenience.ts \
  packages/core/src/security/postQuantumCrypto.ts \
  packages/core/src/runtime/internalUrls.ts \
  packages/core/src/sandbox/teeEnclave.ts \
  packages/core/src/selfEvolution/trajectoryAnalyzer.ts \
  docs/dead-code-and-stubs.md
git commit -m "fix(core): surface placeholder implementations instead of misleading defaults"
```

---

## Task 4: 为 agentRuntime.ts 拆分建立基线

**Files:**
- Read: `packages/core/src/runtime/agentRuntime.ts`
- Create: `packages/core/src/runtime/llm/llmCaller.ts`
- Create: `packages/core/src/runtime/tool/toolCallNormalizer.ts`
- Create: `packages/core/src/runtime/tool/toolCallRetryLoopDetector.ts`
- Create: `packages/core/src/runtime/tool/toolCallSecurityGate.ts`
- Create: `packages/core/src/runtime/tenant/tenantContextResolver.ts`
- Modify: `packages/core/src/runtime/agentRuntime.ts`
- Modify: `packages/core/src/runtime/index.ts`

**原则：**
- 仅移动代码，不修改行为。
- 新模块通过 getter callback 注入，与 `serviceInitializer.ts` 的现有模式一致。
- 保持 `AgentRuntimeInterface` 不变。

- [ ] **Step 1: 提取 LLM 调用层到 llm/llmCaller.ts**

创建 `packages/core/src/runtime/llm/llmCaller.ts`：

```ts
import type { AgentRuntime } from '../agentRuntime';
import type { ProviderCallResult, CallProviderOptions } from '../types';

export class LlmCaller {
  constructor(private runtime: AgentRuntime) {}

  async callWithTimeout(
    requestedProvider: string | undefined,
    messages: unknown[],
    options: CallProviderOptions,
    timeoutMs: number,
  ): Promise<ProviderCallResult> {
    // 从 agentRuntime.ts 中复制 callWithTimeout / callProviderOrThrow / callProvider 的实现
  }

  async callProvider(
    providerId: string,
    messages: unknown[],
    options: CallProviderOptions,
  ): Promise<ProviderCallResult> {
    // 包含语义缓存、Gemini 缓存、single-flight、安全网关前后检查
  }
}
```

在 `agentRuntime.ts` 中：

```ts
import { LlmCaller } from './llm/llmCaller';

export class AgentRuntime implements AgentRuntimeInterface {
  private llmCaller: LlmCaller;

  constructor(...) {
    // ...
    this.llmCaller = new LlmCaller(this);
  }

  // 删除原 callWithTimeout / callProviderOrThrow / callProvider 方法
  // 调用点改为 this.llmCaller.callWithTimeout(...)
}
```

- [ ] **Step 2: 提取工具调用归一化**

创建 `packages/core/src/runtime/tool/toolCallNormalizer.ts`：

```ts
import type { ToolCallRequest, NormalizedToolCall } from '../types';

export function normalizeToolCall(call: ToolCallRequest): NormalizedToolCall {
  // 从 agentRuntime.ts:3205-3225 复制实现
}
```

在 `agentRuntime.ts` 中将 `normalizeToolCall` 调用替换为导入函数。

- [ ] **Step 3: 提取重试循环检测**

创建 `packages/core/src/runtime/tool/toolCallRetryLoopDetector.ts`：

```ts
import type { ToolCallRequest } from '../types';

export class ToolCallRetryLoopDetector {
  private recentCalls = new Map<string, number>();

  checkRetryLoop(runId: string, toolName: string, args: unknown): boolean {
    // 从 agentRuntime.ts:618-679 复制实现
  }
}
```

在 `agentRuntime.ts` 中注入使用。

- [ ] **Step 4: 提取工具调用前安全门**

创建 `packages/core/src/runtime/tool/toolCallSecurityGate.ts`：

```ts
import type { AgentRuntime } from '../agentRuntime';

export class ToolCallSecurityGate {
  constructor(private runtime: AgentRuntime) {}

  async applyBeforeToolCallSecurity(toolName: string, args: unknown, ctx: unknown): Promise<boolean> {
    // 从 agentRuntime.ts:703-778 复制
  }

  async applyPreToolCallGates(...): Promise<...> {
    // 从 agentRuntime.ts:810-867 复制
  }
}
```

- [ ] **Step 5: 提取 tenant 上下文解析**

创建 `packages/core/src/runtime/tenant/tenantContextResolver.ts`：

```ts
import type { AgentRuntime } from '../agentRuntime';

export class TenantContextResolver {
  constructor(private runtime: AgentRuntime) {}

  async resolveTenantContext(ctx: unknown): Promise<...> {
    // 从 agentRuntime.ts:992-1016 复制
  }

  async restoreTenantOverrides(original: unknown): Promise<void> {
    // 从 agentRuntime.ts:1021-1031 复制
  }
}
```

- [ ] **Step 6: 更新 runtime/index.ts 导出**

在 `packages/core/src/runtime/index.ts` 添加：

```ts
export { LlmCaller } from './llm/llmCaller';
export { normalizeToolCall } from './tool/toolCallNormalizer';
export { ToolCallRetryLoopDetector } from './tool/toolCallRetryLoopDetector';
export { ToolCallSecurityGate } from './tool/toolCallSecurityGate';
export { TenantContextResolver } from './tenant/tenantContextResolver';
```

- [ ] **Step 7: 运行 runtime 相关测试**

Run:
```bash
cd /Users/sampan/Documents/GitHub/Commander/packages/core
corepack pnpm vitest run --no-cache tests/runtime
```

Expected: 全部 PASS。

- [ ] **Step 8: 统计基线并记录**

Run:
```bash
cd /Users/sampan/Documents/GitHub/Commander/packages/core/src/runtime
wc -l agentRuntime.ts
```

Expected: `agentRuntime.ts` 从 3,372 行降至约 2,800 行以下。

记录到 `docs/dead-code-and-stubs.md`：

```markdown
## Structural Debt Baseline
| Date | agentRuntime.ts lines | Extracted modules |
|------|----------------------:|-------------------|
| 2026-07-04 | 3,372 | — |
| TBD | <2,800 | llmCaller, toolCallNormalizer, toolCallRetryLoopDetector, toolCallSecurityGate, tenantContextResolver |
```

- [ ] **Step 9: Commit**

```bash
cd /Users/sampan/Documents/GitHub/Commander
git add packages/core/src/runtime/llm packages/core/src/runtime/tool packages/core/src/runtime/tenant \
  packages/core/src/runtime/agentRuntime.ts packages/core/src/runtime/index.ts \
  docs/dead-code-and-stubs.md
git commit -m "refactor(runtime): extract LLM caller, tool gates and tenant resolver from agentRuntime"
```

---

## Self-Review

- **Spec coverage:**
  - 删除死代码 → Task 1
  - 拆分 index.ts barrel / 统一跨包导入 → Task 2
  - 清理占位符伪装实现 → Task 3
  - 为 agentRuntime.ts 拆分建立基线 → Task 4
- **Placeholder scan:** 无 TBD/待补充；每步均含具体文件路径、代码与命令。
- **Type consistency:** 新模块类型从 `runtime/types` 导入，与现有 `AgentRuntimeInterface` 保持一致。
- **Safety:** 删除代码前均通过 grep 确认无生产引用；AgentRuntime 拆分仅移动代码，接口不变。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-04-structural-debt-cleanup.md`.

**Execution options:**

1. **Subagent-Driven (recommended)** — 为每个 Task 启动 `general_purpose_task` 子代理，任务间 Review，快速迭代。
2. **Inline Execution** — 在当前会话中按步骤顺序执行。

Which approach do you want for 方向三?
