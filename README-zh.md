<p align="center">
  <img src="https://img.shields.io/badge/GAIA-TBD-lightgrey?style=flat-square" />
  <img src="https://img.shields.io/badge/providers-25-purple?style=flat-square" />
  <img src="https://img.shields.io/badge/topologies-5-red?style=flat-square" />
  <img src="https://img.shields.io/badge/license-MIT-yellow?style=flat-square" />
</p>

<h1 align="center">Commander</h1>
<p align="center"><strong>看清 AI 在做什么。检查结果。花费更少。</strong></p>

> **Alpha 提示：** Commander 目前是 alpha，尚未达到生产就绪标准。输出、基准、POC
> 场景和仪表盘数据都可能是开发或演示信号；未经自行审查，不要用于无人值守的生产工作负载或敏感数据。

<p align="center">
  <code>pnpm exec tsx packages/core/src/cliEntry.ts watch "investigate this bug"</code><br>
  <sub>无需安装。一条命令。实时查看多智能体事件和工具调用流式传输到你的终端。</sub>
</p>

<p align="center">
  <img src="docs/assets/commander-watch-demo.svg" alt="Commander watch demo — 实时智能体流式传输" width="90%">
</p>

---

> **两种运行方式：** Commander 以两个 SKU 提供 —— **Local CLI**（本地工具，默认，可用于本地开发/单机）与 **Enterprise Gateway**（`/v1` + 可选 Postgres，**alpha**，非 live-fire 证明的完整多租户 SaaS）。详见英文 [README.md](README.md) 的 SKU 表与 [ENTERPRISE_READINESS.md](ENTERPRISE_READINESS.md)。

## Commander 的独特之处

**透明——查看运行事件。** 智能体事件、工具调用和可用的质量门决策会通过 SSE 实时流式传输。你可以逐步检查已发出的工作轨迹。

**可靠——可配置的输出检查。** 在启用验证管线的路径上，质量门控会在返回结果前运行配置的检查，包括幻觉检测、一致性、完整性、准确性与安全性。失败时系统会重试或报告失败。

**经济高效——智能花费。** 推理引擎在消耗 token 之前会分析你的任务。自动选择合适的拓扑结构——简单任务使用 1 个智能体，复杂任务使用并行智能体。实际成本取决于提供商、模型、任务和启用的验证检查。

**25 个 LLM 提供商。** OpenAI、Anthropic、Google、Azure、DeepSeek、GLM、MiMo、Xiaomi、Groq、Together、Perplexity、Fireworks、Replicate、Mistral、Cohere、OpenRouter、xAI、Anyscale、DeepInfra、Agnes、Ollama、vLLM、AWS Bedrock、StepFun、MiniMax——设置一个环境变量，Commander 会处理其余一切。包含回退链。

**自我改进。** Meta-learner 使用 Thompson Sampling + Reflexion 根据已记录运行调优智能体配置；效果取决于任务、模型和数据。

---

## 30 秒演示

```bash
# 如果已有 tsx，无需安装（或使用 pnpm/npx）
pnpm exec tsx packages/core/src/cliEntry.ts watch "find the bug in src/server.ts and fix it"
```

这是用于展示界面的录制示例，展示 CLI 的 SSE 流式交互；它不代表生产运行结果或客户现场证据。

---

## 30 秒了解工作原理

```bash
# 1. 安装
pnpm install

# 2. 设置任意 API 密钥（自动检测 25 个提供商）
export OPENAI_API_KEY=sk-...

# 3. 运行任何任务
pnpm exec tsx packages/core/src/cliEntry.ts run "analyze this repository"
pnpm exec tsx packages/core/src/cliEntry.ts plan "implement authentication"    # 执行前查看计划
pnpm exec tsx packages/core/src/cliEntry.ts watch "debug the failing test"     # 实时查看智能体事件
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

Commander 自动从 5 种标准拓扑中选择合适的方案：

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

在启用验证管线的路径上，结果会在返回前经过配置的检查：

```
任务输入 → 智能体执行 → [质量门控] → 配置检查后的输出
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
pnpm exec tsx packages/core/src/cliEntry.ts run "your task here"

# 运行基础示例
pnpm exec tsx examples/basic.ts

# 使用 Docker
docker compose up -d
```

---

## 基准测试

> 以下基准运行于模拟/脚本化 harness 或 CI 基线，衡量的是 harness，不是生产 SLA 或 SOC 证据。

```bash
pnpm benchmark:gaia        # 运行 GAIA 基准测试（完整脚本见 package.json scripts）
```

---

| 套件 | 覆盖范围 | 结果 |
| ---- | -------- | ---- |
| 混沌工程 | 200 个合成案例 + 55 个变异案例（共 255） | 仅列出 harness；结果见基准矩阵 |
| 红队 | 47 个场景、8 类攻击 | 所列用例均 blocked（模拟 harness） |
| AgentDojo | 12 个安全测试案例 | 所列用例均 blocked（模拟 harness） |
| GAIA Spine | 核心能力基准 | 已调度 quick/offline 回归；完整 fixture 待补齐 |
| SLO | API 可用性 99.95%、P95 调度 <5s | CI 基线，不是生产 SLA |

```bash
# 复现任意基准测试
pnpm test:core                   # 运行核心套件并验证本地基线
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
| `commander company <task>`     | 本地 company 模式：质量门控 + 记忆                 |
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
pnpm exec tsx packages/core/src/cliEntry.ts run "analyze this repository"
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

生产 Compose 覆盖层还可加：CPU/内存限制、JSON 文件日志、自动重启、健康检查、速率限制。多租户属于 **Enterprise Gateway（alpha）**——请求上下文隔离已有；存储层隔离为 opt-in，须对照 `ENTERPRISE_READINESS.md`，**勿当作完整多租户 SaaS**。

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

## 隐私、反馈与安全

- [PRIVACY.md](PRIVACY.md)：provider 外发、trace/memory/audit 保存、保留与删除边界。
- 普通 bug 请提交 [GitHub Issues](https://github.com/PStarH/Commander/issues)，先脱敏 prompt、日志、配置、PII 和密钥。
- 问题讨论和建议请使用 [GitHub Discussions](https://github.com/PStarH/Commander/discussions)。
- 安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 issue。

## 许可证

MIT

---

<p align="center">
  <sub>为希望看清 AI 实际在做什么的开发者用心打造 ❤️</sub>
</p>
