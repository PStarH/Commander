# 方向一：稳定测试基线 Implementation Plan

> **For agentic workers:** Use `general_purpose_task` subagent to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `pnpm --filter @commander/core test` 全绿，建立可信的回归基线。

**Architecture:** 当前失败主要由 Node ABI 不匹配（better-sqlite3 预编译二进制 vs 本地 Node 26）和一处 checkpoint adapter 逻辑回归导致。本方向先修环境，再修代码，最后清理 vitest 配置中已删除文件的残留引用。

**Tech Stack:** pnpm, Node 22, better-sqlite3, vitest, TypeScript.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `.node-version` | 已指定 Node 22；需确认 CI/本地均遵循 |
| `packages/core/vitest.config.ts` | **MODIFY** — 清理已删除测试文件的注释引用，保留新增安全测试 |
| `packages/core/tests/ultimate/checkpointAdapters.test.ts` | **READ-ONLY** — 用其失败信息定位 bug |
| `packages/core/src/ultimate/checkpointAdapters.ts` | **MODIFY** — 修复 dbPath 重载返回 `not-found` 而非 `seed` 的问题 |

---

## Task 1: 对齐 Node 版本并重建 better-sqlite3

**Files:**
- Read: `.node-version`
- Modify: `packages/core/package.json` (optional — add `engines` stricter pin)

- [ ] **Step 1: 切换本地 Node 到 22 并验证**

Run:
```bash
nvm use 22
node --version
```

Expected: `v22.x.x`。

- [ ] **Step 2: 重新安装依赖以重建原生模块**

Run:
```bash
corepack pnpm install --frozen-lockfile
```

Expected: better-sqlite3 在 Node 22 下重新编译，无 ABI 错误。

- [ ] **Step 3: 跑 storage/ultimate SQLite 测试验证**

Run:
```bash
cd packages/core && corepack pnpm vitest run --no-cache tests/storage/sqliteDriver.test.ts tests/ultimate/workCoordinator.test.ts tests/ultimate/workQueueStore.test.ts
```

Expected: 上述文件全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add .node-version packages/core/package.json pnpm-lock.yaml
git commit -m "chore(dev): pin Node 22 and rebuild better-sqlite3 for ABI compatibility"
```

---

## Task 2: 修复 checkpointAdapters dbPath 重载回归

**Files:**
- Modify: `packages/core/src/ultimate/checkpointAdapters.ts`
- Read: `packages/core/tests/ultimate/checkpointAdapters.test.ts:380-420`

- [ ] **Step 1: 复现失败**

Run:
```bash
cd packages/core && corepack pnpm vitest run --no-cache tests/ultimate/checkpointAdapters.test.ts -t "dbPath overload"
```

Expected: FAIL — `expected 'not-found' to be 'seed'`。

- [ ] **Step 2: 定位 dbPath 重载与 engine 重载差异**

在 `checkpointAdapters.ts` 中找到 `tryResumeFromATR` 的两个重载：
- engine 重载：接受 ATR 引擎，读取已有 checkpoint；
- dbPath 重载：接受字符串路径，自行打开/读取。

对比两者在找不到 runId 时的回退逻辑。dbPath 重载当前直接返回 `{ kind: 'not-found' }`，而 engine 重载会返回 seed checkpoint（`{ kind: 'seed', executorKind: 'goal-round' }`）。

- [ ] **Step 3: 统一行为**

修改 dbPath 重载，使其在数据库不存在或找不到 runId 时，与 engine 重载一致返回 seed checkpoint：

```ts
if (!point) {
  return { kind: 'seed', executorKind: 'goal-round' } as const;
}
```

- [ ] **Step 4: 运行测试**

Run:
```bash
cd packages/core && corepack pnpm vitest run --no-cache tests/ultimate/checkpointAdapters.test.ts
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/ultimate/checkpointAdapters.ts
git commit -m "fix(ultimate): align tryResumeFromATR dbPath overload with engine overload seed fallback"
```

---

## Task 3: 清理 vitest.config.ts 中已删除文件的引用

**Files:**
- Modify: `packages/core/vitest.config.ts`

- [ ] **Step 1: 删除已不存在测试文件的注释行**

删除以下被注释掉的 include 条目（文件已不存在）：
- `'tests/runtime/healthCheck.test.ts'`
- `'tests/runtime/mcpRemoteRuntime.test.ts'`
- `'tests/runtime/toolResultShape.test.ts'`
- `'tests/tools/resourceTools.test.ts'`
- `'tests/memory/resolveSessionProjectId.test.ts'`
- `'tests/security/d31-rotation-signoff-library-api.test.ts'`
- `'tests/security/d32-rotation-signoff-async-api.test.ts'`
- `'tests/security/sandboxVerifier.test.ts'`
- `'tests/security/security-hardening.test.ts'`
- `'tests/harness/mcpHarnessCapabilities.test.ts'`
- `'tests/ultimate/deliberationYear.test.ts'`

- [ ] **Step 2: 保留合理的跳过说明**

保留带明确 bug 说明的跳过项，例如：
- `'tests/security/agentdojoDefense.test.ts'` — 导入符号不存在
- `'tests/runtime/llmCaller.test.ts'` — FallbackChainExhaustedError 未记录样本
- `'tests/ultimate/checkpoint.roundTrip.test.ts'` — checkpoint 未接入 ReliabilityEngine

- [ ] **Step 3: 运行全量测试**

Run:
```bash
corepack pnpm --filter @commander/core test
```

Expected: 全部 PASS（221/221 files）。

- [ ] **Step 4: Commit**

```bash
git add packages/core/vitest.config.ts
git commit -m "chore(test): remove commented includes for deleted test files"
```

---

## Task 4: 提交当前未提交改动（或拆分后提交）

**Files:**
- 多个已修改文件，见 `git status --short`

- [ ] **Step 1: 审查当前改动主题**

运行：
```bash
git diff --stat
```

当前改动大致分为：
1. checkpointWriter 新增测试辅助方法；
2. compensation/runtime 多文件小改；
3. 测试文件调整（async-migration、a2aMtls 等）；
4. python-sdk 新增 advisor/governance 文件；
5. vitest.config.ts 已在上一步处理。

- [ ] **Step 2: 按主题拆分为 2-3 个 commit**

建议：
```bash
# commit 1: checkpoint / compensation 运行时改动 + 测试辅助方法
git add packages/core/src/runtime/checkpointWriter.ts \
  packages/core/src/runtime/compensation*.ts \
  packages/core/src/runtime/samplesStore.ts \
  packages/core/src/runtime/traceStore.ts
git commit -m "feat(runtime): checkpoint triggers, compensation wiring and sample store accessors"

# commit 2: 安全与测试调整
git add packages/core/src/security/litellmPricing.ts \
  packages/core/tests/... # 按实际相关测试文件
git commit -m "test(security): a2a mTLS and runtime integration test alignments"

# commit 3: python-sdk 新增模块
git add packages/python-sdk/src/commander/__init__.py \
  packages/python-sdk/src/commander/advisor.py \
  packages/python-sdk/src/commander/governance.py
git commit -m "feat(python-sdk): add advisor and governance modules"
```

- [ ] **Step 3: 再次跑全量测试**

Run:
```bash
corepack pnpm --filter @commander/core test
```

Expected: 全部 PASS。

---

## Self-Review

- **Spec coverage:** 本计划覆盖了 Node ABI 修复、checkpoint 回归修复、vitest 配置清理、未提交改动提交四个子目标。
- **Placeholder scan:** 无 TBD/TODO；每步含命令或代码。
- **Type consistency:** 仅涉及已存在的 `CheckpointPoint` discriminated union 类型。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-04-stabilize-test-baseline.md`.

**Execution options:**
1. **Subagent-driven** — dispatch `general_purpose_task` subagent per task.
2. **Inline execution** — I run each step in this session.

Which approach do you want for this direction?
