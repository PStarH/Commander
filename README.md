# Commander

**Multi-Agent Orchestration System** — 8 topologies · 15 tools · quality gates · MCP-native · self-optimizing

```bash
npx tsx cli.ts plan "Design a distributed rate-limiting system"
# → deliberation → effort scaling → topology → decompose → execute → synthesize → quality gates
```

---

## Why Commander?

Most agent frameworks use **one fixed topology**. LangGraph is graph-based. CrewAI is role-based. AutoGen is conversation-based.

**Commander dynamically selects from 8 topologies** based on the task:

```
SINGLE · SEQUENTIAL · PARALLEL · HIERARCHICAL · HYBRID · DEBATE · ENSEMBLE · EVALUATOR-OPTIMIZER
```

Research shows topology-aware orchestration yields **12–23% improvement** over any single topology (AdaptOrch, arXiv 2026).

## Pipeline

```
Task → Deliberation → EffortScaling → TopologyRoute → Decompose → Execute → Synthesize → QualityGate
```

| Phase | What it does |
|-------|-------------|
| Deliberation | LLM-powered task analysis |
| Effort Scaling | 1 agent for simple tasks, up to 20 for deep research |
| Topology Routing | DAG-based dependency analysis |
| Decomposition | ROMA-inspired recursive subtask trees |
| Team Formation | Persistent agent teams with inbox messaging |
| Execution | Dependency-aware parallel execution |
| Synthesis | Multi-agent synthesis (lead, hierarchical, vote, ensemble) |
| Quality Gates | 5 gates: hallucination, consistency, completeness, accuracy, safety |

## 15 Tools

```
browser_search   browser_fetch    web_search   web_fetch
file_read        file_write       file_edit    file_search   file_list
python_execute   shell_execute
memory_store     memory_recall    memory_list
git
```

`browser_search` uses stealth Playwright — bypasses bot detection, searches DuckDuckGo, returns real results. No API key needed.

## Quick Start

```bash
git clone https://github.com/PStarH/Commander.git
cd Commander
pnpm install
npx tsx cli.ts plan "Design a rate-limiting system with Redis"
```

## Tests

```bash
pnpm test
```
```
# tests 101
# pass 101
# fail 0
```

## CLI

```
commander <task>         Quick plan (no API key)
commander run <task>      Full multi-agent execution
commander plan <task>     Deliberation plan
commander watch <task>    SSE real-time stream
commander status          System status
```

## Architecture

```
packages/core/src/
├── ultimate/       Orchestration engine (deliberation → quality gates)
├── runtime/        Execution engine (AgentRuntime, model routing, message bus)
├── mcp/            Model Context Protocol (client + server)
├── selfEvolution/  Thompson Sampling + Reflexion
├── telos/          Token-efficient orchestration
└── tools/          15 built-in tools
```

## Comparison

| Capability | Commander | LangGraph | CrewAI | AutoGen |
|-----------|-----------|-----------|--------|---------|
| Topologies | 8 dynamic | 1 (graph) | 2 (seq/hier) | 1 (chat) |
| Quality Gates | 5 built-in | none | none | none |
| Self-Optimization | MetaLearner | none | none | none |
| MCP Protocol | native | no | no | no |
| Tools | 15 | via LangChain | limited | via plugins |
| Tests | 101 | — | — | — |
| Browser Search | stealth Playwright | no | no | no |

## License

MIT
