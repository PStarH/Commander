# Commander Architecture

## Overview

Commander is a multi-agent orchestration system that dynamically selects execution topology based on task complexity. It routes tasks through a deliberation → scaling → topology → decomposition → execution → synthesis → quality gate pipeline.

```
User Task → Deliberation → EffortScaling → TopologyRoute → Decompose → Execute → Synthesize → QualityGate
```

## Core Modules

### `packages/core/src/ultimate/` — Orchestration Engine

| File | Purpose |
|------|---------|
| `deliberation.ts` | Task classification (keyword + LLM). Determines topology, effort, capabilities |
| `effortScaler.ts` | Anthropic-style effort scaling: SIMPLE→MODERATE→COMPLEX→DEEP_RESEARCH |
| `topologyRouter.ts` | 8 topologies: SINGLE, SEQUENTIAL, PARALLEL, HIERARCHICAL, HYBRID, DEBATE, ENSEMBLE, EVALUATOR_OPTIMIZER |
| `atomizer.ts` | Recursive decomposition (ROMA-inspired). Aspect/Step/Recursive strategies |
| `subAgentExecutor.ts` | Executes decomposed tasks with dependency-aware topological ordering |
| `synthesizer.ts` | Multi-agent synthesis with 5 quality gates (hallucination, consistency, completeness, accuracy, safety) |
| `artifactSystem.ts` | Reference-based agent communication (prevents telephone game) |
| `agentTeamManager.ts` | Persistent teams with shared tasks and inbox messaging |
| `capabilityRegistry.ts` | FoA-inspired semantic agent capability matching |
| `orchestrator.ts` | Top-level orchestrator wiring all phases together + self-optimization |
| `types.ts` | All orchestration types, configs, and defaults |

### `packages/core/src/runtime/` — Execution Engine

| File | Purpose |
|------|---------|
| `agentRuntime.ts` | Core agent execution loop with caching, retry, observation masking |
| `modelRouter.ts` | Model tier routing (eco→standard→power→consensus) |
| `messageBus.ts` | Event-driven inter-agent communication (pub/sub) |
| `executionTrace.ts` | Full execution tracing for debugging and analysis |
| `embedding.ts` | Vector embedding with OpenAI real + mock providers |
| `sseStream.ts` | Server-Sent Events bridge for real-time agent visibility |
| `mcpRemoteRuntime.ts` | Distributed execution via MCP protocol |
| `providers/openaiProvider.ts` | OpenAI API provider with streaming |
| `providers/anthropicProvider.ts` | Anthropic API provider with streaming |

### `packages/core/src/mcp/` — Model Context Protocol

MCP client/server implementation for tool exposure and distributed agent execution.

### `packages/core/src/selfEvolution/` — Meta-Learning

| File | Purpose |
|------|---------|
| `metaLearner.ts` | Thompson Sampling + Reflexion + cross-session persistence |

### `packages/core/src/telos/` — Token-Efficient Orchestration

Token budget enforcement, provider pooling, and cost-aware routing.

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
- 8 topology types selected based on task DAG analysis
- AdaptOrch-inspired: topology selection yields 12-23% improvement
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

```bash
commander "task"              # Quick plan (default, no API key needed)
commander run "task"          # Full execution with streaming progress
commander plan "task"         # Show deliberation plan
commander watch "task"        # Execute with real-time SSE stream
commander company "task"      # Company mode execution
commander status              # Show system status
commander help                # Show this help
```

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/orchestrator/execute` | POST | Full multi-agent execution |
| `/api/orchestrator/deliberate` | POST | Task deliberation only |
| `/api/orchestrator/stream` | GET | SSE stream for real-time agent events |
| `/api/runtime/execute` | POST | Single agent execution |
| `/api/runtime/traces` | GET | Execution trace history |
| `/api/runtime/learner/stats` | GET | Meta-learner statistics |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | OpenAI provider key |
| `ANTHROPIC_API_KEY` | Anthropic provider key |
| `OPENAI_BASE_URL` | Custom API endpoint |
| `OPENAI_MODEL` | Model override (default: gpt-4o) |
| `COMMANDER_TOOLS` | Comma-separated tool list |
| `COMMANDER_EFFORT` | Force effort level |

## Benchmarks

```bash
pnpm benchmark:gaia          # Full GAIA-style benchmark
pnpm benchmark:gaia:quick    # 5-task quick benchmark
pnpm test:core               # Core module tests
pnpm test:bench              # Benchmark tests
pnpm test:coverage           # Tests with coverage
```

## Key Design Decisions

1. **No framework lock-in**: Commander is a system, not a framework. Import what you need.
2. **Dynamic topology over fixed**: 8 topologies beat 1-2 (LangGraph, CrewAI).
3. **Artifact-based communication**: References instead of raw text to prevent information loss.
4. **Self-optimizing**: Meta-learner adjusts config based on execution outcomes.
5. **MCP-native**: First-class MCP support for tool exposure and distributed execution.
6. **SSE streaming**: Real-time agent visibility for human operators.
