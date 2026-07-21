# Commander Architecture

## §0 — Two generations (read this first)

Commander is mid-strangler-migration. Two architectures coexist, corresponding
to the two SKUs (see `README.md` "Two ways to run Commander"):

- **V1 — Local CLI SKU.** `@commander/core`: a large monolith whose `src/index.ts`
  barrel re-exports the runtime, orchestrators, memory systems, security guards,
  SQLite/Postgres drivers, CLI, and TUI. This is what the live CLI and most of
  `apps/api` run today. **WIRED.** Single-user, local state, no gateway.
- **V2 — Enterprise Gateway SKU.** The plane-separated target: `@commander/contracts`
  (types) → `@commander/kernel` (durable Postgres authority + always-on ops binary at
  `packages/kernel/src/ops`) → `@commander/worker-plane` (execution) +
  `@commander/effect-broker` (capability PEP), fronted by `apps/api` (Gateway) at `/v1`.
  The WS1-era `@commander/operations` **package is ABSENT on master** and must not reappear;
  arch-guard bans it. Ops = kernel-ops only. Adapter compensation/reconcile drain (when
  EffectBroker + action-adapters are required) lives in the deploy unit
  `@commander/adapter-ops` — **not** a fifth plane, **not** a rename of `@commander/operations`.
  Partially built; durable `/v1` kernel defaults ON in production / V2 mode /
  when a DSN is set (`isCommanderKernelEnabled`). **Alpha** for multi-tenant enterprise use.

The modules below define V1 (Local CLI). The V2 package map is in §"V2 packages".
For the governing invariants and live duplication counts, see `PRINCIPLES.md`.

## Overview

Commander is a multi-agent orchestration system that dynamically selects execution topology based on task complexity. It routes tasks through a deliberation → scaling → topology → decomposition → execution → synthesis → quality gate pipeline.

```
User Task → Deliberation → EffortScaling → TopologyRoute → Decompose → Execute → Synthesize → QualityGate
```

## Core Modules

### `packages/core/src/ultimate/` — Orchestration Engine

| File                    | Purpose                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `deliberation.ts`       | Task classification (keyword + LLM). Determines topology, effort, capabilities                          |
| `effortScaler.ts`       | Anthropic-style effort scaling: SIMPLE→MODERATE→COMPLEX→DEEP_RESEARCH                                   |
| `topologyRouter.ts`     | 5 canonical topologies: SINGLE, CHAIN, DISPATCH, ORCHESTRATOR, REVIEW (9 legacy aliases accepted)       |
| `atomizer.ts`           | Recursive decomposition (ROMA-inspired). Aspect/Step/Recursive strategies                               |
| `subAgentExecutor.ts`   | Executes decomposed tasks with dependency-aware topological ordering                                    |
| `synthesizer.ts`        | Multi-agent synthesis with 5 quality gates (hallucination, consistency, completeness, accuracy, safety) |
| `artifactSystem.ts`     | Reference-based agent communication (prevents telephone game)                                           |
| `agentTeamManager.ts`   | Persistent teams with shared tasks and inbox messaging                                                  |
| `capabilityRegistry.ts` | FoA-inspired semantic agent capability matching                                                         |
| `orchestrator.ts`       | Top-level orchestrator wiring all phases together + self-optimization                                   |
| `types.ts`              | All orchestration types, configs, and defaults                                                          |

### `packages/core/src/runtime/` — Execution Engine

| File                             | Purpose                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `agentRuntime.ts`                | Core agent execution loop with caching, retry, observation masking |
| `modelRouter.ts`                 | Model tier routing (eco→standard→power→consensus)                  |
| `messageBus.ts`                  | Event-driven inter-agent communication (pub/sub)                   |
| `executionTrace.ts`              | Full execution tracing for debugging and analysis                  |
| `embedding.ts`                   | Vector embedding with OpenAI real + mock providers                 |
| `sseStream.ts`                   | Server-Sent Events bridge for real-time agent visibility           |
| `mcpRemoteRuntime.ts`            | Distributed execution via MCP protocol                             |
| `providers/openaiProvider.ts`    | OpenAI API provider with streaming                                 |
| `providers/anthropicProvider.ts` | Anthropic API provider with streaming                              |

### `packages/core/src/mcp/` — Model Context Protocol

MCP client/server implementation for tool exposure and distributed agent execution.

### `packages/core/src/selfEvolution/` — Meta-Learning

| File             | Purpose                                                   |
| ---------------- | --------------------------------------------------------- |
| `metaLearner.ts` | Thompson Sampling + Reflexion + cross-session persistence |

### `packages/core/src/telos/` — Token-Efficient Orchestration

Token budget enforcement, provider pooling, and cost-aware routing.

## V2 packages (Enterprise Gateway SKU)

These packages form the durable, multi-tenant V2 path exposed at `/v1`. Most are
**partially WIRED** — the kernel is the durable authority for `/v1/runs*`, but
V1 `@commander/core` still hosts the agent runtime that V2 invokes.

| Package                   | Role                                                                                                                                              | Status                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/contracts`      | Types, states, OpenAPI blob — the ABI seed. Zero internal deps.                                                                                   | EXISTS + ENFORCED as leaf by `pnpm arch:guard`                        |
| `packages/kernel`         | Postgres durable authority (`runs`/`steps`/`events`/outbox/leases) **and** always-on ops (`src/ops`: reclaim, timer, outbox, compensation probe). | WIRED (kernel auto-on in production); `/v1`-only                      |
| `packages/worker-plane`   | Poll/claim/execute; invokes core `AgentRuntime`.                                                                                                  | WIRED; depends on core barrel                                         |
| `packages/effect-broker`  | Capability PEP for external effects; fail-closed.                                                                                                 | EXISTS; not the sole effect path (WS2)                                |
| ~~`packages/operations`~~ | **Deleted in WS1.** Do not reintroduce; arch-guard bans `@commander/operations`. Ops = `packages/kernel/src/ops`.                                  | ABSENT + import-banned                                                |
| `packages/adapter-ops`    | Deploy unit only: EffectBroker compensation/reconcile drain. **Not a V2 plane**; not a resurrected operations package.                            | PARTIAL — registry PEP + egress fail-closed before daemon start       |
| `apps/api`                | Gateway — sole HTTP framework (ENFORCED). Hosts `/v1` + legacy `/api/v1/*`.                                                                       | WIRED; `/v1` kernel-only, 503 `KERNEL_UNAVAILABLE` when kernel absent |

## Pipeline Phases

### Phase 1: Deliberation

- Keyword-based (`deliberate()`) for zero-cost fast path
- LLM-powered (`deliberateWithLLM()`) for richer classification when a provider is available
- Outputs: task type, effort level, recommended topology, capabilities, token budget

### Phase 2: Effort Scaling

- Maps task complexity to agent count (1 for SIMPLE, up to 20 for DEEP_RESEARCH)
- Sets token budgets per agent
- Configures recursive decomposition depth

### Phase 3: Topology Routing

- 5 canonical topology types selected based on task DAG analysis
- Cost-aware: adjusts topology under budget constraints

### Phase 4: Task Decomposition

- Recursive decomposition into subtask trees
- Three strategies: ASPECT (by concern), STEP (by workflow), RECURSIVE (by chunking)
- Dependency graph with topological ordering ensures sequential correctness

### Phase 5: Team Formation

- Creates persistent agent teams with shared task lists
- Inbox messaging for inter-agent communication
- Status tracking per member

### Phase 6: Parallel Execution

- Dependency-aware parallel execution with topological ordering
- Max parallelism configurable (default 10)
- Error isolation: one failed subtask doesn't kill siblings

### Phase 7: Multi-Agent Synthesis

- Combines subtask results using configurable strategy
- Strategies: LEAD_SYNTHESIS, HIERARCHICAL, VOTE, ENSEMBLE
- Includes dissent reporting for transparency

### Phase 8: Quality Gates

- 5 gates: hallucination, consistency, completeness, accuracy, safety
- Auto-fix retry loop with targeted repair prompts
- Configurable thresholds per gate

## CLI Usage

Each command belongs to a **profile**: `local` (Local CLI SKU, default) or
`local·exp` (experimental one-run-model extension). No CLI command routes to the
Enterprise Gateway today — gateway routing is via `POST /v1/runs`. `commander status`
and `commander --version` print the resolved profile.

| Command          | Profile     | Purpose                                                                                               |
| ---------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| `run "task"`     | `local`     | Full execution (`--dry-run` plan, `--stream` live SSE, `--tui` dashboard). Enterprise via `/v1/runs`. |
| `fix`            | `local`     | Auto-fix lint, formatting & type errors                                                               |
| `init`           | `local`     | Zero-config environment setup                                                                         |
| `company "task"` | `local·exp` | **Local** company-mode: quality gating + memory (not the Enterprise Gateway)                          |
| `swarm "task"`   | `local·exp` | Recursive decomposition + parallel (experimental)                                                     |
| `drive "task"`   | `local·exp` | Autonomous step-by-step execution (experimental)                                                      |
| `goal "task"`    | `local·exp` | Multi-round convergence loop (experimental)                                                           |
| `review`         | `local`     | Code review with P0-P3 findings                                                                       |
| `status`         | `local`     | Show system status (and active profile)                                                               |
| `config`         | `local`     | View or change settings                                                                               |
| `doctor`         | `local`     | Run diagnostics                                                                                       |
| `history`        | `local`     | Session management                                                                                    |
| `gui`            | `local`     | Web dashboard (Agent War Room)                                                                        |
| `skill`          | `local`     | Learnable skill management                                                                            |
| `plugin`         | `local`     | Install/list/uninstall plugins                                                                        |
| `mode`           | `local`     | Show/set approval mode                                                                                |
| `intelligence`   | `local`     | MetaLearner stats & insights                                                                          |
| `feedback`       | `local`     | Submit feedback                                                                                       |
| `budget`         | `local`     | View token budget status                                                                              |
| `checkpoint`     | `local`     | View checkpoint documents                                                                             |
| `saga`           | `local`     | Saga transaction management                                                                           |
| `cost`           | `local`     | Token usage & cost reports                                                                            |
| `help`           | `local`     | Show this help                                                                                        |

## API Endpoints

The canonical Enterprise Gateway surface is `/v1` (kernel-only, durable). The
legacy `/api/v1/*` routes predate the V2 kernel and are **legacy**. The `/v1`
spec is defined in `apps/api/src/openApiSpec.ts` (owned by WS3).

### `/v1` — Enterprise Gateway (canonical, durable)

| Endpoint                  | Method | Purpose                                                                                                               |
| ------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| `/v1/runs`                | POST   | Submit a durable agent run (requires `Idempotency-Key` + tenant identity). 503 `KERNEL_UNAVAILABLE` if kernel absent. |
| `/v1/runs/{runId}`        | GET    | Get a durable run                                                                                                     |
| `/v1/runs/{runId}/events` | GET    | List durable run events (ordered timeline)                                                                            |
| `/v1/runs/{runId}/status` | GET    | Run status                                                                                                            |
| `/v1/runs/{runId}/{verb}` | POST   | Run control verbs (e.g. cancel/pause/resume)                                                                          |

### `/api/v1/*` — legacy (pre-kernel)

| Endpoint               | Method     | Purpose                                       |
| ---------------------- | ---------- | --------------------------------------------- |
| `/api/v1/execute`      | POST       | Agent execution (legacy)                      |
| `/api/v1/mcp`          | POST       | MCP JSON-RPC 2.0 (tool discovery + execution) |
| `/api/v1/runtime`      | POST       | Create runtime session (legacy)               |
| `/api/v1/runtime/{id}` | GET/DELETE | Get or delete runtime session (legacy)        |
| `/api/v1/bus`          | POST       | Message bus publish                           |
| `/api/v1/status`       | GET        | System status                                 |

### System

| Endpoint               | Method | Purpose                                   |
| ---------------------- | ------ | ----------------------------------------- |
| `/health`              | GET    | Health check (bypasses auth + rate limit) |
| `/readyz`              | GET    | Readiness probe                           |
| `/stream/runtime/{id}` | GET    | SSE stream for real-time agent events     |

## Environment Variables

| Variable                                         | Purpose                                                                                            |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                                 | OpenAI provider key (Local CLI + Enterprise)                                                       |
| `ANTHROPIC_API_KEY`                              | Anthropic provider key                                                                             |
| `OPENAI_BASE_URL`                                | Custom API endpoint                                                                                |
| `OPENAI_MODEL`                                   | Model override (default: gpt-4o)                                                                   |
| `COMMANDER_TOOLS`                                | Comma-separated tool list                                                                          |
| `COMMANDER_EFFORT`                               | Force effort level                                                                                 |
| `COMMANDER_KERNEL_DATABASE_URL` / `DATABASE_URL` | Postgres DSN — **Enterprise Gateway**. Enables the durable kernel.                                 |
| `COMMANDER_V2_MODE`                              | Set to `1` to enable V2/kernel mode.                                                               |
| `COMMANDER_KERNEL_ENABLED`                       | Kernel auto-on in production/V2/DSN; `=0` is a non-prod escape hatch only (production refuses it). |
| `COMMANDER_API_KEY`                              | Gateway API key (Enterprise Gateway auth).                                                         |
| `COMMANDER_EVENT_SOURCING_WAL`                   | Optional WAL path for `EventSourcingEngine` (in-memory by default).                                |
| `COMMANDER_WORKER_EFFECT_POLICY`                 | Worker effect policy; default `deny-all`, `permit` restores legacy allow-all for local demos.      |

## Workstream status (WS0–WS7)

Only verified, landed changes are stated as fact; in-progress items are marked
target. See `PRINCIPLES.md` change log for evidence.

| WS  | Scope                                                                    | Status                                                                                                                                                         |
| --- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS0 | Contracts-as-ABI: boundary lint, delete `control-plane` stub, freeze     | **Landed (partial)** — contracts clean (zero deps); `scripts/arch-guard.sh` / `pnpm arch:guard` **ENFORCED** in CI (V2 graph, deleted-package ban, contracts leaf). Remaining debt: V1 wholesale `@commander/core` import ban still PARTIAL (allowlisted bridges) |
| WS1 | Kernel + ops durability: kernel default-on, reclaim, outbox, transitions | **Landed (partial)** — kernel auto-on in production/V2/DSN (`isCommanderKernelEnabled`); reclaim loop exists but not ops-wired; outbox publisher console-grade |
| WS2 | Effect monopoly: effect-broker sole PEP, one capability crypto           | **Landed (partial)** — worker effect deny-default ENFORCED; effect-broker not yet sole path                                                                    |
| WS3 | Gateway `/v1`-only: apps/api freeze, OpenAPI = surface                   | **In-progress** — `/v1` OpenAPI EXISTS (`openApiSpec.ts`); legacy `/api/v1/*` not yet frozen                                                                   |
| WS4 | Single planner: `planWorkGraph` profiles, freeze Ultimate verbs          | **Target** — 10 orchestrator classes still exist (ceiling ENFORCED)                                                                                            |
| WS5 | Runtime package: extract runtime; worker !core barrel                    | **Target** — core barrel still imported wholesale                                                                                                              |
| WS6 | Memory/store unify                                                       | **Landed (partial)** — memory allowlist 7 (L3-10a); `writeProductMemory` preferred; MEMORY-001 on MemoryService.store                                          |
| WS7 | Sandbox fail-closed                                                      | **Landed** — worker `PolicyEvaluator` deny-default; sandbox mechanisms present (fail-closed default target)                                                    |

## Benchmarks

```bash
pnpm test:core               # Core module tests
pnpm test:bench              # Benchmark tests
pnpm test:coverage           # Tests with coverage
```

## Key Design Decisions

1. **No framework lock-in**: Commander is a system, not a framework. Import what you need.
2. **Dynamic topology over fixed**: 5 canonical topologies beat 1-2 (LangGraph, CrewAI).
3. **Artifact-based communication**: References instead of raw text to prevent information loss.
4. **Self-optimizing**: Meta-learner adjusts config based on execution outcomes.
5. **MCP-native**: First-class MCP support for tool exposure and distributed execution.
6. **SSE streaming**: Real-time agent visibility for human operators.
