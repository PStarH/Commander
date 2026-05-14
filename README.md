# Commander

**Multi-agent orchestration with dynamic topology — 8 topologies, 13 tools, quality gates, MCP-native.**

```bash
npx tsx cli.ts plan "Design a distributed rate-limiting system"
# → Deliberation plan: task type, effort level, topology, agents needed
```

---

## Why Commander?

Most agent frameworks use a **fixed topology**. Commander analyzes each task and **dynamically selects** from 8 topologies:

| Topology | Use Case |
|----------|----------|
| SINGLE | Simple factual queries |
| SEQUENTIAL | Multi-step pipelines |
| PARALLEL | Independent subtask research |
| HIERARCHICAL | Complex tasks with dependencies |
| HYBRID | Deep research combining parallel + sequential |
| DEBATE | Reasoning tasks needing multiple perspectives |
| ENSEMBLE | Creative tasks wanting diverse outputs |
| EVALUATOR_OPTIMIZER | Iterative refinement |

Research shows topology-aware orchestration yields **12–23% improvement** over fixed topologies (AdaptOrch, arXiv 2026).

## Pipeline

```
Task → Deliberation → EffortScaling → TopologyRoute → Decompose → Execute → Synthesize → QualityGate
```

1. **Deliberation** — LLM-powered task analysis. Classifies type, estimates effort, selects topology.
2. **Effort Scaling** — 1 agent for simple tasks, up to 20 for deep research.
3. **Topology Routing** — DAG-based dependency analysis. O(|V|+|E|).
4. **Recursive Decomposition** — Subtask trees with dependency ordering.
5. **Team Formation** — Persistent teams with shared tasks and inbox messaging.
6. **Parallel Execution** — Dependency-aware, configurable concurrency.
7. **Multi-Agent Synthesis** — Lead, hierarchical, vote, ensemble strategies.
8. **Quality Gates** — 5 gates (hallucination, consistency, completeness, accuracy, safety) with auto-fix.

## 13 Built-in Tools

```
web_search · web_fetch · file_read · file_write · file_edit · file_search · file_list
python_execute · shell_execute · memory_store · memory_recall · memory_list · git
```

## Quick Start

```bash
pnpm install

# Plan a task (no API key needed)
npx tsx cli.ts plan "Design a rate-limiting system with Redis"

# Execute (requires OPENAI_API_KEY or ANTHROPIC_API_KEY)
export OPENAI_API_KEY=sk-...
npx tsx cli.ts run "Compare quicksort, mergesort, heapsort"

# Real-time SSE stream
npx tsx cli.ts watch "Research microservices vs monoliths"

# Status
npx tsx cli.ts status
```

## Tests

```bash
pnpm test          # 101 tests (72 core + 29 benchmark)
```

```
# tests 101
# pass 101
# fail 0
```

## Architecture

```
packages/core/src/
├── ultimate/          # Orchestration engine
│   ├── deliberation.ts       # Task classification
│   ├── effortScaler.ts       # Effort scaling rules
│   ├── topologyRouter.ts     # 8 topologies + DAG routing
│   ├── atomizer.ts           # Recursive decomposition
│   ├── subAgentExecutor.ts   # Parallel execution
│   ├── synthesizer.ts        # Multi-agent synthesis
│   ├── orchestrator.ts       # 8-phase pipeline
│   ├── artifactSystem.ts     # Reference-based communication
│   ├── agentTeamManager.ts   # Teams + inbox messaging
│   └── types.ts              # All types and configs
├── runtime/           # Execution engine
│   ├── agentRuntime.ts       # Core agent loop
│   ├── modelRouter.ts        # Model tier routing
│   ├── messageBus.ts         # Inter-agent pub/sub
│   ├── embedding.ts          # Vector embeddings
│   ├── sseStream.ts          # SSE streaming
│   └── providers/            # OpenAI, Anthropic
├── mcp/               # Model Context Protocol
├── selfEvolution/     # Meta-learning
└── tools/             # 13 tools
```

## Key Capabilities

| Capability | What It Does |
|-----------|-------------|
| Dynamic Topology | 8 topologies auto-selected per task |
| LLM Deliberation | Keyword + LLM-powered task analysis |
| Quality Gates | 5 gates with auto-fix retry loop |
| Self-Optimization | Meta-learner adjusts config from outcomes |
| Vector Memory | Three-layer memory with embeddings |
| SSE Streaming | Real-time agent execution visibility |
| MCP Protocol | Distributed execution |
| Cross-Session Learning | Persisted meta-learner experiences |
| Cost-Aware Routing | Budget-constrained topology selection |

## Benchmarks

```bash
pnpm benchmark:multiagent    # Multi-agent advantage demo
```

## Environment

```
OPENAI_API_KEY        # OpenAI / compatible provider
ANTHROPIC_API_KEY     # Anthropic provider
OPENAI_BASE_URL       # Custom API endpoint
OPENAI_MODEL          # Model override
COMMANDER_TOOLS       # Comma-separated tool list
```

## License

MIT
