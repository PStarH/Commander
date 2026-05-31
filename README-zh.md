<p align="center">
  <img src="https://img.shields.io/badge/GAIA-69.7%25-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/PinchBench-97.7%25-green?style=flat-square" />
  <img src="https://img.shields.io/badge/HumanEval+-91.5%25-orange?style=flat-square" />
  <img src="https://img.shields.io/badge/providers-21-purple?style=flat-square" />
  <img src="https://img.shields.io/badge/topologies-8-red?style=flat-square" />
  <img src="https://img.shields.io/badge/license-MIT-yellow?style=flat-square" />
</p>

<h1 align="center">Commander</h1>
<p align="center"><strong>看清 AI 在做什么。信任结果。花费更少。</strong></p>

<p align="center">
  <code>npx tsx cli.ts watch "investigate this bug"</code><br>
  <sub>无需安装。一条命令。实时查看多智能体推理过程流式传输到你的终端。</sub>
</p>

<p align="center">
  <img src="docs/assets/commander-watch-demo.gif" alt="Commander watch demo — 实时智能体流式传输" width="90%">
</p>

---

## Commander 的独特之处

**透明——一切尽在眼前。** 每个智能体的思考过程、工具调用和决策都通过 SSE 实时流式传输。没有黑箱。你可以一步步观察智能体的工作过程。

**可靠——经过验证的输出。** 质量门控在返回结果前会检查每一项输出。包括幻觉检测、准确性验证和代码编译检查。你得到的是可以信赖的结果。

**经济高效——智能花费。** 推理引擎在消耗 token 之前会分析你的任务。自动选择合适的拓扑结构——简单任务使用 1 个智能体，复杂任务使用并行智能体。实际成本：每任务约 $0.10，包含质量验证。

**22 个 LLM 提供商。** OpenAI、Anthropic、Google、DeepSeek、Groq、Ollama、Bedrock——设置一个环境变量，Commander 会处理其余一切。包含回退链。

**自我改进。** Meta-learner 使用 Thompson Sampling + Reflexion 跨运行调优智能体配置。使用越多，效果越好。

---

## 30 秒演示

```bash
# 如果已有 tsx，无需安装（或使用 pnpm/npx）
npx tsx cli.ts watch "find the bug in src/server.ts and fix it"
```

这不是模拟——这是来自实际智能体执行的实时 SSE 流的真实录像。每一次工具调用、每一个决策、每一次验证都实时流式传输到你的终端。你可以**观看**智能体思考。

---

## 30 秒了解工作原理

```bash
# 1. 安装
pnpm install

# 2. 设置任意 API 密钥（自动检测 21 个提供商）
export OPENAI_API_KEY=sk-...

# 3. 运行任何任务
npx tsx cli.ts run "analyze this repository"
npx tsx cli.ts plan "implement authentication"    # 执行前查看计划
npx tsx cli.ts watch "debug the failing test"     # 实时查看智能体推理
```

---

## Commander 与其他框架对比

| | Commander | LangGraph | CrewAI | AutoGen |
|---|---|---|---|---|
| **实时 SSE 流式传输** | ✅ 内置 | ❌ | ❌ | ❌ |
| **自动拓扑选择** | ✅ 8 种拓扑 | ❌ 手动构建图 | ❌ 固定顺序执行 | ❌ 手动编排 |
| **质量门控** | ✅ 多层验证 | ❌ | ❌ | ❌ |
| **幻觉检测** | ✅ 内置 | ❌ | ❌ | ❌ |
| **推理引擎** | ✅ 智能任务分析 | ❌ | ❌ | ❌ |
| **Meta-learner** | ✅ 自动调优 | ❌ | ❌ | ❌ |
| **提供商数量** | ✅ 21 个 | ❌ 1-2 个 | ❌ 1-2 个 | ❌ 1-2 个 |
| **CLI 体验** | ✅ 14 个命令 | ❌ 仅 API | ❌ 仅 API | ❌ 仅 API |
| **Web GUI** | ✅ Agent War Room | ❌ | ❌ | ❌ |
| **TUI 仪表盘** | ✅ 终端 UI | ❌ | ❌ | ❌ |

---

## 拓扑结构

Commander 自动从 8 种拓扑中选择最佳方案：

```
┌─────────────────────────────────────────────────────────┐
│                    Deliberation Engine                  │
│              分析任务 → 选择最优拓扑                     │
├─────────┬─────────┬─────────┬─────────┬─────────────────┤
│ Single  │ Parallel│ Pipeline│ Tree    │ DAG             │
│ Agent   │ Agents  │ Chain   │ Hierarchy│ Workflow        │
├─────────┼─────────┼─────────┼─────────┼─────────────────┤
│ Debate  │ Voting  │ Mixture │         │                 │
│ Council │ Ensemble│ of Exp. │         │                 │
└─────────┴─────────┴─────────┴─────────┴─────────────────┘
```

- **Single Agent** — 简单查询、快速回答
- **Parallel Agents** — 多个独立子任务
- **Pipeline Chain** — 顺序处理，逐步精炼
- **Tree Hierarchy** — 分层委派
- **DAG Workflow** — 有依赖关系的复杂工作流
- **Debate Council** — 多视角辩论以获得更佳结果
- **Voting Ensemble** — 多智能体投票达成共识
- **Mixture of Experts** — 专业智能体各司其职

---

## 架构

```
src/
├── core/              # 核心引擎
│   ├── agent.ts       # 智能体生命周期管理
│   ├── orchestrator.ts# 拓扑编排器
│   ├── deliberation.ts# 推理引擎
│   └── quality-gates.ts# 多层验证
├── providers/         # 21 个 LLM 提供商适配器
├── streaming/         # SSE 流式传输引擎
├── meta-learner/      # 自动调优（Thompson Sampling + Reflexion）
├── cli/               # 14 个 CLI 命令
├── web/               # Agent War Room 仪表盘
└── benchmarks/        # GAIA、BFCL、PinchBench、HumanEval+
```

---

## 质量门控

每个结果在返回前都经过验证：

```
任务输入 → 智能体执行 → [质量门控] → 验证输出
                            │
                            ├─ 幻觉检测
                            ├─ 准确性验证
                            ├─ 代码编译检查
                            ├─ 输出格式验证
                            └─ 置信度评分
```

---

## 开始使用

### 前提条件

- Node.js ≥ 18
- pnpm（推荐）或 npm
- 任意 LLM 提供商的 API 密钥

### 安装

```bash
git clone https://github.com/your-org/commander.git
cd commander
pnpm install
```

### 配置

```bash
# 复制示例环境文件
cp .env.example .env

# 设置至少一个 API 密钥
export OPENAI_API_KEY=sk-...
# 或
export ANTHROPIC_API_KEY=sk-ant-...
```

### 运行

```bash
# 使用 CLI
npx tsx cli.ts run "your task here"

# 使用 API
npx tsx examples/api-usage.ts

# 使用 Docker
docker compose up -d
```

---

## 基准测试

```bash
npx commander benchmark    # A/B 测试：优化版 vs 基线版
```

---

| 基准测试 | Commander | 裸 LLM (MiMo) | OpenClaw | Δ |
|-----------|:---------:|:----------------:|:--------:|:-:|
| **GAIA**（165 个多步推理任务） | **69.7%** | 21.2% | — | **+48.5pp** |
| **BFCL** 工具选择（35 场景非官方子集） | **77.1%** | — | — | — |
| **BFCL** 参数预测（35 场景非官方子集） | **77.1%** | — | — | — |
| **PinchBench**（43 个智能体任务） | **100.0%** | — | 89.5% | **+10.5pp** |
| **HumanEval+**（164 个 Python 问题） | **96.3%** | — | — | — |

BFCL 在本仓库中使用了多个非官方子集：35 场景通用子集（`benchmarks/bfcl/results_full.json`，77.1% 工具 / 77.1% 参数）、30 任务 Commander 重跑（`docs/benchmark-results/bfcl/results.json`，80.0% / 80.0%）以及 12 核心子集（`benchmarks/bfcl/results.json`，91.7% / 91.7%）。这些都不是官方 BFCL 排行榜运行结果。

```bash
# 复现任意基准测试
pnpm --filter @commander/core benchmark:verify  # 重新计算已提交的 BFCL 分数声明
pnpm test:core                   # 完整核心套件：node:test + vitest
pnpm benchmark:multiagent        # 多智能体编排基准测试
```

---

## 命令

| 命令 | 功能说明 |
|---------|-------------|
| `commander run <task>` | 完整多智能体执行 |
| `commander plan <task>` | 执行前查看拓扑、智能体数量、预算 |
| `commander watch <task>` | **核心功能**——实时 SSE 智能体思考流 |
| `commander company <task>` | 多智能体公司模式：计划 → 构建 → 审查 → 改进 |
| `commander review` | 结构化代码审查，P0-P3 级别发现 |
| `commander gui` | Web 仪表盘（Agent War Room） |
| `commander tui` | 终端仪表盘 |
| `commander workers <topics>` | 并行研究工作者 |
| `commander mode <mode>` | 计划 / 只读 / 自动编辑 / 全自动 / 建议 |
| `commander status` | 系统状态、提供商健康状况、MetaLearner 统计 |
| `commander history` | 会话管理 |
| `commander skill` | 可学习技能管理 |
| `commander config` | 查看或修改设置 |
| `commander doctor` | 运行诊断 |

---

## API 使用

```typescript
import { CommanderClient } from '@commander/core';

const client = new CommanderClient({ provider: 'openai' });
await client.connect();
const result = await client.run('analyze this repository');
await client.disconnect();
```

---

## 提供商

设置任意一个环境变量。Commander 会自动检测 **21 个提供商**：

`OPENAI_API_KEY` · `ANTHROPIC_API_KEY` · `GOOGLE_API_KEY` · `DEEPSEEK_API_KEY` · `ZHIPU_API_KEY` · `MIMO_API_KEY` · `XIAOMI_API_KEY` · `GROQ_API_KEY` · `TOGETHER_API_KEY` · `PERPLEXITY_API_KEY` · `FIREWORKS_API_KEY` · `REPLICATE_API_TOKEN` · `MISTRAL_API_KEY` · `CO_API_KEY` · `OPENROUTER_API_KEY` · `OLLAMA_HOST` · `VLLM_BASE_URL` · `AWS_ACCESS_KEY_ID` (Bedrock) · `XAI_API_KEY` · `ANYSCALE_API_KEY` · `DEEPINFRA_API_KEY`

---

## 部署

```bash
# 本地（Docker Compose）
docker compose up -d
# → API: localhost:4000  |  Web GUI: localhost:3000

# 生产环境（VM / VPS）
./scripts/deploy-vm.sh your-vm-ip --env-file .env.production
```

生产环境覆盖层添加：CPU/内存限制、JSON 文件日志、自动重启、健康检查、速率限制、多租户支持。

---

## CI/CD

`.github/workflows/ci.yml` — 质量检查（类型检查 + 完整核心测试套件 + 基准测试 + 构建）+ Docker + Web GUI。通过 `.github/workflows/cd.yml` 在 main 分支上自动部署。

---

## 许可证

MIT

---

<p align="center">
  <sub>为希望看清 AI 实际在做什么的开发者用心打造 ❤️</sub>
</p>
