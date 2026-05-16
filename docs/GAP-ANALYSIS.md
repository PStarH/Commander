# 师夷长技以制夷 — Commander差距分析与补全计划

## 竟品真实优势（我们该学的）

### 1. Codex CLI — 最值得学的3个

| 优势 | 细节 | 影响力 |
|------|------|--------|
| **Conversation Compaction** | `/responses/compact` endpoint可以压缩对话而不丢失模型的理解状态。Commander目前只是粗暴drop消息 | ⭐⭐⭐ |
| **工具执行沙箱** | bubblewrap/Landlock沙箱隔离shell执行，支持approval policy控制。Commander完全没有沙箱 | ⭐⭐⭐⭐ |
| **App Server JSON-RPC** | 双向JSON-RPC协议支持Web/CLI/IDE/Desktop四种客户端。Commander只有CLI | ⭐⭐⭐⭐⭐ |
| **Sub-agent角色系统** | default/worker/explorer三种预置角色+自定义TOML。Commander只有AgentTeam没有角色系统 | ⭐⭐ |

### 2. Claude Code — 最值得学的2个

| 优势 | 细节 | 影响力 |
|------|------|--------|
| **Programmatic Tool Calling** | Agent写Python脚本，`from claude_tools import ...`通过RPC调用工具，只有stdout进入context。零中间token成本！Commander没有这个能力 | ⭐⭐⭐⭐⭐ |
| **Streaming-first UX** | 工具执行过程中实时流式预览，用户可以打断。Commander的SSE是后加的，不是原生设计 | ⭐⭐⭐ |

### 3. OpenCode — 最值得学的2个

| 优势 | 细节 | 影响力 |
|------|------|--------|
| **Plugin/Hook系统** | 20+ hook pipeline (`chat.params`, `chat.message`, `event`, `tool.execute.before/after`)，任何人都可以插件注入能力。Commander 0插件 | ⭐⭐⭐⭐⭐ |
| **LSP原生集成** | 读取文件时自动attach diagnostics到tool output。Commander完全不感知LSP | ⭐⭐⭐ |

### 4. OpenClaw — 最值得学的2个

| 优势 | 细节 | 影响力 |
|------|------|--------|
| **Multi-Channel Gateway** | 12+平台（Telegram/Discord/Slack/WhatsApp等），Agent可以作为持久化服务运行在消息平台上。Commander只有CLI一次执行 | ⭐⭐⭐⭐⭐ |
| **44K+社区Skill生态** | 社区贡献的skill可以在ClawHub一键安装。Commander的skill系统只有本地文件 | ⭐⭐⭐⭐ |

### 5. Hermes Agent — 最值得学的2个

| 优势 | 细节 | 影响力 |
|------|------|--------|
| **自进化闭环** | 执行→评估→提取→存储→下次复用，45天验证40%速度提升。Commander的MetaLearner有Thompson Sampling但没有闭环skill创建 | ⭐⭐⭐⭐ |
| **70+工具集** | 按工具集分组管理，支持按平台启用/禁用。Commander只有15个工具，没有工具集概念 | ⭐⭐ |

---

## Commander差距全景图

### 🔴 严重差距（必须补）

| 差距 | 竟品标杆 | 当前状态 | 影响 |
|------|----------|----------|------|
| **Plugin/Hook系统** | OpenCode(20+hooks), OpenClaw(ClawHub), Hermes(plugins) | ❌ 完全没有 | 可扩展性=0 |
| **Messaging Gateway** | OpenClaw(12+渠道), Hermes(6+) | ❌ 只有CLI | 不能作为服务运行 |
| **沙箱/容器隔离** | Codex(bubblewrap), OpenClaw(Docker) | ❌ 直接host执行 | 安全风险 |
| **Provider多样性** | OpenCode(75+), Hermes(10+), OpenClaw(5+) | ⚠️ 8个但只有4个专用Provider | 用户选择受限 |

### 🟡 重要差距（推荐补）

| 差距 | 竟品标杆 | 当前状态 | 影响 |
|------|----------|----------|------|
| **Programmatic Tool Calling** | Claude Code, Hermes | ❌ 完全没有 | 漏掉核心效率feature |
| **Client-Server架构** | Codex(App Server), OpenCode(HTTP+SSE) | ❌ 只有CLI | 不能同时服务多个客户端 |
| **Token-Aware Truncation** | Codex(head+tail elide middle) | ⚠️ 简单slice | 大输出时信息丢失 |
| **Tool Search (大目录)** | OpenClaw(tool_search+scores) | ❌ 全量发所有schema | token浪费 |
| **IDE Integration** | Codex/Claude Code/OpenCode都有 | ❌ 完全没有 | 开发者获取渠道缺失 |
| **Tool Auto-Discovery** | Hermes/OpenClaw自动注册 | ❌ 手动createAllTools() | 扩展工具麻烦 |
| **Tool Categorization** | Hermes 28工具集 | ❌15工具平铺 | 模型选择困难 |
| **File Change Tracking** | Claude Code原生 | ❌ 无 | 无法追踪修改历史 |
| **Structured SSE Events** | Codex(Reasoning/ToolCall/Diff) | ⚠️ 基础emit | 缺少细粒度事件类型 |
| **Per-Tool Timeout** | Claude Code有 | ❌ 只有全局timeout | 单个工具可以卡死全局 |

### 🟢 已有但较弱（可优化）

| 能力 | 当前状态 | 竟品状态 | 差距 |
|------|----------|----------|------|
| **MCP** | Client+Server都有 | Codex弃用MCP, 其他都有 | 已追平 |
| **Skill系统** | 基础实现 | OpenClaw 44K, Hermes自创建 | 缺社区+自动创建 |
| **自进化** | MetaLearner+Reflexion | Hermes有闭环 | 缺skill自动创建 |
| **Memory** | InMemory+Sqlite | Hermes三层+FTS5 | 缺FTS5全文搜索 |
| **SSEStreaming** | 基础实现 | Claude Code原生流式 | 缺实时预览UI |

---

## 补全优先级

### P0 — 立刻（本周）

```
1. Plugin/Hook系统
   └─ 让第三方可以注入: beforeToolCall, afterToolCall, onMessage, onEvent
   └─ 对标OpenCode的20+hooks
   └─ 这是Commander从"框架"变成"平台"的关键一步
   
2. Programmatic Tool Calling
   └─ Agent写TypeScript/Python脚本
   └─ import { commander_tools } from 'commander'
   └─ 只有stdout进context
   └─ 对标Claude Code和Hermes的execute_code
```

### P1 — 下周

```
3. Token-Aware Truncation
   └─ 大输出保留head+tail, elide middle
   └─ 对标Codex的方法
   
4. Messaging Gateway (基础版)
   └─ Agent作为长期服务运行
   └─ Telegram/Slack adapter
   └─ 对标OpenClaw的gateway架构
```

### P2 — 下月

```
5. Client-Server Architecture
   └─ HTTP API + SSE
   └─ 支持Web/CLI同时连接
   └─ 对标OpenCode的架构
   
6. 沙箱/容器隔离
   └─ shell_execute沙箱
   └─ 可选Docker隔离
```

---

## 关键计算：为什么Programmatic Tool Calling是P0

**BFCL v3数据:**
```
单工具accuracy 96%
5工具链 = 0.96^5 = 59%
10工具链 = 0.96^10 = 35%
```

**正常Agent流程（5个工具）:**
```
LLM: 调用tool1 → tool1结果进context → LLM读结果 → 调用tool2 → ... 
= 5次LLM调用, 5次工具结果进context
= 59%成功率, 大量token浪费
```

**Programmatic Tool Calling流程（Claude Code/Hermes）:**
```
LLM: 写脚本 → import tools → tool1(); tool2(); ...; print(result)
= 1次LLM调用, 只有最终print()进context
= 接近96%成功率, 零中间token成本
```

**Commander现在的流程（5个工具）:**
```
与"正常Agent流程"相同, 5次调用5次context
= 59%成功率, 大量token浪费
```

**结论**: 没有Programmatic Tool Calling, Commander的多工具链场景效率只有竟品的60%。这是必须补的核心能力差距。

---

## 实现策略

不直接复制竟品, 而是用Commander的优势（8拓扑+质量门+自进化）来增强：

| 竟品能力 | Commander实现方案 | 优势 |
|----------|-----------------|------|
| Programmatic Tool Calling | TypeScript脚本 + commander_tools模块通过IPC调用 | 可以利用EVALUATOR-OPTIMIZER拓扑验证脚本质量 |
| Plugin/Hook | 基于message bus的事件驱动hook系统 | 可以利用quality gate验证插件安全性 |
| Messaging Gateway | AgentLoop + Channel Adapter模式 | 可以利用8拓扑在不同channel上 |
| 自进化skill创建 | MetaLearner + Reflexion → 自动创建skill | 已有Thompson Sampling, 加自动提取即可 |
