# Commander

Multi-agent orchestration system. 8 providers · 8 topologies · 25+ tools · 233+ tests · 70% GAIA.

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
| `commander workers [topics]` | Parallel research workers |

## Providers

Set any one of these environment variables:

| Variable | Provider |
|----------|----------|
| `OPENAI_API_KEY` | OpenAI / DeepSeek / GLM / MiMo |
| `ANTHROPIC_API_KEY` | Anthropic Claude |
| `GOOGLE_API_KEY` | Google Gemini |
| `OPENROUTER_API_KEY` | OpenRouter (200+ models) |
| `DEEPSEEK_API_KEY` | DeepSeek (dedicated) |
| `ZHIPU_API_KEY` | GLM (Zhipu AI) |
| `MIMO_API_KEY` | MiMo (dedicated) |
| `XIAOMI_API_KEY` | Xiaomi MiMo |

## Architecture

```
CLI / HTTP
  ├─ deliberation.ts         Task analysis & topology selection
  ├─ effortScaler.ts         Scale agents (1-20) by complexity
  ├─ topologyRouter.ts       SINGLE | SEQUENTIAL | PARALLEL | HIERARCHICAL
  │                          | HYBRID | DEBATE | ENSEMBLE | EVALUATOR-OPT
  ├─ atomizer.ts             ROMA task decomposition
  ├─ agentRuntime.ts         LLM → tools → verification → retry loop
  │   ├─ providers/          8 providers (OpenAI, Anthropic, Google, etc.)
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

## Module Status

| Status | Count | Description |
|--------|-------|-------------|
| Production | 90+ | Wired into the main execution flow |
| `@experimental` | 3 | Scaffolding, test-only, or replaced: `mockLLMProvider`, `pluginLoader`, `dynamicOrchestrator`, `verificationLoop` |
| Standalone | 1 | `benchmarkRunner.ts` — independent CLI tool |

## License

MIT
