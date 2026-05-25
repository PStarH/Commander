# Commander — Tool Calling 执行计划 (Metis 级分析)

> 基于竞品差距报告的系统化可执行计划
> 日期: 2026-05-22

---

## 1. 隐藏风险分析

### 风险矩阵

| # | 风险 | 影响 | 概率 | 缓解策略 |
|---|------|------|------|---------|
| R1 | **Seatbelt/Landlock 跨平台兼容性** — macOS 和 Linux 沙箱 API 完全不同，各自有独特限制 | Sprint 1 范围膨胀 2x | 高 | 先做 Docker 沙箱（跨平台），OS 原生作为增量优化 |
| R2 | **MCP Server 的协议边界** — Commander 内部使用 `Tool` 接口，MCP 需要 JSON-RPC 序列化/反序列化 | Sprint 2 核心复杂度 | 高 | 复用已有的 `mcpToolAdapter.ts` 反向模式，已有 JSON-RPC 基础设施 |
| R3 | **子Agent隔离破坏现有 multi-tenant 架构** — 当前 AgentTool 共享全局工具注册表 | Sprint 2 回归风险 | 中 | 严格单元测试覆盖现有 multi-tenant 行为不变 |
| R4 | **SSH 后端引入安全漏洞** — 远程命令执行、密钥管理 | Sprint 3 安全 | 高 | 使用现有 sandbox profile 包装，禁止明文密钥 |
| R5 | **70+ 工具的维护成本** — 每个工具需要 schema、测试、文档 | 长期 | 中 | 优先替换 Hermes 的 `execute_code` RPC 模式（LLM 写脚本调用工具），比堆积工具数量更 scalable |
| R6 | **流式工具事件与现有 Bus 系统冲突** — 当前 `tool.executed` topic 可能重命名 | Sprint 4 架构 | 中 | 向后兼容：旧 topic 继续 emit，新 streaming 作为附加事件 |
| R7 | **Context compaction 破坏 prompt cache** — 压缩后 cache key 变化导致 cache miss | Sprint 4 | 中 | 压缩后自动 reprompt 重建 cache，或用 encrypted content item（类似 Codex） |
| R8 | **BFCL 99% 不现实** — 91.4%→99% 需要 7.6% 提升，工具定义优化最多贡献 3-5% | 长期 | 高 | 将目标设为 96-97%（仍为行业第一），99% 作为愿景目标 |

### 关键假设检验

| 假设 | 真实性 | 说明 |
|------|--------|------|
| "DAG 规划优于纯顺序执行" | ✅ 真 | 竞品采用顺序执行是 deliberate choice（依赖保证），不是技术限制 |
| "工具缓存是纯优势" | ⚠️ 有条件 | 缓存一致性是挑战：LLM 可能依赖"当前"文件状态 |
| "更多工具 = 更好" | ⚠️ 有条件 | Hermes 70+ 工具但 BFCL 89.5% 低于我们 91.4%，质量 > 数量 |
| "OS 沙箱比 profile 沙箱更安全" | ✅ 真 | Codex 的 Seatbelt/Landlock 是 OS 级强制，我们的 profile 是自实现 |

---

## 2. Sprint 逐项分析

### Sprint 1: OS 级沙箱

| 任务 | 工作量 | 隐藏复杂度 | 依赖 | 最简单方案 |
|------|--------|-----------|------|-----------|
| Docker 沙箱 Profile | **S** (2-3天) | 低 — `sandbox/manager.ts` 已有抽象接口 | 无 | 新增 `DockerSandbox` 实现 `PlatformSandbox`，映射现有 3 profiles |
| macOS Seatbelt Profile | **M** (5天) | 中 — 需要学习 `sandbox-exec` 语法，每个 profile 写 `.sb` 文件 | 无 | 为 3 个 profile 各写一个 .sb 模板，`SandboxManager` 检测 Darwin 自动应用 |
| Linux Landlock Profile | **M** (5天) | 中 — Landlock ABI 版本差异，检测可用性 | 无 | 使用 `landlock_create_ruleset` syscall 检测，按 ABI 版本降级 |
| Profile → OS Policy 映射 | **S** (1天) | 低 | 依赖前三项 | `SandboxManager.selectProfile()` 自动选择最优实现：OS原生 > Docker > noop |

**建议**: 先做 Docker（跨平台，立即可用），再做 Seatbelt（macOS 用户多），Landlock 排最后。

### Sprint 2: MCP Server + 子Agent 隔离

| 任务 | 工作量 | 隐藏复杂度 | 依赖 | 最简单方案 |
|------|--------|-----------|------|-----------|
| MCP Server | **M** (5天) | 中 — 需要决定暴露哪些 Commander 工具作为 MCP tools | Sprint 1 (sandbox 保护 MCP 调用) | 新增 `mcpServerTool.ts`，反向使用 `MCPToolAdapter` 模式：`Tool → MCPTool` |
| 子Agent 工具白名单 | **M** (5天) | 中 — AgentExecutionContext.availableTools 已有但不够细粒度 | 无 | AgentConfig 加 `allowedTools: string[]`，`AgentTool` 执行前做交集运算 |
| 执行通道 (Lanes) | **L** (8天) | 高 — 需要修改 agentRuntime.execute() 的并发模型 | 子Agent 白名单 | 新增 `ExecutionLane` 枚举，`AgentRuntime` 按 lane 管理 concurrency slot |
| AgentTool 上下文隔离 | **M** (5天) | 中 — 现有 AgentTool 传递 `contextData` 但不隔离 message history | 执行通道 | 子Agent 每次调用创建独立的 `AgentExecutionContext`，不与父级共享消息历史 |

**风险**: 执行通道改动 agentRuntime 并发模型，需要充分的回归测试覆盖。

### Sprint 3: 多终端后端 + 插件 Hooks

| 任务 | 工作量 | 隐藏复杂度 | 依赖 | 最简单方案 |
|------|--------|-----------|------|-----------|
| SSH 执行后端 | **L** (8天) | 高 — SSH 连接池、密钥管理、 session 复用、超时 | 无 | `ssh2` npm 包实现 `PlatformSandbox`，复用 sandbox profile 限制 |
| Docker 执行后端 | **M** (5天) | 中 — dockerode 包装，镜像管理 | Sprint 1 Docker sandbox (复用) | 新增 `DockerExecSandbox` implements `PlatformSandbox` |
| 10+ 新 Plugin Hook 点 | **M** (5天) | 中 — 需要枚举所有生命周期阶段 | 无 | 在现有 `HookManager.ts` 加：beforeToolResolve, afterToolResolve, beforeContextCompaction, afterContextCompaction, onSessionFork, onSessionArchive, beforeToolRetry, afterToolRetry |
| PreToolUse/PostToolUse | **M** (5天) | 中 — 需要拦截器模式，支持短路 | Plugin hooks | 新增 `ToolInterceptor` 类，hook 返回 `{ action: 'allow' | 'deny' | 'modify', modifiedArgs? }` |

**注意**: SSH 后端是安全敏感项，必须使用现有 sandbox profile 的 envVarDenyList 过滤环境变量。

### Sprint 4: 流式事件 + UX 改进

| 任务 | 工作量 | 隐藏复杂度 | 依赖 | 最简单方案 |
|------|--------|-----------|------|-----------|
| 工具生命周期流式事件 | **M** (5天) | 中 — 在 agentRuntime.execute() 的工具循环中 emit start/delta/complete | 无 | 新增 `ToolLifecycleStream` 类，通过 messageBus emit 结构化事件 |
| Token-aware 截断 | **S** (2天) | 低 — 已有 maxOutputSize 机制 | 无 | 修改 `ToolResult.output` 截断逻辑：保留头 N 行 + 尾 M 行 |
| Web GUI 工具事件可视化 | **M** (5天) | 中 — 前端组件开发 | 工具生命周期事件 | 在 `apps/web/` 添加 ToolEventPanel 组件，订阅新的事件流 |
| 5 阶段 Context Compaction | **L** (8天) | 高 — 需要实现 budget→snip→micro→collapse→auto 流水线 | 无 | 在 `ContextCompactor` 中新增多阶段 pipeline，每个阶段可配置启用/禁用 |

**Context Compaction 复杂度最高** — 需要参考 Claude Code 的 5 阶段设计，但可以用更轻量的实现。

---

## 3. 依赖图

```
Sprint 1                   Sprint 2                Sprint 3                Sprint 4
─────────                  ─────────               ─────────               ─────────
Docker Sandbox ─────────┐  MCP Server              SSH Backend             Tool Lifecycle Events
Seatbelt Profile        │  Sub-agent Whitelist ─┐  Docker Backend          Token-aware Truncation
Landlock Profile        │  Execution Lanes ─────┤  10+ Plugin Hooks ────┐  Web GUI Visualization
Profile→OS Mapping ────┘  AgentTool Isolation ──┘  PreToolUse/PostTool ─┘  Context Compaction Pipeline
                              ↑                          ↑
                         Docker Sandbox             Plugin Hooks
                         (Sprint 1)                 (Sprint 3, 先做)
```

**关键路径**: Docker Sandbox → MCP Server 是阻塞关系（MCP Server 需要 sandbox 保护）。
其他大部分可以并行。

**并行化建议**:
- Sprint 1 Docker + Sprint 2 子Agent 白名单可以并行（无依赖）
- Sprint 3 SSH/Docker 后端可以并行
- Sprint 4 所有四项可以并行

---

## 4. 优先级调整建议

### 升优先级

| 项 | 从 → 到 | 理由 |
|----|---------|------|
| **Docker Sandbox** | Sprint 1 → **立即** | 跨平台、低风险、高收益；解锁 MCP Server |
| **Tool 定义 Few-shot Examples** | P3 → **Sprint 1** | 最简单 BFCL 提升（+2-3%），一行代码改动 |
| **execute_code RPC 工具** | P3 → **Sprint 2** | 比堆积工具数量更 scalable；对标 Hermes 的核心创新 |
| **Token-aware 截断** | Sprint 4 → **Sprint 1** | 简单实现（2天），立即可降低长输出上下文占用 |

### 降优先级

| 项 | 从 → 到 | 理由 |
|----|---------|------|
| **A2A 跨网络协议** | P1 → **P3** | 对 tool calling 核心能力影响小；与 Commander 定位（单实例编排引擎）不 match |
| **Landlock Profile** | Sprint 1 → **Sprint 3** | Linux 用户少，Landlock ABI 差异大，维护成本高 |
| **Web GUI 可视化** | Sprint 4 → **P3** | 用户体验改善但不是 tool calling 核心竞争力 |

### 新增缺失项

| 缺失项 | 优先级 | 理由 |
|--------|--------|------|
| **Tool 定义 Few-shot Examples** | **高** | 低投入高回报 BFCL，2-3% 提升 |
| **execute_code RPC 工具** | **高** | Hermes 的最佳创新：LLM 写脚本通过 RPC 调用多个工具，单次推理循环内完成多步操作 |
| **Tool 搜索/过滤 API** | **中** | 工具超过 30+ 时，LLM 需要高效的工具发现机制 |
| **structured outputSchema** | **中** | Codex v0.120 已支持，提高 agent-to-agent 调用的可靠性 |

---

## 5. 预研知识点

| 任务 | 需要学习 | 参考资源 |
|------|---------|---------|
| Docker Sandbox | Dockerode API, Docker socket 安全 | dockerode npm, Docker SDK docs |
| macOS Seatbelt | sandbox-exec 语法, .sb 文件格式 | Apple Sandbox Guide, Codex CLI 源码 |
| MCP Server | MCP 协议 Server 端 (list_tools, call_tool) | MCP Spec, `@modelcontextprotocol/sdk` |
| SSH Backend | ssh2 npm, SSH key 管理, known_hosts | ssh2 npm docs |
| Context Compaction | Claude Code 5-stage 设计, Codex Responses API compaction | Claude Code from Source ch7, Codex CLI context_manager |
| execute_code RPC | Hermes code_execution_tool.py 的 UDS/file-based RPC | Hermes 源码 |

---

## 6. Oracle 触发点

| 时机 | 咨询内容 |
|------|---------|
| **Sprint 1 前** | Docker Sandbox 架构设计 — 如何将现有 3 profiles 映射到 Docker 安全策略 |
| **Sprint 2 前** | MCP Server 协议设计 — 哪些 Commander 工具应该暴露？输出 schema 如何设计？ |
| **Sprint 2 前** | 执行通道 (Lanes) 并发模型 — 如何不改动现有 agentRuntime 并发逻辑的前提下加入 lane 隔离 |
| **Sprint 3 前** | SSH 后端安全架构 — 密钥管理、连接池、会话隔离 |
| **Sprint 4 前** | Context Compaction Pipeline 设计 — 参考 Claude Code 但用更轻量的实现 |
| **Phase 2 前** | 自进化工具选择 — MetaLearner 如何与 tool ranking 集成 |

---

## 7. 低垂果实（最快最高回报）

### 🥇 BFCL +3%: Tool 定义添加 Few-shot Examples
- **工作量**: 1-2天
- **改动**: 给每个 `ToolDefinition` 的 `examples` 字段填入 1-2 个示例
- **影响**: BFCL +2-3%，几乎零维护成本
- **状态**: `examples` 字段已存在但未使用

### 🥈 MCP Server（暴露 Commander 作为工具）
- **工作量**: 3-5天
- **改动**: 复用 `MCPToolAdapter` 的反向模式，将 Commander 现有 Tool 包装为 MCP Server
- **影响**: 对标 Codex 的核心差异化能力，使 Commander 可被其他 agent 调用
- **前提**: 已有完整的 MCP Client 基础设施可复用

### 🥉 Token-aware 截断（头尾保留）
- **工作量**: 2天
- **改动**: 修改 `ToolResult.output` 截断逻辑，保留头部 N 行 + 尾部 M 行
- **影响**: 对标 Codex/Claude Code 的标准实践，降低上下文占用
- **状态**: `maxOutputSize` 机制已存在

---

## 8. Phase 2 可行性评估

| 特性 | 可行性 | 投入 | 建议 |
|------|--------|------|------|
| 自进化工具选择 (MetaLearner) | ✅ 高 | M | **立即做** — 已有 MetaLearner，只需加 tool ranking 接口 |
| 预测性工具预取 | ⚠️ 中 | L | **延后** — 需要执行历史数据积累，依赖现有 SpeculativeExecution 先成熟 |
| Tool-aware Prompt Cache 优化 | ✅ 高 | S | **做** — 低投入，只需工具定义排序优化 |
| 跨租户工具学习 | ⚠️ 低 | XL | **不做** — 隐私风险大，收益不确定 |
| 自动化工具 Fuzzing | ✅ 高 | M | **做** — 可以显著提高工具健壮性，持续 CI 集成 |
| 工具组合图 (Macro Tools) | ⚠️ 中 | L | **延后** — 依赖 MetaTool 系统成熟和足够多的执行历史 |

**Phase 2 推荐启动顺序**: 
1. Tool-aware Prompt Cache 优化 (S)
2. 自动化工具 Fuzzing (M)
3. 自进化工具选择 (M)
4. 预测性工具预取 (L)
5. 工具组合图 (L)
6. 跨租户学习 (❌ 跳过)

---

## 9. 回归风险与防护

| 改动 | 风险项 | 检测手段 |
|------|--------|---------|
| DAG Planner 改动 | 并行执行与顺序执行结果不一致 | `tests/ultimate-orchestration.test.ts` — 添加确定性测试 |
| Tool Cache 改动 | 缓存一致性问题：文件已变但返回旧结果 | `toolResultCache.test.ts` — 添加写后读失效测试 |
| AgentRuntime 执行通道 | 现有并发模型被破坏 | `tests/internal-torture.test.ts` — 50 并发调用验证 |
| MCP Server 暴露 | 外部调用可能绕过 sandbox | Docker Sandbox 必须在 MCP Server 之前完成 |
| SSH Backend | 远程代码执行 | sandbox profile 的 envVarDenyList + 只允许 workspace-write 模式 |

**黄金法则**: 每 Sprint 结束后跑全量测试 + BFCL benchmark，确保零回归。

---

## 10. 推荐 Sprint 计划（修订版）

### Sprint 0（立即 — 低垂果实）
```
[1d] BFCL: Tool 定义添加 few-shot examples（+2-3% BFCL）
[2d] Token-aware 输出截断（头尾保留）
[2d] Tool-aware Prompt Cache 排序优化
[3d] Docker Sandbox Profile（跨平台、解锁后续）
```
**预计耗时**: 8天 | **BFCL**: 91.4% → ~93-94%

### Sprint 1（核心基础设施）
```
[5d] MCP Server（暴露 Commander 作为工具）
[5d] 子Agent 工具白名单 + 上下文隔离
[5d] macOS Seatbelt Profile
[5d] Tool Definition 分类与描述优化（+1-2% BFCL）
```
**预计耗时**: 20天 | **BFCL**: ~94-96%

### Sprint 2（扩展能力）
```
[5d] PreToolUse/PostToolUse 拦截器
[8d] 执行通道 (Execution Lanes)
[5d] 10+ 新 Plugin Hook 点
[3d] execute_code RPC 工具（Hermes 模式）
```
**预计耗时**: 21天 | **BFCL**: ~96-97%

### Sprint 3（行业第一）
```
[5d] 流式工具生命周期事件
[5d] 工具循环检测与自恢复 (MetaLearner ranking)
[5d] SSH 执行后端
[8d] 5 阶段 Context Compaction Pipeline
[3d] 自动化工具 Fuzzing (CI 集成)
```
**预计耗时**: 26天 | **BFCL**: ~97-98%

### 总计: 约 75 天（3.5 个自然月，假设并行化）

---

## 11. 关键指标

```
当前状态:
  BFCL: 91.4%        ← 已超 OpenClaw (89.5%)
  工具: 25+
  独有优势: 12项
  竞品有我们没有的: 6项

Sprint 0 后:
  BFCL: ~93-94%
  竞品有我们没有的: 5项

Sprint 1 后:
  BFCL: ~94-96%
  竞品有我们没有的: 3项

Sprint 2 后:
  BFCL: ~96-97%
  竞品有我们没有的: 2项
  我们独有的: 15+项

Sprint 3 后:
  BFCL: ~97-98%
  竞品有我们没有的: 0-1项
  我们独有的: 18+项
  行业第一: ✅
```
