# Commander - Agent Guide

Commander is a multi-agent orchestration system. Key files and architecture:

## Core Modules

| Path | Purpose |
|------|---------|
| `packages/core/src/ultimate/` | Orchestration engine (deliberation, topology, decomposition) |
| `packages/core/src/tools/` | 13 built-in tools (web, file, code, git, memory) |
| `packages/core/src/company.ts` | Company mode (scheduler, quality, feedback) |
| `packages/core/src/runtime/` | LLM provider abstraction, message bus |
| `packages/core/src/telos/` | TELOS orchestration framework |
| `packages/core/benchmarks/` | Performance and comparison benchmarks |

## Key Architecture

```
User Task → Deliberation → EffortScaling → TopologyRoute → Decompose → Execute → QualityGate
```

- **Simple tasks**: SINGLE topology, 1 agent, direct answer
- **Complex tasks**: HIERARCHICAL/HYBRID topology, multi-agent, quality verified
- **Company mode**: Scheduled tasks + quality tracking + persistent memory

## Tools

13 tools available: web_search, web_fetch, file_read, file_write, file_edit, file_search, file_list, python_execute, shell_execute, memory_store, memory_recall, memory_list, git

## Tests

```bash
cd packages/core
npx tsx --test tests/*.test.ts
npx tsx --test benchmarks/*.test.ts
npx tsc --noEmit
```
