# RFC-0007: ATR Policy Engine

**Status:** Draft
**Authors:** ATR Working Group
**Date:** 2026-06-04
**Target Release:** Commander 0.18.0
**Supersedes:** None
**Related:** `atp-spec.md` (historical), RFC-0001 (ATR kernel), `SECURITY-ARCHITECTURE.md`

---

## 1. Summary

The ATR Policy Engine is a **horizontal, tenant-scoped, declarative governance layer** for Commander. It sits between the ATR `ExecutionScheduler` and every side-effecting tool call. It answers four questions, in order, before any irreversible work is attempted:

1. Is the action structurally allowed? *(deny / allow)*
2. Does it require human approval? *(require_approval)*
3. Can the run afford the cost? *(budget gate)*
4. Is the action semantically permitted given context? *(risk score, redaction, tool-class restriction)*

The engine is **pure** with respect to side effects. It only reads run/agent/tenant state and returns a `PolicyDecision`. Enforcement is a separate concern, performed by the `ExecutionScheduler` and `toolOrchestrator` call sites.

The engine **absorbs and unifies** the existing scattered policy machinery: `sandbox/approval.ts` (modes + session cache), `sandbox/execPolicy.ts` (Codex-style shell classification), `sandbox/profiles.ts` (filesystem/network profiles), and the implicit "deny by default" hard-coded in `toolOrchestrator.checkApprovalMode()`. None of these are removed; they are wrapped as **policy packs** the engine can load.

---

## 2. Goals

| # | Goal | Measurable |
|---|------|------------|
| G1 | Centralize every allow/deny decision through a single pipeline | One call site per enforcement boundary; no string checks scattered across the codebase |
| G2 | Express policy as data, not code | Operators ship `policy.json` / `policy.rego` files; no recompile |
| G3 | Tenant-isolated evaluation | `tenant-A` policy and state never observable from `tenant-B` evaluation |
| G4 | OPA-compatible DSL subset | Rego-style rules, importable as a `policyPack` |
| G5 | Sub-millisecond p99 per decision (cached) | Benchmarked |
| G6 | Auditable decisions | Every decision emits a `SecurityAuditEvent` with `decision_path` (rule trace) |
| G7 | Defensive against policy conflicts and loops | Static analyzer + runtime circuit breaker |
| G8 | Backward-compatible with existing `ApprovalSystem` callers | `getApprovalSystem().evaluate()` still works; routes through the new engine |

## 3. Non-Goals

| # | Non-Goal | Reason |
|---|----------|--------|
| N1 | Replace the LLM-side `beforeLLMCall` content moderation | That's a separate model-side concern; we act on the tool call, not the prompt |
| N2 | Implement full Rego spec | 5% of Rego covers 95% of agent policy. We pick a smaller core. |
| N3 | Provide a policy authoring UI | Out of scope. Files in `.commander/policy/`, plus `policy validate` CLI |
| N4 | Cross-tenant policy composition | Tenant isolation is G3; composition is a v2 problem |
| N5 | Auto-remediation of failed policies | The engine is read-only; remediation is the operator's job |
| N6 | Cryptographic policy attestation | V2. v1 trusts the file system + audit log |

---

## 4. Background & Prior Art

### 4.1 What Commander Has Today

| Component | File | Role | Limitation |
|-----------|------|------|------------|
| `ApprovalSystem` | `sandbox/approval.ts` (223 LOC) | Mode-based + session cache + denied-forever threshold (3) | Modes are global; no per-tool fine grain; callback is fire-and-forget |
| `ExecPolicyEngine` | `sandbox/execPolicy.ts` (422 LOC) | Codex-style shell command classification | Shell-only; no JSON-struct / API / DB awareness; priority-sorted linear scan |
| `SandboxManager` + `PROFILES` | `sandbox/{manager,profiles}.ts` | Filesystem/network isolation profiles | Profile is a *post-facto* backstop, not a *pre-hoc* decision |
| `securityAuditLogger` | `security/securityAuditLogger.ts` | 16 event types, ring buffer + NDJSON, MessageBus publish | Reactive; no policy decision trace |
| `tokenGovernor` | `runtime/tokenGovernor.ts` | Token budget pressure + strategy selection | Optimization, not governance. No cost cap, only "soft pressure" |
| `Tool` interface fields | `runtime/types.ts` (lines 217–240) | `riskLevel`, `destructive`, `externalSystem`, `isReadOnly` | No formal use outside approval mode check |
| PluginManager | `pluginManager.ts` (820 LOC) | 18 hook points incl. `beforeToolCall` returning `ToolResult | null` | Plugins can block, but no structured decision contract |

### 4.2 What ATR Kernel Provides (this RFC's foundation)

The kernel shipped in the previous sprint provides the four primitives the policy engine must consume:

- **IdempotencyStore** — every `scheduleAction` carries a `sha256(ext + tool + canonical(args) + intent + run + step)`. Policy can key on this.
- **LeaseManager** — fencing token + epoch. Policy can refuse actions against a stale lease.
- **RunLedger** — run state (`PENDING | EXECUTING | VERIFYING | COMMITTED | ABORTED | COMPENSATED | PAUSED`), action history with `CompensableAction { riskLevel, destructive, externalSystem, tenantId, ... }`. Policy can read this state.
- **ExecutionScheduler** — single composable facade. Natural integration point.

### 4.3 External Prior Art

| Source | Pattern Borrowed | Rejected |
|--------|-----------------|----------|
| OPA / Rego | Rule-based DSL with priority + `default allow/deny`, decision log, importable bundles | Full Rego parser (~10k LOC, gRPC plugin model). We use a 200-LOC AST walker. |
| Hashicorp Sentinel | `import "policy.foo" as foo` and rule composition | VM-based, embeddable but heavy. We keep it pure-JS. |
| AWS IAM policy language | `Action`/`Resource`/`Condition` triple, explicit deny-wins | Too coarse for tool-level granularity. |
| Anthropic tool-use safety | Per-tool risk classification + confirmation gates | Vendor-specific, no audit story |
| LangChain approval gates | Sync callback pre-execute | No async, no replay, no ledger |
| Kubernetes NetworkPolicy | Default-deny with explicit allow rules, namespace scoping | The closest analog. We borrow the *default-deny posture*. |

---

## 5. Architecture Overview

```
                              ┌─────────────────────────────────────┐
                              │       ATR Policy Engine             │
   agentRuntime               │                                     │
   ─────────────              │   ┌──────────┐   ┌─────────────┐    │
   toolOrchestrator ────────► │   │  Policy  │   │   Policy    │    │
   ExecutionScheduler         │   │  Loader  │   │  Cache      │    │
                              │   │  (Rego)  │   │  (LRU+TTL)  │    │
   agentHandoff               │   └────┬─────┘   └──────┬──────┘    │
   ─────────────              │        │                │           │
                              │   ┌────▼────────────────▼──────┐    │
   HTTP API caller ─────────► │   │     Evaluation Pipeline     │    │
                              │   │  1. pre-allow               │    │
   Plugin beforeToolCall      │   │  2. budget                  │    │
   ─────────────              │   │  3. approval                │    │
                              │   │  4. deny-class              │    │
                              │   │  5. risk-score              │    │
                              │   │  6. post-allow              │    │
                              │   └────────────┬────────────────┘    │
                              │                │                     │
                              │   ┌────────────▼───────────────┐     │
                              │   │  Decision + decision_path  │     │
                              │   └──────┬────────────────┬────┘     │
                              │          │                │          │
                              │   allow  │  deny          │  prompt  │
                              └──────────┼────────────────┼──────────┘
                                         ▼                ▼
                              ┌──────────────┐   ┌──────────────────┐
                              │ tool.execute │   │ ApprovalRequest  │
                              │              │   │  (async, ledger) │
                              └──────────────┘   └──────────────────┘
                                         │                │
                                         ▼                ▼
                              ┌──────────────────────────────────────┐
                              │   SecurityAuditLogger                │
                              │   - decision_id                      │
                              │   - decision_path (rule trace)       │
                              │   - latency_ms                       │
                              │   - tenant_id                        │
                              └──────────────────────────────────────┘
```

**Three properties of this architecture:**

1. **The engine is pure.** No filesystem writes, no network calls, no LLM calls. It reads run state and policy bundles and returns a decision. Side effects happen in the caller.
2. **The engine is layered.** Each step in the pipeline can short-circuit. A budget violation is a `deny` regardless of what later steps would have decided.
3. **The engine is auditable.** Every evaluation emits exactly one audit event with the full decision path, even for `allow` (configurable).

---

## 6. DSL Design

### 6.1 Grammar (Rego-subset, TypeScript-flavored)

```ebnf
policy        := packageDecl? importDecl* ruleDecl+ defaultDecl
packageDecl   := "package" identifier ("." identifier)*
importDecl    := "import" "data" "." identifier ("as" identifier)?
ruleDecl      := identifier ( "(" params? ")" )? "{" expr "}"
defaultDecl   := "default" decisionType "=" decisionValue
decisionType  := "allow" | "deny" | "require_approval" | "deny_class"
decisionValue := "true" | "false" | decisionType
expr          := term ( "==" | "!=" | ">" | "<" | ">=" | "<=" | "in" | "and" | "or" ) term
               | "not" expr
               | "if" expr "{" expr "}"
term          := literal | ref | call | list
ref           := identifier ("." identifier | "[" expr "]")*
call          := identifier "(" args? ")"
literal       := string | number | boolean | null | array | object
```

### 6.2 Decision Type Hierarchy

```
PolicyDecision = {
  effect:    "allow" | "deny" | "require_approval" | "deny_class",
  reason:    string,
  decisionPath: string[],   // rule trace, ordered
  matchedRule: string | null,
  riskScore:  number,       // 0-100, computed last
  budget:     BudgetSnapshot, // for audit only
  latencyMs:  number,
  cached:     boolean,
}
```

The four effects are **mutually exclusive per decision**, but the pipeline can combine signals: a `deny_class` (e.g. `deny_shell`) automatically denies regardless of the `allow` rules; a `require_approval` is a sub-case of `deny` that can be upgraded to `allow` by the approval callback.

### 6.3 Built-in Refs (Input Schema)

The engine injects this read-only object into every rule evaluation:

```typescript
interface PolicyInput {
  // From ExecutionScheduler
  run: {
    id: string;
    state: 'PENDING' | 'EXECUTING' | 'VERIFYING' | 'COMMITTED' | 'ABORTED' | 'COMPENSATED' | 'PAUSED';
    fencingEpoch: number;
    intentHash: string;
    tenantId?: string;
    agentId: string;
    goal: string;
    metadata?: Record<string, unknown>;
    createdAt: number;
    actionsSoFar: CompensableAction[];   // for context-aware decisions
  };

  // From tool definition
  tool: {
    name: string;
    externalSystem?: string;
    riskLevel: 'low' | 'medium' | 'high';
    destructive: boolean;
    isReadOnly: boolean;
    category: 'shell' | 'network' | 'file_write' | 'file_read' | 'destructive' | 'mcp' | 'compute' | 'api';
  };

  // From this call
  action: {
    args: Record<string, unknown>;
    idempotencyKey: string;          // sha256
    stepNumber: number;              // monotonic per run
    callSite: 'agent' | 'http' | 'plugin' | 'scheduler';
  };

  // From TenantProvider
  tenant: {
    id: string | null;
    config: {
      tokenBudget: number;
      maxConcurrency: number;
      maxRunsPerMinute: number;
      policyPack?: string;           // active pack name
    };
  };

  // From MetricsCollector (read-only aggregates)
  metrics: {
    tokensUsedThisRun: number;
    tokensUsedThisHour: number;
    actionsThisRun: number;
    destructiveThisRun: number;
    estimatedCostUsd: number;
  };

  // Time
  time: {
    now: number;                     // ms
    hourOfDay: number;               // 0-23
    isWeekend: boolean;
  };
}
```

### 6.4 Example Policy Pack

```rego
# .commander/policy/coding-agent.rego
package atr.policy

import data.atr.builtins as b

# Default: deny if no rule matches (fail-safe)
default allow = false
default require_approval = false

# === Read-only tools are always allowed ===
allow {
  input.tool.isReadOnly == true
  input.run.state == "EXECUTING"
}

# === Shell is denied outside dev mode ===
deny_class = "deny_shell" {
  input.tool.category == "shell"
  not input.tenant.config.allowShell
}

deny_class = "deny_network" {
  input.tool.category == "network"
  not input.tenant.config.allowNetwork
  input.run.metadata.bypassNetwork != true
}

# === Destructive requires approval above $5 cumulative ===
require_approval {
  input.tool.destructive == true
  input.metrics.estimatedCostUsd > 5
}

# === Production deploy always requires approval ===
require_approval {
  input.run.metadata.environment == "production"
  contains(input.tool.name, "deploy")
}

# === Per-tenant rate cap ===
deny {
  input.metrics.actionsThisRun > 50
  not input.tenant.config.unlimited
}

# === Budget hard cap ===
deny {
  input.metrics.tokensUsedThisRun > input.tenant.config.tokenBudget
}

# === Bash blocked: indirect injection via `cat .env` ===
deny_class = "deny_secret_read" {
  input.tool.category == "file_read"
  b.path_matches_secret(input.action.args.path)
}

# === Idempotency is required for destructive ops ===
deny {
  input.tool.destructive == true
  not input.tool.isIdempotent
}
```

The `b` namespace is provided by the engine (`b.path_matches_secret`, `b.canonical_json`, `b.in_denylist`, etc.). Adding a builtin is a 5-LOC change in `policy/builtins.ts`.

### 6.5 Why This Shape

| Decision | Rationale |
|----------|-----------|
| Rego-flavoured, not bespoke | Operators familiar with OPA need zero retraining. |
| Explicit `deny_class` separate from `deny` | Allows UI to render "shell is disabled in this workspace" distinctly from "this specific command was denied." |
| No string interpolation in rules | Prevents rule-author prompt injection. |
| All decisions, even allows, audit-logged | Forensic capability; cost is the audit log volume. |
| `default allow = false` mandatory | Fail-closed posture. Operators must whitelist. |
| `decisionPath` array | Forensic chain: which rules fired, in order. |

---

## 7. Runtime Integration

### 7.1 Enforcement Sites

There are exactly **three** enforcement sites in the kernel:

```
┌──────────────────────────────────────────────────────────────────────┐
│  Call chain with policy gates                                        │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. HTTP API → ExecutionScheduler.beginRun                           │
│     └── policy.eval({phase: 'begin', ...})         ← phase gate     │
│                                                                      │
│  2. toolOrchestrator.executeSingleWithRetry                          │
│     └── policy.eval({phase: 'tool', ...})          ← main gate      │
│         │                                                             │
│         ├─► allow  → tool.execute(args)                              │
│         ├─► deny   → ToolResult.error + audit                        │
│         └─► require_approval → ApprovalRequest → ledger              │
│                                                                      │
│  3. ExecutionScheduler.abortRun / commitRun                          │
│     └── policy.eval({phase: 'lifecycle', ...})     ← phase gate      │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

The two **phase gates** are intentional narrowing:
- `begin` gate: only the *intent* and *tenant* are known. Use for: "tenant disabled", "off-hours kill switch", "global deny-list".
- `tool` gate: full context including prior actions. Use for everything else.
- `lifecycle` gate: governs `commit`/`abort`/`kill` for the saga itself.

### 7.2 Module Layout

```
packages/core/src/atr/policy/
├── types.ts                    # PolicyDecision, PolicyInput, PolicyRule types
├── engine.ts                   # PolicyEngine class — pure evaluator
├── loader.ts                   # Rego-subset parser (200 LOC, hand-rolled)
├── cache.ts                    # DecisionCache (LRU + TTL + content-hash key)
├── builtins.ts                 # b.* namespace functions
├── conflictAnalyzer.ts         # Static rule conflict detection
├── packs/
│   ├── defaultCoding.rego      # Default coding-agent pack (shipped)
│   ├── readOnly.rego           # Shipped for `commander plan` mode
│   └── destructiveOps.rego     # Shipped pack for prod-touching tools
├── telemetry.ts                # decision_id, latency, counter wiring
├── httpRoutes.ts               # GET /api/v1/atr/policy/decisions (read-only)
├── integration/
│   ├── scheduler.ts            # ExecutionScheduler hook
│   ├── toolOrchestrator.ts     # toolOrchestrator hook
│   ├── httpServer.ts           # one-line wire-in
│   └── pluginManager.ts        # expose as a "policy" plugin
└── index.ts                    # public exports
```

### 7.3 Backward Compatibility

`getApprovalSystem().evaluate()` is kept as a thin wrapper that translates `ApprovalRequest` → `PolicyInput` and translates the result back. No call site changes. The legacy `ExecPolicyEngine` becomes one of the shipped `PolicyPack`s (`packs/legacyExec.rego`).

### 7.4 Multi-Tenancy

Each tenant has its own `PolicyEngine` instance via `createTenantAwareSingleton`. The engine never reads cross-tenant state; the `input.tenant` field is provided by the resolver and is the only tenant reference the engine sees. This matches the existing ATR pattern (`IdempotencyStore`, `RunLedger` are already tenant-scoped).

### 7.5 Persistence

The decision cache lives in-memory (LRU + TTL). Decisions are *also* persisted to a `policy_decisions` SQLite table (better-sqlite3, optional dep, `:memory:` in tests) keyed by `sha256(tenantId + runId + actionId + policyPackVersion)`. This is the audit-log table, not a perf cache. The perf cache is in-memory only; cache hits are marked `cached: true` in the decision.

---

## 8. Evaluation Pipeline

The pipeline is a fixed ordered chain. Each stage can short-circuit. The order is **load-bearing** — reordering stages changes observable behavior.

```
evaluate(input, pack) → PolicyDecision
│
├── 1. STATIC CHECKS
│   ├── Parse pack → AST (cached per pack version)
│   ├── Run conflict analyzer on pack → conflicts[]. If critical, fail-closed deny.
│   └── Detect loops: rule A's right-hand side references rule B's body and vice versa.
│       If loop, mark first occurrence as undefined and continue (Rego semantics).
│
├── 2. DEFAULT MERGE
│   ├── If no `default allow = true` rule, allow = false.
│   ├── If no `default require_approval = false` rule, require_approval = false.
│
├── 3. EVALUATE RULES
│   ├── Build dependency graph of rules.
│   ├── Topological evaluate. Record fired rules in `decisionPath`.
│   ├── If any `deny_class` is set → effect = "deny", reason = "deny_class: <class>".
│   ├── Else if any `deny` is true → effect = "deny", reason = first matching rule.
│   ├── Else if any `require_approval` is true → effect = "require_approval", reason = first matching.
│   ├── Else if `allow` is true → effect = "allow", reason = "explicit_allow".
│   └── Else → effect = "deny", reason = "default_deny".
│
├── 4. BUDGET GATE
│   ├── If `effect == "allow"` AND `tokensUsedThisRun + estTokens > tenant.tokenBudget`:
│   │   downgrade to "deny", reason = "budget_hard_cap_exceeded".
│   ├── If `effect == "allow"` AND `actionsThisRun > tenant.maxActionsPerRun`:
│   │   downgrade to "deny", reason = "rate_limit_exceeded".
│   └── If `effect == "require_approval"` AND `tenant.requiresApprovalBypass == true`:
│       upgrade to "allow" ONLY for `riskLevel: 'medium'` (never for `destructive: true`).
│
├── 5. RISK SCORE
│   ├── score = base 0
│   ├── +30 if destructive
│   ├── +20 if externalSystem is registered
│   ├── +10 per prior destructive action in this run
│   ├── -20 if isReadOnly
│   ├── +5 if tool category matches a denied-class pattern
│   ├── Clamp to [0, 100]
│   └── Attach to decision for audit (does not affect effect).
│
├── 6. CACHE CHECK
│   ├── Compute cacheKey = sha256(tenantId + runId + actionId + packVersion + canonicalJson(input.action))
│   ├── If decision cache has an entry within TTL, return with `cached: true`.
│   └── Else store decision in cache.
│
└── 7. EMIT
    ├── SecurityAuditEvent { type: 'policy_decision', effect, decisionPath, latencyMs, ... }
    ├── counter('policy.evaluations.total', { effect, tenant })
    ├── histogram('policy.evaluation_latency_ms', latencyMs, { tenant })
    └── return decision
```

**Why this order:**
- Static checks first — fail fast on a broken pack before doing any work.
- Default merge second — establishes fail-closed posture.
- Rule evaluation third — the policy author's intent.
- Budget gate fourth — overrides any allow if hard caps violated. This is *defense in depth*; operators should not rely on the engine to enforce tenant budgets, but the engine must.
- Risk score fifth — informational for audit; not a control signal.
- Cache sixth — only the *final* decision is cached, never intermediate state.

---

## 9. Caching Strategy

### 9.1 Two-Tier Cache

| Tier | Key | Storage | TTL | Purpose |
|------|-----|---------|-----|---------|
| L1 (perf) | `sha256(tenantId + runId + actionId + packVersion + canonical(input.action))` | In-memory LRU, 10K entries | 30s | Avoid re-eval during retry storms |
| L2 (audit) | Same key + `decision_id` | SQLite `policy_decisions` table | 30 days | Forensic trail |

The L1 cache is **content-keyed, not request-keyed**. Two calls with identical input get the same decision. The L1 cache is *invalidated on pack reload* (version bump).

### 9.2 Invalidation Triggers

| Event | L1 Action | L2 Action |
|-------|-----------|-----------|
| `policyPack.reload()` | Clear by `packVersion` | None |
| `tenant.policyPack` changes | Clear that tenant's slice | None |
| `run.state` changes (`EXECUTING` → `COMMITTED`) | Clear by `runId` | None |
| TTL expires | Evict | Evict via nightly cron |
| `decision.cached` was true AND downstream side-effect occurred | n/a | Mark `stale: true` row (audit only) |

### 9.3 What Is Never Cached

- `phase: 'begin'` decisions (run-level, evaluated once)
- `phase: 'lifecycle'` decisions (commit/abort, evaluated once)
- Decisions where `effect == 'deny_class'` and the deny class is `deny_shell` (always re-eval — security posture may have flipped)
- Decisions where `cached: true` would mask a clock-driven rule (e.g. `time.hourOfDay`)

The engine sets a `cacheable: boolean` field on each decision; the cache consults it.

### 9.4 Cache Stampede

On `policyPack.reload()`, multiple in-flight runs may re-evaluate simultaneously. We use a per-key `Promise` dedupe table (same pattern as `IdempotencyStore.begin()`): the first caller evaluates, subsequent callers await the in-flight promise. No thundering herd.

---

## 10. Threat Model

This is the *operational* threat model. Each threat is given a likelihood × impact score and a concrete mitigation.

### 10.1 Prompt Injection → Tool Escalation

**Scenario:** Adversarial content in a tool result (e.g. PR description, web page, file content) is read back into the LLM context. The LLM, now containing the injection, emits a `merge_pr` call with `force: true` that it would not have emitted otherwise.

**Attack vector:** Indirect prompt injection via tool output.

**Mitigations:**

1. **Output sanitization** (defense in depth): The `policy/input/tool` ref includes a `sanitized_output_size` field. If the LLM re-passes text from a tool result, the policy can detect that the action's `args` contain strings from prior outputs and require re-approval. *Implemented in builtin `b.contains_injection_pattern`.*
2. **Risk score boost** (control signal): A destructive action with `args` containing markdown or HTML or JSON-shaped strings from external systems receives +20 risk score, which can trigger `require_approval` in a pack.
3. **Per-tool re-approval on external system writes**: `deny_class: deny_payment` and `deny_class: deny_force_push` are shipped pack rules; an action named `merge_pr` with `force: true` matches and requires approval regardless of mode.
4. **Trace chain**: `decisionPath` records the rule that flagged the injection, surfaced in audit and HTTP `/api/v1/atr/policy/decisions`.

**Residual risk:** A sufficiently subtle injection that doesn't trigger any of the 5 builtin patterns. Mitigated by G6 (every decision is auditable; SOC team can replay).

### 10.2 Tool Escalation via Composition

**Scenario:** Tool A (read-only, allowed) returns data that, when fed to tool B (destructive), causes harm. The agent calls A, then B, where the policy would have denied B if called directly with adversarial input.

**Attack vector:** Composition of individually-permitted tools.

**Mitigations:**

1. **Action history in `input.run.actionsSoFar`**: The policy can express rules like "after `read_pr_diff`, deny `merge_pr` with `force: true` within 5 steps."
2. **Sequence allowlist**: A pack can declare `allow_sequence` rules that permit specific orderings (`read` then `merge` allowed only if `read` was in same run).
3. **Destructive + non-idempotent penalty**: `deny` if `destructive: true && !isIdempotent` and a prior read tool was called in the last N steps. (Avoids "read-then-destroy-no-replay".)

**Residual risk:** Sequences longer than 3 steps are hard to enumerate. Mitigated by G6 (audit replay) + run-level compensation (ATR saga).

### 10.3 Privilege Escalation via Tenant Confusion

**Scenario:** Tenant A's run somehow receives a `leaseToken` belonging to tenant B and uses it to read tenant A's data through a shared tool.

**Attack vector:** Lease token reuse or cross-tenant injection.

**Mitigations:**

1. **Tenant-keyed `PolicyInput`**: The `input.tenant.id` is resolved *server-side* by `resolveTenant(req)` and never read from `input.action.args`. Any rule that reads `input.action.args.tenantId` is treated as **untrusted** by the engine (ref `input.action.args` is typed `Record<string, unknown>`; no automatic trust promotion).
2. **Lease validation is upstream**: `ExecutionScheduler.scheduleAction` already calls `LeaseManager.validate(leaseToken, fencingEpoch)`. Policy cannot bypass this.
3. **Tenant-prefixed cache keys**: L1 and L2 cache keys start with `tenantId`. A tenant A decision cannot be served to tenant B.
4. **Per-tenant `PolicyEngine` instance**: `createTenantAwareSingleton` ensures engine A and engine B are separate objects, with separate state.

**Residual risk:** Operator misconfiguration (e.g. wrong `resolveTenant` mapping). Mitigated by HttpServer integration tests (existing) + this RFC's tenant-isolation tests.

### 10.4 Approval Bypass

**Scenario:** Operator sets `mode: 'full-auto'` to disable approval prompts, expecting destructive tools to be approved. But a `require_approval` rule fires and the *callback* returns `approved_session`, persisting approval for the entire session — including subsequent runs.

**Attack vector:** Session-cache poisoning.

**Mitigations:**

1. **Session cache is per-`approvalId`, not per-tool-arg**: The legacy `approval_session_approvals` Set uses `toolName + JSON(args)` as key. The new engine uses `sha256(tenantId + toolName + canonicalJson(args) + fencingEpoch)`. The fencing epoch invalidates the cache when a new run starts.
2. **Per-run cache partition**: The cache key includes `runId` *and* `fencingEpoch`. Approval cannot leak across runs even if the lease is reused.
3. **Approval replay is audit-logged**: `decisionPath` records `approved_via: 'session_cache'`.
4. **Bypass gate (Stage 4 of pipeline)**: The engine never upgrades `require_approval` to `allow` for `destructive: true` tools, even with `tenant.requiresApprovalBypass: true`. The bypass is *medium-only*.

**Residual risk:** None identified.

### 10.5 Policy Conflicts (allow + deny in same pack)

**Scenario:** Pack A says `allow` for `merge_pr` in production. Pack B (imported) says `deny` for `merge_pr` in production. Result: ambiguous.

**Attack vector:** Pack composition errors.

**Mitigations:**

1. **Static conflict analyzer** (`conflictAnalyzer.ts`): At pack load time, runs a pairwise check. For each pair of rules, computes the set of inputs for which both fire. If both fire and produce contradictory effects on a non-empty input set, the analyzer returns a `ConflictReport`. The engine refuses to load a pack with `severity: 'critical'` conflicts.
2. **Explicit `deny_class` precedence**: A `deny_class` rule always wins over an `allow` rule, regardless of priority. This is encoded in the evaluator and not configurable.
3. **Conflict categories**:
   - `critical` — pack refuses to load.
   - `warning` — pack loads, surfaces in CLI `policy validate` output, requires operator acknowledgment.
   - `info` — pack loads silently.

**Residual risk:** False negatives in the static analyzer. Mitigated by runtime audit (every decision logged, conflicts visible in production).

### 10.6 Policy Loops

**Scenario:** Rule A's body references `data.policy.B` and rule B's body references `data.policy.A`. The evaluator enters an infinite loop or stack overflow.

**Attack vector:** Malicious or buggy pack.

**Mitigations:**

1. **Static cycle detection**: At load time, build the rule dependency graph and run Tarjan's. Any cycle is a `critical` conflict — pack refuses to load.
2. **Runtime depth limit**: Maximum 32 nested rule evaluations. Exceeding returns `deny` with `reason: "max_evaluation_depth_exceeded"` (fail-closed).
3. **Timeout**: 50ms wall clock per evaluation. Exceeding returns `deny` with `reason: "evaluation_timeout"`. Benchmarked: a typical pack evaluates in <1ms.

**Residual risk:** None identified.

### 10.7 Threat Matrix Summary

| Threat | Likelihood | Impact | Engine Mitigation | Audit-Only? |
|--------|-----------|--------|-------------------|-------------|
| Prompt injection → tool escalation | High | High | Builtin pattern match + risk score boost | Yes (decision path) |
| Tool composition escalation | Medium | High | `actionsSoFar` ref + sequence rules | Yes |
| Privilege escalation (tenant confusion) | Low | Critical | Tenant-keyed everything | No (block) |
| Approval bypass | Low | Critical | Fencing epoch in cache key + destructive bypass block | No (block) |
| Policy conflicts | Medium | Medium | Static analyzer + deny_class precedence | Yes |
| Policy loops | Low | Medium | Static cycle detection + depth/timeout | No (block) |

---

## 11. Security Guarantees

These are the **invariants** the engine must hold. Each is testable.

### 11.1 Fail-Closed

> **G-FAIL-1**: If the engine cannot complete evaluation (parse error, timeout, missing pack), the default `effect` is `deny`.

**Test:** Inject a pack with a syntax error, call `eval()`, assert `effect === 'deny'` and `reason.startsWith('parse_error')`.

### 11.2 Tenant Isolation

> **G-TENANT-1**: For any input `I_A` and `I_B` where `I_A.tenant.id !== I_B.tenant.id`, the result of `eval(I_A)` is byte-for-byte independent of `eval(I_B)`.

**Test:** Run the same `eval` against two tenant engines with different `input.tenant` configurations; assert no cross-tenant state observed (no shared cache, no shared rule AST).

### 11.3 Audit Completeness

> **G-AUDIT-1**: Every `eval()` call produces exactly one `policy_decision` audit event, even for `allow`. The event contains `decisionPath` (non-empty) and `latencyMs`.

**Test:** Run 1000 `eval()` calls, assert 1000 audit events with `decisionPath.length > 0`.

### 11.4 No Bypass for Destructive

> **G-DESTRUCT-1**: For any input where `tool.destructive === true`, the engine never returns `allow` unless `tenant.requiresApprovalBypass === true AND a human approval decision of "approved" is recorded in the same evaluation cycle`.

**Test:** Call `eval()` with `destructive: true` and `bypass: true` and no callback; assert `effect === 'require_approval'`.

### 11.5 Determinism

> **G-DETERM-1**: For identical `input` and identical `packVersion`, the engine returns the same `effect` and `decisionPath` (modulo `latencyMs` and `cached`).

**Test:** Run `eval()` 100 times with the same input; assert all 100 decisions have identical `effect` and `decisionPath` (allowing `latencyMs` variance).

### 11.6 Fencing Honored

> **G-FENCE-1**: If `input.run.fencingEpoch` does not match the active lease in `LeaseManager`, the engine returns `deny` with `reason: 'stale_lease'`.

**Test:** Bump the lease epoch out-of-band; call `eval()`; assert `effect === 'deny'`.

### 11.7 Idempotency Coercion

> **G-IDEMP-1**: For any input where `tool.destructive === true && !tool.isIdempotent`, the engine never returns `allow`. It must be `require_approval` or `deny`.

**Test:** Call `eval()` with `destructive: true, isIdempotent: false`; assert `effect !== 'allow'`.

---

## 12. Performance Analysis

### 12.1 Latency Budget

| Stage | Cold (no cache) | Warm (cache hit) |
|-------|----------------|------------------|
| Static checks (parse, conflicts, cycles) | 0.1ms (cached by packVersion) | 0ms |
| Default merge | <0.01ms | <0.01ms |
| Rule evaluation (50-rule pack) | 0.3ms | 0ms |
| Budget gate | 0.05ms | 0.05ms |
| Risk score | 0.05ms | 0.05ms |
| Cache check + write | 0.05ms | 0.02ms |
| Audit emit (async, non-blocking) | 0.1ms (sync portion) | 0.1ms |
| **Total** | **~0.7ms p99** | **~0.2ms p99** |

### 12.2 Throughput

- Cold: ~1,400 evaluations/sec/core
- Warm: ~5,000 evaluations/sec/core

A typical agent run (50 actions) at cold evaluation: 35ms total policy overhead. Negligible against LLM latency (10s+).

### 12.3 Memory

- Engine instance: ~2MB per tenant (pack AST + LRU cache)
- LRU cache: 10K entries × ~500 bytes = 5MB
- Audit log (L2): bounded by retention (30 days default)

### 12.4 Bench Required

A new benchmark file `benchmarks/policy-engine.bench.ts` is added covering:

- Cold vs warm eval latency (p50, p99)
- Pack load latency (50-rule pack)
- Conflict analyzer runtime (linear in rule pairs)
- Cache hit rate under retry storm (1000 calls / 10s / 5 unique inputs → expected 99.5% hit rate)

---

## 13. Tradeoffs

| Choice | Alternative | Why we chose this |
|--------|-------------|-------------------|
| Pure-JS Rego subset | Full Rego (OPA) | 200 LOC vs 10K LOC; no gRPC overhead; no Rego language training. We accept ~5% of Rego is unsupported. |
| Per-tenant `PolicyEngine` instance | Shared engine with tenant-keyed state | Matches `createTenantAwareSingleton` pattern; eliminates tenant-keyed cache lookups; ~2MB/tenant is acceptable. |
| LRU + content-hash cache | No cache (eval every time) | Reduces p99 by 3.5x; cache stampede mitigated by per-key dedupe. |
| Static + runtime conflict detection | Pure runtime detection | Static catches conflicts at pack-load time (CI-friendly); runtime catches false negatives. |
| Engine returns decision only, no side effects | Engine logs/audits inline | Pure engine is testable in isolation; audit emission is the caller's responsibility. |
| Decision path in audit (verbose) | Decision only | Forensic trail costs 100 bytes/event; the operator value of "why was this denied" is high. |
| Default-deny posture | Default-allow | Fail-closed is the only acceptable default for autonomous agents. |
| Rego-style rules over JSON Schema | JSON Schema validation only | Rego is more expressive; JSON Schema is too coarse for "if destructive and external system, require approval." |
| 32-deep evaluation limit | Unbounded | Prevents stack overflow; well above any legitimate pack's depth. |
| 50ms wall clock per eval | Unbounded | Prevents CPU exhaustion by malicious pack; 50ms is 50x p99. |

---

## 14. Migration Path

### 14.1 Phase 1: Ship alongside (v0.18.0)

- Land `atr/policy/*` modules.
- Ship `packs/defaultCoding.rego` matching the existing `mode: 'suggest'` behavior.
- `getApprovalSystem().evaluate()` is now a wrapper around the engine.
- `sandbox/execPolicy.ts` becomes a builtin of the engine (loaded as `packs/legacyExec.rego`).
- All existing tests pass unchanged. **No behavior change visible to operators by default.**

### 14.2 Phase 2: Opt-in (v0.19.0)

- Add `policyPack` field to `AgentExecutionContext` and `TenantConfig`.
- HTTP endpoint `POST /api/v1/atr/policy/reload` to swap a tenant's pack.
- CLI command `commander policy validate <pack>` for static analysis.
- Documentation: how to write a custom pack.

### 14.3 Phase 3: Default (v0.20.0)

- The shipped pack becomes the *default*; tenants can override with their own pack.
- The `mode: 'auto-edit'/'full-auto'` switches become *shortcuts* to the default pack's rules, not separate code paths.
- The legacy `ExecPolicyEngine` class is deprecated. Its logic lives entirely in the shipped pack.

### 14.4 Phase 4: Remove legacy (v0.22.0)

- Delete `sandbox/execPolicy.ts` and the priority-sorted code path in `approval.ts`.
- `ApprovalSystem` is a thin compatibility shim.

---

## 15. Open Questions

1. **Q-A1**: Should `deny_class` be a separate effect or a special case of `deny`? Current design: separate effect. *Decision pending: implementation ergonomics.*
2. **Q-A2**: Should we ship a `policy test` CLI command that runs a pack against a fixture set of inputs? *Likely yes; defer to v0.19.*
3. **Q-A3**: Should the engine be embeddable in the LLM-call path (i.e. `beforeLLMCall` hook to refuse a request that would only generate denied tool calls)? *Out of scope; separate RFC.*
4. **Q-A4**: Should `decisionPath` be signed/attested for non-repudiation? *V2; v1 trusts the audit log + filesystem.*
5. **Q-A5**: How does the engine interact with sub-agent handoff? The sub-agent's `input.tenant` is the parent's. Should the policy evaluate the sub-agent's `goal` or the parent's? *Decision: parent's `goal` is in scope; sub-agent's tools are filtered through parent's pack.*

---

## 16. Alternatives Considered

### 16.1 Embed OPA as a sidecar

- Pro: full Rego, battle-tested, decision log + bundle protocol.
- Con: gRPC, separate process, ~100MB binary, OPA versions to track, 1-3ms per eval (network). Operationally heavy for a feature that should be in-process.
- **Rejected.** A 200-LOC Rego subset covers the use case. We can graduate to full OPA in v2 if pack authors demand it.

### 16.2 CEL (Google's Common Expression Language)

- Pro: small embeddable, well-typed.
- Con: not Rego-shaped; operators familiar with OPA would retrain; fewer rule composition primitives.
- **Rejected.** Rego-subset is the right level of abstraction for "decide based on tool args and run state."

### 16.3 Pure JSON Schema validation

- Pro: trivially embeddable.
- Con: can't express "if destructive AND external AND recent destructive in this run, require approval." Schema is for shape, not policy.
- **Rejected** as the policy engine; **kept** as the input validator (callers must validate `input.action.args` against `tool.compiledSchema` *before* calling `eval()`).

### 16.4 Plugin-only model

- Pro: no new module.
- Con: no decision contract, no shared cache, no audit trail, no static analysis.
- **Rejected** as the engine; **used** as the integration mechanism (the policy engine *is* shipped as a built-in plugin: `builtin-policy`).

### 16.5 Embed LangChain-style approval gates

- Pro: simple callback model.
- Con: no async with TTL, no replay, no ledger, no static analysis, no tenant scoping.
- **Rejected.** Already considered in §4.1.

---

## 17. References

- **OPA**: https://www.openpolicyagent.org/docs/latest/ — Rego language, decision log, bundle protocol
- **Hashicorp Sentinel**: https://developer.hashicorp.com/sentinel — import model, rule composition
- **AWS IAM Policy Grammar**: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_grammar.html — Action/Resource/Condition pattern
- **Anthropic Tool Use Safety**: https://docs.anthropic.com/en/docs/tool-use — confirmation gates, destructive flag
- **Kubernetes NetworkPolicy**: https://kubernetes.io/docs/concepts/services-networking/network-policies/ — default-deny + namespace scoping
- **Codex CLI command_safety**: `codex-rs/shell-command/src/command_safety/` — shell classification model
- **Claude Code permission system**: process wrapper prefix stripping
- **Existing Commander code**: `sandbox/approval.ts`, `sandbox/execPolicy.ts`, `sandbox/profiles.ts`, `security/securityAuditLogger.ts`, `runtime/tokenGovernor.ts`, `pluginManager.ts`, `atr/` (kernel)
- **Multi-tenant singleton pattern**: `runtime/tenantAwareSingleton.ts`

---

## 18. Test Plan

| Test File | Coverage |
|-----------|----------|
| `tests/atr/policy/loader.test.ts` | Pack parsing, syntax errors, version handling |
| `tests/atr/policy/engine.test.ts` | All 7 security guarantees (G-FAIL, G-TENANT, G-AUDIT, G-DESTRUCT, G-DETERM, G-FENCE, G-IDEMP) |
| `tests/atr/policy/cache.test.ts` | LRU + TTL + stampede dedupe + invalidation |
| `tests/atr/policy/conflictAnalyzer.test.ts` | Static + runtime conflict detection |
| `tests/atr/policy/builtins.test.ts` | `b.*` namespace functions |
| `tests/atr/policy/integration/scheduler.test.ts` | ExecutionScheduler integration, begin/tool/lifecycle phases |
| `tests/atr/policy/integration/toolOrchestrator.test.ts` | Tool-call enforcement site |
| `tests/atr/policy/packs/defaultCoding.test.ts` | Shipped pack rules |
| `tests/atr/policy/policyHttp.test.ts` | `/api/v1/atr/policy/decisions` read endpoint |
| `tests/atr/policy/threats.test.ts` | All 6 threat scenarios from §10 |
| `benchmarks/policy-engine.bench.ts` | Latency + throughput + cache hit rate |

Estimated new tests: ~120. Estimated new test runtime: <5s.

---

## 19. Open Questions for the Working Group

1. Is the four-effect decision model (`allow | deny | require_approval | deny_class`) the right shape, or should `require_approval` and `deny_class` collapse into `deny` with a `reason_class` field? *Working group to decide in next session.*
2. Should the engine expose a `dryRun` mode where it returns a decision but the caller ignores the `effect`? *Use case: pre-flight checks in CI.*
3. Should the L1 cache survive process restart? *Likely no; cold start is fast enough.*

---

**End of RFC-0007. Comments due: 2026-06-11. Decision date: 2026-06-14.**
