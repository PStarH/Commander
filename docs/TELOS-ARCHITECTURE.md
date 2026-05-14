# TELOS Framework Architecture

**Token-Efficient Low-waste Orchestration System**

## Overview

TELOS is a production-grade multi-agent framework built on three principles:
1. **Token efficiency first** — every API call is measured, budgeted, and optimized before it fires
2. **Adaptive orchestration** — the framework adapts its coordination strategy to task complexity, not the other way around
3. **Protocol-native** — A2A v1.0 for agent↔agent, MCP for agent↔tool, no vendor lock-in

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                         │
│  TELOSOrchestrator planAndExecute() — the unified entry     │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────┐  │
│  │  AgentRuntime (6-stage harness loop)                  │  │
│  │  ├─ 1. Context Compression Pipeline (5 tiers)          │  │
│  │  │    Budget → Snip → Microcompact → Collapse → Compact│  │
│  │  ├─ 2. Streaming API Call (OpenAI/Anthropic)           │  │
│  │  ├─ 3. Error Recovery Ladder (413 → collapse → compact)│  │
│  │  ├─ 4. Diminishing Returns Detection                   │  │
│  │  ├─ 5. Tool Execution (parallel-safe, streaming)       │  │
│  │  └─ 6. Terminal Decision (10 typed exit reasons)       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────┐ ┌──────────────┐ ┌────────────────────┐  │
│  │ ModelRouter  │ │ TokenSentinel│ │ ProviderPool       │  │
│  │ 4-tier route │ │ Count/Track/ │ │ Failover + Health  │  │
│  │ cost-aware   │ │ Enforce      │ │ + Rate limiting    │  │
│  └──────────────┘ └──────────────┘ └────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Memory + Self-Evolution                               │  │
│  │ ├─ ThreeLayerMemory + embedding retrieval             │  │
│  │ ├─ Reflexion (verbal self-reflection)                 │  │
│  │ ├─ Thompson Sampling (Bayesian strategy selection)    │  │
│  │ └─ HeuristicEvaluator (5-dimension LLM-as-Judge)      │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐ │
│  │MessageBus│ │ExecTrace │ │MCP Client│ │  A2A Server   │ │
│  │ pub/sub  │ │ LLM/Tool │ │ Stdio/   │ │ JSON-RPC + SSE│ │
│  │ history  │ │ Decision │ │ HTTP     │ │ Agent Card    │ │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. AgentRuntime

The execution engine. Implements a 6-stage pipeline adapted from Claude Code's `query.ts`:

```
State (reconstructed at every continue site):
  messages, toolUseContext, autoCompactTracking,
  maxOutputTokensRecoveryCount, hasAttemptedReactiveCompact,
  stopHookActive, turnCount, transition

Loop:
  while (true):
    1. Compress Context (5 tiers, cheapest first)
    2. Stream API Call (OpenAI/Anthropic)
    3. Recover Errors (413 ladder, output token escalation)
    4. Run Stop Hooks (diminishing returns detector)
    5. Execute Tools (parallel-safe partitioning)
    6. Terminal Decision (10 reasons)

Terminal Reasons:
  completed | max_turns | user_aborted | context_overflow |
  model_error | budget_exhausted | stop_hook_blocked |
  tool_error | diminishing_returns | image_error
```

### 2. ModelRouter

Routes tasks to optimal models based on complexity, governance constraints, and cost:

```
Tiers:  eco (fast/cheap) → standard (balanced) → power (strong) → consensus (multi-model)
 
Scoring: goal length + tool count + token budget + governance risk level
         score 0-3 → eco, 4-6 → standard, 7+ → power, CRITICAL risk → consensus
 
Fallback: consensus→power→standard→eco (automatic cascade)
```

### 3. TokenSentinel

Three guards against token waste:

```
Pre-flight Check:  estimate input/output tokens BEFORE API call
                   → deny if exceeds hardCap or monthlyBudget
                   
Cost Tracking:     record every call's token usage + USD cost
                   → summary per model, per agent, per run
                   
Budget Enforcement: hardCap → stop execution
                    monthlyLimitUSD → deny new runs
                    softCap → warn
```

### 4. ProviderPool

Multi-provider management with automatic failover:

```
Selection: weighted random among healthy endpoints
           3 consecutive failures → mark 'down'
           auto-recover after cooldown
           
Failover:  primary → fallback 1 → fallback 2 → graceful error
           error-type aware: 429 → different provider
                             413 → larger context model
```

### 5. MessageBus

Event-driven inter-agent communication:

```
Topics: agent.started | agent.completed | agent.failed
        mission.updated | mission.blocked | tool.executed
        memory.written | system.alert | trace.recorded

Features: typed topics, priority levels, message history,
          subscribe/unsubscribe, async handlers
```

### 6. ExecutionTrace

Full observability pipeline:

```
Event types: llm_call | tool_execution | decision | error | state_change
Per event:  input, output, model info, token usage, timing, parent trace
Summary:    total events, duration, tokens, LLM calls, tool calls, errors
```

## Protocol Layer

### A2A v1.0 (Agent-to-Agent)

```
Agent Card: /.well-known/agent-card.json
  capabilities, skills, interfaces, auth schemes

JSON-RPC 2.0: POST /a2a/v2/
  methods: message/send, tasks/get, tasks/list, tasks/cancel

SSE Streaming: POST /a2a/v2/stream
  events: task updates, artifact updates, status transitions

Task Lifecycle:
  SUBMITTED → WORKING → COMPLETED | FAILED | CANCELED | REJECTED
                         → INPUT_REQUIRED | AUTH_REQUIRED
```

### MCP (Model Context Protocol)

```
Server:     POST /mcp — JSON-RPC 2.0
            tools/list → tools/call
            resources/list → resources/read
            prompts/list → prompts/get

Client:     StdioClientTransport (local subprocess)
            StreamableHTTPClientTransport (remote HTTP)

Built-in Tools:
  execute_agent — run a TELOS agent task
  list_models — query available models
  route_task — preview routing decision
```

## Self-Evolution

### Reflexion

Verbal self-reflection on every execution:

```
Success: "The SEQUENTIAL strategy worked well for this code_generation task"
Failure: "The PARALLEL strategy may not be optimal — consider HANDOFF"
```

### Thompson Sampling

Bayesian multi-armed bandit for strategy selection:

```
Each task type has Beta distributions over 5 strategies
  selectStrategy(): sample each Beta, pick highest
  updatePrior(): Beta.update(success/failure)
  
Explores untested strategies, exploits proven ones.
```

### LLM-as-Judge

5-dimension evaluation:

```
correctness (0.30) | grounding (0.25) | completeness (0.20)
clarity (0.15)     | safety (0.10)

Pass threshold: 0.67

EvalSuite: regression testing from failure cases
  addFromFailure() → auto-generate test case
  run() → passed/failed per test
```

## Providers

### OpenAI

```typescript
new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: 'https://api.openai.com/v1',  // optional
  defaultModel: 'gpt-4o',                // optional
})
```

Features: streaming, auto-caching (>1024 tokens), parallel_tool_calls=true

### Anthropic

```typescript
new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseUrl: 'https://api.anthropic.com/v1',  // optional
  defaultModel: 'claude-3-5-sonnet-20241022',
})
```

Features: streaming, cache_control ephemeral markers, tool use with cache

## Benchmarks

```
cosineSimilarity(64d):       0.000ms avg  (7,364,448 ops/sec)
MCPServer.handleRequest:     0.001ms avg  (1,180,174 ops/sec)
ModelRouter.route:           0.001ms avg    (808,462 ops/sec)
HeuristicEvaluator.evaluate: 0.001ms avg    (681,913 ops/sec)
MessageBus.publish:          0.002ms avg    (631,941 ops/sec)
ExecutionTrace.record:       0.002ms avg    (611,808 ops/sec)
ProviderPool.select:         0.002ms avg    (422,020 ops/sec)
TokenSentinel.check:         0.003ms avg    (319,446 ops/sec)
TELOS.plan:                  0.005ms avg    (218,104 ops/sec)
AgentRuntime.execute:        0.020ms avg     (59,397 ops/sec)
TELOS.planAndExecute:        0.120ms avg      (8,274 ops/sec)
EvalSuite.run(1000 tests):   2.103ms avg        (476 ops/sec)
```

## Project Structure

```
packages/core/src/
├── runtime/
│   ├── types.ts                  — All runtime interfaces
│   ├── agentRuntime.ts           — 6-stage harness loop
│   ├── modelRouter.ts            — 4-tier cost-aware routing
│   ├── messageBus.ts             — Event bus for agent communication
│   ├── executionTrace.ts         — Execution observability
│   ├── embedding.ts              — Embedding functions + similarity
│   ├── mockLLMProvider.ts        — Test mock provider
│   └── providers/
│       ├── openaiProvider.ts     — OpenAI streaming + caching
│       └── anthropicProvider.ts  — Anthropic streaming + cache_control
│
├── telos/
│   ├── types.ts                  — TELOS budget, plan, stream types
│   ├── tokenSentinel.ts          — Counter + CostTracker + BudgetEnforcer
│   ├── providerPool.ts           — Multi-provider failover
│   ├── telosOrchestrator.ts      — Unified plan→preflight→execute
│   └── evaluator.ts              — HeuristicEvaluator + EvalSuite
│
├── mcp/
│   ├── types.ts                  — MCP protocol types
│   ├── client.ts                 — Stdio + HTTP clients
│   ├── server.ts                 — MCP server with dispatch
│   └── a2aCompliance.ts          — A2A v1.0 types + state machine
│
├── selfEvolution/
│   └── metaLearner.ts            — Reflexion + Thompson Sampling
│
├── reporting/
│   └── htmlReportRenderer.ts     — Self-contained HTML reports
│
├── threeLayerMemory.ts           — Memory with embedding retrieval
└── index.ts                      — Public API exports

apps/api/src/
├── runtimeEndpoints.ts           — POST /api/runtime/execute
├── a2aV2Endpoints.ts             — A2A v1.0 JSON-RPC + SSE
├── mcpEndpoints.ts               — MCP server + client endpoints
└── index.ts                      — Express router assembly

docs/
├── TELOS-ARCHITECTURE.md         — This file
└── ...
```

## Quick Start

```typescript
import {
  AgentRuntime, OpenAIProvider, AnthropicProvider,
  TELOSOrchestrator, getTokenSentinel,
} from '@commander/core';

// 1. Create runtime with providers
const runtime = new AgentRuntime();
runtime.registerProvider('openai', new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
}));
runtime.registerProvider('anthropic', new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
}));

// 2. Create orchestrator
const telos = new TELOSOrchestrator(runtime);

// 3. Plan and execute
const result = await telos.planAndExecute({
  projectId: 'my-project',
  agentId: 'agent-builder',
  goal: 'Analyze the current system architecture and provide optimization recommendations.',
  contextData: {
    governanceProfile: { riskLevel: 'LOW' },
  },
});

console.log(`Status: ${result.status}`);
console.log(`Cost: $${result.totalCostUsd}`);
console.log(`Tokens: ${result.totalTokens}`);

// 4. Check budget
const sentinel = getTokenSentinel();
console.log(`Monthly spend: $${sentinel.getMonthlyCostUsd()}`);
console.log(`Monthly limit: $${sentinel.getMonthlyLimitUsd()}`);
```
