# Commander – Agent 作战室 v0 PRD（草案）

## 1. 产品定位

- 面向对象：
  - 2–10 人的小产品团队、独立开发者工作室、外包小团队；
  - 已经在用 AI（ChatGPT / Claude / 各类 Agent 框架）参与项目开发。
- 核心价值：
  - 让团队可以把 AI 当成“可管理、可复盘的团队成员”，而不是一堆分散的聊天记录；
  - 用一个界面回答：
    - 这个项目现在进行到哪？
    - 哪些任务是 Agent 完成的？
    - 本周 AI 帮我们节省了多少活？

## 2. v0 范围

### 2.1 场景假设

- 单项目视图：先只支持管理一个项目；
- 团队成员：
  - 人类用户 1–3 名（简化为“成员名称 + 头像 URL”）；
  - Agent 2–5 个（名称、角色说明、技能标签）。
- 任务颗粒度：
  - 每个任务是一条可以描述为「一句话需求」+「若干补充说明」的开发/运营任务。

### 2.2 核心功能

1. 任务看板
   - 列：TODO / DOING / DONE；
   - 每个任务字段：
     - 标题（必填）
     - 描述（选填）
     - 执行者：人类成员 / 某个 Agent（必填）
     - 状态：TODO / DOING / DONE
     - 完成时间（状态变为 DONE 时记录）

2. Agent / 成员管理（简化版）
   - 人类成员：仅用于展示名字和头像；
   - Agent：
     - 名称
     - 角色说明（例如「前端开发 Agent」「文档整理 Agent」）
     - 技能标签列表（字符串数组）。

3. AI 团队战报（v0 核心差异化）
   - 以“本周”为单位（按自然周），自动生成：
     - 总任务数
     - Agent 执行的任务数 / 占比
     - 人类执行的任务数 / 占比
     - 每个 Agent 的：
       - 完成任务数
       - 典型任务标题列表（最多 3 条）
     - 一段可复制的战报文案（用于贴到周报 / X / Discord）。

   - 同时生成一个简单的「战报视图」：
     - 显示上述统计数字；
     - 带有团队成员 + Agent 的头像排列（便于截屏）。

4. 最小 API
   - REST API（或 tRPC 形式），满足：
     - 创建 / 更新任务
     - 查询当前任务列表
     - 创建 / 更新 Agent / 成员
     - 查询战报数据

### 2.3 明确不做（v0）

- 不做真实的 Agent 调用/执行，只记录“指定给哪个 Agent”；
- 不做权限体系；
- 不做多项目切换；
- 不做复杂的时间维度分析（仅按自然周统计）。

## 3. 数据模型（草案）

### 3.1 Member（人类成员）
- `id: string`
- `name: string`
- `avatarUrl?: string`

### 3.2 Agent
- `id: string`
- `name: string`
- `description?: string`  // 角色说明
- `skills: string[]`
- `avatarUrl?: string`

### 3.3 Task
- `id: string`
- `title: string`
- `description?: string`
- `assigneeType: "member" | "agent"`
- `assigneeId: string`
- `status: "todo" | "doing" | "done"`
- `createdAt: Date`
- `updatedAt: Date`
- `completedAt?: Date`

### 3.4 WeeklyReport（计算所得，非持久化）
- 时间范围：某一自然周的 `startDate` / `endDate`
- 汇总字段：
  - `totalTasks`
  - `agentTasks`
  - `memberTasks`
  - `agentTaskRatio`
  - `memberTaskRatio`
  - `byAgent: Array<{ agentId, taskCount, sampleTaskTitles: string[] }>`
  - `narrative: string`  // 一段可复制战报文案

## 4. 前端界面草图（文字版）

1. 主界面：
   - 上方：项目标题 + 当前周的概览（本周任务总数、Agent 占比）；
   - 中间：三列看板（TODO / DOING / DONE），任务卡右上角标记“人/Agent”；
   - 右侧（或底部）：当前团队成员和 Agent 列表。

2. 战报页面：
   - 显示本周战报的关键数字；
   - 列出 Agent 卡片（头像 + 名称 + 本周任务数）；
   - 提供一块只读文本框，内含战报文案 + 一键复制按钮。

## 5. 技术实现原则

- 以「简单可跑通」优先：
  - Node + SQLite（或 Prisma + SQLite）即可；
  - 前端先用 React + 任意轻框架（Next.js / Vite）。
- 所有统计逻辑写在 `packages/core` 中，方便未来迁移到其他后端。

## 6. v0 验收标准

- 能在本地 `npm install && npm run dev` 启动：后端 + 前端；
- 在 UI 上：
  - 能新增/编辑任务，分配给人/Agent，并拖动改变状态；
  - 能看到当前周的战报数字和文案；
- 手动构造 20 个任务样本，截图一张「战报页面」，足够适合发到 X/Discord 当 demo。

---

## 7. 多智能体运行规范（草案）

> 目标：在「速度、透明、省 token」三者之间找到平衡，让 Commander 可以安全地承载多 Agent 编排，而不是把日志和长对话强行塞进上下文。

### 7.1 角色拓扑与调用模式

- 拓扑设计：
  - 单一 Orchestrator（Commander）负责全局决策与调度；
  - 多个 Worker Agent（例如 Scout / Builder / Sentinel）负责具体子任务（研究、实现、风控）。
- 调用模式：
  - Worker Agent 被视为“函数调用”，每次调用默认 1–2 轮对话内完成一个明确子任务；
  - 禁止 Worker 之间直接长聊，所有信息通过 War Room 黑板 + 记忆层流转。
- 模型选择：
  - 默认使用小模型 / mini 模型完成常规任务；
  - 仅在高风险决策、长文档审阅时切换到更强模型，由治理层控制（例如 MANUAL 模式下的 Sentinel 审批）。

### 7.2 上下文与记忆使用规范

- 分级记忆：
  - **黑板（War Room）**：当前项目状态的唯一事实源，包含 Project / Agents / Missions / Logs / BattleReport；
  - **项目经验库（ProjectMemoryItem）**：蒸馏过的 DECISION / ISSUE / LESSON / SUMMARY，用于长期语义记忆；
  - **AgentState**：每个 Agent 的瘦身自我状态（summary / preferences / tags）。
- 读取原则：
  - Worker 调用前，Orchestrator 通过 `/projects/:projectId/run-context` 获取 `CommanderRunContextV2`：
    - `slimSnapshot`：War Room 当前精简快照；
    - `recentMemory`：限定条数的 ProjectMemoryItem；
    - `recommendedMemory.items`：Commander 基于 focus 裁剪后的推荐记忆；
    - `focus.agentId` / `focus.missionId` / `focus.intent`：本次调用目标。
  - 优先复用 Commander 框架已经提供的裁剪结果，而不是在 orchestrator 里重复发明压缩逻辑：
    - 对 Builder：优先读当前 `focusMission`、`missionBoard.running`、`recommendedMemory.items`；
    - 对 Sentinel：优先读高风险 / guarded 任务卡片、battleMetrics、风控相关推荐记忆。 
- 写入原则：
  - Mission 状态变更、日志等写回 War Room；
  - 与决策、经验、教训相关的内容写入 ProjectMemory（DECISION / LESSON / SUMMARY），而不是长日志；
  - Agent 的整体风格改变或长期偏好更新时，写入 AgentState（summary / preferences）。

### 7.3 决策透明度与可追踪性

- 每次 Worker 调用视为一条“可审计动作”：
  - 记录在 ExecutionLog 中：谁（agentId）、在做什么（missionId）、为何被唤醒（简短 reason）、结果如何；
  - 对关键决策（例如高风险任务的 APPROVE / REJECT）生成 ProjectMemoryItem(kind = 'DECISION')，附上简短理由。
- War Room UI 需要提供：
  - Mission 级别的决策时间线视图（关联 DECISION / LESSON type 的 memory 条目）；
  - Project 级别的「Recent lessons / Decisions」列表（当前已实现基本版本）。
- 目标：
  - 人类指挥官可以从 War Room + 经验库中复盘“多 Agent 是基于什么信息做了哪些决定”。

### 7.4 性能与 token 预算

- Orchestrator 必须显式管理：
  - 每个 Agent 的 `maxTurns`（建议默认 1–2）；
  - 每次调用的 `maxTokens` 预算（prompt + output）。
- 上下文预算分配建议：
  - 70–80% 用于“当前任务描述 + Worker 输出”；
  - 20–30% 用于“精简上下文”：
    - snapshot 的裁剪（只挂与当前 mission 直接相关的字段）；
    - 从经验库检索出来的 3–5 条 bullet 级记忆；
    - AgentState 的 1–2 句 summary / preferences。
- 所有“平台级提示词”（system prompt）应保持精简、条款化，避免长篇故事式描述。

### 7.5 与治理模型的结合

- Mission 的风险与治理字段：
  - `riskLevel: LOW | MEDIUM | HIGH | CRITICAL`
  - `governanceMode: AUTO | GUARDED | MANUAL`
- 调度策略示例：
  - AUTO：低风险任务，Orchestrator 可直接调用 Builder 等执行，无需人类审批，仅记录日志与经验；
  - GUARDED：中等风险任务，由 Sentinel 监控，只有触碰特定规则时才升级为需要人工确认；
  - MANUAL：高风险任务必须经过人类在 War Room 中的明确批准（SENATE / COMMANDER 审批），相关意见与结果记录为 DECISION / LESSON。
- 多 Agent 编排必须尊重 governanceMode：
  - 对于 MANUAL 任务，Orchestrator 只能生成“执行计划 / 变更草案”，不能直接执行；
  - 执行前需要：
    - 在 War Room 中呈现提案摘要；
    - 等待人类或指定 Agent 集体给出决策；
    - 决策结果写入 ProjectMemory，供后续任务作为先例引用。
