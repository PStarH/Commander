# 方向三：结构性债务清理 Implementation Plan

> **For agentic workers:** Use `general_purpose_task` subagent to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 降低演进风险与维护成本，重点清理死代码、明确标注/实现占位符、统一跨包导入，并为 `agentRuntime.ts` 拆分建立可增量推进的基线。

**Architecture:** 本方向不追求一次性大爆炸重构，而是“先止血、再分层”。先删除确认无引用的死代码（立即见效），再处理伪装成实现的占位符（防止误导调用方），最后整理跨包导入边界。`agentRuntime.ts` 拆分作为独立大项单独跟踪，避免阻塞本方向交付。

**Tech Stack:** TypeScript, vitest, eslint, pnpm workspace。

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/core/src/actor/*` | **DELETE** — 完全孤立 |
| `packages/core/src/ultimate/inspectorAgent.ts` | **DELETE** — 仅被孤立文件引用 |
| `packages/core/src/ultimate/frameworkIntegration.ts` | **DELETE** — 孤立 |
| `packages/core/src/ultimate/adaptiveOrchestrator.ts` | **DELETE** — 半孤立 |
| `packages/core/src/ultimate/company.ts` | **DELETE** — 被 `companyEngine.ts` 替代 |
| `packages/core/src/index.ts` | **MODIFY** — 移除 legacy/experimental 混排，拆分为稳定/实验/legacy 三个入口 |
| `packages/core/src/security/postQuantumCrypto.ts` | **MODIFY** — `generateSharedSecret` 标为未实现或抛出 |
| `packages/core/src/security/adaptiveHitl.ts` | **MODIFY** — `learnWeights` 标为未实现或实现 Thompson Sampling |
| `packages/core/src/security/sandboxVerifier.ts` | **MODIFY** — `resource_limits` 检查返回明确“未验证”状态 |
| `packages/core/src/intelligence/costAggregator.ts` | **MODIFY** — 修复 `promptHits` 死代码三元表达式 |
| `packages/core/src/observability/sloManager.ts` | **MODIFY** — `cost_usd` 硬编码 0 接入真实成本 |
| `packages/observability/*`, `packages/sdk/commanderClient.ts` | **MODIFY** — 跨包相对路径导入改为 `@commander/core` |

---

## Task 1: 死代码清理（Pkg4）

**Files:**
- Delete: `packages/core/src/actor/*`
- Delete: `packages/core/src/ultimate/inspectorAgent.ts`
- Delete: `packages/core/src/ultimate/frameworkIntegration.ts`
- Delete: `packages/core/src/ultimate/adaptiveOrchestrator.ts`
- Delete: `packages/core/src/ultimate/company.ts`（确认 `companyEngine.ts` 已替代）
- Modify: `packages/core/src/index.ts` 移除对应导出
- Modify: `docs/dead-code-and-stubs.md` 更新清单

- [ ] **Step 1: 确认无外部引用**

Run:
```bash
grep -R "from '.*actor/" packages/core/src packages/core/tests || true
grep -R "inspectorAgent\|frameworkIntegration\|adaptiveOrchestrator\|company'" packages/core/src packages/core/tests | grep -v companyEngine
```

Expected: 无命中（或仅在公司文件自身）。

- [ ] **Step 2: 删除文件并清理 index.ts**

```bash
rm -rf packages/core/src/actor
git rm packages/core/src/ultimate/inspectorAgent.ts
git rm packages/core/src/ultimate/frameworkIntegration.ts
git rm packages/core/src/ultimate/adaptiveOrchestrator.ts
git rm packages/core/src/ultimate/company.ts
```

在 `packages/core/src/index.ts` 中移除以上模块的导出。

- [ ] **Step 3: 运行类型检查**

Run:
```bash
corepack pnpm run typecheck
```

Expected: exit 0。

- [ ] **Step 4: 运行全量测试**

Run:
```bash
corepack pnpm --filter @commander/core test
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add docs/dead-code-and-stubs.md
git commit -m "chore(core): remove dead code modules (actor, inspectorAgent, frameworkIntegration, adaptiveOrchestrator, company)"
```

---

## Task 2: 清理 index.ts  barrel 入口

**Files:**
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/src/experimental.ts`（可选）
- Create: `packages/core/src/legacy.ts`（可选）

- [ ] **Step 1: 按稳定度拆分导出**

将 `index.ts` 中标注 `legacy` / `experimental` 的导出拆走：

```ts
// index.ts — 仅保留稳定 API
export { CommanderCore } from './commanderCore';
export * from './runtime/types';
// ...

// legacy.ts
export { LegacyOrchestrator as Orchestrator } from './ultimate/legacyOrchestrator';

// experimental.ts
export { ConsensusEngine } from './consensus/consensusEngine';
```

- [ ] **Step 2: 更新内部引用**

把 `packages/core/src` 内部引用 legacy/experimental 符号的地方改为从 `./legacy` / `./experimental` 导入。

- [ ] **Step 3: 类型检查 + 测试**

Run:
```bash
corepack pnpm run typecheck
corepack pnpm --filter @commander/core test
```

Expected: 全部通过。

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/experimental.ts packages/core/src/legacy.ts
git commit -m "refactor(core): split index.ts into stable, experimental and legacy barrels"
```

---

## Task 3: 处理占位符伪装实现

**Files:**
- Modify: `packages/core/src/security/postQuantumCrypto.ts`
- Modify: `packages/core/src/security/adaptiveHitl.ts`
- Modify: `packages/core/src/security/sandboxVerifier.ts`
- Modify: `packages/core/src/intelligence/costAggregator.ts`
- Modify: `packages/core/src/observability/sloManager.ts`

- [ ] **Step 1: postQuantumCrypto.generateSharedSecret**

当前实现为 HMAC 占位符。改为明确失败：

```ts
export function generateSharedSecret(/* ... */): never {
  throw new Error('ML-KEM shared secret generation is not yet implemented');
}
```

或在类型层面标注：返回类型改为 `never` / 方法标 `@unimplemented`。

- [ ] **Step 2: adaptiveHitl.learnWeights**

若暂不实现，改为：

```ts
learnWeights(): void {
  throw new Error('Adaptive HITL weight learning is not yet implemented');
}
```

并在启用配置处默认 `enableWeightLearning: false`。

- [ ] **Step 3: sandboxVerifier.resource_limits**

将全零结果改为明确状态：

```ts
return {
  pass: 0, fail: 0, skip: 0, error: 0,
  status: 'unverified',
  note: 'Actual cgroup/resource limit enforcement is not verified by this test',
};
```

- [ ] **Step 4: costAggregator promptHits 死代码**

修复三元表达式：

```ts
const promptHits = semanticHitCost > 0 ? actualPromptCacheHits : 0;
```

需确认 `actualPromptCacheHits` 来源（如 metrics counter）。

- [ ] **Step 5: sloManager cost_usd 硬编码**

接入实际成本：

```ts
case 'cost_usd':
  actualValue = getCostModel().calculateTraceCost(trace).totalUsd;
  break;
```

- [ ] **Step 6: 运行相关测试**

Run:
```bash
cd packages/core && corepack pnpm vitest run --no-cache \
  tests/security/postQuantumCrypto.test.ts \
  tests/security/adaptiveHitl.test.ts \
  tests/observability/sloManager.test.ts
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/security/postQuantumCrypto.ts \
  packages/core/src/security/adaptiveHitl.ts \
  packages/core/src/security/sandboxVerifier.ts \
  packages/core/src/intelligence/costAggregator.ts \
  packages/core/src/observability/sloManager.ts
git commit -m "fix(core): surface placeholder implementations instead of returning misleading defaults"
```

---

## Task 4: 统一跨包导入边界

**Files:**
- Modify: `packages/observability/*/timelineBuilder.ts`
- Modify: `packages/observability/*/decisionProvenance.ts`
- Modify: `packages/observability/*/httpRoutes.ts`
- Modify: `packages/observability/*/replay.ts`
- Modify: `packages/observability/*/evalScorer.ts`
- Modify: `packages/sdk/src/commanderClient.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: 在 @commander/core 公共导出 reportSilentFailure**

在 `packages/core/src/index.ts` 中添加：

```ts
export { reportSilentFailure } from './silentFailureReporter';
```

- [ ] **Step 2: 替换 observability 包中的相对路径导入**

将：
```ts
import { reportSilentFailure } from '../../core/src/silentFailureReporter';
```

改为：
```ts
import { reportSilentFailure } from '@commander/core';
```

- [ ] **Step 3: 替换 sdk 中的相对路径导入**

同样处理 `packages/sdk/src/commanderClient.ts`。

- [ ] **Step 4: 类型检查**

Run:
```bash
corepack pnpm run typecheck
```

Expected: exit 0。

- [ ] **Step 5: Commit**

```bash
git add packages/observability packages/sdk/src/commanderClient.ts packages/core/src/index.ts
git commit -m "refactor: replace cross-package relative imports with @commander/core public exports"
```

---

## Task 5: 为 AgentRuntime 拆分建立基线（可选大项，单独跟踪）

**Files:**
- Read: `packages/core/src/runtime/agentRuntime.ts`
- Create: `packages/core/src/runtime/phases/providerRouter.ts`
- Create: `packages/core/src/runtime/phases/executionContext.ts`

- [ ] **Step 1: 提取 ProviderRouter**

将 `agentRuntime.ts` 中重复三次的 provider fallback 链提取到 `runtime/phases/providerRouter.ts`：

```ts
export class ProviderRouter {
  constructor(private registry: ProviderRegistry) {}
  getFirstAvailable(requested?: string): LLMProvider | undefined { /* ... */ }
}
```

- [ ] **Step 2: 提取 ExecutionContext**

将 `slidingWindow`、`governor`、`tools`、`messages` 等 per-run 可变状态封装到 `runtime/phases/executionContext.ts`。

- [ ] **Step 3: 在 agentRuntime.ts 中逐步替换**

先替换 provider fallback 调用点，确保测试通过后再继续下一步。

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/runtime/phases/providerRouter.ts \
  packages/core/src/runtime/phases/executionContext.ts \
  packages/core/src/runtime/agentRuntime.ts
git commit -m "refactor(runtime): extract ProviderRouter and ExecutionContext from agentRuntime"
```

---

## Self-Review

- **Spec coverage:** 覆盖死代码清理、index 拆分、占位符处理、跨包导入、AgentRuntime 拆分基线。
- **Placeholder scan:** 无 TBD；AgentRuntime 拆分为可选大项，明确标注单独跟踪。
- **Compatibility:** 删除死代码前均通过 grep 确认无引用；legacy 导出保留在 `legacy.ts` 中不直接删除。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-04-structural-debt-cleanup.md`.

**Execution options:**
1. **Subagent-driven** — dispatch `general_purpose_task` subagent per task.
2. **Inline execution** — I run each step in this session.

Which approach do you want for this direction?
