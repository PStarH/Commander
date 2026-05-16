# Commander 降维打击战略

## 竟品全景图

```
                     单Agent系统                       多Agent系统
                   ┌──────────────────┐           ┌──────────────────┐
                   │   Claude Code    │           │    CrewAI        │
     编程Agent      │   Codex CLI      │           │    AutoGen       │
                   │   OpenCode       │           │    LangGraph     │
                   └──────┬───────────┘           └────────┬─────────┘
                          │                               │
                          └───────────┬───────────────────┘
                                      │
                              ┌───────┴────────┐
                              │   OpenClaw     │
     通用Agent                │   Hermes Agent │
                              └───────┬────────┘
                                      │
                              ┌───────┴────────┐
                              │ ★ Commander ★  │  ← 我们在这里
                              └────────────────┘
```

## 竟品架构对比

### Codex CLI (OpenAI) — 最强的编程Agent
```
架构: 单Agent循环 → Responses API → 工具执行 → 循环
内核: Rust (codex-rs), 67K+ GitHub stars
工具: shell, apply_patch, js_repl, list_dir, view_image, spawn_agent
子Agent: ✅ 通过 spawn_agent/wait_agent
MCP: ✅ 原生
Context: Conversation Compaction (compaction endpoint)
缓存: Prompt prefix caching
弱点: ❌ 单拓扑 ❌ 无质量门 ❌ 无自进化 ❌ 只有1个provider
```

### Claude Code (Anthropic) — 最流行的编程Agent
```
架构: 单Agent循环 → Messages API → 工具执行 → 循环
工具: Bash, Edit, Write, Glob, Read
子Agent: ✅ Agent Teams (2026.02发布)
MCP: ✅ 原生
Context: Summarization + caching
弱点: ❌ 单拓扑 ❌ 无质量门 ❌ 无自进化 ❌ 仅Anthropic provider
```

### OpenCode (SGLang) — 最强开源编程Agent
```
架构: Client-Server (HTTP+SSE), Primary+Subagent双层
工具: 14+ 内置, 6层执行流水线, Zod schema验证
子Agent: ✅ General/Explore作为subagent
MCP: ✅ 原生
插件: 20+ hook 事件驱动架构
Context: Protection window + progressive pruning + compaction
Provider: 75+ 通过抽象层
弱点: ❌ 单拓扑 ❌ 无质量门 ❌ 编程专用 ❌ 无自进化
```

### OpenClaw — 通用Agent平台
```
架构: 双循环(外=规划,内=执行), 单Gateway多Agent路由
工具: File-based context, tool registry, Docker沙箱
子Agent: ✅ sessions_spawn, ACP runtime, 嵌套深度5
MCP: ✅ 原生
Memory: 文件共享(AGENTS.md/SOUL.md/TOOLS.md)
沙箱: Docker-level, loopback-only networking
弱点: ❌ 单拓扑 ❌ 无质量门 ❌ 文件协调原始 ❌ 无结构化memory
```

### Hermes Agent (Nous Research) — 自进化通用Agent
```
架构: 单同步循环, 13700行run_agent.py
工具: 70+ 工具, 28工具集, 自动注册, ThreadPoolExecutor并行
子Agent: ✅ delegate_task
MCP: ✅ 原生
自进化: ✅ Skill创建 + 自改进 + FTS5记忆
Context: Pluggable context engine, lossy summarization
弱点: ❌ 单拓扑 ❌ 无质量门 ❌ 13700行单文件 ❌ 无多Agent编排
```

## 降维打击矩阵

### 维度1: Agent拓扑编排 — 从1到8的降维

```
竟品: 所有5款都是单拓扑(Agent Loop)
我们: 8种动态拓扑 + LAMaS DAG依赖分析

竟品场景: 全用同一模式处理所有任务
我们的场景: 
  SINGLE → "2+2=?" 零开销
  PARALLEL → 独立研究任务 5x加速
  HIERARCHICAL → Lead分解给Sub-agents
  DEBATE → 关键决策需多方验证
  ENSEMBLE → 高风险任务多模型投票
  EVALUATOR-OPTIMIZER → Code Review
  HYBRID → 复杂任务组合策略
  SEQUENTIAL → 有严格依赖的任务链

碾压点: 竟品在单模式上优化, 我们8种自动切换 + 14-23% improvement (AdaptOrch)
→ 竟品连"为什么选择单拓扑"的系统论证都没有
```

### 维度2: 质量门 — 从0到5的降维

```
竟品: 0个质量门 (全靠模型本身)
我们: 5个质量门 (Hallucination/Consistency/Completeness/Accuracy/Safety)

竟品场景: 模型输出什么就接受什么
我们的场景:
  Hallucination Gate: 检测事实性幻觉
  Consistency Gate: 确保自洽性
  Completeness Gate: 检查是否覆盖所有要求
  Accuracy Gate: 验证准确性
  Safety Gate: 安全护栏

碾压点: 竟品=模型说什么就是什么, 我们有5道检验
→ Hermes连"context pressure warnings"都当feature, 我们有5个正式质量门
```

### 维度3: 自进化 — 完全碾压

```
竟品: 
  - Codex/Claude Code/OpenCode: 0 自进化
  - OpenClaw: 0 自进化 (只靠用户写AGENTS.md)
  - Hermes: 部分自进化 (skill创建+记忆)
  
我们:
  ✅ MetaLearner (Thompson Sampling策略优化)
  ✅ Reflexion (后执行反思)
  ✅ EvolutionaryWorkflowEngine (遗传算法优化)
  ✅ RuntimeWorkflowAdapter (EvoMAS-style自适应)
  ✅ 3层记忆系统 (Working/Episodic/Semantic)
  ✅ 循环检测 (3-mode)
  ✅ Tool Approval (11默认策略)
  ✅ PASTE (推测执行)

碾压点: Hermes的"self-improving"只是skill创建 + FTS5记忆
我们的自进化 = 策略优化 + 拓扑优化 + 工作流进化 + 运行时自适应
→ 不是一个数量级的
```

### 维度4: 工具调用 — 对标+超越前3(Codex/Claude/OpenCode)

```
Codex的工具系统:
  - shell, apply_patch, js_repl, list_dir
  - FuturesOrdered并行执行
  - Guardian审批系统
  - token-aware truncation

我们的对标:
  ✅ 并行工具执行 (concurrent-safe + serial分区)
  ✅ 工具审批 (ToolApproval + 11默认策略)
  ✅ 结果预算 (大结果截断+文件保存)
  ✅ Observation Mask (NeurIPS 2025: 52%成本降低)
  ✅ Descending Scheduler (W&D: +7.3% BrowseComp)
  ✅ AWO (Meta-Tool编译)
  ✅ ITR (动态工具检索)
  
超越: 竟品没有任何动态检索/Observation Mask/Meta-Tool

Claude Code的工具系统:
  - Bash, Edit, Write, Glob, Read
  - 有限并发
  - 基本审批

我们的超越:
  ✅ 同Codex的所有能力
  ✅ + 循环检测 (竟品全部没有!)
  ✅ + Speculative Execution (PASTE: 预测性预执行)
  ✅ + Entropy Gating (跳过不需要的工具定义)
  ✅ + 15个工具 vs 5-10个
```

### 维度5: Provider生态 — 从1到8的降维

```
竟品:
  Codex = 仅OpenAI
  Claude Code = 仅Anthropic
  OpenCode = 75+ (但编程专用)
  OpenClaw = 5+ 
  Hermes = 10+

我们: 8 providers + 自动检测
  OpenAI, Anthropic, Google, OpenRouter, MiMo, DeepSeek, GLM, Xiaomi
  + 统一fallback链
  + OpenAI-compatible自动适配

碾压点: 我们是通用Agent ≠ 编程Agent
→ 可以同时调MiMo+DeepSeek+GLM作为consensus集群
→ 竟品只能绑一个provider
```

## 投放文案策略

### 定位

```
Commander = 通用AI Agent编排系统
不是"编程Agent" → 超越编程Agent
8种动态拓扑 → 所有竟品1种
5个质量门 → 所有竟品0个
自进化引擎 → 只有Hermes有1/10
8 providers → 所有竟品1-5个
```

### 对每个竟品的打击点

**对Codex**: "你以为tool calling就是shell+apply_patch? Commander有动态检索+循环检测+推测执行+meta-tool编译，你有几个?"

**对Claude Code**: "Agent Teams很酷, 但你只有1种拓扑。Commander有8种动态拓扑自动切换, 你的团队只能在单一loop里跑。"

**对OpenCode**: "75个provider? 你是编程Agent, Commander是通用Agent。多Agent编排你只有primary+subagent两层, 我们有8种编排策略+LAMaS DAG。"

**对OpenClaw**: "你还用文件来协调多Agent? 2026年了。Commander有EvoMAS运行时自适应+Reflexion拓扑优化。你的file-based memory在Commander的3层记忆系统面前像玩具。"

**对Hermes**: "你引以为傲的self-improving只是skill创建。Commander有Thompson Sampling策略优化 + 遗传算法工作流进化 + Reflexion反思。不是一个维度。"

### 核心叙事

```
Commander不是"又一个Agent框架"
它是Agent框架的操作系统

竟品: 每个框架固定一种执行模式
Commander: 8种模式根据任务自动切换

竟品: 模型说什么就是什么
Commander: 5道质量门验证每个输出

竟品: 永远不会从经验中学习
Commander: 每次执行都反思+进化

竟品: 被一个LLM provider绑定
Commander: 8个自动检测+统一fallback

竟品: 解决单一问题
Commander: 解决所有问题
```

## 致命漏洞（来自Code/Issue层面分析）

### OpenClaw #45049 — Tool Call仿真绕过漏洞 ⚠️⚠️⚠️
```
OpenClaw的agent循环解析模型输出的文本作为工具调用，而不是要求模型发出有效的tool_calls对象。
当模型产生JSON代码块时，agent循环将其视为等价于真正的工具调用——但它不是。

后果: 所有预执行钩子(before_tool_call、策略检查、来源追踪)在模型绕过协议层使用纯文本时全部被绕过!

Commander: 严格执行协议层tool_calls, 永不解析文本为工具调用
```

### Hermes #20849 — 截断覆盖永久删除源代码 ⚠️⚠️⚠️
```
Hermes读取大文件时截断占位符(/* ... full function ... */) 会无意识写回文件, 永久删除源代码!

后果: 工具在读取大文件后截断了输出, 后续写操作把截断内容当成了完整内容写回

Commander: 结果预算系统自动将大输出保存到文件, 返回引用而非截断内容
```

### BFCL v3 — 工具链复合错误率 ⚠️⚠️
```
单工具96% → 5工具链 = 96%^5 = 59%端到端成功率
10工具链 = 35%

竟品: 全都天真地假设"per-call accuracy = system accuracy"
Commander: 循环检测 + 结构化错误恢复 + 质量门 = 打破复合错误链
```

### Claude Code — 33K token不可配置的缓冲 ⚠️⚠️
```
200K context window = 33K永久保留给compaction buffer
用户不能关闭这个缓冲(#15435被rejected)
有效可用只有114K-167K (system+tool+buffer吃掉剩下的)
```

### OpenCode — 6,107个open issues ⚠️⚠️
```
Session snapshot导致多GB内存泄漏(#17226)
大型AGENTS.md > 100KB导致立即compaction循环(#18037)
恶意opencode.json可执行任意命令RCE(#6361)
145K stars但6107 open issues = 可靠性灾难
```

## 降维打击终极话术

| 话术 | 打谁 | 证据 |
|------|------|------|
| "你能确保工具调用是真的调用还是模型在脑补?" | OpenClaw | #45049 OpenClaw的模型可以文本模拟工具调用绕过安全钩子 |
| "你的系统能防止截断占位符把源代码删了吗?" | Hermes | #20849 Hermes读大文件后覆盖写回永久删除代码 |
| "你的5个工具链成功率是多少? 我们的循环检测打破了复合错误链" | 所有竞品 | BFCL v3: 5个工具链59%, 10个工具链35% |
| "你的33K token谁都不能动?" | Claude Code | #15435 硬编码compaction缓冲, 用户不能配置 |
| "你6K个open issue修了几个?" | OpenCode | 6,107 open issues, 767 releases in 1 year = 稳定性灾难 |
| "你被$200/mo绑定到一个provider上了吗?" | Codex | Plus=$20/mo(32K context cut), Pro=$200/mo, 无BYOK |

## 立即行动

1. **终结"编程Agent"叙事** — 我们是通用Agent编排系统
2. **所有竞品对比表** — 发布到HN/Reddit/Twitter
3. **GAIA benchmark** — 用我们的8 provider consensus打榜
4. **端到端demo** — 展示8拓扑切换的实况
5. **开源打擂** — 在竞品GitHub issue里贴对比
