<p align="center">
  <img src="https://img.shields.io/badge/GAIA-TBD-lightgrey?style=flat-square" />
  <img src="https://img.shields.io/badge/PinchBench-97.7%25-green?style=flat-square" />
  <img src="https://img.shields.io/badge/HumanEval+-91.5%25-orange?style=flat-square" />
  <img src="https://img.shields.io/badge/providers-25-purple?style=flat-square" />
  <img src="https://img.shields.io/badge/topologies-5-red?style=flat-square" />
  <img src="https://img.shields.io/badge/license-MIT-yellow?style=flat-square" />
</p>

<h1 align="center">Commander</h1>
<p align="center"><strong>看清 AI 在做什么。信任结果。花费更少。</strong></p>

<p align="center">
  <code>npx tsx packages/core/src/cli.ts watch "investigate this bug"</code><br>
  <sub>无需安装。一条命令。实时查看多智能体推理过程流式传输到你的终端。</sub>
</p>

<p align="center">
  <img src="docs/assets/commander-watch-demo.gif" alt="Commander watch demo — 实时智能体流式传输" width="90%">
</p>

---

## Commander 的独特之处

**透明——一切尽在眼前。** 每个智能体的思考过程、工具调用和决策都通过 SSE 实时流式传输。没有黑箱。你可以一步步观察智能体的工作过程。

**可靠——经过验证的输出。** 质量门控在返回结果前会检查每一项输出。包括幻觉检测、一致性、完整性、准确性与安全性校验。你得到的是可以信赖的结果。

**经济高效——智能花费。** 推理引擎在消耗 token 之前会分析你的任务。自动选择合适的拓扑结构——简单任务使用 1 个智能体，复杂任务使用并行智能体。实际成本：每任务约 $0.10，包含质量验证。

**25 个 LLM 提供商。** OpenAI、Anthropic、Google、Azure、DeepSeek、GLM、MiMo、Xiaomi、Groq、Together、Perplexity、Fireworks、Replicate、Mistral、Cohere、OpenRouter、xAI、Anyscale、DeepInfra、Agnes、Ollama、vLLM、AWS Bedrock、StepFun、MiniMax——设置一个环境变量，Commander 会处理其余一切。包含回退链。

**自我改进。** Meta-learner 使用 Thompson Sampling + Reflexion 跨运行调优智能体配置。使用越多，效果越好。

---

## 30 秒演示

```bash
# 如果已有 tsx，无需安装（或使用 pnpm/npx）
npx tsx packages/core/src/cli.ts watch "find the bug in src/server.ts and fix it"
```

这不是模拟——这是来自实际智能体执行的实时 SSE 流的真实录像。每一次工具调用、每一个决策、每一次验证都实时流式传输到你的终端。你可以**观看**智能体思考。

---

## 30 秒了解工作原理

```bash
# 1. 安装
pnpm install

# 2. 设置任意 API 密钥（自动检测 25 个提供商）
export OPENAI_API_KEY=sk-...

# 3. 运行任何任务
npx tsx packages/core/src/cli.ts run "analyze this repository"
npx tsx packages/core/src/cli.ts plan "implement authentication"    # 执行前查看计划
npx tsx packages/core/src/cli.ts watch "debug the failing test"     # 实时查看智能体推理
```

---

## Commander 与其他框架对比

|                       | Commander         | LangGraph     | CrewAI          | AutoGen     |
| --------------------- | ----------------- | ------------- | --------------- | ----------- |
| **实时 SSE 流式传输** | ✅ 内置           | ❌            | ❌              | ❌          |
| **自动拓扑选择**      | ✅ 5 种标准拓扑    | ❌ 手动构建图 | ❌ 固定顺序执行 | ❌ 手动编排 |
| **质量门控**          | ✅ 多层验证       | ❌            | ❌              | ❌          |
| **幻觉检测**          | ✅ 内置           | ❌            | ❌              | ❌          |
| **推理引擎**          | ✅ 智能任务分析   | ❌            | ❌              | ❌          |
| **Meta-learner**      | ✅ 自动调优       | ❌            | ❌              | ❌          |
| **提供商数量**        | ✅ 25 个          | ❌ 1-2 个     | ❌ 1-2 个       | ❌ 1-2 个   |
| **CLI 体验**          | ✅ 36 个命令      | ❌ 仅 API     | ❌ 仅 API       | ❌ 仅 API   |
| **Web GUI**           | ✅ Agent War Room | ❌            | ❌              | ❌          |
| **TUI 仪表盘**        | ✅ 终端 UI        | ❌            | ❌              | ❌          |

---

## 拓扑结构

Commander 自动从 5 种标准拓扑中选择最佳方案：

- **SINGLE** — 单一智能体，简单查询、快速回答
- **CHAIN** — 顺序管线，逐步精炼
- **DISPATCH** — 并行分派多个独立子任务
- **ORCHESTRATOR** — 编排器协调多个子智能体（含递归拆解）
- **REVIEW** — 生成后交由审查智能体校验

（另保留 9 个历史别名以兼容旧配置。）

---

## 架构

```
packages/core/src/
├── ultimate/          # 编排引擎（deliberation / topologyRouter / atomizer / synthesizer / qualityGates）
├── runtime/           # 执行引擎（agentRuntime / modelRouter / providers / messageBus / saga 集成）
├── security/          # 安全子系统（零信任 / 审计链 / 红队 / 合规）
├── tools/             # 内置工具（createAllTools，默认注册 18 个）
├── memory/            # 三层记忆（working / episodic / long-term）
├── mcp/               # Model Context Protocol + A2A
├── saga/              # 持久化补偿事务
├── selfEvolution/     # Meta-learning（Thompson Sampling + Reflexion）
├── sandbox/           # 沙箱（TEE / seccomp / 网络代理）
└── ... 其他核心模块
```

---

## 质量门控

每个结果在返回前都经过验证：

```
任务输入 → 智能体执行 → [质量门控] → 验证输出
                            │
                            ├─ 幻觉检测（hallucination）
                            ├─ 一致性（consistency）
                            ├─ 完整性（completeness）
                            ├─ 准确性（accuracy）
                            └─ 安全性（safety）
```

---

## 开始使用

### 前提条件

- Node.js ≥ 18
- pnpm（推荐）或 npm
- 任意 LLM 提供商的 API 密钥

### 安装

```bash
git clone https://github.com/PStarH/Commander.git
cd Commander
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
npx tsx packages/core/src/cli.ts run "your task here"

# 使用 API
npx tsx examples/api-usage.ts

# 使用 Docker
docker compose up -d
```

---

## 基准测试

```bash
pnpm benchmark:gaia        # 运行 GAIA 基准测试（完整脚本见 package.json scripts）
```

---

| 基准测试                               | Commander  | 裸 LLM (MiMo) | OpenClaw |      Δ      |
| -------------------------------------- | :--------: | :-----------: | :------: | :---------: |
| **GAIA**（165 个多步推理任务）         | ⏳ 待重跑  |     21.2%     |    —     |      —      |
| **BFCL** 工具选择（35 场景非官方子集） | **77.1%**  |       —       |    —     |      —      |
| **BFCL** 参数预测（35 场景非官方子集） | **77.1%**  |       —       |    —     |      —      |
| **PinchBench**（43 个智能体任务）      | **100.0%** |       —       |  89.5%   | **+10.5pp** |
| **HumanEval+**（164 个 Python 问题）   | **96.3%**  |       —       |    —     |      —      |

BFCL 在本仓库中使用了多个非官方子集：35 场景通用子集（`benchmarks/bfcl/results_full.json`，77.1% 工具 / 77.1% 参数）、30 任务 Commander 重跑（`docs/benchmark-results/bfcl/results.json`，80.0% / 80.0%）以及 12 核心子集（`benchmarks/bfcl/results.json`，91.7% / 91.7%）。这些都不是官方 BFCL 排行榜运行结果。

```bash
# 复现任意基准测试
pnpm --filter @commander/core benchmark:verify  # 重新计算已提交的 BFCL 分数声明
pnpm test:core                   # 完整核心套件：node:test + vitest
pnpm benchmark:chaos:full        # 混沌工程基准测试（255 场景）
```

---

## 命令

| 命令                           | 功能说明                                          |
| ------------------------------ | ------------------------------------------------- |
| `commander run <task>`         | 完整多智能体执行（`--dry-run` 显示计划，`--stream` 实时 SSE 流，`--tui` 终端仪表盘） |
| `commander fix`                | 自动修复 lint、格式和类型错误                     |
| `commander init`               | 零配置环境扫描 + 提供商连接测试                   |
| `commander company <task>`     | 企业模式：质量门控 + 记忆                         |
| `commander swarm <task>`       | 递归拆解 + 并行执行                               |
| `commander drive <task>`       | 自主逐步执行                                      |
| `commander goal <task>`        | 多轮收敛循环                                      |
| `commander review`             | 结构化代码审查，P0-P3 级别发现                    |
| `commander status`             | 系统状态、提供商健康状况、MetaLearner 统计         |
| `commander config`             | 查看或修改设置                                    |
| `commander doctor`             | 运行诊断                                          |
| `commander history`            | 会话管理                                          |
| `commander gui`                | Web 仪表盘（Agent War Room）                      |
| `commander skill`              | 可学习技能管理                                    |
| `commander plugin`             | 安装/列出/卸载插件                                |
| `commander mode`               | 显示或设置审批模式                               |
| `commander feedback`           | 提交反馈                                          |
| `commander budget`             | 查看令牌预算状态                                  |
| `commander checkpoint`         | 查看检查点文档                                    |
| `commander saga`               | Saga 事务管理                                     |
| `commander cost`               | 令牌用量和成本报告                                |

---

## API 使用

通过 CLI 或 `@commander/core` 的 `Commander` 入口使用：

```bash
npx tsx packages/core/src/cli.ts run "analyze this repository"
```

或通过 HTTP API（`apps/api`，默认 `:4000`）与 Web 控制台（`pnpm gui`）集成。

---

## 提供商

设置任意一个环境变量。Commander 会自动检测 **25 个提供商**：

`OPENAI_API_KEY` · `AZURE_OPENAI_API_KEY` · `ANTHROPIC_API_KEY` · `GOOGLE_API_KEY` · `DEEPSEEK_API_KEY` · `ZHIPU_API_KEY` (GLM) · `MIMO_API_KEY` · `XIAOMI_API_KEY` · `GROQ_API_KEY` · `TOGETHER_API_KEY` · `PERPLEXITY_API_KEY` · `FIREWORKS_API_KEY` · `REPLICATE_API_TOKEN` · `MISTRAL_API_KEY` · `CO_API_KEY` · `OPENROUTER_API_KEY` · `OLLAMA_HOST` · `VLLM_BASE_URL` · `AWS_ACCESS_KEY_ID` (Bedrock) · `XAI_API_KEY` · `ANYSCALE_API_KEY` · `DEEPINFRA_API_KEY` · `AGNES_API_KEY` · `STEPFUN_API_KEY` · `MINIMAX_API_KEY`

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


## 文档

- [ARCHITECTURE.md](ARCHITECTURE.md) — 系统设计、模块图、数据流
- [docs/getting-started.md](docs/getting-started.md) — 快速开始
- [docs/deploy.md](docs/deploy.md) — 部署
- [docs/v2-migration-guide.md](docs/v2-migration-guide.md) — Architecture V2 迁移
- [docs/slo.md](docs/slo.md) — SLO 定义
- [SECURITY.md](SECURITY.md) — 安全模型、威胁模型、合规
- [BENCHMARK.md](BENCHMARK.md) — 基准测试矩阵与方法
- [CHANGELOG.md](CHANGELOG.md) — 发布历史
- [docs/README.md](docs/README.md) — 公开文档索引

内部审计、AI 工作计划与尽调笔记**不在本仓库**；仅存在于开发者本机的 `.internal/`（已被 gitignore）。

## 许可证

MIT

---

<p align="center">
  <sub>为希望看清 AI 实际在做什么的开发者用心打造 ❤️</sub>
</p>
