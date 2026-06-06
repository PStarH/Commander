# Reversibility Research Notes — Supporting Material for RFC

> Detailed research from production systems. For the actionable plan, see `reversibility-rfc.md`.

---

## A. Temporal / Cadence — The Replay Engine

**Sources**:
- [Temporal Docs](https://docs.temporal.io/workflows)
- [Temporal Blog: "Designing a Workflow engine from first principles"](https://temporal.io/blog/workflow-engine-principles)
- Maxim Fateev's talks (Temporal CTO)

### Key Concepts

**Event History** — The append-only log of every "command" the workflow issues:
- `WorkflowExecutionStarted`
- `ActivityTaskScheduled`
- `ActivityTaskStarted`
- `ActivityTaskCompleted`
- `TimerStarted`
- `TimerFired`
- `WorkflowExecutionSignaled`
- `ChildWorkflowExecutionStarted`
- ...

Each `ActivityTaskScheduled` has a corresponding `ActivityTaskCompleted`. On replay, the workflow re-executes from the beginning, but when it tries to schedule an activity, the matching service returns the recorded `ActivityTaskCompleted` event. The workflow code is unaware — it just sees the result.

**Deterministic Sandbox (TypeScript SDK)**:

The TypeScript SDK intercepts non-deterministic APIs:
- `Date.now()` → `workflow.now()` (uses a clock that advances only on replay events)
- `Math.random()` → `workflow.random()` (deterministic from seed)
- `setTimeout()` → `workflow.sleep()` (creates a `TimerStarted` event)
- `Promise.race()` is allowed, `process.nextTick()` is forbidden

If your workflow code calls a non-deterministic API, Temporal throws `DeterminismViolationError` at runtime. The protection is at the SDK level.

**Transfer Queue** — Cited as "the most important slide in the entire Temporal design" by Maxim Fateev:

> *"Every shard which stores workflow state also stores a queue... Every time we make an update to a shard we can also make an update to the queue because it lives in the same partition."*

This is the **transactional outbox pattern** at the infrastructure level. State + outgoing messages are written in the same local transaction. A background thread drains the queue to the global task-matching service.

**System Workflows** — Temporal's own cluster operations (batch termination, database scans, archival) are implemented as Temporal workflows. This is dogfooding at the infrastructure level.

**Continue-As-New** — To prevent Event History from growing unbounded (hard limit: 50K events per workflow), workflows can terminate themselves and restart with a fresh history, passing accumulated state forward.

**Versioning** — `workflow.getVersion()` and Task Queue based versioning allow workflow code to evolve without breaking in-flight executions.

**Multi-Cluster Replication** — Asynchronous replication across clusters with active-passive failover. A total meltdown of one cluster doesn't lose workflow state.

### What Commander Can Steal

1. **Transactional outbox** for state + outgoing messages (currently absent)
2. **Continue-As-New** pattern for long-running workflows
3. **Versioning** strategy before adding more workflow features

---

## B. AWS Step Functions / SWF — Declarative State Machines

**Sources**:
- [AWS Step Functions Docs](https://docs.aws.amazon.com/step-functions/latest/dg/welcome.html)
- [AWS Prescriptive Guidance: Serverless Saga](https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/implement-the-serverless-saga-pattern-with-aws-step-functions.html)

### Key Concepts

**Amazon States Language (ASL)** — JSON-based declarative state machine:

```json
{
  "Comment": "Order fulfillment saga",
  "StartAt": "CreateOrder",
  "States": {
    "CreateOrder": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:us-east-1:123:function:create-order",
      "Retry": [{
        "ErrorEquals": ["States.TaskFailed"],
        "IntervalSeconds": 2,
        "MaxAttempts": 3,
        "BackoffRate": 2.0
      }],
      "Catch": [{
        "ErrorEquals": ["States.ALL"],
        "Next": "FailOrder"
      }],
      "Next": "ChargePayment"
    },
    "ChargePayment": { ... },
    "FailOrder": {
      "Type": "Compensate",
      "Compensation": ["CancelOrder", "RefundPayment"]
    }
  }
}
```

**Three Levels of Service Integration**:

| Pattern | Behavior | Use Case |
|---------|----------|----------|
| **Request Response** | Fire-and-forget HTTP | Public API calls |
| **Run a Job (.sync)** | Poll until completion | Async jobs with known completion |
| **Wait for Callback (.waitForTaskToken)** | Pause, return token, resume on external POST | Human-in-loop, slow external systems |

**Standard vs Express Workflows**:
- **Standard**: Exactly-once, full audit history, 1-year max, ~$0.000025/transition
- **Express**: At-least-once, CloudWatch logs only, 5-min max, ~$0.000001/execution

Same language, different guarantees. Commander could use a similar split: long-running agent tasks (Standard) vs. short tool calls (Express).

### What Commander Can Steal

1. **Per-state Retry/Catch** is already implemented via `stepErrorBoundary.ts`. Could be extended with `BackoffRate` (exponential growth factor).
2. **`.waitForTaskToken`** pattern for human-in-the-loop — Commander has `agentInbox` but no formal "callback token" pattern.

---

## C. Stripe Idempotency — The Gold Standard

**Sources**:
- [Stripe API: Idempotent Requests](https://docs.stripe.com/api/idempotent_requests)
- [Stripe Blog: "Designing robust and predictable APIs with idempotency"](https://stripe.com/blog/idempotency)

### Design Choices

1. **Result cached AFTER execution begins**, not on receipt. Validation failures don't get cached. This means retrying a bad request will still fail validation.

2. **24-hour TTL on keys**. Bounds storage while covering all practical retry windows.

3. **Parameter matching**: If a key is reused with **different** request parameters, reject. Prevents accidental misuse.

4. **Stripe-Constructed Idempotency in SDK**: The Stripe Ruby library auto-retries with idempotency keys using exponential backoff + jitter. The entire retry stack is invisible to the application developer.

5. **Idempotency key MUST be unique per request**: Recommended `UUID v4` or `UUID v7` (time-sortable).

### What Commander Can Steal

1. **Parameter matching in idempotency check** — currently `generateIdempotencyKey()` uses SHA256 hash of all args, so equivalent args always match. But what if the LLM retries with slightly different whitespace? Currently they'd be different keys. Stripe's approach: hash canonicalized form, then check parameter equivalence.
2. **Idempotency-Key header pattern** — make `Idempotency-Key` a first-class concept in tool calls.

---

## D. Amazon Builders' Library — Hard-Won Lessons

**Sources**:
- [Amazon Builders' Library: Timeouts, retries and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
- [Amazon Builders' Library: Avoiding fallback in distributed systems](https://aws.amazon.com/builders-library/avoiding-fallback-in-distributed-systems/)

### The Cache-DB Fallback Disaster (2001)

Amazon's fulfillment system used a cache as a "fallback" when the database was slow. The cache was never tested at scale because it was only active during DB failures. When the DB actually failed, the cache couldn't handle the load, and the system collapsed.

**The lesson**: A fallback path is a second system that fails at the worst possible moment. Don't build fallbacks; make the primary bulletproof.

### Token Bucket vs Circuit Breaker

Amazon's stance: **Token bucket throttling > Circuit breakers** because:
1. Circuit breakers introduce bimodal behavior (works perfectly or doesn't work)
2. The "half-open" state is hard to test
3. Token buckets give smoother degradation

### Exponential Backoff with Jitter

The formula: `delay = min(cap, base * 2^attempt) * random(0, 1)`

The "full jitter" variant: `delay = random(0, min(cap, base * 2^attempt))`

**Why jitter prevents thundering herd**: If 10,000 clients all retry at second 1, then second 2, then second 4 (without jitter), they synchronize. With jitter, they spread out.

### Consistent Jitter (Underrated Trick)

When adding jitter to **periodic scheduled work** (not retries), use a **deterministic hash** of the host identity, not `Math.random()`. This ensures reproducible patterns: if a race condition happens, it happens the same way every time, making it debuggable.

### Timeout from Latency Percentiles

Set timeouts based on p99.9 of downstream latency, plus padding for connection establishment. This gives a 0.1% acceptable false-timeout rate.

### Share Fate

If a dependency fails, **fail fast** rather than trying a fallback. The calling system has the same failure modes as the dependency — don't pretend otherwise.

### Proactive Retry (Hedging)

Instead of waiting for a timeout, send multiple parallel requests and use the first response. This is inherent in quorum systems. The key insight: always-on redundancy is better than reactive retry.

---

## E. Netflix Conductor — Workflows as Data

**Source**: [Netflix Conductor Docs](https://netflix.github.io/conductor/)

### Key Concepts

**JSON Workflow Definitions as API Contracts** — Workflows are versioned via API. This makes workflows "data" rather than "code" — they can be modified without deployment.

**Built-in Task Types**:
- Switch (conditional branching)
- Fork/Join (parallel)
- Sub-workflow
- Dynamic Fork (runtime-determined parallel)
- Wait (timer)
- HTTP (outbound call)
- Inline compensation with `compensationTasks` field

**Task Domains** — Tasks are assigned to domains (queues) to isolate priorities. Each domain has its own worker pool.

**Inline Compensation** — Each task can specify compensation tasks:

```json
{
  "name": "charge_payment",
  "taskReferenceName": "charge",
  "compensationTasks": [{"taskReferenceName": "refund_charge"}]
}
```

On failure, Conductor runs compensation tasks in **reverse order** automatically. This is the closest to Commander's `compensationRegistry` of any system.

### What Commander Can Steal

1. **JSON workflow definitions** — Commander's DAG (`src/ultimate/topologyRouter.ts`) is currently TS code. A JSON DSL could enable runtime modification.

---

## F. Argo Workflows — Kubernetes-Native DAGs

**Source**: [Argo Workflows](https://argoproj.github.io/argo-workflows/)

### Key Concepts

**DAG as First-Class Topology** — Workflows are defined as directed acyclic graphs at the template level. Dependencies are explicit (`dependencies: [step1, step2]`), not implicit sequencing.

**Template Reusability** — Templates can be composed; a workflow can reference another workflow as a template. This creates a reusable library of workflow patterns.

**Artifact Passing** — Steps pass data via S3/GCS artifacts (not just in-memory). The execution engine handles upload/download automatically, enabling large-data workflows.

**Suspend/Resume with Cron** — Workflows can be suspended at approval gates and resumed via `resume` API. Combined with cron triggers, this enables scheduled human-in-the-loop flows.

---

## G. Azure Durable Functions

**Source**: [Azure Durable Functions](https://docs.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-overview)

### Key Concepts

**Orchestrator Function Constraints** — Orchestrator functions are replayed from history. They must be **deterministic**:
- No I/O
- No `DateTime.Now` (use `CurrentUtcDateTime`)
- No `Guid.NewGuid()` (use `NewGuid()`)
- No `Task.Run` (use `CallActivityAsync`)

The Durable Task Framework enforces these constraints by recording all decisions in the history.

**Fan-Out/Fan-In as Native Primitives**:
- `CallActivityAsync` (single call)
- `CallActivityWithRetryAsync` (retry policy)
- `FanOutFanIn` (parallel → collect)

**Eternal Orchestrations** — `ContinueAsNew` — self-terminating and restarting with a fresh history (same pattern as Temporal's Continue-As-New).

**Durable Entities** — Stateful actors with CRUD operations, backed by the same event sourcing as orchestrations. The "entity pattern" — a persistent object with a well-defined lifecycle.

---

## H. Google Cloud Workflows

**Source**: [Google Cloud Workflows](https://cloud.google.com/workflows/docs)

### Key Concepts

**`http.get` with Automatic Retry** — Steps can call any HTTP endpoint with built-in retry policies (exponential backoff, max retries, timeout). No SDK needed — works with any REST API.

**Parallel Branching with `parallel` Step** — Execute multiple branches concurrently, wait for all to complete, collect results.

**Step-Level Execution Logs** — Each step's input/output is logged in the execution history, enabling exact replay debugging.

**Custom Callback with `callbacks`** — HTTP callbacks enable human-in-the-loop patterns — the workflow pauses, sends a callback URL, and resumes when the external system POSTs to it.

---

## I. LLM Agent Failure Modes — Research Summary

**Sources**:
- [PALADIN](https://arxiv.org/abs/2509.25238)
- [Reflexion](https://arxiv.org/abs/2303.11381)
- [SelfCheckGPT](https://arxiv.org/abs/2303.08896)
- [Anthropic: Effective Harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Redis: Why Multi-Agent LLM Systems Fail](https://redis.io/blog/why-multi-agent-llm-systems-fail/)

### Failure Mode Catalog (10 modes)

| # | Mode | Detection | Mitigation |
|---|------|-----------|------------|
| 1 | LLM hallucinates tool call | Schema validation, internal rep classifier | Repair + feedback + retry (PALADIN: 89.68% recovery) |
| 2 | LLM hallucinates answer | Multi-sample consistency, NLI classifier | Reflexion: verbal self-correction |
| 3 | Stuck in retry loop | Cycle detection (exact/alternating/drift) | Hard cap on retries + cost |
| 4 | 10+ min step | Wall clock timeout | AbortController + fallback response |
| 5 | Inconsistent sub-agent state | Cross-agent consistency check | Verifier agent + sync points |
| 6 | Tool contradiction | Cross-tool semantic field comparison | Surface to LLM with resolution prompt |
| 7 | Wrong tool arguments | Schema validation | Repair + structured feedback |
| 8 | Sub-agent infinite loop | Step counter + cost + wall clock | Hard kill at limits |
| 9 | LLM API down | HTTP error classification | Multi-provider fallback chain |
| 10 | Malformed JSON | Parse attempt → repair attempt | Retry with stricter prompt |

### Real-World Production Costs

- **$200 overnight burn**: User hit recursive loop in default LangChain config (recursion limit 9999)
- **$12,000 compute cost**: 47,000 failed API calls over a weekend from retry loop
- **211 looping runs**: First user query with default settings hit LangChain recursion limit

### Production Defenses

| Defense | Source | Effectiveness |
|---------|--------|---------------|
| SelfCheckGPT | [arXiv 2303.08896](https://arxiv.org/abs/2303.08896) | 90%+ hallucination detection |
| Reflexion | [arXiv 2303.11381](https://arxiv.org/abs/2303.11381) | 91% pass@1 on HumanEval (vs GPT-4 baseline 80%) |
| PALADIN | [arXiv 2509.25238](https://arxiv.org/abs/2509.25238) | 89.68% recovery rate (vs 23.75% baseline) |
| Anthropic Harness Design | [Anthropic Engineering](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | Hard timeouts + structured progress |
| AgentGuard | [GitHub: agentguard-llm](https://github.com/bluedone/agent-guard-rail-python) | Circuit breaker + idempotency + loop detection |

---

## J. TypeScript Code Patterns

### Pattern: Step Timeout with AbortController

```typescript
class StepTimeoutManager {
  private abortController = new AbortController();
  
  async executeWithTimeout<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    fallback: T
  ): Promise<T> {
    const timer = setTimeout(() => {
      this.abortController.abort(new Error(`Step timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    
    try {
      return await Promise.race([
        fn(this.abortController.signal),
        new Promise<never>((_, reject) => {
          this.abortController.signal.addEventListener('abort', () => {
            reject(new StepTimeoutError(`Step exceeded ${timeoutMs}ms`));
          });
        }),
      ]);
    } catch (err) {
      if (err instanceof StepTimeoutError) return fallback;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
```

### Pattern: Provider Fallback Chain

```typescript
class FallbackChain {
  private providers: ProviderConfig[];
  private breakers: Map<string, CircuitBreaker>;
  
  async call(prompt: LLMRequest): Promise<LLMResponse> {
    const tried: string[] = [];
    const errors: Error[] = [];
    
    for (const provider of [this.primary, ...this.fallbacks]) {
      tried.push(provider);
      const breaker = this.breakers.get(provider);
      if (breaker && !breaker.isAvailable()) {
        errors.push(new Error(`${provider}: circuit open`));
        continue;
      }
      
      try {
        const result = await this.callProvider(provider, prompt);
        breaker?.onSuccess();
        return { ...result, provider, tried, fellBackFrom: tried[0] !== this.primary };
      } catch (err) {
        breaker?.onFailure();
        errors.push(err as Error);
      }
    }
    
    throw new AllProvidersExhaustedError(errors);
  }
}
```

### Pattern: Reflexion Self-Correction

```typescript
async function reflexionLoop(
  task: string,
  verify: (output: string) => Promise<VerificationResult>,
  maxIterations = 2
): Promise<{ output: string; iterations: number; confidence: number }> {
  const reflections: string[] = [];
  let output = '';
  
  for (let i = 0; i < maxIterations; i++) {
    output = await callLLM([{ role: 'user', content: task }, ...reflections.map(r => ({
      role: 'system', content: `Previous reflection: ${r}`
    }))]);
    
    const result = await verify(output);
    if (result.recommendation === 'pass') {
      return { output, iterations: i + 1, confidence: result.confidence };
    }
    
    // Self-critique
    const reflection = await callLLM([{
      role: 'user', content: `Analyze what was wrong with: "${output}". Verification said: ${result.reason}`
    }]);
    reflections.push(reflection);
  }
  
  return { output, iterations: maxIterations, confidence: 0.3 };
}
```

### Pattern: Idempotency Key Validation (Stripe-style)

```typescript
class IdempotencyLayer {
  async execute<T>(
    key: string,
    params: Record<string, unknown>,
    fn: () => Promise<T>
  ): Promise<T> {
    const stored = await this.store.get(key);
    
    if (stored) {
      // Reject if params don't match
      if (!deepEqual(stored.params, params)) {
        throw new IdempotencyKeyReusedError(key);
      }
      // Return cached result
      return stored.result;
    }
    
    // Execute and cache
    const result = await fn();
    await this.store.set(key, { params, result, expiresAt: Date.now() + 24 * 3600 * 1000 });
    return result;
  }
}
```

### Pattern: Sub-Agent Lifetime Guard

```typescript
class SubAgentGuard {
  private stepCount = 0;
  private tokenUsage = 0;
  private costUsd = 0;
  private startTime = Date.now();
  private lastProgress = 0;
  private noProgressCount = 0;
  
  constructor(private limits: { maxSteps: number; maxTokens: number; maxWallClockMs: number; maxCostUsd: number; noProgressSteps: number }) {}
  
  check(progressMetric: number): 'continue' | 'warn' | 'stop' {
    this.stepCount++;
    const elapsed = Date.now() - this.startTime;
    
    if (this.stepCount >= this.limits.maxSteps) return 'stop';
    if (this.tokenUsage >= this.limits.maxTokens) return 'stop';
    if (elapsed >= this.limits.maxWallClockMs) return 'stop';
    if (this.costUsd >= this.limits.maxCostUsd) return 'stop';
    
    if (progressMetric === this.lastProgress) {
      this.noProgressCount++;
      if (this.noProgressCount >= this.limits.noProgressSteps) return 'stop';
    } else {
      this.noProgressCount = 0;
      this.lastProgress = progressMetric;
    }
    
    if (this.stepCount >= this.limits.maxSteps * 0.8) return 'warn';
    if (elapsed >= this.limits.maxWallClockMs * 0.8) return 'warn';
    
    return 'continue';
  }
  
  record(tokens: number, cost: number): void {
    this.tokenUsage += tokens;
    this.costUsd += cost;
  }
}
```

---

## K. The Final List — What to Build

### Tier 1: Cost Explosion Prevention (Build First)

1. **Step-level timeout** with AbortController (1 day)
2. **Sub-agent max steps/tokens/cost** (1 day)
3. **Provider fallback chain** (1 day)
4. **Process-level crash safety** (1 day)
5. **Automatic run recovery from checkpoint** (1.5 days)

### Tier 2: Semantic Error Catching (Build Second)

1. **Reflexion self-correction loop** (2 days)
2. **Validation feedback → LLM retry** (1 day)
3. **Cross-tool contradiction detector** (1.5 days)
4. **Compensation retry queue** (1.5 days)

### Tier 3: Multi-Agent Hardening (Build Third)

1. **Verifier agent pattern** (2 days)
2. **State reconciliation protocol** (1.5 days)
3. **Consensus voting** (2 days)
4. **PALADIN failure exemplar bank** (2 days)

### Tier 4: Observability (Ongoing)

1. **Per-step latency telemetry** (0.5 day)
2. **Failure mode classification in DLQ** (0.5 day)
3. **Loop detection alerts** (0.5 day)
4. **Provider health dashboard** (1 day)
5. **Cost tracking per failure mode** (0.5 day)

**Total: ~21 days of work for full production hardening.**

---

## L. URLs to All Sources

### Production Systems
- Temporal: https://docs.temporal.io/workflows
- Temporal blog: https://temporal.io/blog/workflow-engine-principles
- AWS Step Functions: https://docs.aws.amazon.com/step-functions/latest/dg/welcome.html
- AWS Saga: https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/implement-the-serverless-saga-pattern-with-aws-step-functions.html
- Stripe idempotency: https://docs.stripe.com/api/idempotent_requests
- Stripe blog: https://stripe.com/blog/idempotency
- Amazon Builders' Library: https://aws.amazon.com/builders-library/
- Netflix Conductor: https://netflix.github.io/conductor/
- Azure Durable Functions: https://docs.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-overview
- Google Cloud Workflows: https://cloud.google.com/workflows/docs
- Argo Workflows: https://argoproj.github.io/argo-workflows/
- Google SRE Book: https://sre.google/sre-book/

### LLM Agent Failure Research
- PALADIN: https://arxiv.org/abs/2509.25238
- Reflexion: https://arxiv.org/abs/2303.11381
- SelfCheckGPT: https://arxiv.org/abs/2303.08896
- Internal Representations as Hallucination Indicators: https://arxiv.org/abs/2601.05214
- Anthropic: Effective Harnesses: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Redis: Why Multi-Agent LLM Systems Fail: https://redis.io/blog/why-multi-agent-llm-systems-fail/
- AgentGuard: https://github.com/bluedone/agent-guard-rail-python
- Helicone: https://docs.helicone.ai/
- Portkey Gateway: https://portkey.ai/docs/
- Galileo Luna-2: https://docs.galileo.ai/

### Validation & Repair
- Hermes (Nous Research): https://github.com/NousResearch/hermes
- OpenAI structured outputs: https://platform.openai.com/docs/guides/structured-outputs
- Anthropic tool input schema: https://docs.anthropic.com/en/docs/build-with-claude/tool-use
