<p align="center">
  <img src="https://img.shields.io/badge/GAIA-25%25-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/PinchBench-97.7%25-green?style=flat-square" />
  <img src="https://img.shields.io/badge/HumanEval+-91.5%25-orange?style=flat-square" />
  <img src="https://img.shields.io/badge/providers-21-purple?style=flat-square" />
  <img src="https://img.shields.io/badge/topologies-8-red?style=flat-square" />
  <img src="https://img.shields.io/badge/license-MIT-yellow?style=flat-square" />
</p>

<h1 align="center">Commander</h1>
<p align="center"><strong>See what your AI is doing. Trust the results. Pay less.</strong></p>

<p align="center">
  <code>npx tsx cli.ts run "investigate this bug" --stream</code><br>
  <sub>No install. One command. See multi-agent reasoning stream live to your terminal.</sub>
</p>

<p align="center">
  <img src="docs/assets/commander-watch-demo.gif" alt="Commander watch demo — live agent streaming" width="90%">
</p>

---

## What makes Commander different

**Transparent — see everything.** Every agent's thinking, tool calls, and decisions stream in real time via SSE. No black boxes. You watch your agents work, step by step.

**Trustworthy — verified output.** Quality gates check every result before returning it. Hallucination detection, accuracy verification, code compilation checks. You get results you can trust.

**Cost-effective — smart spending.** Deliberation engine analyzes your task before spending tokens. Chooses the right topology automatically — 1 agent for simple tasks, parallel for complex ones. Real cost: ~$0.10 per task, with quality verification included.

**22 LLM providers.** OpenAI, Anthropic, Google, DeepSeek, Groq, Ollama, Bedrock — set one env var, Commander handles the rest. Fallback chains included.

**Self-improving.** Meta-learner with Thompson Sampling + Reflexion tunes agent configs across runs. Gets better the more you use it.

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

# 2. Set any API key (auto-detects from 22 providers)
export OPENAI_API_KEY=sk-...
# Or use mimo: export MIMO_API_KEY=your-key

# 3. Run anything
npx tsx cli.ts run "analyze this repository"              # Execute
npx tsx cli.ts run "implement auth" --dry-run             # See plan first
npx tsx cli.ts run "debug the failing test" --stream      # Watch live
npx tsx cli.ts run "research state mgmt" --mode=goal      # Multi-round convergence

# 4. Other modes
npx tsx cli.ts company "build a CLI tool"    # Enterprise: quality gating + memory
npx tsx cli.ts swarm "audit security"        # Recursive decomposition
npx tsx cli.ts drive "set up CI/CD"          # Autonomous step-by-step
npx tsx cli.ts review --commit               # Code review
```

---

## Commander vs other frameworks

| | Commander | LangGraph | CrewAI | AutoGen |
|---|---|---|---|---|
| **Live SSE streaming** | ✅ Built-in | ❌ | ❌ | ❌ |
| **Automatic topology selection** | ✅ 8 topologies | ❌ Manual graph building | ❌ Fixed sequential | ❌ Manual orchestration |
| **LLM providers** | 22 (with fallback chain) | 1-3 (via LangChain) | 3-5 | Mostly OpenAI |
| **Cost per task** | ~$0.10 (verified output) | Unknown | Unknown | Unknown |
| **Self-optimization** | ✅ Thompson Sampling + Reflexion | ❌ | ❌ | ❌ |
| **Multi-tenant isolation** | ✅ Per-tenant rate limits, storage, memory | ❌ | ❌ | ❌ |
| **Benchmarked** | PinchBench 97.7%, HumanEval+ 96.3%, BFCL 85.7% | — | — | GAIA varies |
| **Install size** | Lean core package; optional heavy integrations | Heavy | Moderate | Heavy |
| **Crash safety** | ✅ Atomic checkpoints every step | ❌ | ❌ | ❌ |

> Commander adds **+48.5 points** over bare LLM on GAIA. Full data in [`docs/benchmark-results/`](docs/benchmark-results/).

---

## 5 Modes

Commander has 5 execution modes (consolidated from 11 for simplicity):

| Mode | Command | When to use |
|------|---------|-------------|
| **run** | `commander run "task"` | Default. Full pipeline execution. |
| **run --dry-run** | `commander run "task" --dry-run` | Preview plan without executing. |
| **run --stream** | `commander run "task" --stream` | Real-time SSE progress streaming. |
| **run --mode=goal** | `commander run "task" --mode=goal` | Multi-round convergence loop. |
| **company** | `commander company "task"` | Enterprise: quality gating + memory. |
| **swarm** | `commander swarm "task"` | Recursive decomposition + parallel. |
| **drive** | `commander drive "task"` | Autonomous step-by-step execution. |
| **review** | `commander review --commit` | Code review with AI analysis. |

### Gallery: what you can do

```bash
# 👁  Watch agent reasoning in real-time
commander run "analyze this repository" --stream

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

## Real output (not a mockup)

This is actual terminal output from `commander run` — every line is real:

```
╭────────────────────────────────────────────╮
│ Commander multi-agent orchestration         │
│ mimo · mimo-v2.5-pro                       │
╰────────────────────────────────────────────╯
Task: write a TypeScript function to validate email addresses

[0.0s]  INIT          Starting execution...
[0.0s]  DELIBERATION  Analyzing task requirements...
[15.0s] EFFORT_SCALING Classifying effort level...
[15.0s] TOPOLOGY_ROUTING Selecting orchestration topology...
[15.0s] DECOMPOSITION  Decomposing task into subtasks...
[15.0s] EXECUTION      Executing subtasks...
[25.9s] SYNTHESIS      Synthesizing results...

┃ RESULTS
✅ SUCCESS  25.9s · 6,876 tok · $0.1031

# Synthesis
File written: validateEmail.ts
- RFC 5322-compliant regex
- Length limits (254 total, 64 local)
- Domain validity checks
```

**What just happened:**
1. **Deliberation** — classified as CODING task, SIMPLE effort, SINGLE topology
2. **Execution** — spawned 1 agent, wrote the code, verified it
3. **Synthesis** — merged results into a clean summary
4. **Quality gates** — verified output before returning

Total cost: **$0.10**. Total time: **26 seconds**. You saw every step.

---

## Cost-effectiveness: real numbers

| Task | Tokens | Cost | Time | What you get |
|------|:------:|:----:|:----:|-------------|
| Validate email (TypeScript) | 6,876 | $0.10 | 26s | RFC-compliant function + type exports |
| Check prime number (TypeScript) | 6,603 | $0.10 | 32s | Optimized function with edge cases |
| Palindrome checker (TypeScript) | 6,603 | $0.10 | 32s | Unicode-aware with normalization |

**Why this matters:**
- A developer manually writing the same code: **15-30 minutes**
- Commander does it in **26 seconds** for **$0.10**
- Quality gates verify the output before you see it
- Deliberation picks the right topology — no wasted parallelism on simple tasks

**What deliberation costs:**
Commander adds ~50% overhead for deliberation + quality gates. That's ~$0.05 extra per task. In return, you get:
- Task classification (CODING vs RESEARCH vs REASONING)
- Automatic topology selection (1 agent for simple, parallel for complex)
- Quality verification (output checked before returning)
- Full execution trace (see every step)

```bash
npx commander benchmark    # A/B test: optimized vs baseline
```

---

## Migration from v0.x (11 modes → 5 modes)

Commander consolidated 11 execution modes into 5 for simplicity. Old commands still work but show deprecation warnings.

| Old command | New command | Notes |
|-------------|-------------|-------|
| `commander plan "task"` | `commander run "task" --dry-run` | Plan without executing |
| `commander watch "task"` | `commander run "task" --stream` | Real-time SSE streaming |
| `commander goal "task"` | `commander run "task" --mode=goal` | Multi-round convergence |
| `commander workers topic1 topic2` | `commander swarm "task"` | Parallel research |
| `commander workflow run id` | `commander company "task"` | Enterprise engine |
| `commander benchmark` | `commander run "task" --benchmark` | A/B testing |

### Why consolidate?

1. **Less cognitive load** — 5 commands instead of 11
2. **Flags > commands** — `--dry-run`, `--stream`, `--mode=goal` are more composable
3. **No functionality lost** — every old command maps to a new one
4. **Backward compatible** — old commands still work with deprecation warnings

---

## Benchmarks

| Benchmark | Commander | Bare LLM (MiMo) | OpenClaw | Δ |
|-----------|:---------:|:----------------:|:--------:|:-:|
| **GAIA** (165 multi-step reasoning tasks) | ⏳ 待重跑 | 21.2% | — | — |
| **BFCL** Tool Selection (35-scenario unofficial subset) | **85.7%** | — | — | — |
| **BFCL** Parameter Prediction (35-scenario unofficial subset) | **85.7%** | — | — | — |
| **PinchBench** (43 agentic tasks) | **97.7%** (42/43) | — | 89.5% | **+8.2pp** |
| **HumanEval+** (164 Python problems) | **96.3%** | — | — | — |

BFCL uses multiple unofficial subsets in this repo: 35-scenario general subset
(`benchmarks/bfcl/results.json`, 85.7% tool / 85.7% parameter), 30-task
Commander rerun (`docs/benchmark-results/bfcl/results.json`, 80.0% / 80.0%),
and 12-core subset (91.7% / 91.7%). None of these are official BFCL leaderboard
runs.

> **GAIA note**: Previous 69.7% result was invalid — scoring bug marked responses
> as correct when expected field was empty. Scoring fixed, re-run pending.
> Bare MiMo baseline: 21.2% (165 tasks, no tools).

```bash
# Reproduce any benchmark
pnpm --filter @commander/core benchmark:verify  # Recompute checked-in BFCL score claims
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
│    ├─ 21 LLM providers with fallback chain  │
│    ├─ 23 tools with SHA-256 caching           │
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

## Getting Started (5 minutes)

### Prerequisites

- Node.js 18+ (recommended: 22)
- pnpm 9+ (`npm install -g pnpm`)
- Any LLM API key (OpenAI, Anthropic, Google, DeepSeek, Groq, Ollama, etc.)

### Step 1: Clone and install

```bash
git clone https://github.com/PStarH/Commander.git
cd Commander
pnpm install
```

### Step 2: Configure your LLM provider

```bash
# Pick any one — Commander auto-detects from 21 providers
export OPENAI_API_KEY=sk-...
# or
export ANTHROPIC_API_KEY=sk-ant-...
# or
export DEEPSEEK_API_KEY=sk-...
# or for local models:
export OLLAMA_HOST=http://localhost:11434
```

### Step 3: Run your first task

```bash
# Execute a task with multi-agent orchestration
npx tsx packages/core/src/cli.ts run "write a TypeScript function to validate email addresses"

# Watch agents think in real-time (the killer feature)
npx tsx packages/core/src/cli.ts watch "analyze the README and summarize key features"

# See the execution plan before running
npx tsx packages/core/src/cli.ts plan "implement user authentication"
```

### Step 4: Explore the API server (optional)

```bash
# Start the API + Web GUI
pnpm dev
# → API: http://localhost:4000
# → Web GUI: http://localhost:3000
# → Health check: http://localhost:4000/health
# → OpenAPI spec: http://localhost:4000/openapi.json
```

### Storage Options

Commander supports two storage backends for the API server:

```bash
# JSON file (default) — simple, no dependencies
# Data stored in apps/api/data/

# SQLite (recommended for production) — WAL mode, indexes, transactions
WARROOM_STORAGE=sqlite
```

### Step 5: Run tests (for contributors)

```bash
pnpm test              # Run all tests
pnpm test:core         # Core package tests only
pnpm lint              # ESLint check
pnpm typecheck         # TypeScript type check
pnpm build:core        # Build the core package
```

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

- **19 plugin hook points** — LLM, tool, agent lifecycle, context compaction, session, step, and backend-selection hooks
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

Set any one env var. Commander auto-detects from **21 providers**:

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
