<p align="center">
  <img src="https://img.shields.io/badge/GAIA-69.7%25-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/PinchBench-97.7%25-green?style=flat-square" />
  <img src="https://img.shields.io/badge/HumanEval+-91.5%25-orange?style=flat-square" />
  <img src="https://img.shields.io/badge/providers-18-purple?style=flat-square" />
  <img src="https://img.shields.io/badge/topologies-8-red?style=flat-square" />
  <img src="https://img.shields.io/badge/license-MIT-yellow?style=flat-square" />
</p>

<h1 align="center">Commander</h1>
<p align="center"><strong>Watch your AI agents work — in real time, across any model, at any scale.</strong></p>

<p align="center">
  <code>npx tsx cli.ts watch "investigate this bug"</code><br>
  <sub>No install. One command. See multi-agent reasoning stream live to your terminal.</sub>
</p>

<p align="center">
  <img src="docs/assets/commander-watch-demo.gif" alt="Commander watch demo — live agent streaming" width="90%">
</p>

---

## What makes Commander different

There are dozens of AI agent frameworks. Commander is the only one that:

**🧵 Shows you what's happening inside.** Every agent's thinking, tool calls, and decisions stream in real time via SSE. You don't get a black box — you get a live feed.

**🔀 Runs any topology without changing code.** Same task, one flag: sequential, parallel, hierarchical, debate, ensemble, evaluator-optimizer. The engine picks the right one automatically.

**🔌 Works with 18 LLM providers.** OpenAI, Anthropic, Google, DeepSeek, Groq, Ollama, Bedrock — set one env var, Commander handles the rest. Fallback chains included.

**🧠 Gets better the more you use it.** Meta-learner with Thompson Sampling + Reflexion tunes agent configs across runs. Self-optimizing workflows.

**📊 Has the numbers to back it up.** Benchmarked on GAIA, PinchBench, HumanEval+, BFCL — not just claims.

---

## 30-second demo

```bash
# No install needed if you have tsx (or use pnpm/npx)
npx tsx cli.ts watch "find the bug in src/server.ts and fix it"
```

This isn't a mockup — that's a real recording of the live SSE stream from actual agent execution. Every tool call, every decision, every verification streams to your terminal in real time. You can **watch** your agents think.

---

## How it works in 30 seconds

```bash
# 1. Install
pnpm install

# 2. Set any API key (auto-detects from 18 providers)
export OPENAI_API_KEY=sk-...

# 3. Run anything
npx tsx cli.ts run "analyze this repository"
npx tsx cli.ts plan "implement authentication"    # See plan before executing
npx tsx cli.ts watch "debug the failing test"     # Watch live agent reasoning
```

---

## Commander vs other frameworks

| | Commander | LangGraph | CrewAI | AutoGen |
|---|---|---|---|---|
| **Live SSE streaming** | ✅ Built-in | ❌ | ❌ | ❌ |
| **Automatic topology selection** | ✅ 8 topologies | ❌ Manual graph building | ❌ Fixed sequential | ❌ Manual orchestration |
| **LLM providers** | 18 (with fallback chain) | 1-3 (via LangChain) | 3-5 | Mostly OpenAI |
| **Self-optimization** | ✅ Thompson Sampling + Reflexion | ❌ | ❌ | ❌ |
| **Multi-tenant isolation** | ✅ Per-tenant rate limits, storage, memory | ❌ | ❌ | ❌ |
| **Benchmarked** | GAIA 69.7%, PinchBench 97.7%, HumanEval+ 91.5% | — | — | GAIA varies |
| **Install size** | Lean core package; optional heavy integrations | Heavy | Moderate | Heavy |
| **Crash safety** | ✅ Atomic checkpoints every step | ❌ | ❌ | ❌ |

> Commander adds **+48.5 points** over bare LLM on GAIA. Full data in [`docs/benchmark-results/`](docs/benchmark-results/).

---

## Gallery: what you can do

```bash
# 👁  Watch agent reasoning in real-time
commander watch "analyze this repository"

# 🧠  Multi-agent code review (debate topology)
commander run "review all PR changes for security issues"

# 🔬  Deep research with 20 parallel agents
commander run "research vector database options for our stack" --effort deep_research

# 🏭  Company mode: plan → execute → review → improve
commander company "build a REST API for user management"

# 🤖  Recursive delegation (agents spawning agents)
commander run "refactor the entire auth module"

# 📊  Enterprise: multi-tenant, rate-limited, metrics-enabled
docker compose -f docker-compose.prod.yml up -d
```

---

## Benchmarks

| Benchmark | Commander | Bare LLM (MiMo) | OpenClaw | Δ |
|-----------|:---------:|:----------------:|:--------:|:-:|
| **GAIA** (165 multi-step reasoning tasks) | **69.7%** | 21.2% | — | **+48.5pp** |
| **BFCL** Tool Selection (35-scenario unofficial subset) | **60.0%** | — | — | — |
| **BFCL** Parameter Prediction (35-scenario unofficial subset) | **91.4%** | — | — | — |
| **PinchBench** (43 agentic tasks) | **97.7%** | — | 89.5% | **+8.2pp** |
| **HumanEval+** (164 Python problems) | **91.5%** | — | — | — |

BFCL uses multiple unofficial subsets in this repo: 35-scenario general subset
(`benchmarks/bfcl/results_full.json`, 60.0% tool / 91.4% parameter), 30-task
Commander rerun (`docs/benchmark-results/bfcl/results.json`, 80.0% / 80.0%),
and 12-core subset (`benchmarks/bfcl/results.json`, 91.7% / 91.7%). None of
these are official BFCL leaderboard runs.

```bash
# Reproduce any benchmark
pnpm benchmark:gaia              # Full GAIA (takes a while)
pnpm benchmark:gaia:quick        # 5-task quick check
pnpm test:core                   # Full core suite: node:test + vitest
pnpm benchmark:multiagent        # Multi-agent orchestration benchmark
```

---

## Commands

| Command | What it does |
|---------|-------------|
| `commander run <task>` | Full multi-agent execution |
| `commander plan <task>` | Shows topology, agent count, budget before execution |
| `commander watch <task>` | **The killer feature** — live SSE stream of agent thinking |
| `commander company <task>` | Multi-agent company mode: plan → build → review → improve |
| `commander review` | Structured code review with P0-P3 findings |
| `commander gui` | Web dashboard (Agent War Room) |
| `commander tui` | Terminal dashboard |
| `commander workers <topics>` | Parallel research workers |
| `commander mode <mode>` | Plan / read-only / auto-edit / full-auto / suggest |
| `commander status` | System status, provider health, MetaLearner stats |
| `commander history` | Session management |
| `commander skill` | Learnable skill management |
| `commander config` | View or change settings |
| `commander doctor` | Run diagnostics |

---

## Architecture (the short version)

```
Your Task
    │
    ▼
┌─────────────────────────────────────────────┐
│  Deliberation   ← What kind of task?        │
│  Effort Scaling ← 1 agent or 20?            │
│  Topology Route ← Sequential? Parallel?     │
│  Atomizer       ← Break into subtasks       │
├─────────────────────────────────────────────┤
│  Agent Runtime  ← LLM → Tools → Verify      │
│    ├─ 18 LLM providers with fallback chain  │
│    ├─ 25+ tools with SHA-256 caching         │
│    ├─ Cycle detection + circuit breakers     │
│    ├─ Crash-safe checkpoints every step     │
│    └─ Live SSE streaming                     │
├─────────────────────────────────────────────┤
│  Synthesis     ← Merge agent outputs        │
│  Quality Gates ← Hallucination, accuracy    │
└─────────────────────────────────────────────┘
    │
    ▼
  Result + Trace + Metrics
```

Full architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)

---

## Production readiness

| Capability | Status |
|------------|--------|
| TypeScript strict | `packages/core/src` is checked with `npx tsc --noEmit`; no `as any` / `@ts-ignore` in core source |
| Error handling | Core source avoids empty `catch {}`; cleanup paths log or intentionally ignore with comments |
| Metrics | OpenMetrics/Prometheus counters, gauges, histograms with tenant labels |
| Tracing | Span-based with persistent store |
| Crash safety | Atomic write-tmp-rename checkpoints at every step |
| Circuit breaker | 5 failures → 30s open → half-open recovery |
| Dead letter queue | Persisted unrecoverable errors |
| Multi-tenancy | Per-tenant rate limits, quota, storage isolation |
| Security | Bearer token auth, CORS origin allow-list, request body limit, request IDs, rate limiting, optional HTTPS |
| Observability | Health check, readiness probe, OpenAPI spec, SSE streaming |

---

## Extensibility

- **17 plugin hook points** — LLM, tool, agent lifecycle, context compaction, session, step, and backend-selection hooks
- **Custom LLM providers** — Implement `LLMProvider`, register via `runtime.registerProvider()`
- **Custom tools** — Implement `Tool`, register via `runtime.registerTool()`
- **Custom topologies** — Add a case in `topologyRouter.ts`
- **Channel adapters** — Telegram, Discord, Slack via `ChannelAdapter`
- **Agent SDK** — Embed in your own apps:

```typescript
import { CommanderClient } from '@commander/sdk';

const client = new CommanderClient({ provider: 'openai' });
await client.connect();
const result = await client.run('analyze this repository');
await client.disconnect();
```

---

## Providers

Set any one env var. Commander auto-detects from **18 providers**:

`OPENAI_API_KEY` · `ANTHROPIC_API_KEY` · `GOOGLE_API_KEY` · `DEEPSEEK_API_KEY` · `ZHIPU_API_KEY` · `MIMO_API_KEY` · `XIAOMI_API_KEY` · `GROQ_API_KEY` · `TOGETHER_API_KEY` · `PERPLEXITY_API_KEY` · `FIREWORKS_API_KEY` · `REPLICATE_API_TOKEN` · `MISTRAL_API_KEY` · `CO_API_KEY` · `OPENROUTER_API_KEY` · `OLLAMA_HOST` · `VLLM_BASE_URL` · `AWS_ACCESS_KEY_ID` (Bedrock) · `XAI_API_KEY` · `ANYSCALE_API_KEY` · `DEEPINFRA_API_KEY`

---

## Deployment

```bash
# Local (Docker Compose)
docker compose up -d
# → API: localhost:4000  |  Web GUI: localhost:3000

# Production (VM / VPS)
./scripts/deploy-vm.sh your-vm-ip --env-file .env.production
```

Production overlay adds: CPU/memory limits, JSON-file logging, auto-restart, health checks, rate limiting, multi-tenancy.

---

## CI/CD

`.github/workflows/ci.yml` — quality (typecheck + full core test suite + benchmark + build) + docker + web-gui. Auto-deploy on main via `.github/workflows/cd.yml`.

---

## License

MIT

---

<p align="center">
  <sub>Built with ❤️ for developers who want to see what their AI is actually doing.</sub>
</p>
