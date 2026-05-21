# Commander

Multi-agent orchestration system. 18 providers · 8 topologies · 25+ tools · 330+ tests · 70% GAIA.

```bash
npx tsx cli.ts "分析这个仓库的结构"
npx tsx cli.ts run "写一个 FastAPI CRUD"
npx tsx cli.ts status
```

## Quick Start

```bash
# Install
pnpm install

# Set any API key
export OPENAI_API_KEY=sk-...

# Run
npx tsx cli.ts plan "your task"     # Deliberation plan only
npx tsx cli.ts run "your task"      # Full multi-agent execution
npx tsx cli.ts watch "your task"    # Real-time SSE streaming
```

## Commands

| Command | Description |
|---------|-------------|
| `commander <task>` | Quick task analysis |
| `commander run <task>` | Full multi-agent execution pipeline |
| `commander plan <task>` | Show deliberation plan (topology, agents, budget) |
| `commander watch <task>` | Execute with real-time event stream |
| `commander status` | System status, provider, MetaLearner stats |
| `commander config` | View or change settings |
| `commander doctor` | Run diagnostics |
| `commander gui` | Start the Agent War Room dashboard (API server + Web UI) |
| `commander tui` | Terminal dashboard with live event feed and session browser |
| `commander history` | List past execution sessions |
| `commander history view <runId>` | View session details |
| `commander history prune <n>` | Keep only N most recent sessions |
| `commander history delete <runId>` | Delete a specific session |
| `commander workers [topics]` | Parallel research workers |
| `commander company <task>` | Company mode execution with review |
| `commander mode [mode]` | Show/set approval mode (plan, read-only, auto-edit, full-auto, suggest) |
| `commander review [--commit, --base, --json]` | Code review with guidelines |
| `commander skill list/view/create/pin` | Manage learnable skills |
| `commander --debug` | Enable debug logging (verbose output across all 74+ modules) |

## Debug Mode

Enable verbose logging across all 74+ runtime modules to diagnose execution flow:

```bash
commander --debug plan "implement login"    # Verbose deliberation
commander --debug run "research RAG"        # Full execution with traces
commander --verbose status                  # Alternate flag, same effect
```

Debug output includes:
- **LLM calls**: Request/response payload, token counts, cache hits, latency
- **Tool execution**: Each tool's before/after state, errors, retries
- **State transitions**: Compaction events, checkpoints, budget governor decisions
- **Agent orchestration**: Topology routing, subtask delegation, agent team handoffs

The `--debug` flag sets the global log level to `DEBUG`. Modules that import `getGlobalLogger()` (all 74+) emit detailed diagnostics without per-module configuration. No restart or configuration file needed.

## Agent SDK (`@commander/sdk`)

Embed Commander's multi-agent orchestration programmatically in your own applications:

```typescript
import { CommanderClient } from '@commander/sdk';

const client = new CommanderClient({ provider: 'openai' });

// Connect (auto-detects API key from env)
await client.connect();

// Execute a task — full deliberation → multi-agent pipeline
const result = await client.run('analyze this repository structure');
console.log(result.summary, result.status);

// Subscribe to live events
const unsub = client.onEvent((event) => {
  console.log(`[${event.type}]`, event.data);
});

// List past sessions
const sessions = client.listSessions();

// Clean shutdown
await client.disconnect();
```

The SDK wraps Commander's core (`UltimateOrchestrator`, `SSEStream`, `MessageBus`) into a single `CommanderClient` class with lifecycle management (`connect`/`disconnect`) and event-driven execution monitoring.

## Session History

Every execution run is automatically checkpointed to disk. View, inspect, and prune past sessions:

```bash
commander history                    # List all past sessions (ID, task, status, timestamp)
commander history view <runId>       # Full session details + step breakdown
commander history delete <runId>     # Remove a single session
commander history prune 10           # Keep only the 10 most recent sessions
```

Sessions are persisted as crash-safe JSON snapshots in `~/.commander/state/` — written with atomic tmp+rename to prevent corruption. Each checkpoint stores:
- **Run ID** and **task goal**
- **Phase** and **step number** in the execution loop
- **LLM message history** and **token usage** per step
- **Error state** for failed runs (enables dead-letter analysis)

## Providers

Set any one of these environment variables (also supports fallback names noted below):

| Variable | Provider | Notes |
|----------|----------|-------|
| `OPENAI_API_KEY` | OpenAI / DeepSeek / GLM / MiMo | |
| `ANTHROPIC_API_KEY` | Anthropic Claude | |
| `GOOGLE_API_KEY` | Google Gemini | |
| `OPENROUTER_API_KEY` | OpenRouter (200+ models) | |
| `DEEPSEEK_API_KEY` | DeepSeek (dedicated) | |
| `ZHIPU_API_KEY` | GLM (Zhipu AI) | |
| `MIMO_API_KEY` | MiMo (dedicated) | |
| `XIAOMI_API_KEY` | Xiaomi MiMo | |
| `CO_API_KEY` | Cohere | Also accepts `COHERE_API_KEY` |
| `MISTRAL_API_KEY` | Mistral AI | |
| `GROQ_API_KEY` | Groq (fast inference) | |
| `TOGETHER_API_KEY` | Together AI | |
| `PERPLEXITY_API_KEY` | Perplexity | Also accepts `PPLX_API_KEY` |
| `FIREWORKS_API_KEY` | Fireworks AI | |
| `REPLICATE_API_TOKEN` | Replicate (open-source cloud) | Also accepts `REPLICATE_API_KEY` |
| `OLLAMA_HOST` | Ollama (local) | Also accepts `OLLAMA_BASE_URL` |
| `VLLM_BASE_URL` | vLLM (local) | |
| `AWS_ACCESS_KEY_ID` | AWS Bedrock (+ `AWS_SECRET_ACCESS_KEY`) | |
| `XAI_API_KEY` | xAI (Grok) | |
| `ANYSCALE_API_KEY` | Anyscale | |
| `DEEPINFRA_API_KEY` | DeepInfra | |

## Architecture

```
CLI / HTTP
  ├─ deliberation.ts         Task analysis & topology selection
  ├─ effortScaler.ts         Scale agents (1-20) by complexity
  ├─ topologyRouter.ts       SINGLE | SEQUENTIAL | PARALLEL | HIERARCHICAL
  │                          | HYBRID | DEBATE | ENSEMBLE | EVALUATOR-OPT
  ├─ atomizer.ts             ROMA task decomposition
  ├─ agentRuntime.ts         LLM → tools → verification → retry loop
  │   ├─ providers/          18 providers (OpenAI, Anthropic, Google, etc.)
  │   ├─ toolResultCache.ts  SHA-256 caching per tenant
  │   ├─ stateCheckpointer.ts Crash-safe snapshots
  │   ├─ circuitBreaker.ts   Failure threshold → open circuit
  │   └─ verificationLoop.ts Quality gates (5-stage)
  └─ quality gates           Hallucination, consistency, accuracy
```

## Benchmarks

| Benchmark | Score | Detail |
|-----------|-------|--------|
| GAIA (165 questions) | 69.7% | +48.5pp over bare MiMo (21.2%) |
| BFCL (35 scenarios) | 60.0% / 91.4% | Tool selection / Parameter accuracy |
| MT-Bench (80 questions) | 6.6/10 | Across 8 categories |
| PinchBench (20 tasks) | 100.0% | Commander core vs OpenClaw 89.5% |

Run benchmarks with the unified runner:

```bash
npx tsx packages/core/src/benchmark/benchmarkRunner.ts <config> [--max N] [--parallel N]
```

## GUI Dashboard

Start the Agent War Room — a React-based operations dashboard:

```bash
commander gui
```

This starts the API server on `http://localhost:4000`. The web frontend runs on Vite:

```bash
cd apps/web && npx vite
```

The dashboard includes:
- **Battle Report** — project health, completion rate, top agents, narrative
- **Agent Roster** — status, specialty, workload per agent
- **Mission Board** — Kanban with PLANNED / RUNNING / BLOCKED / DONE lanes
- **Execution Feed** — real-time operation logs with level filtering
- **Memory Browser** — search/filter/tag across DECISION, ISSUE, LESSON, SUMMARY
- **Governance** — risk alerts, approval flow for MANUAL mode

## HTTP API

Commander includes an HTTP API server for runtime management, task execution, and monitoring.
The full API specification is available at `/openapi.json` when the server is running.

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Liveness probe — uptime, active sessions, bus topics |
| `GET` | `/ready` | No | Readiness probe — Kubernetes-style deployment check |
| `GET` | `/metrics` | Yes | Metrics in JSON or Prometheus OpenMetrics (use `Accept: text/plain`) |
| `GET` | `/openapi.json` | No | OpenAPI 3.0 specification |
| `POST` | `/api/v1/runtime` | Yes | Create a new runtime session |
| `GET` | `/api/v1/runtime/{id}` | Yes | Get session details |
| `DELETE` | `/api/v1/runtime/{id}` | Yes | Delete a session |
| `POST` | `/api/v1/execute` | Yes | Execute an agent task |
| `GET` | `/api/v1/bus` | Yes | Message bus topics and history |
| `GET` | `/api/v1/status` | Yes | System-wide status |

### Authentication

Set `COMMANDER_API_KEY` or let the server auto-generate one (logged at startup).
Include it in requests:

```bash
curl -H "Authorization: Bearer <api-key>" http://localhost:3001/api/v1/status
```

## Docker Deployment

Production-grade Docker setup with multi-stage builds:

```bash
# Build and start all services
docker compose up -d

# Access
# - API: http://localhost:4000
# - Web GUI: http://localhost:3000
# - Health check: http://localhost:4000/health
# - Metrics: http://localhost:4000/metrics
```

The Docker setup includes:
- **6-stage build**: base → deps → build-core → build-web → api → web
- **Health checks** on the API service (15s interval, 3 retries)
- **Persistent volumes** for state, traces, memory, and results
- **Nginx** serving the SPA with cache headers and API reverse proxy
- **tini** init system for proper signal handling

## Continuous Integration

The CI workflow (`.github/workflows/ci.yml`) runs on push/PR to master/main:

| Job | What it checks |
|-----|----------------|
| **quality** | TypeScript compilation, full test suite (330+ tests), benchmarks, CLI check, core build |
| **docker** | `docker compose build` succeeds |
| **web-gui** | Vite production build of the web dashboard |

## Module Status

| Status | Count | Description |
|--------|-------|-------------|
| Production | 90+ | Wired into the main execution flow |
| `@experimental` | 3 | Scaffolding, test-only, or replaced: `mockLLMProvider`, `pluginLoader`, `dynamicOrchestrator`, `verificationLoop` |
| Standalone | 1 | `benchmarkRunner.ts` — independent CLI tool |

## Production Readiness

- **Type safety**: TypeScript strict mode, zero `as any` / `@ts-ignore`
- **Error handling**: Zero empty catch blocks across the entire codebase
- **Logging**: Structured logger with component-level severity (debug → error)
- **Metrics**: OpenMetrics/Prometheus-compatible export
- **Tracing**: Span-based execution tracing with persistent storage
- **Multi-tenancy**: Per-tenant isolation (rate limits, concurrency, storage, memory)
- **Resilience**: Circuit breakers, dead letter queues, compensation registry
- **Security**: Bearer token auth, rate limiting, configurable CORS
- **Observability**: Health, readiness, metrics, and OpenAPI endpoints
- **Deployment**: Docker Compose with health checks, persistent volumes, Nginx

## License

MIT
