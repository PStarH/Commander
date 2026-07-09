# 生产集成修复计划

> **目标**：把架构文档中声称已启用、但实际未接入生产路径的安全与可观测组件真正接线，并消除启动日志中的“虚假幻觉”。

---

## 工作流 1：修复 `serve.ts` 启动日志幻觉并真正启动 Layer 2 组件

**问题**：`packages/core/src/cli/commands/serve.ts` 在启动输出中宣称已激活 `SecurityAnomalyDetector` 和 `OutboundNetworkPolicy`，但 `cmdServe` 从未调用它们的启动函数。

**影响文件**：
- `packages/core/src/cli/commands/serve.ts`
- `packages/core/src/runtime/httpServer.ts`
- `packages/core/src/security/securityAnomalyDetector.ts`（必要时调整启动签名）
- `packages/core/src/security/outboundNetworkPolicy.ts`（必要时调整安装签名）

**任务**：
1. 在 `serve.ts` 的 `cmdServe` 中，调用 `startSecurityAnomalyDetector()` 和 `installOutboundNetworkPolicy()`。
2. 确保 `httpServer.ts` 的启动路径不会重复启动；若需要，将启动点统一放到 `serve.ts`。
3. 启动失败时不应阻塞 server 启动（当前这些组件多为 best-effort），但必须打印真实状态（activated / failed）。
4. 更新启动日志，使其只打印实际已激活的组件。

---

## 工作流 2：将 `ReversibilityGate` 接入工具执行热路径

**问题**：`ReversibilityGate` 只在安全 benchmark 和测试中使用；`ToolExecutionService.execute()` 仅通过 `CompensationService` 评估可逆性并发布 `system.alert`，不会阻断不可逆操作。

**影响文件**：
- `packages/core/src/runtime/toolExecutionService.ts`
- `packages/core/src/security/reversibilityGate.ts`
- `packages/core/src/runtime/serviceInitializer.ts`
- `packages/core/src/runtime/types.ts`（若需要增加配置项）

**任务**：
1. 在 `serviceInitializer.ts` 中创建并配置 `ReversibilityGate`，接入 `ToolApproval` 的审批回调。
2. 在 `ToolExecutionService.execute()`  capability-token 检查之后、`beforeToolResolve` 之前调用 `ReversibilityGate.check()`。
3. 对不可逆工具：若无审批回调或回调拒绝，直接返回 `BLOCKED` 的 `ToolResult`。
4. 保持 benchmark 现有行为：通过 `AgentRuntimeConfig` 提供 `reversibilityGate?: { enabled: boolean; blockWithoutCallback?: boolean }`，benchmark 可显式关闭。
5. 更新现有 `reversibilityGate.test.ts` 和 `agentdojoDefense.test.ts` 保证兼容。

---

## 工作流 3：修复 `ToolApproval` 默认关闭与 capability token 不传问题

**问题**：
- `serviceInitializer.ts` 创建 `ToolOrchestrator` 时 `useApproval: false`。
- `ToolExecutionService.execute()` 有完整 capability token 验证逻辑，但 `AgentRuntime.executeToolCall()` 调用时未传 `capabilityToken`。

**影响文件**：
- `packages/core/src/runtime/serviceInitializer.ts`
- `packages/core/src/runtime/toolOrchestrator.ts`
- `packages/core/src/runtime/agentRuntime.ts`
- `packages/core/src/runtime/toolExecutionService.ts`
- `packages/core/src/runtime/types.ts`

**任务**：
1. 将 `ToolOrchestrator` 的 `useApproval` 默认改为 `true`；允许通过 `AgentRuntimeConfig.toolApproval?.enabled` 关闭。
2. 在 `AgentRuntime` 中为每个 tool call 生成/传递 capability token（若配置启用）。
3. 确保 `ToolExecutionService.execute()` 接收并验证 token。
4. 保持 benchmark 可以通过配置显式关闭审批和 token，避免破坏现有 benchmark。

---

## 工作流 4：修复 `resetMessageBus()` 破坏 `EventSourcingSubscriber`

**问题**：`EventSourcingSubscriber` 在 `serviceInitializer.ts` 中启动并订阅 MessageBus；`resetMessageBus()` 会 dispose 旧 bus，导致 subscriber 订阅的是已被清空的旧实例。

**影响文件**：
- `packages/core/src/runtime/eventSourcingSubscriber.ts`
- `packages/core/src/runtime/messageBus.ts`
- `packages/core/src/runtime/serviceInitializer.ts`
- `packages/core/tests/setup.ts`

**任务**：
1. 让 `EventSourcingSubscriber` 监听 `MessageBus` 的 reset 事件或在 `getMessageBus()` 返回新实例时自动重新订阅。
2. 或在 `resetMessageBus()` 中保留“系统级订阅者”不被清除。
3. 更新 `tests/setup.ts` 的 reset 逻辑，避免测试隔离破坏 WAL 事件流。
4. 为 `EventSourcingSubscriber` 添加 `restart()` 方法，便于 benchmark 在 reset 后恢复订阅。

---

## 工作流 5：补齐 `.env.example` 关键环境变量

**问题**：`.env.example` 缺少 `COMMANDER_EVENT_SOURCING_WAL`、`COMMANDER_LOG_PERSIST`、`COMMANDER_CAPABILITY_TOKEN_KEY` 等关键变量，operator 不知道需要配置。

**影响文件**：
- `.env.example`

**任务**：
1. 添加 `COMMANDER_EVENT_SOURCING_WAL`（默认 `.commander_state/event-sourcing.wal`）。
2. 添加 `COMMANDER_LOG_PERSIST=true/false` 并注释说明默认关闭。
3. 添加 `COMMANDER_CAPABILITY_TOKEN_KEY` 并说明生产环境需要 ≥32 字符。
4. 添加 `OTEL_EXPORTER_OTLP_ENDPOINT` 与启用说明（取消注释状态）。

---

## 工作流 6：验证与回归测试

**命令**：
```bash
pnpm run build:core
pnpm run test:core
pnpm run lint
```

**任务**：
1. 每次工作流修改后运行 `pnpm run build:core` 检查 TypeScript。
2. 重点运行安全相关测试：
   ```bash
   cd packages/core && npx vitest run tests/security/reversibilityGate.test.ts
   cd packages/core && npx vitest run tests/security/agentdojoDefense.test.ts
   cd packages/core && npx vitest run tests/runtime/toolExecutionService.test.ts
   cd packages/core && npx vitest run tests/runtime/serviceInitializer.test.ts
   ```
3. 运行 chaos benchmark 快速模式验证无回归：
   ```bash
   pnpm run benchmark:chaos
   ```
4. 提交：每个工作流独立 commit，使用 conventional commits。

---

## 后续可选（超出本次范围）

- 在 `apps/api/src/index.ts` 挂载 `ZeroTrust` 中间件。
- 将 `ShadowProxy` 接入 `apps/api` 的请求 mirror 路径。
- 为 MCP 命令实现运行时白名单并禁止 `npx`。
- 将 `UniversalSanitizer` 接入 LLM/工具输入边界。
- 将 `ResourceGovernor` 接入所有外部调用。
- 将 `IntegrityLayer` 扩展到 WAL 以外的持久化数据。
