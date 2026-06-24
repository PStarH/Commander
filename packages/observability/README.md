# @commander/observability

Observability platform for Commander multi-agent orchestration. Provides metrics, tracing, cost analysis, and evaluation tooling.

## Features

- **Execution Timeline** — structured timeline of LLM calls, tool executions, decisions, and errors
- **Span Tree** — parent-child span relationships for nested agent calls
- **Cost Analysis** — per-model, per-tool, and per-agent cost breakdowns with cached token savings
- **Decision Provenance** — trace which tools were chosen and why, with LLM reasoning
- **Executive Summary** — 30-second narrative with key metrics and highlights
- **OTel Export** — hand-rolled OTLP/HTTP/JSON exporter (zero runtime dependencies)
- **W3C Trace Context** — `traceparent` header parsing and generation
- **Sampling Policy** — deterministic head-based + tail-based sampling (errors, latency, retries, quality)
- **PII Redaction** — strips prompts, completions, and tool args from exported spans (default on)
- **Replay** — dry and live replay of execution traces with substitutions
- **Trace Comparison** — side-by-side diff of two execution traces
- **Tool Metrics** — aggregated success rates, invocation counts, and durations
- **Prompt Versioning** — track prompt drift across runs
- **SLO Management** — define and monitor service-level objectives
- **Dataset Eval** — Braintrust-style datasets with LLM-as-judge scoring
- **Experiment Runner** — run dataset evaluations with sequential or parallel execution
- **Auto Scorer** — production eval hook that auto-scores a fraction of traces
- **Anomaly Detection** — z-score based token usage anomaly detection
- **MCP Tools** — observability tools for the MCP server
- **Routing Dashboard** — live exploration log for topology routing

## Installation

```bash
pnpm add @commander/observability
```

## Quick Start

```typescript
import { CostModel, buildTimeline, buildExecutiveSummary } from '@commander/observability';

// Cost calculation
const costModel = new CostModel();
const cost = costModel.calculate('openai', 'gpt-4o', {
  input: 1000,
  output: 500,
  cached: 0,
  reasoning: 0,
  total: 1500,
});

// Build timeline from an execution trace
const timeline = buildTimeline(executionTrace);

// Generate executive summary
const summary = buildExecutiveSummary(executionTrace);
console.log(summary.narrative);
```

## HTTP API

Mount the observability routes in your HTTP server:

```typescript
import { handleObservabilityRequest, OBSERVABILITY_HTTP_ROUTES } from '@commander/observability';

// Routes are prefixed with /api/v1/observability
const routes = OBSERVABILITY_HTTP_ROUTES;
```

### Endpoints

| Method | Path                             | Description             |
| ------ | -------------------------------- | ----------------------- |
| GET    | `/runs`                          | List all runs           |
| GET    | `/runs/:runId`                   | Get a specific run      |
| GET    | `/runs/:runId/timeline`          | Get execution timeline  |
| GET    | `/runs/:runId/tree`              | Get span tree           |
| GET    | `/runs/:runId/cost`              | Get cost breakdown      |
| GET    | `/runs/:runId/decisions`         | Get decision provenance |
| GET    | `/runs/:runId/summary`           | Get executive summary   |
| POST   | `/runs/:runId/replay`            | Replay a trace          |
| POST   | `/runs/:runId/feedback`          | Submit feedback         |
| GET    | `/agents/:agentId`               | Get agent runs          |
| GET    | `/conversations/:conversationId` | Get conversation runs   |
| GET    | `/tools`                         | Get tool metrics        |
| GET    | `/compare/:runIdA/:runIdB`       | Compare two runs        |
| GET    | `/prompts`                       | Get prompt versions     |
| GET    | `/slos`                          | Get SLO status          |
| GET    | `/search`                        | Search runs             |

## OTel Export

```typescript
import { OtelSpanExporter, SamplingPolicy } from '@commander/observability';

const exporter = new OtelSpanExporter({
  endpoint: 'http://otel-collector:4318',
  serviceName: 'my-service',
  samplingPolicy: new SamplingPolicy({ baseRate: 0.05 }),
  redactInput: true, // strip prompts (default)
  redactOutput: true, // strip completions (default)
  redactToolArgs: true, // strip tool args (default)
});

exporter.start();
exporter.enqueue(executionTrace);
await exporter.flush();
```

## Dataset Eval

```typescript
import { DatasetStore, EvalScorer, ExperimentRunner } from '@commander/observability';

const store = new DatasetStore();
const scorer = new EvalScorer(judgeProvider);
const runner = new ExperimentRunner(store, scorer);

// Create a dataset
const dataset = store.create({
  name: 'Code Quality',
  rubricId: 'default-quality',
  cases: [{ id: 'case-1', input: { goal: 'Write a function that sorts an array' } }],
});

// Run evaluation
const result = await runner.run(dataset.id, executeCase);
console.log(result.summary.passRate);
```

## Testing

```bash
pnpm test
```

## Architecture

The package is organized into independent modules:

- `types.ts` — shared type definitions
- `costModel.ts` — token pricing and cost calculation
- `timelineBuilder.ts` — execution timeline and span tree
- `decisionProvenance.ts` — decision tracking
- `executiveSummary.ts` — narrative summary generation
- `otelSemConv.ts` — OpenTelemetry semantic conventions
- `otelExporter.ts` — OTLP/HTTP/JSON exporter
- `traceContext.ts` — W3C Trace Context
- `samplingPolicy.ts` — head + tail sampling
- `replay.ts` — trace replay
- `traceComparison.ts` — trace diffing
- `toolMetrics.ts` — tool usage metrics
- `promptVersioning.ts` — prompt drift tracking
- `sloManager.ts` — SLO management
- `dataset.ts` — dataset storage
- `experimentRunner.ts` — evaluation runner
- `evalScorer.ts` — LLM-as-judge scoring
- `autoScorer.ts` — production auto-scoring
- `anomalyDetector.ts` — token usage anomalies
- `mcpObservability.ts` — MCP tool registration
- `routingDashboard.ts` — routing dashboard HTTP handler
- `httpApi.ts` — HTTP router
- `httpRoutes.ts` — HTTP route handlers
