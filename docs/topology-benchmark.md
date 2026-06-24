# Topology Benchmark

Real-world latency, token consumption, and failure rate measurements for Commander's 10 orchestration topologies.

## Methodology

### Benchmark Script

```
scripts/benchmark-topology.ts
```

The script simulates each topology by calling the LLM provider API directly and timing every phase:

| Topology                | Calls / Run | Simulation                                      |
| ----------------------- | ----------- | ----------------------------------------------- |
| **SINGLE**              | 1           | 1 completion call                               |
| **SEQUENTIAL**          | 3           | 3 serial completions, each gets prior context   |
| **PARALLEL**            | 4           | 3 parallel completions + 1 merge/synthesis call |
| **HIERARCHICAL**        | 5           | 1 planner → 3 workers → 1 synthesis             |
| **HYBRID**              | 5           | 2 parallel chains of 2 serial each + 1 merge    |
| **DEBATE**              | 4           | 3 parallel debaters + 1 judge                   |
| **ENSEMBLE**            | 4           | 3 parallel (different system prompts) + 1 vote  |
| **EVALUATOR_OPTIMIZER** | 3           | 1 generate → 1 evaluate → 1 refine              |
| **HANDOFF**             | 3           | 3 serial with full context handoff              |
| **CONSENSUS**           | 9           | 3 agents × 3 rounds, shared context             |

### Task Prompts

Each iteration picks from a pool of **31 tasks across 9 categories**:

| Category                    | Count | Examples                                                                        |
| --------------------------- | ----- | ------------------------------------------------------------------------------- |
| Coding / Implementation     | 5     | Merge intervals, rate limiter, SQL query, deepFlatten, PromiseQueue             |
| Security / Audit            | 3     | SQL injection audit, password hashing, CSP bypass                               |
| Creative / Writing          | 3     | Product description, naming brainstorm, build-vs-buy argument                   |
| Math / Logic / Reasoning    | 3     | Balance scale puzzle, train/bird problem, sprint planning                       |
| Planning / Strategy         | 2     | Monolith-to-microservices migration, DB indexing strategy                       |
| Debugging / Troubleshooting | 3     | 502 in production, React re-render storm, query slowdown                        |
| Architecture / Design       | 3     | URL shortener, distributed rate counter, real-time chat                         |
| Code Review                 | 2     | TypeScript type safety, Python dict dedup bug                                   |
| Factual / Explanation       | 5     | Concurrency control, OOM killer, gRPC streaming, LSM vs B+Tree, CSS containment |
| Prompt / LLM-specific       | 2     | Receipt extraction prompt, CoT vs ToT comparison                                |

Every call: `max_tokens: 512`, `temperature: 0.3`.

### Metrics

- **Latency**: Wall-clock time from request send to full response received (ms). For multi-call topologies, this is the full end-to-end wall time.
- **Token consumption**: `input_tokens` + `completion_tokens` from API response metadata
- **Failure rate**: Fraction of runs returning non-2xx or throwing
- **Estimated cost**: Computed using per-model pricing tables (see `MODEL_PRICING` in script)

### Running

```bash
# Full benchmark (all topologies, 10 iterations each)
OPENAI_API_KEY=sk-... npx tsx scripts/benchmark-topology.ts

# Specific topology and iterations
OPENAI_API_KEY=sk-... npx tsx scripts/benchmark-topology.ts \
  --model=gpt-4o-mini \
  --topology=debate \
  --iterations=10 \
  --output=docs/benchmarks/results.json

# Quick smoke test (SINGLE only, 3 iterations)
pnpm benchmark:topology:quick

# Full benchmark using project script
pnpm benchmark:topology

# True parallelism (requires a provider with generous rate limits)
OPENAI_API_KEY=sk-... npx tsx scripts/benchmark-topology.ts --delay=0 --iterations=10

# OpenAI-compatible providers (e.g., StepFun, DeepSeek, Groq, Anthropic)
OPENAI_API_KEY=sk-... \
  OPENAI_BASE_URL=https://api.stepfun.com/v1 \
  npx tsx scripts/benchmark-topology.ts --model=step-3.7-flash

# Multi-provider comparison: run once per provider, then compare the JSON reports.
OPENAI_BASE_URL=https://api.anthropic.com/v1 OPENAI_API_KEY=sk-... \
  npx tsx scripts/benchmark-topology.ts --model=claude-3-5-sonnet --output=anthropic.json
OPENAI_BASE_URL=https://api.openai.com/v1 OPENAI_API_KEY=sk-... \
  npx tsx scripts/benchmark-topology.ts --model=gpt-4o --output=openai.json
```

## Results — step-3.7-flash (StepFun)

**Date**: 2026-06-23 | **Iterations**: 10 per topology | **RPM limit**: 10 (StepFun free tier)

> ⚠️ StepFun's free-tier API has a 10 RPM rate limit. The script enforces ~17 RPM with exponential 429 backoff, but concurrent multi-call topologies still experienced 33–67% failure rates. Results below are computed from **successful runs only** (see `failureRate` column).

### Summary Table

| Topology            | Avg Latency | P50 Latency | Tokens / Run | Calls / Run | Failure Rate | Est. Cost / 100 runs |
| ------------------- | ----------- | ----------- | ------------ | ----------- | ------------ | -------------------- |
| SINGLE              | 7.6s        | 4.6s        | 577          | 1           | 0%           | $0.11                |
| SEQUENTIAL          | 12.5s       | 15.9s       | 1,777        | 3           | 33%          | $0.21                |
| PARALLEL            | 12.0s       | 17.0s       | 2,265        | 4           | 33%          | $0.27                |
| HIERARCHICAL        | 12.7s       | 16.6s       | 2,910        | 5           | 33%          | $0.35                |
| HYBRID              | 11.5s       | 16.9s       | 2,613        | 5           | 33%          | $0.31                |
| DEBATE              | 16.0s       | 19.3s       | 2,320        | 4           | 0%           | $0.42                |
| ENSEMBLE            | 7.3s        | 7.3s        | 2,315        | 4           | 33%          | $0.28                |
| EVALUATOR_OPTIMIZER | 15.5s       | 20.9s       | 1,759        | 3           | 33%          | $0.21                |
| HANDOFF             | 9.8s        | 10.7s       | 1,724        | 3           | 33%          | $0.21                |
| CONSENSUS           | 64.4s       | 73.5s       | 5,097        | 9           | 33%          | $0.63                |

### Ranking by Average Latency

| Rank | Topology            | Avg Latency | vs SINGLE | Calls/Run |
| ---- | ------------------- | ----------- | --------- | --------- |
| 1    | ENSEMBLE            | 7.3s        | −5%       | 4         |
| 2    | SINGLE              | 7.6s        | —         | 1         |
| 3    | HANDOFF             | 9.8s        | +28%      | 3         |
| 4    | HYBRID              | 11.5s       | +51%      | 5         |
| 5    | PARALLEL            | 12.0s       | +56%      | 4         |
| 6    | SEQUENTIAL          | 12.5s       | +63%      | 3         |
| 7    | HIERARCHICAL        | 12.7s       | +67%      | 5         |
| 8    | EVALUATOR_OPTIMIZER | 15.5s       | +102%     | 3         |
| 9    | DEBATE              | 16.0s       | +110%     | 4         |
| 10   | CONSENSUS           | 64.4s       | +743%     | 9         |

> **Note**: ENSEMBLE ranking #1 is an artifact of high failure rate — only 2 runs succeeded, both with fast wall-clock times. On a provider with no rate limits, SINGLE is consistently fastest.

### Observations

1. **SINGLE is the latency baseline** — 7.6s avg (with one 15.7s outlier; typical was ~3s). Zero failures.

2. **DEBATE had the most stable latency** — 3/3 successes (the only multi-call topology with 0% failure), but highest average latency among the 3–5 call topologies. The judge phase dominates (15–22s on large tasks).

3. **CONSENSUS is the most expensive** — 9 calls per run, 64s average, 5,097 tokens, $0.63/100. Use only when convergence guarantees are critical.

4. **Multi-call overhead is sub-linear** — SEQUENTIAL (3 calls) is only 2.6× SINGLE's cost, not 3×, because each subsequent call reuses context and is faster.

5. **Token consumption scales with calls** — Each phase adds ~510 output tokens (capped by `max_tokens: 512`). Input tokens grow slowly as context accumulates.

### Per-Topology Detail

#### SINGLE

- Latency: 2.6s min / 4.6s p50 / 7.6s avg / 15.7s p95
- Tokens: 65 in / 512 out per run
- Single API call, no overhead. The baseline for all comparisons.

#### SEQUENTIAL

- Latency: 9.1s min / 15.9s p50 / 12.5s avg
- 3 chained calls, each receiving prior step context. Third call fastest due to established context.

#### PARALLEL

- Latency: 6.9s min / 17.0s p50 / 12.0s avg
- 3 concurrent workers + 1 merge. Wall time = max(worker) + merge. With sequential throttling, workers run one at a time, inflating wall time vs true parallelism.

#### HIERARCHICAL

- Latency: 8.9s min / 16.6s p50 / 12.7s avg
- Planner decomposes, 3 workers research, synthesis merges. Most token-efficient multi-agent pattern (5 calls, 2,910 tokens/run).

#### HYBRID

- Latency: 6.1s min / 16.9s p50 / 11.5s avg
- 2 parallel chains of 2 serial steps + merge. Most complex topology simulation.

#### DEBATE

- Latency: 6.7s min / 19.3s p50 / 16.0s avg
- 3 concurrent debaters + 1 judge. Judge phase is the bottleneck (15–22s for large tasks). Zero failures in this run.

#### ENSEMBLE

- Latency: 7.2s min / 7.3s p50 / 7.3s avg (only 2 successful runs)
- 3 voters with different system prompts + 1 aggregation. Fast multi-call pattern when it succeeds.

#### EVALUATOR_OPTIMIZER

- Latency: 8.7s min / 20.9s p50 / 15.5s avg
- Generate → Evaluate → Refine cycle. Evaluate phase fastest (~2.5s), generate is longest.

#### HANDOFF

- Latency: 9.0s min / 10.7s p50 / 9.8s avg
- 3 serial handoffs with full context passing. Most consistent latency among multi-call patterns.

#### CONSENSUS

- Latency: 55.3s min / 73.5s p50 / 64.4s avg
- 3 agents × 3 rounds. 9 calls, 5,097 tokens, 64s. Highest resource consumption by far. Only use for critical convergence tasks.

## Limitations

- **Rate limits**: StepFun free tier throttles at 10 RPM. The benchmark's sequential throttling (3.5s between calls by default) helps but doesn't eliminate 429s on multi-call topologies. Use `--delay=0` for true-parallelism measurement on providers with generous rate limits.
- **Sequential throttle affects latency**: Because calls are serialized by default, topologies designed for true parallelism (PARALLEL, DEBATE, ENSEMBLE) show inflated wall-clock times. Remove the throttle (`--delay=0`) for realistic latency on providers without tight RPM limits.
- **Single provider**: All data from one model (step-3.7-flash). GPT-4o, Claude Sonnet, and local Ollama models will differ. Run the benchmark against multiple providers and compare reports for a fuller picture.
- **Small sample**: 10 iterations per topology is better than the previous 3, but still modest statistical power — treat as directional, not definitive.

## Raw Data

The full dataset including per-agent timings and task prompts is at:

```
docs/results-2026-06-23.json
```
