# Commander vs CLI Agent 竞品对比

> 2026-05-31 · Commander v0.2.0

## 竞品定义

| 产品 | 语言 | 类型 | 核心特点 |
|------|------|------|---------|
| **Commander** | TypeScript | CLI Agent框架 | 多Agent编排、治理、可观测 |
| **Hermes Agent** | Python | CLI Agent | 闭环学习、GEPA进化、FTS5记忆 |
| **OpenCode** | Rust | CLI Agent | 轻量级、TUI界面 |
| **Codex CLI** | Rust | CLI Agent | OpenAI生态、IDE集成 |
| **Claude Code** | TypeScript | CLI Agent | Anthropic生态、MCP协议 |

---

## 一、功能差距分析

### 1. Commander 缺失的 Hermes 功能

| 功能 | Hermes | Commander | 差距严重度 |
|------|--------|-----------|-----------|
| **FTS5全文搜索** | ✅ SQLite FTS5，搜所有历史对话 | ❌ 只有嵌入搜索 | 🔴 严重 |
| **闭环学习** | ✅ Agent自主决定记忆什么 | ❌ 需显式调用 | 🔴 严重 |
| **用户建模 (Honcho)** | ✅ 跨会话深化用户画像 | ❌ 无 | 🔴 严重 |
| **GEPA进化** | ✅ 遗传帕累托优化，$2-10/次 | ❌ 只有Thompson Sampling | 🟡 中等 |
| **轨迹压缩** | ✅ 长对话自动压缩 | ❌ 无 | 🟡 中等 |
| **自主技能创建** | ✅ 从复杂任务自动提取技能 | ✅ 有技能系统 | ✅ 已有 |
| **SOUL.md身份文件** | ✅ 持久化Agent身份 | ❌ 无 | 🟡 中等 |
| **6沙箱后端** | ✅ Local/Docker/SSH/Singularity/Modal/Daytona | ✅ 3个(Local/Docker/SSH) | 🟡 中等 |
| **消息网关** | ✅ Telegram/Discord/Slack/WhatsApp/Signal | ✅ 只有Telegram | 🟡 中等 |
| **RPC子Agent** | ✅ 零上下文成本管道 | ❌ 无 | 🟡 中等 |
| **agentskills.io** | ✅ 80+可加载技能 | ❌ 无市场 | 🟡 中等 |

### 2. Commander 缺失的 Codex/Claude Code 功能

| 功能 | Codex/Claude Code | Commander | 差距严重度 |
|------|-------------------|-----------|-----------|
| **IDE集成** | ✅ VS Code/JetBrains | ❌ 无 | 🟢 不需要(通用Agent) |
| **桌面应用** | ✅ Mac/Windows | ❌ 无 | 🟢 不需要 |
| **CI/CD集成** | ✅ GitHub Action | ❌ 无 | 🟡 中等 |
| **MCP服务端** | ✅ | ✅ 已有 | ✅ 已有 |
| **审批模式** | ✅ plan/read-only/auto | ✅ 已有 | ✅ 已有 |
| **Session持久化** | ✅ | ✅ 已有 | ✅ 已有 |

### 3. Commander 缺失的 OpenCode 功能

| 功能 | OpenCode | Commander | 差距严重度 |
|------|----------|-----------|-----------|
| **Rust性能** | ✅ 原生二进制 | ❌ Node.js | 🟢 可接受 |
| **轻量级** | ✅ 极简 | ❌ 较重 | 🟢 定位不同 |
| **Ratatui TUI** | ✅ 精美终端UI | ✅ 有TUI | ✅ 已有 |

---

## 二、关键差距优先级

### 🔴 P0: 必须补齐 (影响核心竞争力)

#### 1. FTS5全文搜索记忆
**现状**: Commander只有嵌入搜索，无法精确匹配关键词
**Hermes**: SQLite FTS5索引，搜所有历史对话，LLM摘要
**影响**: 用户问"上次那个bug怎么修的"搜不到
**实现**:
```sql
CREATE VIRTUAL TABLE conversations USING fts5(
  session_id, role, content, 
  tokenize='porter unicode61'
);
```

#### 2. 闭环学习 (自主记忆)
**现状**: Commander需要显式调用memory_store
**Hermes**: Agent自主决定什么值得记住
**影响**: 记忆不完整，需要用户手动管理
**实现**: 在agent loop中添加记忆决策器，基于信息密度和重要性自动存储

#### 3. 用户建模
**现状**: Commander不了解用户偏好
**Hermes**: Honcho式辩证用户模型，跨会话深化
**影响**: 每次对话都从零开始，不记得用户习惯
**实现**: 维护user.md文件，记录偏好、常用命令、项目结构等

---

### 🟡 P1: 应该补齐 (提升竞争力)

#### 4. 轨迹压缩
**现状**: 长对话上下文膨胀
**Hermes**: 自动压缩历史对话为摘要
**影响**: 长任务token浪费严重
**实现**: 当上下文超过阈值时，用LLM压缩早期对话

#### 5. GEPA式进化
**现状**: Commander只有Thompson Sampling
**Hermes**: 遗传帕累托优化，分析失败根因
**影响**: 自我进化能力弱于Hermes
**实现**: 在MetaLearner中添加根因分析和变异优化

#### 6. 更多沙箱后端
**现状**: Commander有Local/Docker/SSH
**Hermes**: 额外支持Singularity/Modal/Daytona(无服务器)
**影响**: 无法支持serverless场景
**实现**: 添加Modal和Daytona后端

#### 7. 更多消息网关
**现状**: Commander只有Telegram
**Hermes**: Telegram/Discord/Slack/WhatsApp/Signal
**影响**: 无法在其他平台使用
**实现**: 基于ChannelAdapter接口添加Discord/Slack适配器

#### 8. RPC子Agent管道
**现状**: Commander子Agent有上下文开销
**Hermes**: Python RPC脚本零上下文成本
**影响**: 多Agent管道token浪费
**实现**: 实现轻量级RPC调用机制

#### 9. 技能市场
**现状**: Commander技能系统封闭
**Hermes**: agentskills.io 80+可加载技能
**影响**: 用户需要自己开发技能
**实现**: 建立技能注册中心和社区贡献机制

---

### 🟢 P2: 可以后续 (锦上添花)

#### 10. SOUL.md身份文件
**现状**: Commander无持久化Agent身份
**Hermes**: SOUL.md定义Agent人格和行为准则
**影响**: Agent行为不一致
**实现**: 支持.commander/soul.md配置文件

#### 11. CI/CD集成
**现状**: Commander无GitHub Action
**Codex**: 有GitHub Action用于CI/CD
**影响**: 无法自动化工作流
**实现**: 创建commander-github-action

#### 12. SWE-bench提交
**现状**: Commander未提交SWE-bench
**Hermes/Codex**: 有相关基准
**影响**: 缺少标准基准可信度
**实现**: 创建SWE-bench runner并提交

---

## 三、Commander领先的地方

| 功能 | Commander | Hermes | OpenCode | Codex | Claude Code |
|------|-----------|--------|----------|-------|-------------|
| **多Agent拓扑** | ✅ 10种自动选择 | ❌ 手动 | ❌ 单Agent | ❌ 单Agent | ❌ 单Agent |
| **幻觉检测** | ✅ 8信号零成本 | ❌ | ❌ | ❌ | ❌ |
| **治理检查点** | ✅ 3模式 | ❌ | ❌ | ✅ 简单 | ✅ 简单 |
| **共识验证** | ✅ 多模型投票 | ❌ | ❌ | ❌ | ❌ |
| **SSE流式** | ✅ 实时可见 | ✅ | ❌ | ❌ | ✅ |
| **Prometheus指标** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **OpenTelemetry** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **多租户** | ✅ 隔离 | ❌ | ❌ | ❌ | ❌ |
| **LLM提供商** | 22个 | 200+(OpenRouter) | 多个 | OpenAI | Anthropic |
| **崩溃恢复** | ✅ 原子检查点 | ❌ | ❌ | ✅ | ✅ |
| **补偿注册** | ✅ 工具回滚 | ❌ | ❌ | ❌ | ❌ |
| **A2A协议** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **基准测试** | ✅ 多个 | ❌ | ❌ | ❌ | ❌ |

---

## 四、实现路线图

### Phase 1: 闭合Hermes差距 (1-2个月)
1. **FTS5全文搜索** — SQLite FTS5索引历史对话
2. **闭环学习** — Agent自主记忆决策器
3. **用户建模** — user.md持久化用户画像
4. **轨迹压缩** — 长对话自动压缩

### Phase 2: 增强进化能力 (2-3个月)
5. **GEPA式进化** — 根因分析 + 变异优化
6. **RPC子Agent** — 零上下文成本管道
7. **更多沙箱** — Modal/Daytona无服务器后端

### Phase 3: 扩展生态 (3-6个月)
8. **技能市场** — 社区贡献的可加载技能
9. **消息网关** — Discord/Slack适配器
10. **CI/CD集成** — GitHub Action
11. **SOUL.md** — Agent身份配置

---

## 五、总结

### Commander核心优势
- ✅ 多Agent编排 (10种拓扑，独有)
- ✅ 幻觉检测 (8信号，独有)
- ✅ 治理和可观测 (最完善)
- ✅ 多租户 (独有)
- ✅ 崩溃恢复 (原子检查点)

### 必须补齐的差距
- ❌ FTS5全文搜索 (Hermes)
- ❌ 闭环学习 (Hermes)
- ❌ 用户建模 (Hermes)
- ❌ 轨迹压缩 (Hermes)
- ❌ GEPA进化 (Hermes)
- ❌ 更多沙箱后端 (Hermes)
- ❌ 技能市场 (Hermes)

### 定位建议
**Commander = 企业级多Agent编排 + 治理 + 可观测**
**Hermes = 自主学习Agent + 持久记忆 + 自我进化**

两者不是替代关系，而是互补：
- 需要复杂多Agent协作 → Commander
- 需要持久学习和自我进化 → Hermes
- 两者都用 → Commander + Hermes记忆/进化能力
