# Commander 迭代研究文档 (Iteration Research)

> 本文档由 heartbeat 驱动，每轮迭代会自动更新。
> 最后更新：2026-04-08

---

## 一、你的核心笔记 (来自 realization-hub 讨论)

### 1. 治理 / 审批 / 安全
- [ ] **Governance Observer v1**
  - 统计：高风险任务数/完成率、MANUAL 审批率、风险 Agent 分布
  - 产出：ProjectMemory（LESSON/ISSUE）作为周报/风险提示
  - UI：治理态势卡片

- [ ] **待审批列表（Web）**
  - 聚合：`governanceMode=MANUAL` + 高风险 + 未完成
  - 支持批量 Approve / Reject

- [ ] **细粒度权限模型**
  - 扩展 CommanderOperation（Git / Shell / Deploy 等）
  - 在 AgentInvocationProfile 中明确权限映射

### 2. 记忆 / 经验层
- [ ] **Memory 抽象**
  - EpisodeMemory（过程）
  - SemanticMemory（可检索经验库）
  - API：JSON/文件存储 + `/memory/search`

- [ ] **策略经验沉淀**
  - 记录：任务类型 × 策略 → 成功率 / 成本
  - 用于 `recommendStrategy` 优化

- [ ] **记忆引用 & 审计**
  - 输出标记 `memoryRefs`
  - 分析低质量/误导记忆 → 清理或人工审核

### 3. 多 Agent 调度 / 评估
- [ ] **Eval 流程**
  - 基于 `runAgentStep` 跑任务集
  - 对比策略：成功率 / 轮数 / token

- [ ] **Eval 规范**
  - 定义：用例格式（输入/期望/判定）+ 指标计算

- [ ] **智能策略推荐**
  - 输入：历史经验 + AgentState + 近期错误率
  - 输出：更优 executor / reviewer / 策略

### 4. Web / 产品层
- [ ] **治理 & 策略可视化**
  - 策略分布（SINGLE / GUARDED / MANUAL）
  - Agent 角色 & 负载展示

- [ ] **Memory UI 强化**
  - 支持 kind / tags / query 过滤
  - 可视化检索经验（而非纯 API）

---

## 二、Research 吸收 (每轮迭代更新)

### 2.1 Anthropic Multi-Agent 经验 (Building Effective Multi-Agent Systems)

**来源**: Anthropic Engineering Blog - "How we built our multi-agent research system"
**发布时间**: 2025年6月13日
**链接**: https://www.anthropic.com/engineering/multi-agent-research-system

**核心发现**:

1. **Lead Agent + Subagents 架构**
   - Lead Agent 负责规划和协调
   - Subagents 并行执行具体研究任务
   - 最终由 Lead Agent 汇总结果

2. **性能提升数据**
   - 多 agent 系统比单 agent 提升 **90.2%** on research eval
   - Token 使用量解释 95% 的性能方差
   - 单 agent 使用 ~4x tokens vs chat，multi-agent ~15x tokens vs chat

3. **适用场景**
   - ✅ 适合：大量并行化、信息超单上下文窗口、复杂多工具接口
   - ❌ 不适合：需要共享上下文、agent 间强依赖的任务

4. **Prompt Engineering 原则**
   - **Think like your agents**: 用模拟器观察 agent 行为来迭代 prompt
   - **Give agents explicitly bounded scopes**: 明确限制 agent 职责范围
   - **Build guardrails for common failure modes**: 建立常见错误的安全防护
   - **Have a coordination mechanism**: 建立协调机制

5. **常见错误 (要避免)**
   - 给简单查询 spawn 50 个子 agent
   - 无休止搜索不存在的来源
   - Agent 之间互相干扰（过多更新）

6. **Memory 机制**
   - 当 context 超过 200K tokens 时会被截断
   - 需要把 plan 保存到 Memory 持久化

**对 Commander 的启示**:
- ✅ Lead Agent + Subagents = Commander 的 Orchestrator + Agent Workers
- ✅ 明确每个 Agent 的 bounded scope（我们的 Role/Specialty 定义）
- ✅ 需要 guardrails（我们的 Governance Mode）
- ✅ Memory 持久化（我们的 EpisodeMemory / SemanticMemory）
- ✅ Token 预算控制（你的 "Token as budget" 想法）

---

### 2.2 CrewAI 对比分析

**来源**: CrewAI 官方文档

**CrewAI 核心架构**:
- **Flows**: 状态管理 + 事件驱动 + 控制流（if/else, loops）
- **Crews**: Agent 团队协作 + 任务委派
- **Processes**: Sequential / Hierarchical 模式

**CrewAI 关键特性**:
- Role-Playing Agents（角色扮演 agent）
- Autonomous Collaboration（自主协作）
- Task Delegation（基于能力的任务委派）
- 100K+ 开发者认证，社区活跃
- 丰富的 Observability 集成（Langfuse, Phoenix, etc.）

**与 Commander 的区别**:

| 维度 | CrewAI | Commander |
|------|--------|-----------|
| 核心理念 | 构建多 agent 工作流 | 作战室 + 治理 + 战报 |
| 治理层面 | 基础 Flow 控制 | 完整的 governance Mode (SINGLE/GUARDED/MANUAL) |
| 记忆层 | 简单 Memory | EpisodeMemory + SemanticMemory + 审计 |
| 战报/可视化 | 无专门设计 | Battle Report + 治理态势卡片 |
| 目标用户 | 开发者构建 workflow | 小团队/个人 AI 军队指挥 |
| 审计/合规 | 无专门设计 | Governance Observer, 权限映射 |

**Commander 差异化定位**:
- 强调"作战室"心智（Agent = 团队成员）
- 完整的治理与合规体系
- 战报驱动的项目管理
- 适合"一个人 + AI 军队"场景

---

### 2.3 Claude Code / OpenCode 源码分析

**待完成**: 需要深入分析这两个开源项目的架构设计

**已知信息**:
- Claude Code (`claude` CLI) 源码已公开
- OpenCode 源码已公开
- 两者都是 "coding agent" 类型的实现

**待研究**:
- Agent 循环实现方式
- 工具调用架构
- 状态管理模型
- 与 Commander 的互补点

---

### 2.4 Token Budget 机制

**问题**: 能否把 Token 作为预算给 agent 思考，让它在预算内高质量完成任务？

**可行方案**:
1. **预算分配**: 在任务启动时设定 token 上限
2. **动态调整**: 根据任务复杂度调整预算
3. **质量监控**: 追踪 token 消耗 vs 输出质量

**平衡策略**:
- 简单任务：低 token 预算（如 2k tokens）
- 复杂任务：高 token 预算（如 10k+ tokens）
- 关键路径：预留额外预算用于反思

**Anthropic 的实践**:
- `Effort` 参数控制输出详细程度
- `Extended thinking` 可控制思考深度

---

### 2.5 Harness Engineering

**来源**: linux.do 讨论 (https://linux.do/t/topic/1791588)

**核心概念**: Harness = "挽具/缰绳"，隐喻对 AI Agent 的引导与控制

**关键议题**:
- 如何有效控制 agent 行为
- 安全与自由的边界
- 自动化 vs 人工干预

**对 Commander 的启示**:
- Governance Mode (SINGLE/GUARDED/MANUAL) 正是这种思路的体现
- 需要更细粒度的权限控制

---

### 2.6 RAG 用于长期记忆

**问题**: RAG 是否适合做长期记忆/经验层？

**分析**:
- ✅ 适合场景：SemanticMemory（可检索的经验库）
- ⚠️ 不适合场景：EpisodeMemory（过程记忆需要时序）
- 关键技术：embedding + 向量检索

**实现建议**:
- 使用轻量级 embedding 模型
- 按主题/标签建索引
- 定期清理低质量记忆

---

### 2.7 Agent 通信模式

**你的想法**: Agent 互相传递信息不要说 "做好了"，要说 "做了什么"

**分析**:
- 这是一种 "explicit state sharing" 模式
- 避免 "success" 抽象，暴露具体行为
- 有利于审计和调试

**Commander 实现参考**:
- 每轮迭代记录具体 action + result
- 日志中包含 "who did what" 而非 "task completed"
- 便于回溯和责任追踪

---

### 2.8 GAN-like 审计团队

**你的想法**: 加入审计团队像 GAN 一样改善质量

**分析**:
- **Generator (Executor)**: 执行任务的 Agent
- **Discriminator ( Auditor)**: 审查输出的 Agent
- **对抗训练**: 通过不断审查-反馈-改进提升质量

**Commander 实现参考**:
- Sentinel Agent 可扮演 Auditor 角色
- 对高风险任务自动触发审核
- 建立反馈循环持续改进

---

## 三、2026-04-08 第一轮迭代发现

### Research Agent 本轮发现:

1. **Anthropic Multi-Agent System 文章** (已深入)
   - 链接: https://www.anthropic.com/engineering/multi-agent-research-system
   - 核心: Lead Agent + Subagents 架构，90.2% 性能提升
   - Token 使用量解释 95% 性能方差

2. **Harness Engineering** 
   - 来源: linux.do 讨论 + 搜索
   - 核心: 对 Agent 的引导与控制机制
   - 与 Commander Governance Mode 理念一致

3. **CrewAI 架构** (已分析)
   - Flows: 状态管理 + 事件驱动
   - Crews: Agent 团队协作
   - 差异化: Commander 强调作战室 + 治理

### Implementation Agent 本轮发现:

- 当前 Commander 代码结构:
  - apps/api/src/store.ts (状态管理)
  - apps/api/src/orchestrator.ts (调度)
  - packages/core/src/index.ts (核心类型)
  - apps/web/src/main.tsx (Web UI)

- 可改进点:
  - 缺少 Governance Observer 实现
  - Memory 层未完整实现 (只有简单 store)
  - 缺少 Token Budget 控制机制

---

## 四、本轮迭代行动项

### Priority 1 (下一轮立即做)
- [x] 更新 HEARTBEAT.md 添加 research + implementation 循环 ✅ (HEARTBEAT.md 已实现双循环)
- [x] 基于 CrewAI 对比，明确 Commander 差异化文档 ✅ (docs/COMMANDER-VS-CREWAI.md)

### Priority 2 (本周内)
- [x] Governance Observer v1 设计和实现 ✅ (store.ts 已添加 getGovernanceStats + getPendingApprovals)
- [x] Token Budget 机制原型 ✅ (core/index.ts 已添加 TokenBudget 接口)

### Priority 3 (持续迭代)
- [ ] Claude Code / OpenCode 源码深入分析
- [ ] RAG 实现 SemanticMemory 原型

---

## 四、待研究清单 (每轮 heartbeat 更新)

- [ ] Harness Engineering 最新讨论
- [ ] RAG 用于记忆的最新实践
- [ ] 多 agent 评测最新方法
- [ ] Agent 通信协议新进展

---

## 五、最新研究发现 (2026-04-09)

### AI Agent Framework 7层架构 (Langflow 2025)
1. **Orchestration model**: 有向图、对话循环、角色团队、function-call
2. **Tooling and connectors**: web/file search、code execution、vector stores、SaaS connectors
3. **Memory and state**: conversation、episodic、long-term; per-session/cross-session
4. **Evaluations and guardrails**: trace grading、safety filters、runtime validation
5. **Visual builder vs code-first**: 拖拽画布 vs 代码优先
6. **Deployment and governance**: RBAC、audit logs、observability、telemetry
7. **Multi-agent architectures**: team orchestration、hand-offs、human-in-the-loop、agent-to-agent protocols

### 10 Decision Factors (框架选择矩阵)
1. **Developer Experience**: Visual-first (Langflow, n8n) vs Code-first (LangChain, CrewAI)
2. **Orchestration model fit**: graph vs conversation vs role-based
3. **Multi-agent capabilities**: CrewAI/AutoGen focus; LangGraph state machines
4. **Tooling and connectors**: n8n hundreds; AgentKit built-in; LangChain broad
5. **Memory and state**: LangGraph explicit; CrewAI shared context; AgentKit runtime events
6. **Evaluations/guardrails**: AgentKit built-in; others need third-party stacks
7. **Observability**: n8n run logs; LangChain/Langflow + LangSmith/Langfuse
8. **Deployment model**: Self-host vs Cloud; lock-in considerations
9. **Cost model**: AgentKit usage-based; OSS self-host predictable
10. **Community maturity**: Langflow 147k stars; LangChain largest OSS

### 关键洞察: Commander 改进方向
- **Governance Layer**: 已有 getGovernanceStats ✅ → 需要扩展 RBAC + audit logs
- **Memory Layer**: 需要区分 episodic vs long-term memory
- **Observability**: 需要集成 trace grading + error capture
- **Multi-agent patterns**: 需要明确 hand-off 协议

---

## 六、Anthropic Multi-Agent Research 系统深度解析 (2026-04-09)

### 核心架构: Orchestrator-Worker 模式
- **Lead Agent**: 分析查询、制定策略、创建 subagents
- **Subagents**: 并行探索不同方面、独立使用工具
- **Citation Agent**: 处理文档、识别引用位置

### 性能关键发现
- **Token Usage = 80% 性能差异**: Token 使用量是关键指标
- **Multi-Agent vs Single-Agent**: Opus 4 + Sonnet 4 subagents 比 单独 Opus 4 高 90.2%
- **Token 成本**: Multi-agent 系统使用约 15× tokens vs chat

### 8 大 Prompt Engineering 原则
1. **Think like your agents**: 理解 agent 行为才能优化 prompt
2. **Teach orchestrator how to delegate**: 详细任务描述防止重复工作
3. **Scale effort to query complexity**: 简单任务 1 agent, 复杂研究 10+ subagents
4. **Tool design and selection are critical**: Agent-tool 接口 = 人机接口
5. **Let agents improve themselves**: Claude 4 能自我诊断和优化 prompt
6. **Start wide, then narrow down**: 先探索全景，再深入细节
7. **Guide the thinking process**: Extended thinking 用于规划
8. **Parallel tool calling**: 并行执行可减少 90% 时间

### Production 挑战与解决方案
| 挑战 | 解决方案 |
|------|----------|
| Stateful & errors compound | 持久化执行、resume from error |
| Non-deterministic debugging | Production tracing、agent decision patterns |
| Deployment coordination | Rainbow deployments、gradual traffic shift |
| Synchronous bottlenecks | Asynchronous execution (future) |

### Evaluation 最佳实践
- **Start small**: 20 个测试用例足够发现早期问题
- **LLM-as-judge**: 单一 prompt 输出 0.0-1.0 分数 + pass/fail
- **Human evaluation**: 发现 SEO 陷阱、系统失败、偏见

### Commander 改进方向 (基于 Anthropic 架构)
1. ✅ **Orchestrator**: 已有 getMissionStatus → 需要增强 delegation 能力
2. 🔨 **Parallel execution**: 需要添加 subagent 并行调用
3. 🔨 **Memory persistence**: 需要 external memory 机制
4. 🔨 **Tool ergonomics**: 需要优化 tool descriptions

---

## 七、Claude Code 三层 Memory 架构详解 (2026-04-09)

### 架构概览
```
Layer 1: In-Context Memory (Active Window)
   ↓ 短暂、快速、session-bound
Layer 2: memory.md (Pointer Index)
   ↓ 动态、自愈、指向 domain files
Layer 3: CLAUDE.md (Project-Level Config)
   ↓ 稳定、长期、session-start load
```

### Layer 详解

#### Layer 1: In-Context Memory
- 当前 context window 内的内容
- 对话历史、工具输出、当前文件
- **特点**: 快速、立即可用，但 ephemeral
- **用途**: Working scratchpad，active reasoning

#### Layer 2: memory.md + Domain Files
- **memory.md**: 指针索引文件（不存实际信息！）
- 引用 domain-specific memory files:
  - `memory/project-context.md` - 项目目标和约束
  - `memory/decisions.md` - 架构决策和原因
  - `memory/code-patterns.md` - 代码约定和模式
  - `memory/user-preferences.md` - 用户偏好
- **Self-healing**: Agent 自己更新、修复错误信息
- **机制**: Read → Check → Write (避免覆盖)

#### Layer 3: CLAUDE.md
- 项目级别静态配置
- 每次 session 开始自动加载
- **内容**: 项目架构、coding standards、约束、测试命令
- **特点**: 稳定、长期、很少修改

### Multi-Agent Memory Patterns

| Pattern | 描述 | 适用场景 |
|---------|------|----------|
| **Shared read, isolated write** | 多 agents 读同一 index，各自写 domain | Leader + Workers |
| **Memory broker** | 专用 agent 管理 memory writes | 高并发写入 |
| **Event-sourced** | Append-only events， reconciliation 计算 state | 需要历史追溯 |

### 架构优势
1. **Token-efficient**: 只加载相关 domain files
2. **Transparent**: 纯文本文件，人类可读可编辑
3. **Survives context resets**: session 间保持记忆
4. **Graceful degradation**: 损坏可恢复

### 已知局限
- **Write conflicts**: Multi-agent 无并发控制
- **No semantic retrieval**: 需要向量数据库配合
- **Memory drift**: 长期项目需 periodic reconciliation
- **Storage overhead**: 每次读写都是 API 调用

### Commander 改进 (基于 Claude Code Memory)
1. ✅ **memoryStore.ts** 已存在 → 需要升级为 pointer-index 模式
2. 🔨 **CLAUDE.md 等效**: 需要 `PROJECT.md` 或 `MISSION.md`
3. 🔨 **Self-healing**: Agent 主动更新 memory 能力
4. 🔨 **Multi-agent coordination**: Memory broker pattern

---

## 八、Agent Communication Protocols: MCP vs A2A (2026-04-09)

### 协议对比
| 维度 | MCP (Anthropic) | A2A (Google) |
|------|-----------------|--------------|
| **目的** | Agent 访问工具/API | Agent 间协作通信 |
| **核心** | "Universal toolbelt" | "Agent teamwork" |
| **角色** | Client + Server | Client Agent + Remote Agent |
| **发现机制** | Tool descriptions | Agent Cards |
| **通信** | JSON-RPC | JSON over HTTP |
| **解决问题** | 扩展单个 agent 能力 | 扩展 agent 间协作 |

### MCP 工作流程
```
User → Agent → needs tool → MCP Server
                ↓ structured request
        MCP Server → check permissions → returns result
                ↓
        Agent → working memory → response
```

### A2A 工作流程
```
User → Client Agent → decompose task
                ↓
        Review Agent Cards → select remote agents
                ↓
        Send requests in parallel → aggregate results
                ↓
        Client Agent → final response
```

### Agent Cards (A2A)
- Self-descriptions: 能力、协议、接受请求类型
- 帮助 agents 找到合适的协作伙伴
- 不暴露敏感实现细节

### 关键洞察: 互补而非竞争
- **MCP**: extends *what a single agent can do*
- **A2A**: expands *how agents can collaborate*

### 混合使用场景
1. A2A 系统中每个 agent 用 MCP 调用自己的 tools
2. MCP-powered agent 可以 spawn temporary agents (LangGraph, AutoGen)

### Security 考量
- Authenticate agent identities
- Control what they can access
- Trace their behavior

### Commander 改进 (基于 MCP + A2A)
1. 🔨 **MCP Server**: 暴露 Commander tools 给其他 agents
2. 🔨 **Agent Cards**: 发布 Commander capabilities
3. 🔨 **A2A Client**: 调用其他 specialized agents
4. 🔨 **Identity**: Agent authentication + access control

---

## 九、A2A 协议官方详解 (Google 2025-04-09)

### 五大设计原则
1. **Embrace agentic capabilities**: 真正的多 agent 场景，不限制为 "tool"
2. **Build on existing standards**: HTTP, SSE, JSON-RPC
3. **Secure by default**: 企业级认证授权 (OpenAPI auth schemes)
4. **Support for long-running tasks**: 从快速任务到数天深度研究
5. **Modality agnostic**: 文本、音频、视频流

### 核心能力
| 能力 | 描述 |
|------|------|
| **Capability discovery** | Agent Cards (JSON) |
| **Task management** | Task 生命周期 → Artifact 输出 |
| **Collaboration** | messages (context, replies, artifacts) |
| **UX negotiation** | Parts 内容协商 (iframe, video, web forms) |

### A2A 通信模式
```
Client Agent                    Remote Agent
    │                               │
    ├─ Agent Card (capabilities) ──→│
    │                               │
    ├─── Task Request ────────────→│
    │                               │
    │←─── Messages/Artifacts ──────┤
    │                               │
    │←─── Task Status Updates ─────┤
    │                               │
    │←─── Final Artifact ──────────┤
```

### 生态伙伴 (50+)
- **Tech Partners**: Atlassian, Box, Cohere, LangChain, MongoDB, PayPal, Salesforce, SAP, ServiceNow
- **Services Partners**: Accenture, BCG, Capgemini, Deloitte, KPMG, McKinsey, PwC, TCS

### Real-world Example: Candidate Sourcing
```
Hiring Manager → Agent (find candidates)
                    ↓
              Review Agent Cards
                    ↓
    ┌───────────────┼───────────────┐
    ↓               ↓               ↓
Resume Agent   LinkedIn Agent   Background Agent
    ↓               ↓               ↓
    └───────────────┴───────────────┘
                    ↓
            Aggregate results → Final suggestions
```

### Commander 改进 (基于 A2A 官方规范)
1. 🔨 **Agent Card**: 发布 Commander 的 capabilities (skills, tools, auth)
2. 🔨 **Task lifecycle**: 实现完整的 Task 状态机
3. 🔨 **Artifact system**: 支持多种输出格式
4. 🔨 **Long-running tasks**: 支持 progress updates + notifications

---

## 十、LLM-as-Judge 最佳实践 (Monte Carlo 2025)

### 7 大最佳实践
| # | 实践 | 描述 |
|---|------|------|
| 1 | **Few shot prompting** | 提供 1 个示例（更多反而下降） |
| 2 | **Step decomposition** | 大评估 → 小步骤 |
| 3 | **Criteria decomposition** | 单一标准 per evaluation |
| 4 | **Grading rubric** | 明确评分标准 (1-5) |
| 5 | **Structured outputs** | JSON 格式减少歧义 |
| 6 | **Explanations** | CoT 解释分数原因 |
| 7 | **Score smoothing** | 平滑分数，关注趋势 |

### Evaluation Templates
```markdown
## Answer Relevance (1-5)
- 5 = 完全相关，所有内容有用
- 4 = 大部分相关，有少量无关细节
- 3 = 部分相关，有一些无关内容
- 2 = 几乎不相关
- 1 = 完全不相关

## Task Completion (1-5)
- 5 = 完全完成所有要求
- 4 = 大部分完成，有轻微遗漏
- 3 = 部分完成，有显著差距
- 2 = 几乎未完成
- 1 = 未尝试

## Prompt Adhesion (1-5)
- 5 = 完美遵循所有指令
- 4 = 大部分遵循，轻微偏离
- 3 = 部分遵循
- 2 = 很少遵循
- 1 = 完全忽略
```

### 主要挑战与解决方案
| 挑战 | 解决方案 |
|------|----------|
| **Cost** | 采样、过滤、比例控制 |
| **Defining failure** | 多维度聚合 + 异常检测 |
| **Flaky evaluations** | Golden datasets + 自动重试 |
| **Visibility** | 统一 telemetry 到数据仓库 |

### 生产实践经验
- **Cost ratio**: 评估成本 ≈ 1x baseline workload
- **Soft vs Hard monitors**: 区分软硬告警
- **Human-in-the-loop**: 小样本 + 人工验证
- **Rerun low scores**: 低分自动重评确认

### Commander 改进 (基于 LLM-as-Judge)
1. 🔨 **Evaluation module**: 实现 LLM-as-Judge 评估
2. 🔨 **Score smoothing**: 异常检测 + 趋势分析
3. 🔨 **Evaluation templates**: 预置 relevance/completion/adhesion
4. 🔨 **Cost control**: 采样 + 过滤 + 批量评估

---

*本文档由 Commander Heartbeat 自动维护*