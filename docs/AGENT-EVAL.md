# AGENT-EVAL.md

> Commander 官方多 Agent 调用与评估说明（v0 / 实验性）

这份文档回答三个问题：

1. **一个外部 orchestrator / runner 应该怎样接 Commander？**
2. **Commander 框架层已经固化了哪些治理与策略判断？**
3. **如何评估一套多 Agent 接入是否真的更快、更稳、更省 token，而不是更复杂？**

---

## 1. 设计目标

Commander 对多 Agent 的定位，不是“替代你的 orchestrator”，而是提供一个**统一的作战协议层**：

- **状态协议**：War Room 是项目事实源；
- **记忆协议**：ProjectMemory 是可复用经验层；
- **治理协议**：riskLevel / governanceMode / approval 是平台级约束；
- **调用协议**：`CommanderRunContextV2`、`AgentInvocationProfile`、`recommendStrategy()` 决定每次唤醒该看什么、能做什么、推荐怎么编排。

换句话说：

- orchestrator 负责“何时唤醒谁”；
- Commander 框架负责“被唤醒后允许做什么、推荐采用什么协作策略”。

---

## 2. 当前协议面（Protocol Surface）

### 2.1 Run Context

推荐入口：

```http
GET /projects/:projectId/run-context?agentId=...&missionId=...&intent=EXECUTE&memoryLimit=8
```

当前返回的是 `CommanderRunContextV2`，核心字段包括：

```ts
interface CommanderRunContextV2 {
  projectId: string;
  run: {
    runId: string;
    issuedAt: string;
    issuedBy?: {
      kind: 'HUMAN' | 'AGENT' | 'SYSTEM';
      id?: string;
      label?: string;
    };
  };
  focus?: {
    agentId?: string;
    missionId?: string;
    intent?: 'PLAN' | 'PROPOSE' | 'EXECUTE';
  };
  slimSnapshot: SlimSnapshot;
  recentMemory: ProjectMemoryItem[];
  recommendedMemory: {
    items: ProjectMemoryItem[];
    sourceTags?: string[];
  };
  agentRoster: CommanderAgentCard[];
}
```

### 2.2 Slim Snapshot

`slimSnapshot` 是给 token 敏感型 orchestrator 用的框架级精简上下文，而不是让每个接入方自己发明裁剪规则。

它包含：

- `project`：项目最小必要状态；
- `focusMission`：本次 mission 的精简卡片；
- `missionBoard`：按 running / blocked / planned / done 划分的少量 mission 卡片；
- `battleMetrics`：运行数、阻塞数、完成数、高风险数、审批数、24h log 量等；
- `latestLogs`：少量最新日志。

适用原则：

- 默认优先读 `slimSnapshot`，而不是全量 war-room；
- 只有当 worker 明确需要更多上下文时，再额外读取细节；
- 不要把完整日志流塞进每次 prompt。

### 2.3 Recommended Memory

`recommendedMemory.items` 是 Commander 基于当前 focus 裁剪后的推荐记忆切片。

当前 v0 策略：

- 若提供 `missionId`，优先返回 mission-scoped 记忆；
- 若没有命中，再退化为最近记忆；
- 调用方仍可自行二次过滤，但**推荐先使用框架给出的切片**。

适用原则：

- token 紧张时，优先用 `recommendedMemory.items`；
- `recentMemory` 主要用于兼容旧 orchestrator 或调试；
- 记忆条目优先选 `LESSON / SUMMARY / DECISION`，避免把原始日志当经验库。

---

## 3. 框架层策略：由 Commander 决定，而不是各家 orchestrator 私下约定

### 3.1 AgentInvocationProfile

`getDefaultInvocationProfile()` 会结合以下信息决定调用边界：

- 当前 agent 的 `governanceRole`；
- 当前 mission 的 `riskLevel`；
- 当前 mission 的 `governanceMode`；
- 本轮 intent（PLAN / PROPOSE / EXECUTE）。

输出重点包括：

- `disposition`：
  - `ALLOW_EXECUTION`
  - `PROPOSE_ONLY`
  - `REQUIRE_APPROVAL`
  - `DENY`
- `allowedOperations` / `forbiddenOperations`
- `approval` 要求
- `rationale`（为什么得出这个约束）

这意味着：

- MANUAL 任务不是由 orchestrator “自觉别执行”，而是 Commander 框架明确降级为 proposal-safe；
- 高风险 EXECUTE 不是“看团队习惯”，而是框架可以要求审批；
- 外部 runner 可以把 profile 直接转成 prompt 规则、工具白名单或 UI 提示。

### 3.2 MultiAgentStrategy

`run-context.guidance.strategy` 会直接返回 Commander 已计算好的推荐编排方案；如果调用方要在本地复算，仍可用 `recommendStrategy(context)`：

```ts
type MultiAgentStrategyKind =
  | 'SINGLE_AGENT'
  | 'GUARDED_EXECUTION'
  | 'SENATE_REVIEW'
  | 'MANUAL_APPROVAL_GATE'
  | 'FANOUT_PLAN';
```

当前 v0 已落地的推荐逻辑：

- **无 focus mission** → `SINGLE_AGENT`（偏规划/摸底）；
- **MANUAL** → `MANUAL_APPROVAL_GATE`；
- **GUARDED 或 HIGH/CRITICAL** → `GUARDED_EXECUTION`；
- **AUTO + LOW/MEDIUM** → `SINGLE_AGENT`。

并且会带上：

- `primaryAgentId`
- `executorAgentIds`
- `reviewerAgentIds`
- `approval`
- `rationale`

这份策略不要求 orchestrator 完全照做，但它是 Commander 官方推荐基线，也是后续 benchmark 的对照标准。

---

## 4. 推荐接入循环（Reference Loop）

### 4.1 单轮调用最小流程

1. 选定 `agentId + missionId + intent`；
2. 拉取 `run-context`；
3. 调用 `recommendStrategy()` / 读取上下文里已有策略字段；
4. 基于 `slimSnapshot + recommendedMemory + AgentState` 组 prompt；
5. 调用模型，要求结构化输出；
6. 将结果写回：
   - mission status / fields
   - mission logs
   - project memory（DECISION / LESSON / SUMMARY）
   - agent state

### 4.2 Prompt 组装建议

建议结构：

- **system**：说明 agent 身份、治理边界、输出格式；
- **context**：
  - 当前项目 key metrics
  - 当前 focus mission
  - invocationProfile / strategy rationale
  - 3–5 条 recommended memory
  - 当前 agent 的 AgentState（若有）
- **task**：本轮只做一个明确动作，例如：
  - 生成执行计划
  - 产出风险分析
  - 生成可写回的 mission patch 草案
  - 输出可审阅的 proposal

### 4.3 写回规范

建议映射：

- **执行轨迹** → `POST /missions/:missionId/logs`
- **状态结果** → `PATCH /missions/:missionId`
- **沉淀出的经验/决策** → `POST /projects/:projectId/memory`
- **长期 agent 偏好变化** → `PATCH /projects/:projectId/agents/:agentId/state`

不要把下面两类东西混在一起：

- 日志 = 原始事件流
- 记忆 = 可复用的蒸馏经验

---

## 5. 评估框架：如何知道多 Agent 接入是有效的

多 Agent 最容易出现的幻觉，不是模型幻觉，而是**流程幻觉**：看起来更复杂、更热闹，但没有更快、更稳、更省。

因此评估必须同时覆盖 **效果、效率、治理、可复盘性** 四个维度。

### 5.1 核心评估维度

#### A. 效果（Did it move the mission forward?）

关注：

- 任务是否真的推进到下一状态；
- 输出是否可被人类直接采用；
- 是否减少了后续澄清轮次。

建议指标：

- `mission_progression_rate`：本轮调用后 mission 进入更靠前状态的比例；
- `accepted_patch_rate`：agent 产出的 patch / proposal 被接受的比例；
- `reopen_rate`：DONE 后被 reopen 的比例；
- `blocked_after_execution_rate`：执行后反而进入 BLOCKED 的比例。

#### B. 效率（Was the token/runtime cost worth it?）

关注：

- 是否比单 Agent 更快；
- 是否把 token 花在当前任务上，而不是上下文搬运上；
- 是否出现无意义的多轮调用。

建议指标：

- `tokens_per_completed_mission`
- `tokens_context_ratio`（上下文 token / 总 token）
- `runtime_per_step_ms`
- `avg_model_calls_per_mission`
- `memory_hit_rate`（推荐记忆被实际引用/采用的比例）

#### C. 治理（Did the system respect boundaries?）

关注：

- 是否越权执行；
- 高风险任务是否进入正确审批流；
- MANUAL / GUARDED 的策略是否被遵守。

建议指标：

- `policy_violation_count`
- `manual_mission_auto_execute_count`
- `approval_bypass_attempt_count`
- `guarded_review_coverage`（GUARDED 任务被 review / monitor 覆盖的比例）

#### D. 可复盘性（Can a human understand what happened?）

关注：

- 人类能否看懂“为什么这么做”；
- 关键决策是否沉淀为 DECISION / LESSON；
- 后续类似任务是否能复用这轮经验。

建议指标：

- `decision_capture_rate`
- `lesson_capture_rate`
- `empty_log_step_rate`（做了动作却没有留下有效日志的比例）
- `traceability_score`（抽样人工评分：能否从 War Room + memory 复盘决策链）

---

## 6. 推荐 benchmark 设计

### 6.1 对照组

至少保留三组：

1. **Baseline / Single Agent**
   - 不使用 `recommendStrategy()`
   - 只用一个执行 agent
2. **Commander Strategy**
   - 使用 `slimSnapshot + recommendedMemory + getDefaultInvocationProfile() + recommendStrategy()`
3. **Overstuffed Context**
   - 故意给全量 snapshot / 冗长日志，作为“反例组”

这样能验证 Commander 的价值到底来自：

- 更好的编排；
- 更好的上下文压缩；
- 还是只是更多 prompt 工程。

### 6.2 任务样本分层

样本至少覆盖：

- **低风险执行类**：例如 UI 文案调整、低风险实现任务；
- **中风险 guarded 类**：例如带依赖变更、流程改造；
- **高风险 manual 类**：例如发布、权限、删除、资金/用户数据相关动作；
- **纯规划类**：没有 focus mission 时的规划与拆解。

### 6.3 每个样本记录什么

建议每次运行记录：

- projectId / missionId / agentId / strategyKind
- mission risk/governance
- token in/out
- context token 占比
- runtime
- 是否触发审批
- 是否写入 DECISION / LESSON / SUMMARY
- 最终 mission 状态
- 人工评分（可选）

---

## 7. 当前推荐结论（v0）

### 7.1 什么时候优先单 Agent

优先 `SINGLE_AGENT` 的场景：

- 当前只有一个明确 mission；
- 风险低；
- 任务目标清晰；
- 需要的是“快速往前推一步”，而不是多人辩论。

原因：

- 编排成本最低；
- token 最省；
- 最不容易把上下文和责任边界搞乱。

### 7.2 什么时候启用 guarded execution

优先 `GUARDED_EXECUTION` 的场景：

- mission 已经是 `GUARDED`；
- 或者风险到 `HIGH/CRITICAL`，但仍希望先让 executor 起草方案 / 进行受控执行；
- 需要 Senate / Sentinel 提供风险复核。

### 7.3 什么时候必须 approval gate

以下场景不建议靠 prompt 自觉，而应进入 `MANUAL_APPROVAL_GATE`：

- 外部副作用大；
- 决策不可逆；
- 需要明确责任归属；
- 一旦做错，损失比 token 成本大得多。

---

## 8. 下一步演进建议

为了让评估更可执行，Commander 后续最值得补的不是“更多 agent 花样”，而是：

1. **补 shared fixture helpers / benchmark fixtures**，让 run-context 与 orchestrator 协议测试更容易复用；
2. **沉淀标准 telemetry schema**：token、latency、approval、memory-hit 等统一采集；
3. **为 Sentinel / Senate 补更明确的 review contract**，避免 review 角色名义存在、实际无职责；
4. **把 write-back matrix 进一步沉淀成 SDK helper 或 policy adapter**，减少接入方重复手写权限门控。

---

## 9. 一句话原则

Commander 的多 Agent 能力，不应该让 orchestrator 更自由地“各搞各的”，而应该让多 Agent 系统在**治理、上下文裁剪、评估口径**上越来越统一。

如果一套接入方案做不到下面三点，它就还不算成熟：

- **更快**：更少无效轮次；
- **更稳**：更少越权与返工；
- **更透明**：人类能看懂它为什么这么做。
��。
rompt 自觉，而应进入 `MANUAL_APPROVAL_GATE`：

- 外部副作用大；
- 决策不可逆；
- 需要明确责任归属；
- 一旦做错，损失比 token 成本大得多。

---

## 8. 下一步演进建议

为了让评估更可执行，Commander 后续最值得补的不是“更多 agent 花样”，而是：

1. **把 strategy / profile 暴露进 API 或 SDK 的稳定字段**，减少接入方自行推断；
2. **增加 benchmark fixtures**，让接入方可复现对照实验；
3. **沉淀标准 telemetry schema**：token、latency、approval、memory-hit 等统一采集；
4. **为 Sentinel / Senate 补更明确的 review contract**，避免 review 角色名义存在、实际无职责。

---

## 9. 一句话原则

Commander 的多 Agent 能力，不应该让 orchestrator 更自由地“各搞各的”，而应该让多 Agent 系统在**治理、上下文裁剪、评估口径**上越来越统一。

如果一套接入方案做不到下面三点，它就还不算成熟：

- **更快**：更少无效轮次；
- **更稳**：更少越权与返工；
- **更透明**：人类能看懂它为什么这么做。
��。
