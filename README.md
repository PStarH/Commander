<p align="center">
  <img src="https://img.shields.io/badge/providers-22-7C3AED?style=flat-square" />
  <img src="https://img.shields.io/badge/topologies-8-EF4444?style=flat-square" />
  <img src="https://img.shields.io/badge/modules-448-22C55E?style=flat-square" />
  <img src="https://img.shields.io/badge/license-MIT-EAB308?style=flat-square" />
</p>

<h1 align="center">Commander</h1>
<p align="center"><strong>The most stable agent runtime.</strong></p>

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

**Commander was built for production from day one.** Every agent decision streams to you in real time. Every output passes through quality gates before you see it. The deliberation engine automatically classifies your task and picks the optimal topology — 1 agent for a simple fix, 20 for deep research. No graph building. No YAML. No black boxes.

---

## Reliability SLOs

Commander commits to these service level objectives:

| SLO | Target | Measurement |
|-----|--------|-------------|
| **Uptime** | 99.9% | Monthly, excluding planned maintenance |
| **Checkpoint Recovery** | <5 seconds | From crash to resumed execution |
| **Failover** | <10 seconds | Provider failure to next provider |
| **Compensation** | <30 seconds | Failed mutation to rollback complete |
| **DLQ Processing** | <60 seconds | Error detection to persisted entry |
| **Memory Consistency** | 100% | Zero data loss on crash |

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

The deliberation engine classifies each task (CODING / RESEARCH / ANALYSIS / FACTUAL), estimates complexity, and picks from 8 orchestration topologies — SINGLE, SEQUENTIAL, PARALLEL, HIERARCHICAL, HYBRID, DEBATE, ENSEMBLE, EVALUATOR-OPTIMIZER. A one-line task uses 1 agent. A cross-repository audit spins up 20. Zero configuration.

### 22 providers with automatic failover

Set any one API key. Commander detects your provider, and if it fails, falls through a configurable chain. OpenAI → Anthropic → DeepSeek → Groq → Ollama — you define the order, Commander handles the routing. No single-vendor lock-in.

### Quality gates on every output

Before returning any result, Commander runs a 5-gate verification pipeline: hallucination detection, consistency check, completeness verification, accuracy validation, and safety scanning. If the output fails any gate, the system retries or reports the failure with full context.

### Self-optimizing runtime

A meta-learner using Thompson Sampling and Reflexion tunes agent configurations across runs. It learns which topologies work best for which task types, which providers are fastest, and which parameter combinations produce the highest quality results. The system gets better the more you use it.

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
                        │  SINGLE · SEQUENTIAL · PARALLEL│
                        │  HIERARCHICAL · DEBATE · HYBRID│
                        │  ENSEMBLE · EVALUATOR-OPTIMIZER│
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

## Production infrastructure

Every component that belongs in a production system exists in Commander:

| Capability                  | Implementation                                                                    |
| --------------------------- | --------------------------------------------------------------------------------- |
| **Circuit breakers**        | 3-state (CLOSED / OPEN / HALF-OPEN), 5 failures → 30s cooldown, per-provider      |
| **Crash-safe checkpoints**  | Atomic write-tmp-rename at every step. Recover from any failure.                  |
| **Dead letter queue**       | Unrecoverable errors persisted for analysis, with replay support                  |
| **Multi-tenancy**           | Per-tenant token budgets, concurrency limits, rate limits, storage isolation      |
| **Rate limiting**           | Per-tenant and per-provider, configurable windows                                 |
| **Metrics**                 | OpenMetrics / Prometheus counters, gauges, histograms with tenant labels          |
| **Tracing**                 | Span-based execution traces with persistent store                                 |
| **Security**                | Bearer auth, CORS allow-lists, request body limits, request IDs, privacy router   |
| **Hallucination detection** | Signal-based detector with configurable thresholds                                |
| **Semantic caching**        | SHA-256 + semantic similarity deduplication, per-tenant key isolation             |
| **Fallback chains**         | Auto-failover between providers, configurable order and timeouts                  |
| **Plugin system**           | 19 hook points: LLM, tool, agent lifecycle, context compaction, session lifecycle |
| **SSE streaming**           | Real-time agent thinking, tool calls, decisions streamed via Server-Sent Events   |

---

## How Commander compares

|                       | Commander                     | LangGraph       | CrewAI           | AutoGen       |
| --------------------- | ----------------------------- | --------------- | ---------------- | ------------- |
| **SSE streaming**     | Built-in                      | ❌              | ❌               | ❌            |
| **Auto topology**     | 8 patterns, auto-chosen       | Manual DAG      | Fixed sequential | Manual        |
| **Providers**         | 22, auto-failover             | 1-3 (LangChain) | 3-5              | Mostly OpenAI |
| **Self-optimization** | Thompson Sampling + Reflexion | ❌              | ❌               | ❌            |
| **Multi-tenant**      | Per-tenant isolation          | ❌              | ❌               | ❌            |
| **Crash safety**      | Atomic checkpoints            | ❌              | ❌               | ❌            |
| **Quality gates**     | 5-stage pipeline              | ❌              | ❌               | ❌            |
| **Circuit breakers**  | Per-provider 3-state          | ❌              | ❌               | ❌            |
| **Dead letter queue** | Persistent with replay        | ❌              | ❌               | ❌            |
| **Cost per task**     | ~$1.13 typical ($0.75 - $3.00 max) | Unknown        | Unknown          | Unknown       |

---

## Quick start

```bash
# Clone and install
git clone https://github.com/PStarH/Commander.git
cd Commander && pnpm install

# Set any API key — Commander auto-detects
export OPENAI_API_KEY=sk-...
# or: ANTHROPIC / DEEPSEEK / GROQ / OLLAMA / 18 others

# Run anything
npx tsx packages/core/src/cli.ts run "audit this repo for security vulnerabilities"
npx tsx packages/core/src/cli.ts run "refactor auth module" --dry-run
npx tsx packages/core/src/cli.ts run "debug the failing test" --stream
npx tsx packages/core/src/cli.ts run showcase        # 3-agent debate demo
npx tsx packages/core/src/cli.ts company "build a REST API"   # Enterprise pipeline
npx tsx packages/core/src/cli.ts review --commit     # AI code review
npx tsx packages/core/src/cli.ts status              # System health
```

No configuration files. No YAML pipelines. No graph builders. One command and you're running multi-agent orchestration with production-grade infrastructure.

---

## Provider support

Set any one environment variable. Commander auto-detects from 22 providers:

OpenAI · Anthropic · Google · DeepSeek · Zhipu · MIMO · Xiaomi · Groq · Together · Perplexity · Fireworks · Replicate · Mistral · Cohere · OpenRouter · Agnes · Ollama · vLLM · AWS Bedrock · xAI · Anyscale · DeepInfra

If your primary provider fails, Commander automatically falls through the chain. Every provider is interchangeable — switch with one env var change.

---

## Philosophy

Existing agent frameworks treat you like a passenger. You write configuration, you wait, and you hope the output is correct. When it's wrong, you have no idea why.

Commander treats you like an **engineer**. You see every decision. You trust every result. You ship faster because you're not guessing what your AI is doing.

The system is built with the same discipline as any production distributed system: circuit breakers, crash-safe state, dead letter queues, rate limiting, multi-tenancy, metrics, tracing, and security. The only difference is that the workload is LLM calls instead of HTTP requests.

---

MIT — use it, ship it, build on it. [Star on GitHub](https://github.com/PStarH/Commander) · [Documentation](https://github.com/PStarH/commander-docs) · [Architecture](ARCHITECTURE.md)

<p align="center">
  <sub>448 modules · 8 topologies · 22 providers · 24 built-in tools · Built for engineers who want to see what their AI is actually doing.</sub>
</p>
