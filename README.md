<p align="center">
  <a href="https://www.npmjs.com/package/@commander/core"><img src="https://img.shields.io/badge/npm-pending-CB3837?style=flat-square&label=npm" /></a>
  <a href="https://github.com/PStarH/Commander/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/PStarH/Commander/ci.yml?style=flat-square&label=CI&logo=github" /></a>
  <img src="https://img.shields.io/badge/providers-22-7C3AED?style=flat-square" />
  <img src="https://img.shields.io/badge/topologies-5-EF4444?style=flat-square" />
  <img src="https://img.shields.io/github/license/PStarH/Commander?style=flat-square&color=EAB308" />
  <a href="https://github.com/PStarH/Commander/releases"><img src="https://img.shields.io/github/v/release/PStarH/Commander?style=flat-square&label=release&color=22C55E" /></a>
</p>

<h1 align="center">Commander</h1>
<p align="center"><strong>Multi-agent orchestration framework.</strong></p>

> **v0.2.0 — Pre-production.** Checkpointing is SQLite-backed with WAL persistence. SLOs below are design targets, not guaranteed. See [ARCHITECTURE.md](ARCHITECTURE.md) for current status.

<p align="center">
  <code>npx tsx packages/core/src/cli.ts run "audit this repo" --stream</code><br>
  <sub>Every agent thought streams to your terminal. Every output is verified. 22 providers. One command.</sub>
</p>

<p align="center">
  <a href="#quick-start"><img src="https://img.shields.io/badge/TRY_NOW-000?style=for-the-badge" /></a>
  <a href="https://github.com/PStarH/Commander/stargazers"><img src="https://img.shields.io/github/stars/PStarH/Commander?style=social" /></a>
  <a href="https://github.com/PStarH/commander-docs"><img src="https://img.shields.io/badge/DOCS-000?style=for-the-badge" /></a>
</p>

<p align="center">
  <img src="docs/assets/commander-watch-demo.gif" alt="Commander demo — CLI help, deliberation planning, and system status" width="100%">
</p>

---

AI agents are becoming production infrastructure. But most frameworks were built for demos, not deployments. They hide their reasoning, fail silently, and have no circuit breakers.

**Commander is being built for production.** Every agent decision streams to you in real time. The deliberation engine automatically classifies your task and picks the optimal topology — 1 agent for a simple fix, up to 20 for deep research. No graph building. No YAML. No black boxes.

---

## Reliability Design Targets

These are architectural goals for the current v0.2.0 release. Measurement infrastructure is under development.

| Target | Goal | Notes |
|--------|------|-------|
| **Checkpoint Recovery** | <5 seconds | SQLite-backed with WAL persistence |
| **Failover** | <10 seconds | Provider failure to next provider |
| **Compensation** | <30 seconds | Failed mutation to rollback complete |
| **DLQ Processing** | <60 seconds | Error detection to persisted entry |

---

## Health Check API

```bash
# Basic health check
curl http://localhost:3000/health

# Detailed health with all component statuses
curl http://localhost:3000/health/detailed

# Readiness probe (for k8s)
curl http://localhost:3000/ready
```

Health check monitors 8 components:
- Memory usage (heap)
- Circuit breaker states
- Dead letter queue size
- Checkpoint staleness
- Pending compensations
- Event bus backlog
- Provider availability
- Disk space

---

## Technical moats

### Live SSE streaming

Every agent thought, tool call, and decision streams to your terminal in real time via Server-Sent Events. Not polling. Not logs after the fact. You watch your agents reason, step by step. The only multi-agent framework with built-in streaming.

### Automatic topology selection

The deliberation engine classifies each task (CODING / RESEARCH / ANALYSIS / FACTUAL), estimates complexity, and picks from 5 canonical orchestration topologies — SINGLE, CHAIN, DISPATCH, ORCHESTRATOR, REVIEW. A one-line task uses 1 agent. A cross-repository audit spins up 20. Zero configuration.

### 22 providers with automatic failover

Set any one API key. Commander detects your provider, and if it fails, falls through a configurable chain. OpenAI → Anthropic → DeepSeek → Groq → Ollama — you define the order, Commander handles the routing. No single-vendor lock-in.

### Quality gates on every output

Before returning any result, Commander runs quality checks: regex-based hallucination signal detection, consistency verification, completeness scoring, accuracy estimation, and safety scanning. If the output fails any gate, the system retries or reports the failure with full context.

### Self-optimizing runtime

A meta-learner using Thompson Sampling and Reflexion tunes agent configurations across runs. It learns which topologies work best for which task types, which providers are fastest, and which parameter combinations produce the highest quality results. Note: the meta-learner needs 5+ recorded experiences before it begins to influence strategy selection; new users see sequential execution until that threshold is reached.

---

## Architecture

```
                        ┌──────────────────────────────┐
                        │      DELIBERATION ENGINE      │
                        │  Task classification          │
                        │  Complexity estimation        │
                        │  Topology selection           │
                        └──────────┬───────────────────┘
                                   │
                        ┌──────────▼───────────────────┐
                         │      TOPOLOGY ROUTER          │
                         │  SINGLE · CHAIN · DISPATCH     │
                         │  ORCHESTRATOR · REVIEW          │
                        └──────────┬───────────────────┘
                                   │
               ┌───────────────────┼───────────────────┐
               ▼                   ▼                   ▼
        ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
        │   AGENT 1    │   │   AGENT 2    │   │   AGENT N    │
        │  LLM → Tool  │   │  LLM → Tool  │   │  LLM → Tool  │
        │  → Verify    │   │  → Verify    │   │  → Verify    │
        └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
               └──────────────────┼──────────────────┘
                                  ▼
                        ┌──────────────────────────────┐
                        │         SYNTHESIS             │
                        │  Merge · Resolve conflicts   │
                        └──────────┬───────────────────┘
                                   ▼
                        ┌──────────────────────────────┐
                        │       QUALITY GATES           │
                        │  Hallucination · Consistency  │
                        │  Completeness · Accuracy     │
                        │  Safety                      │
                        └──────────┬───────────────────┘
                                   ▼
                              RESULT
```

---

## Current infrastructure

Commander includes these infrastructure components (see notes for development status):

| Capability                  | Implementation                                                                  | Status |
| --------------------------- | ------------------------------------------------------------------------------- | ------ |
| **Circuit breakers**        | 3-state (CLOSED / OPEN / HALF-OPEN), error-rate windowing, per-provider         | ✅ Live |
| **Dead letter queue**       | Append-only ndjson files with replay support                                    | ✅ Live |
| **SSE streaming**           | Structured events via message bus pub/sub with Last-Event-ID replay             | ✅ Live |
| **Fallback chains**         | Auto-failover between providers, configurable order and timeouts                | ✅ Live |
| **Semantic caching**        | SHA-256 exact + cosine-similarity deduplication (via EmbeddingFunction)         | ✅ Live |
| **Checkpointing**           | SQLite-backed with WAL persistence; falls back to in-memory if SQLite is unavailable (no warning logged)                          | ✅ Live |
| **Multi-tenancy**           | Tenant-aware singleton isolation via AsyncLocalStorage                           | ⚠️ Isolation only; per-tenant budgets/storage pending |
| **Quality gates**           | Regex heuristics (hallucination signals, hedging, contradiction)     | ✅ Live |
| **Self-optimization**       | Beta-distribution Thompson Sampling with Reflexion and cross-session persistence | ⚠️ Needs 5+ runs to activate |
| **Metrics/Tracing**         | OpenMetrics counters + span-based execution traces                               | ⚠️ Partial; persistent store pending |
| **Security**                | Auth manager, CORS, privacy router, content scanner                              | ⚠️ Partial; rate limiting pending |
| **Plugin system**           | Hook points for LLM, tool, and agent lifecycle                                   | ⚠️ Under development |

---

## How Commander compares

|                       | Commander                     | LangGraph       | CrewAI           | AutoGen       |
| --------------------- | ----------------------------- | --------------- | ---------------- | ------------- |
| **SSE streaming**     | Built-in                      | ❌              | ❌               | ❌            |
| **Auto topology**     | 5 canonical patterns, auto-chosen       | Manual DAG      | Fixed sequential | Manual        |
| **Providers**         | 22, auto-failover             | 1-3 (LangChain) | 3-5              | Mostly OpenAI |
| **Self-optimization** | Thompson Sampling + Reflexion | ❌              | ❌               | ❌            |
| **Multi-tenant**      | Tenant-aware singleton context | ❌              | ❌               | ❌            |
| **Crash safety**      | SQLite-backed checkpoints with WAL; silent fallback to in-memory if SQLite unavailable | ❌ | ❌ | ❌ |
| **Quality gates**     | Regex heuristics (hallucination signals, hedging, contradiction)  | ❌              | ❌               | ❌            |
| **Circuit breakers**  | Per-provider 3-state          | ❌              | ❌               | ❌            |
| **Dead letter queue** | Append-only ndjson files with replay | ❌       | ❌               | ❌            |

---

## Quick start

```bash
# Clone and install
git clone https://github.com/PStarH/Commander.git
cd Commander && pnpm install

# Set any API key — Commander auto-detects
export OPENAI_API_KEY=sk-...
# or: ANTHROPIC / DEEPSEEK / GROQ / OLLAMA / 17 others

# Run anything
npx tsx packages/core/src/cli.ts run "audit this repo for security vulnerabilities"
npx tsx packages/core/src/cli.ts run "refactor auth module" --dry-run
npx tsx packages/core/src/cli.ts run "debug the failing test" --stream
npx tsx packages/core/src/cli.ts run showcase        # 3-agent debate demo
npx tsx packages/core/src/cli.ts company "build a REST API"   # Enterprise pipeline
npx tsx packages/core/src/cli.ts review --commit     # AI code review
npx tsx packages/core/src/cli.ts status              # System health
```

No configuration files. No YAML pipelines. No graph builders. One command and you're running multi-agent orchestration.

---

## Provider support

Set any one environment variable. Commander auto-detects from 22 providers:

OpenAI · Anthropic · Google · DeepSeek · Zhipu · MIMO · Xiaomi · Groq · Together · Perplexity · Fireworks · Replicate · Mistral · Cohere · OpenRouter · Agnes · Ollama · vLLM · AWS Bedrock · xAI · Anyscale · DeepInfra

If your primary provider fails, Commander automatically falls through the chain. Note: not all providers support tool/function calling (Replicate and Perplexity currently throw errors for tool use). Switch with one env var change when using a compatible provider.

---

## Philosophy

Existing agent frameworks treat you like a passenger. You write configuration, you wait, and you hope the output is correct. When it's wrong, you have no idea why.

Commander treats you like an **engineer**. You see every decision. You trust every result. You ship faster because you're not guessing what your AI is doing.

The system is being built with the same discipline as any production distributed system: circuit breakers, dead letter queues, SSE streaming, semantic caching, and provider fallback chains. The only difference is that the workload is LLM calls instead of HTTP requests.

---

MIT — use it, ship it, build on it. [Star on GitHub](https://github.com/PStarH/Commander) · [Documentation](https://github.com/PStarH/commander-docs) · [Architecture](ARCHITECTURE.md)

<p align="center">
  <sub>5 topologies · 22 providers · 26 built-in tools · Built for engineers who want to see what their AI is actually doing.</sub>
</p>
