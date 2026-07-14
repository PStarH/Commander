# Security Gaps Closure — Design Spec (v0.2)

**Date:** 2026-06-29
**Status:** Approved by CTO (v0.2 — incorporates source tiering, default-invariant registration, fast-check governance, and three devil-details defenses)
**Implementation order:** G9 property-test skeleton → G3/G10 Core → G2/G1 built-in plugins

---

## 1. Background & Scope

Six security gaps were previously flagged as "未解决" in the Commander panorama
report. A codebase survey revealed that **most have substantial existing
implementations** that are either unwired (G2) or only partially complete (G3,
G10). This spec closes five of them in a single coordinated change. G6
(kernel-level eBPF/Falco sandbox monitoring) is explicitly out of scope — it
requires native binaries and dedicated SRE ownership and will be tracked as a
separate epic.

### Gap status after this work

| Gap | Form | Rationale |
|-----|------|-----------|
| **G3 A2A server mTLS** | Core change | Add TLS option; zero runtime burden |
| **G10 Memory isolation audit** | Core change | Close bypass paths around existing namespaced store |
| **G2 Taint tracking** | Built-in optional plugin `builtin-taint-tracking` | False-positive risk on legitimate ReAct flows; user opts in |
| **G1 RASP extension detectors** | Built-in optional plugin `builtin-rasp-extensions` | Extra detectors carry noise; user opts in |
| **G9 Formal property tests** | Test-only | Zero runtime burden; `fast-check` devDependency |

### Architecture principle

> **"把铁律写进 Core,把偏见写进 Plugin"** — invariants that must always hold
> live in Core; security controls with tuning bias and false-positive risk live
> behind opt-in plugins. This protects the default developer ReAct workflow
> from "假阳性傲慢".

---

## 2. G3 — A2A Server mTLS (Core)

### 2.1 Current state

- [`a2aServer.ts`](file:///Users/sampan/Documents/GitHub/Commander/packages/core/src/mcp/a2aServer.ts) uses `node:http` `createServer` — no TLS.
- Auth = mandatory bearer `authToken` (≥16 chars, fail-closed in constructor).
- Client-side mTLS **already implemented** in
  [`a2aClient.ts`](file:///Users/sampan/Documents/GitHub/Commander/packages/core/src/mcp/a2aClient.ts)
  L68-112 (`mTLSConfig` builds `https.Agent` with `rejectUnauthorized:true`).
- Server-side TLS closes the loop and mirrors the client's contract.

### 2.2 Changes

**File:** `packages/core/src/mcp/a2aServer.ts`

Add optional `tls` field to `A2AServerConfig`:

```ts
export interface A2AServerConfig {
  // ... existing fields ...
  /** Optional mTLS / TLS configuration. When omitted, server runs plain HTTP
   * (development only; production deployments MUST supply tls). */
  tls?: {
    /** PEM-encoded server certificate (content or file path) */
    cert: string;
    /** PEM-encoded server private key (content or file path) */
    key: string;
    /** PEM-encoded CA bundle for verifying client certificates.
     * Required when requestCert is true. */
    ca?: string;
    /** If true, server requests client certificate (enables mTLS). */
    requestCert: boolean;
    /** If true, rejects clients without a valid verified certificate. */
    rejectUnauthorized: boolean;
  };
}
```

Branch in `start()`:

```ts
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';

async start(): Promise<void> {
  const requestHandler = (req, res) => { /* existing */ };
  if (this.config.tls) {
    // Fail-closed: requestCert=true requires ca
    if (this.config.tls.requestCert && !this.config.tls.ca) {
      throw new Error('A2AServer tls.requestCert=true requires tls.ca for client cert verification.');
    }
    const opts: https.ServerOptions = {
      cert: maybeReadFile(this.config.tls.cert),
      key:  maybeReadFile(this.config.tls.key),
      requestCert: this.config.tls.requestCert,
      rejectUnauthorized: this.config.tls.rejectUnauthorized,
    };
    if (this.config.tls.ca) opts.ca = maybeReadFile(this.config.tls.ca);
    this.server = createHttpsServer(opts, requestHandler);
  } else {
    this.server = createHttpServer(requestHandler);
  }
  // ... existing listen() logic ...
}
```

`maybeReadFile(s)` returns `s` if it looks like PEM content (begins with
`-----BEGIN`), otherwise treats it as a file path and calls `readFileSync`.

### 2.3 Defense-in-depth

Bearer `authToken` remains mandatory alongside mTLS. mTLS authenticates the
transport; authToken authenticates the application-layer agent identity.

### 2.4 Devil detail A — TCP socket reuse & cert revocation

> Node.js only verifies the client certificate during the TLS handshake. Once
> an HTTP Keep-Alive connection is established, certificate revocation (CRL /
> OCSP) does **not** affect the live socket — the client can keep sending
> requests until the socket closes.

**Acceptance:** this is a known limitation. Mitigations:

1. Add a top-of-file comment in `a2aServer.ts`:
   > *本版本 mTLS 吊销实时性受限于长连接生命周期,对高敏感会话请搭配 Header 中的 authToken 联合双验。*
2. Document in `docs/security/keys-rotation.md` that high-sensitivity
   deployments should set `shutdownTimeoutMs` shorter (e.g. 60s) and/or
   disable HTTP Keep-Alive at the reverse-proxy layer.
3. Future hardening (out of scope here): periodic re-handshake via
   `tlsSocket.renegotiate()` or a server-side idle-socket reaper — tracked as
   a follow-up.

### 2.5 Tests

- Unit: mTLS handshake succeeds with valid client cert; fails with no cert
  when `requestCert:true, rejectUnauthorized:true`.
- Integration: `a2aClient.ts` ↔ `a2aServer.ts` full mTLS round-trip using
  `selfsigned`-generated certificates.
- Fail-closed: `requestCert:true` without `ca` → constructor/start throws.
- Backward compat: no `tls` field → plain HTTP server still works.

---

## 3. G10 — Memory Isolation Audit (Core)

### 3.1 Current state

- [`namespacedMemoryStore.ts`](file:///Users/sampan/Documents/GitHub/Commander/apps/api/src/namespacedMemoryStore.ts)
  (apps/api) — full ACL + namespace + TTL system: `MemoryPermission`,
  `ACLEntry`, `NamespaceConfig`, write-audit log.
- [`memoryWriteGuard.ts`](file:///Users/sampan/Documents/GitHub/Commander/packages/core/src/memory/memoryWriteGuard.ts)
  (core) — path-policy enforcement per `agentType`, task-bound scoping.
- [`memorySystem.ts`](file:///Users/sampan/Documents/GitHub/Commander/packages/core/src/memory/memorySystem.ts)
  — `MemorySystem` class with `agentId` field but no enforced namespace
  boundary on writes.
- [`tenantAwareSingleton.ts`](file:///Users/sampan/Documents/GitHub/Commander/packages/core/src/runtime/tenantAwareSingleton.ts)
  — tenant-scoped singleton infrastructure.
- Cross-agent sharing already covered by `differentialPrivacyLayer.ts` and
  `memoryPoisoningDefenseEngine.ts`.

**Gap:** not all memory write paths route through `namespacedMemoryStore` /
`memoryWriteGuard`. A sub-agent can call `MemorySystem.write()` directly,
bypassing namespace confinement.

### 3.2 Changes

#### 3.2.1 Audit pass (research, then patch)

Grep all call sites of:
- `MemorySystem` `.write(` / `.store(` / `.append(`
- `ProjectMemoryStore` `.write(`
- `episodicMemoryStore` `.write(`
- Any direct `fs.writeFile` to a path containing `memory` / `.commander/`

For each call site, verify it either (a) goes through
`namespacedMemoryStore` / `memoryWriteGuard`, or (b) is wrapped in an
`assertNamespaced()` call.

#### 3.2.2 Add `assertNamespaced()` to `MemorySystem`

```ts
class MemorySystem {
  // existing agentId, stores...

  /**
   * Assert that a write target is within the calling agent's namespace.
   * O(1) — pure in-memory string comparison. No async I/O.
   */
  assertNamespaced(
    writerAgentId: string,
    targetPath: string,
    acl?: { role: string; namespaces: string[] },
  ): void {
    // 1. Path must start with the writer's namespace
    const writerNs = `agents/${writerAgentId}`;
    if (targetPath.startsWith(writerNs)) return;

    // 2. Or be explicitly granted by ACL
    if (acl && acl.namespaces.some(ns => targetPath.startsWith(ns))) return;

    // 3. Shared task namespace: tasks/<TID>/... — allowed if same task
    //    (verified by caller passing the task-scoped ACL)
    if (acl && acl.namespaces.includes('tasks') && targetPath.startsWith('tasks/')) return;

    throw new SecurityInvariantViolation(
      `MEMORY-001: agent "${writerAgentId}" attempted to write outside its namespace: ${targetPath}`,
    );
  }
}
```

> **Orchestrator spawn contract (hard requirement):** 编排引擎在衍生
> (spawn) 任何任务受限型子智能体时,其运行时上下文必须默认向 ACL 注入
> 对应的任务命名空间令牌(即 `acl.namespaces` 至少包含 `'tasks'` 或具体
> `tasks/<TID>` 前缀),以防合法 ReAct 流在写下第一行任务日志时被
> `MEMORY-001` 误杀。`ultimate/orchestrator.ts` 等编排入口必须把这一步
> 列为 spawn 流程的强制前置,而不是留给业务层自行决定。

#### 3.2.3 Register `MEMORY-001` as a default invariant

**File:** `packages/core/src/security/securityInvariantVerifier.ts`

Per CTO ruling, `MEMORY-001` goes into `registerDefaultInvariants()` — never
into a separately-invoked registration function. The rationale: any code path
that constructs an `AgentRuntime` directly (custom harness, test script,
future business module) must get memory isolation by default. Forgetting to
call a separate registration function leaves memory isolation naked.

```ts
// In registerDefaultNvariants(), after AGENT invariants:
registerInvariant({
  id: 'MEMORY-001',
  description: 'All memory writes must stay within the writer agent\'s namespace or ACL-granted namespaces',
  domain: 'AGENT',  // reuse AGENT domain — memory is an agent-lifecycle concern
  check: (ctx) => {
    // O(1) — pure memory comparison, never async.
    // Violation is surfaced by assertNamespaced() throwing before this check
    // fires; this invariant is the static guarantee that the guard ran.
    return ctx.memoryWriteNamespaced !== false;
  },
  violationSeverity: 'critical',
});
```

Add field to `InvariantContext`:

```ts
export interface InvariantContext {
  // ... existing ...
  /** Set to false when a memory write was attempted outside the writer's namespace. */
  memoryWriteNamespaced?: boolean;
  /** Writer agent ID (for memory-write invariant checks). */
  writerAgentId?: string;
  /** Target memory path. */
  memoryTargetPath?: string;
}
```

**Performance contract:** the invariant check function is **O(1)** — pure
in-memory string comparison. It must never perform async I/O (no SQLite
lookups, no file reads). The `assertNamespaced()` guard runs first and
throws on violation; the invariant check is the static guarantee that the
guard was invoked.

### 3.3 Tests

- Unit: sub-agent writes to own namespace → allowed.
- Unit: sub-agent writes to main agent namespace → `assertNamespaced()` throws.
- Unit: ACL-granted cross-namespace write → allowed.
- Invariant: `MEMORY-001` violated → `processSecurityAlert({severity:'critical'})` fired.
- Property test (G9): for arbitrary `(writerAgentId, targetPath)` pairs, write
  is allowed iff `targetPath.startsWith(writerNs) || acl.grants(targetPath)`.

---

## 4. G2 — Taint Tracking Plugin `builtin-taint-tracking` (v0.2 — Source Tiering)

### 4.1 Why a plugin, not Core

Wiring taint tracking directly into `agentRuntime.ts` would inject
"假阳性傲慢" into the main engine. The default developer ReAct workflow
frequently mixes tool outputs with outbound calls legitimately; a hard-coded
block would paralyze common patterns. Opt-in plugin lets users who need
strict IFC enable it, while leaving the default engine untouched.

### 4.2 Why NOT arg-level taint (CTO ruling)

LLMs exhibit **认知混合性 (Epistemic Mixing)**. If tool A returns `X="卡号6222"`
and the LLM later generates tool B's argument `msg="把六二二二开头的卡重置"`,
traditional compile-time string taint tracking fails — `X`'s pointer never
flowed into `msg`. Arg-level tracking gives a false sense of security while
missing 100% of LLM-mediated flows.

**Therefore:** track at the **run level**, not the argument level. Use
source tiering to distinguish benign local reads from genuinely dangerous
external data.

### 4.3 Source tiering (v0.2)

Replace the original `hasUntrusted: boolean` with a three-level tier:

```ts
type TaintTier = 'CLEAN' | 'LOCAL_DIRTY' | 'EXTERNAL_DIRTY';
```

| Tier | Triggered by | Outbound behavior |
|------|-------------|-------------------|
| `CLEAN` | Initial state, only trusted system / user input | All tools allowed |
| `LOCAL_DIRTY` | LLM has seen output from internal tools (`code_search`, `file_read`, `list_files`, `index_search`, local DB reads) | Outbound allowed — these are legitimate business flows (e.g. read config → send Feishu message) |
| `EXTERNAL_DIRTY` | LLM has seen output from external tools (`web_search`, `web_fetch`, `http_request`, `a2a_delegate`, `mcp_call` against external servers, email fetch) | **Outbound熔断** — all `riskMetadata.sideEffect === 'external_egress'` tools blocked |

### 4.4 Devil detail B — outbound tool detection cannot be a hardcoded list

A hardcoded `['send_mail', 'slack_post']` array breaks the moment a business
team registers `my_corp_wechat_push` via MCP. The plugin would let it
through.

**Fix (two parts):**

#### 4.4.1 Add `riskMetadata` to `ToolDefinition`

**File:** `packages/core/src/runtime/types/tool.ts`

```ts
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  examples?: Array<{ name: string; arguments: Record<string, unknown> }>;
  category?: string;
  hidden?: boolean;
  /** Side-effect classification for taint tracking and security gates.
   *  - 'none': pure read, no state change
   *  - 'local_state': writes to local filesystem / DB / in-process state
   *  - 'external_egress': sends data to an external system (HTTP, email, webhook, A2A, MCP-egress)
   * Tools that omit this field are treated as 'none' for read-detection and
   * 'local_state' for write-detection (fail-safe default). */
  riskMetadata?: {
    sideEffect: 'none' | 'local_state' | 'external_egress';
  };
}
```

> **Fallback strategy (undefined `riskMetadata`):** 对于第三方 MCP 工具或
> 遗留工具,若 `riskMetadata` 为 `undefined` 且无法通过 `name` 匹配
> fallback 规则(见 §4.5 `isKnownExternalTool`):
> - 涉及读取操作(Read)默认视作 `'none'` —— 不升级 run 的 taint tier;
> - 涉及写入或执行操作(Execute)默认安全视作 `'local_state'` —— 升级到
>   `LOCAL_DIRTY` 但不触发 outbound 熔断,保留 ReAct 流活性。
>
> 这一非对称默认值的目的是:在缺乏自报元数据时,宁可放过潜在的外部读取
> 噪声,也不误杀合法的本地写入链路。真正的外部出口工具必须显式声明
> `external_egress` 才会被熔断机制识别 —— 这迫使工具作者主动标注风险,
> 而不是让框架替他们猜测。

#### 4.4.2 Extend plugin hook contexts with `tool?: Tool`

The current `BeforeToolCallContext` / `AfterToolCallContext` only expose
`toolName`. The plugin needs the full `Tool` reference to read
`definition.riskMetadata`. Extend both interfaces in `pluginManager.ts`:

```ts
export interface BeforeToolCallContext {
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  runId: string;
  /** Full tool reference — available when the call originates from the
   * registered ToolRegistry. Plugins may use this to read definition metadata
   * (riskMetadata, category, etc.). May be undefined for synthetic contexts. */
  tool?: Tool;
}

export interface AfterToolCallContext {
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult;
  agentId: string;
  runId: string;
  /** Full tool reference (see BeforeToolCallContext). */
  tool?: Tool;
}
```

The runtime call sites in `agentRuntime.ts` (L823 `fireBeforeToolCall`,
L829 `fireAfterToolCall`) must pass the resolved `Tool` object. Tools
without `riskMetadata` are treated conservatively (see fallback rules in
§4.5).

### 4.5 Plugin design

**New file:** `packages/core/src/plugins/builtin/taintTrackingPlugin.ts`

```ts
import type { CommanderPlugin, BeforeToolCallContext, AfterToolCallContext, BeforeLLMCallContext } from '../../pluginManager';
import type { LLMRequest } from '../../runtime/types';
import { getGlobalLogger } from '../../logging';
import { getSecurityAuditLogger } from '../../security/securityAuditLogger';

type TaintTier = 'CLEAN' | 'LOCAL_DIRTY' | 'EXTERNAL_DIRTY';

interface RunState {
  tier: TaintTier;
  sources: string[];
  /** Outbound tools explicitly whitelisted by config (override). */
  whitelist: Set<string>;
}

/** Tool names whose outputs are internal/trusted. */
const INTERNAL_TOOLS = new Set([
  'code_search', 'file_read', 'list_files', 'index_search',
]);

export function createTaintTrackingPlugin(): CommanderPlugin {
  const runState = new Map<string, RunState>();
  let blockOnExternalDirty = true;
  // Closure-scoped config — avoids polluting the factory function object.
  let cfgWhitelist: Set<string> = new Set();

  return {
    name: 'builtin-taint-tracking',
    version: '0.1.0',
    description: 'Information flow control via run-level taint tiering (OWASP ASI01)',
    category: 'security',
    configSchema: {
      type: 'object',
      properties: {
        blockOutboundOnExternalDirty: {
          type: 'boolean',
          description: 'Block all external_egress tools once the run has seen EXTERNAL_DIRTY data',
          default: true,
        },
        outboundToolWhitelist: {
          type: 'array',
          items: { type: 'string' },
          description: 'Outbound tools exempt from taint blocking (e.g. allow web_search to chain even after external fetch)',
          default: [],
        },
      },
    },

    onLoad: async (ctx) => {
      blockOnExternalDirty = Boolean(ctx.config.blockOutboundOnExternalDirty);
      const wl = (ctx.config.outboundToolWhitelist ?? []) as string[];
      cfgWhitelist = new Set(wl);
    },
    onUnload: async () => { runState.clear(); cfgWhitelist.clear(); },

    hooks: {
      onAgentStart: ({ runId }) => {
        runState.set(runId, {
          tier: 'CLEAN',
          sources: [],
          // Each run snapshots the current config whitelist.
          whitelist: new Set(cfgWhitelist),
        });
      },
      onAgentComplete: ({ runId }) => { runState.delete(runId); },

      beforeLLMCall: (ctx: BeforeLLMCallContext): LLMRequest => {
        const state = runState.get(ctx.runId);
        if (!state) return ctx.request;
        // If any prior tool output is in the message history, the run is at
        // least LOCAL_DIRTY. The tier is already bumped in afterToolCall; this
        // is a belt-and-suspenders scan for messages we missed.
        const hasToolMsg = ctx.request.messages.some(m => m.role === 'tool');
        if (hasToolMsg && state.tier === 'CLEAN') {
          state.tier = 'LOCAL_DIRTY';
        }
        return ctx.request;
      },

      beforeToolCall: (ctx: BeforeToolCallContext) => {
        const state = runState.get(ctx.runId);
        if (!state) return null;
        if (!blockOnExternalDirty) return null;
        if (state.tier !== 'EXTERNAL_DIRTY') return null;

        // Check riskMetadata — the tool self-reports.
        const sideEffect = ctx.tool?.definition?.riskMetadata?.sideEffect;
        const isEgress = sideEffect === 'external_egress';

        if (isEgress && !state.whitelist.has(ctx.toolName)) {
          getSecurityAuditLogger().logEvent({
            type: 'taint_blocked',
            severity: 'high',
            source: 'builtin-taint-tracking',
            message: `Blocked external_egress tool "${ctx.toolName}" after EXTERNAL_DIRTY data in run ${ctx.runId}`,
            details: { toolName: ctx.toolName, runId: ctx.runId, sources: state.sources },
          });
          return {
            content: [{
              type: 'text',
              text: `Blocked: taint tracking prevented data flow to outbound tool "${ctx.toolName}" after external tool output. Override via outboundToolWhitelist config.`,
            }],
            isError: true,
          } as any;
        }
        return null;
      },

      afterToolCall: (ctx: AfterToolCallContext) => {
        const state = runState.get(ctx.runId);
        if (!state) return ctx.result;
        const sideEffect = ctx.tool?.definition?.riskMetadata?.sideEffect;
        const isExternal = !INTERNAL_TOOLS.has(ctx.toolName) &&
                           (sideEffect === 'external_egress' ||
                            // Fallback: tools without riskMetadata that match known external names
                            (sideEffect === undefined && isKnownExternalTool(ctx.toolName)));
        if (isExternal && state.tier !== 'EXTERNAL_DIRTY') {
          state.tier = 'EXTERNAL_DIRTY';
          state.sources.push(ctx.toolName);
          getSecurityAuditLogger().logEvent({
            type: 'taint_promoted',
            severity: 'info',
            source: 'builtin-taint-tracking',
            message: `Run ${ctx.runId} promoted to EXTERNAL_DIRTY after tool "${ctx.toolName}"`,
            details: { toolName: ctx.toolName },
          });
        } else if (state.tier === 'CLEAN' && !INTERNAL_TOOLS.has(ctx.toolName)) {
          state.tier = 'LOCAL_DIRTY';
        }
        return ctx.result;
      },
    },
  };
}

function isKnownExternalTool(name: string): boolean {
  return /^(web_search|web_fetch|http_request|a2a_delegate|send_email|webhook_send|mcp_call)/.test(name);
}
```

### 4.6 Registration

In `packages/core/src/pluginManager.ts` (next to the RAG re-export at L1099):

```ts
export { createTaintTrackingPlugin } from './plugins/builtin/taintTrackingPlugin';
```

In `packages/core/src/index.ts` (next to the RAG export at L1080):

```ts
export { createTaintTrackingPlugin } from './plugins/builtin/taintTrackingPlugin';
```

### 4.7 Enablement

Default disabled. Enable via CLI:

```
commander plugin enable taint-tracking
```

The RAG plugin's enablement pattern is the reference — see prior session memory
for the `commander plugin enable rag` precedent.

### 4.8 Tests

- Plugin disabled → behavior unchanged (regression).
- Plugin enabled, only internal tools used → `web_search` allowed.
- Plugin enabled, `web_fetch` called → subsequent `send_email` blocked.
- Plugin enabled, `web_fetch` called → subsequent `code_search` allowed
  (local tools not blocked).
- Plugin enabled, `outboundToolWhitelist: ['send_email']` → email allowed
  even after external data.
- Audit log contains `taint_blocked` and `taint_promoted` entries.

---

## 5. G1 — RASP Extensions Plugin `builtin-rasp-extensions`

### 5.1 Three new detector feeds into `processSecurityAlert`

1. **Prompt-injection escape patterns** (`beforeLLMCall`)
   - Scan user-role messages for 6 high-risk patterns (ignore-previous,
     reveal-system-prompt, exfil-via, jailbreak role-play, base64-encoded
     payload, unicode-confusable override).
   - Match → `processSecurityAlert({severity:'high', source:'rasp-prompt-injection'})`.

2. **Token rate anomaly** (`afterLLMCall`)
   - Track per-run cumulative tokens; threshold `maxTokensPerRun` (default 500k).
   - Exceed → `processSecurityAlert({severity:'medium', source:'rasp-token-rate'})`.

3. **Tool failure rate** (`afterToolCall`)
   - Sliding window of last N tool calls; if failure rate > threshold
     (default 0.5) sustained over 10 calls →
     `processSecurityAlert({severity:'medium', source:'rasp-tool-failure'})`.

### 5.2 Devil detail C — ReDoS defense

The 6 prompt-injection regexes run on every user message. A 40KB
bracket-nested payload can lock the event loop for seconds.

**Hardening (mandatory):**

1. Each regex pre-validated with the `safe-regex` library during plugin
   `onLoad`. If a regex is flagged as potentially catastrophic, the plugin
   refuses to load and logs a critical error.
2. Wrap every match in a `performance.now()` guard with a 50ms budget. If
   exceeded, log `rasp-regex-timeout` audit event, skip that regex, continue
   with the remaining ones.
3. All regexes use linear-time-safe constructs: no nested quantifiers over
   alternations, no backreferences, anchored where possible.

**Dependency:** add `safe-regex` to `packages/core/dependencies` (not
devDependencies — the plugin uses it at runtime).

### 5.3 Plugin design

**New file:** `packages/core/src/plugins/builtin/raspExtensionsPlugin.ts`

```ts
import type { CommanderPlugin, BeforeLLMCallContext, AfterLLMCallContext, AfterToolCallContext } from '../../pluginManager';
import { processSecurityAlert } from '../../security/securityResponseEngine';
import { getSecurityAuditLogger } from '../../security/securityAuditLogger';
import { performance } from 'node:perf_hooks';
import * as safeRegex from 'safe-regex';

const REGEX_BUDGET_MS = 50;

const INJECTION_PATTERNS: { name: string; re: RegExp; severity: 'high' | 'medium' }[] = [
  { name: 'ignore_previous',     re: /ignore\s+(all\s+)?previous\s+(instructions|prompts?)/i, severity: 'high' },
  { name: 'reveal_system_prompt', re: /(reveal|show|print|repeat)\s+(the\s+)?system\s+prompt/i, severity: 'high' },
  { name: 'exfil_via',           re: /exfil(tra)?te\s+(via|through|using)\s+/i, severity: 'high' },
  { name: 'jailbreak_roleplay',  re: /(you\s+are\s+(now|a)\s+)|(pretend\s+you\s+(are|can))/i, severity: 'high' },
  // Patch B: threshold raised 200 → 512 to avoid false positives on inline SVG
  // assets, RSA/Ed25519 public keys, and obfuscated frontend bundle paths.
  // Pure long-base64 hits are downgraded to 'medium' severity — they log an
  // audit event but do NOT auto-suspend; the RASP response engine escalates
  // only when this signal combines with other behavioural anomalies (e.g.
  // high tool-failure rate from the same run).
  { name: 'base64_payload',      re: /[A-Za-z0-9+/]{512,}={0,2}/, severity: 'medium' },
  { name: 'unicode_confusable',  re: /[\u0400-\u04FF\u202A-\u202E]/, severity: 'high' },
];

interface RunState {
  tokensUsed: number;
  toolCallWindow: boolean[];
  failures: number;
}

export function createRaspExtensionsPlugin(): CommanderPlugin {
  const runState = new Map<string, RunState>();
  const compiledPatterns: { name: string; re: RegExp }[] = [];
  let enabledDetectors: Set<string> = new Set(['prompt_injection']);
  let maxTokensPerRun = 500_000;
  let toolFailureThreshold = 0.5;

  return {
    name: 'builtin-rasp-extensions',
    version: '0.1.0',
    description: 'Extended RASP detectors: prompt-injection, token-rate, tool-failure-rate',
    category: 'security',
    configSchema: {
      type: 'object',
      properties: {
        enabledDetectors: {
          type: 'array',
          items: { type: 'string', enum: ['prompt_injection', 'token_rate', 'tool_failure_rate'] },
          default: ['prompt_injection'],
        },
        maxTokensPerRun:        { type: 'number', default: 500000 },
        toolFailureThreshold:   { type: 'number', default: 0.5 },
        toolFailureWindowSize:  { type: 'number', default: 10 },
      },
    },

    onLoad: async (ctx) => {
      enabledDetectors = new Set(ctx.config.enabledDetectors as string[] ?? ['prompt_injection']);
      maxTokensPerRun = Number(ctx.config.maxTokensPerRun) || 500_000;
      toolFailureThreshold = Number(ctx.config.toolFailureThreshold) || 0.5;

      // Devil detail C: validate every regex with safe-regex before compiling.
      for (const p of INJECTION_PATTERNS) {
        if (!safeRegex(p.re)) {
          getSecurityAuditLogger().logEvent({
            type: 'rasp_regex_unsafe',
            severity: 'critical',
            source: 'builtin-rasp-extensions',
            message: `Refusing to load unsafe regex "${p.name}"`,
          });
          throw new Error(`builtin-rasp-extensions: regex "${p.name}" failed safe-regex validation`);
        }
        compiledPatterns.push(p);
      }
    },

    onUnload: async () => { runState.clear(); compiledPatterns.length = 0; },

    hooks: {
      onAgentStart: ({ runId }) => {
        runState.set(runId, { tokensUsed: 0, toolCallWindow: [], failures: 0 });
      },
      onAgentComplete: ({ runId }) => { runState.delete(runId); },

      beforeLLMCall: (ctx: BeforeLLMCallContext): LLMRequest => {
        if (!enabledDetectors.has('prompt_injection')) return ctx.request;
        for (const m of ctx.request.messages) {
          if (m.role !== 'user') continue;
          const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          for (const p of compiledPatterns) {
            const start = performance.now();
            const hit = p.re.test(text);
            const elapsed = performance.now() - start;
            if (elapsed > REGEX_BUDGET_MS) {
              getSecurityAuditLogger().logEvent({
                type: 'rasp_regex_timeout',
                severity: 'medium',
                source: 'builtin-rasp-extensions',
                message: `Regex "${p.name}" exceeded ${REGEX_BUDGET_MS}ms budget (${elapsed.toFixed(1)}ms)`,
              });
              continue;
            }
            if (hit) {
              // Per-pattern severity — base64_payload is 'medium' (logs but
              // does not auto-suspend); other patterns are 'high' (RASP
              // escalates to suspend + revoke per response engine policy).
              processSecurityAlert({
                severity: p.severity,
                source: 'rasp-prompt-injection',
                agentId: ctx.agentId,
                message: `Prompt-injection pattern "${p.name}" detected in user message`,
                details: { runId: ctx.runId, pattern: p.name },
              });
            }
          }
        }
        return ctx.request;
      },

      afterLLMCall: (ctx: AfterLLMCallContext): void => {
        if (!enabledDetectors.has('token_rate')) return;
        const state = runState.get(ctx.runId);
        if (!state || !ctx.response?.usage) return;
        state.tokensUsed += (ctx.response.usage.totalTokens ?? 0);
        if (state.tokensUsed > maxTokensPerRun) {
          processSecurityAlert({
            severity: 'medium',
            source: 'rasp-token-rate',
            agentId: ctx.agentId,
            message: `Token usage ${state.tokensUsed} exceeded per-run cap ${maxTokensPerRun}`,
            details: { runId: ctx.runId, tokensUsed: state.tokensUsed, cap: maxTokensPerRun },
          });
        }
      },

      afterToolCall: (ctx: AfterToolCallContext) => {
        if (!enabledDetectors.has('tool_failure_rate')) return ctx.result;
        const state = runState.get(ctx.runId);
        if (!state) return ctx.result;
        const failed = Boolean(ctx.result.isError);
        state.toolCallWindow.push(failed);
        if (state.toolCallWindow.length > 10) state.toolCallWindow.shift();
        if (state.toolCallWindow.length === 10) {
          const rate = state.toolCallWindow.filter(Boolean).length / 10;
          if (rate > toolFailureThreshold) {
            processSecurityAlert({
              severity: 'medium',
              source: 'rasp-tool-failure',
              agentId: ctx.agentId,
              message: `Tool failure rate ${(rate * 100).toFixed(0)}% exceeded threshold over last 10 calls`,
              details: { runId: ctx.runId, rate, threshold: toolFailureThreshold },
            });
          }
        }
        return ctx.result;
      },
    },
  };
}
```

### 5.4 Registration & enablement

Same pattern as G2:

```ts
// pluginManager.ts and index.ts
export { createRaspExtensionsPlugin } from './plugins/builtin/raspExtensionsPlugin';
```

Enable: `commander plugin enable rasp-extensions`.

### 5.5 Tests

- `safe-regex` rejects a deliberately unsafe regex → plugin refuses to load.
- Each of the 3 detectors triggers `processSecurityAlert` on its condition.
- Disabled detector does not fire.
- `performance.now()` budget guard logs `rasp_regex_timeout` on slow regex.
- RASP response engine escalates correctly (high severity → suspend + revoke).

---

## 6. G9 — Formal Property Tests (fast-check)

### 6.1 Dependency governance (per CTO)

- Add `fast-check` to `packages/core/devDependencies`.
- `fast-check` is pure TypeScript, zero native binaries — safe for the monorepo.
- **CI:** `numRuns: 100` (default).
- **Nightly `red-team.yml`:** env var `COMMANDER_PROPERTY_TEST_NUM_RUNS=10000`
  overrides to deep search.

### 6.2 Test file

**New file:** `packages/core/tests/security/property/invariantPropertyTests.ts`

Five properties, each mapped to a registered invariant:

1. **`AUTH-001`** — for any agentId without `authenticate()`, all protected
   operations return BLOCKED.
2. **`SANDBOX-001`** — for any command containing an escape pattern,
   `preCheckSandboxEscape()` returns blocked.
3. **`FLOW-001`** (requires taint-tracking plugin enabled) — for any
   untrusted-tainted data, `canFlow('untrusted', 'system_prompt')` returns
   `false`.
4. **`MEMORY-001`** (G10) — for any `(writerAgentId, targetPath)` pair, write
   succeeds iff `targetPath.startsWith(writerNs) || acl.grants(targetPath)`.
5. **Taint algebra** — `combineTaint` is associative, commutative, and
   idempotent; `combineTaint(x, 'trusted') === x`.

### 6.3 Test skeleton

```ts
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { combineTaint } from '../../../src/security/taintTracker';
import { preCheckSandboxEscape } from '../../../src/security/sandboxEscapeDetector';
import type { SandboxProfile } from '../../../src/sandbox/types';

const NUM_RUNS = Number(process.env.COMMANDER_PROPERTY_TEST_NUM_RUNS) || 100;

// Minimal valid SandboxProfile for the detector — the preCheck only reads
// a few fields; we construct a fixed profile once and reuse it.
const FIXED_PROFILE: SandboxProfile = {
  // Populate the required fields per SandboxProfile shape; omit optional.
  // (Exact fields confirmed at implementation time — see sandbox/types.ts.)
  networkMode: 'none',
  filesystem: 'readonly',
} as SandboxProfile;

describe('Security invariant property tests', () => {
  it('combineTaint is commutative', () => {
    fc.assert(fc.property(
      fc.constantFrom('trusted', 'untrusted', 'external'),
      fc.constantFrom('trusted', 'untrusted', 'external'),
      (a, b) => combineTaint(a, b) === combineTaint(b, a),
    ), { numRuns: NUM_RUNS });
  });

  it('combineTaint is associative', () => {
    fc.assert(fc.property(
      fc.constantFrom('trusted', 'untrusted', 'external'),
      fc.constantFrom('trusted', 'untrusted', 'external'),
      fc.constantFrom('trusted', 'untrusted', 'external'),
      (a, b, c) => combineTaint(a, combineTaint(b, c)) === combineTaint(combineTaint(a, b), c),
    ), { numRuns: NUM_RUNS });
  });

  it('combineTaint: most restrictive wins', () => {
    fc.assert(fc.property(
      fc.constantFrom('trusted', 'untrusted', 'external'),
      fc.constantFrom('trusted', 'untrusted', 'external'),
      (a, b) => {
        const r = combineTaint(a, b);
        const order = { trusted: 0, untrusted: 1, external: 2 };
        return order[r] === Math.max(order[a], order[b]);
      },
    ), { numRuns: NUM_RUNS });
  });

  it('SANDBOX-001: escape patterns blocked', () => {
    fc.assert(fc.property(
      fc.oneof(
        fc.string().filter(s => s.includes('nsenter')),
        fc.string().filter(s => s.includes('/dev/mem')),
        fc.string().filter(s => s.includes('docker.sock')),
      ),
      (cmd) => {
        const result = preCheckSandboxEscape(cmd, FIXED_PROFILE);
        return result.blocked === true;
      },
    ), { numRuns: NUM_RUNS });
  });

  // MEMORY-001 and FLOW-001 added after G10/G2 implementations land.
});
```

**Note:** `FIXED_PROFILE` uses `as SandboxProfile` because the full shape
will be confirmed at implementation time against `sandbox/types.ts`. The
detector only reads a subset of fields; the test will be tightened to a
real object literal once the exact required fields are verified.

### 6.4 Tests

- All 5 properties pass at `numRuns: 100`.
- Nightly CI at `numRuns: 10000` does not find counterexamples (this is the
  formal-guarantee proxy per the invariant verifier's design note).

---

## 7. Implementation Order (per CTO directive)

1. **G9 property test skeleton** — write the test file first, even before
   implementations land. Tests that depend on not-yet-existing invariants are
   `.skip`'d with a TODO; this "defines the rules" up front.
2. **G3 A2A server mTLS** — Core change to `a2aServer.ts` + tests.
3. **G10 memory isolation** — audit pass, add `assertNamespaced()`, register
   `MEMORY-001` as default invariant, unskip the G9 `MEMORY-001` test.
4. **G2 taint tracking plugin** — add `riskMetadata` to `ToolDefinition`,
   write `taintTrackingPlugin.ts`, register exports, enable CLI.
5. **G1 RASP extensions plugin** — write `raspExtensionsPlugin.ts`,
   `safe-regex` dependency, register exports, enable CLI.

The CTO sign-off condition: "`fast-check` 在 CI 里把 `MEMORY-001` 变绿" —
Step 3 unskips that test and it must pass at `numRuns: 100`.

---

## 8. Cross-cutting Concerns

### 8.1 Sandboxed context compliance

Both new plugins (`builtin-taint-tracking`, `builtin-rasp-extensions`) follow
the existing built-in plugin pattern. They are loaded via
`buildSandboxedLoadContext()` per the project hard constraint — never receive
the raw `HookManager`. Their `withTimeout` uses
`Math.min(plugin.maxExecutionTimeMs, globalLimit)`.

### 8.2 Audit logging

All plugin decisions (block, promote, alert) flow through
`getSecurityAuditLogger().logEvent()` with structured `details`. New event
types: `taint_blocked`, `taint_promoted`, `rasp_prompt_injection`,
`rasp_token_rate`, `rasp_tool_failure`, `rasp_regex_timeout`,
`rasp_regex_unsafe`, `memory_isolation_violation`.

### 8.3 Failure modes

- Plugin hook throws → existing `withTimeout` + try/catch in `HookManager`
  handles; non-`required` plugins fail-soft, log via
  `recordHookFailure`, and do not crash the run.
- `processSecurityAlert` itself errors → RASP engine has its own try/catch;
  the original alert is logged even if escalation fails.

### 8.4 Backward compatibility

- `A2AServerConfig.tls` is optional → existing deployments unchanged.
- `ToolDefinition.riskMetadata` is optional → existing tools unchanged.
- Both new plugins default-disabled → existing ReAct workflows unchanged.
- `MEMORY-001` invariant is additive; existing `assertInvariants` call sites
  gain the check automatically.

---

## 9. Out of Scope

- **G6 kernel-level sandbox monitoring (eBPF/Falco)** — requires native
  binaries, dedicated SRE ownership. Tracked as separate epic.
- **mTLS certificate revocation real-time enforcement** — documented
  limitation (devil detail A); future hardening via re-handshake tracked as
  follow-up.
- **Arg-level taint tracking** — explicitly rejected by CTO ruling; LLM
  epistemic mixing makes compile-time taint tracking unreliable.

---

## 10. Acceptance Criteria

| Criterion | Verification |
|-----------|-------------|
| G3: A2A server supports mTLS | Unit + integration tests pass with `selfsigned` certs |
| G3: Bearer authToken retained | Existing auth tests still pass |
| G3: Devil detail A documented | Comment in `a2aServer.ts` + entry in `keys-rotation.md` |
| G10: All memory writes pass through namespace guard | Audit grep shows no bypass paths |
| G10: `MEMORY-001` registered as default | `registerDefaultInvariants()` includes it; `O(1)` check |
| G10: Sub-agent cross-namespace write blocked | Unit test + invariant violation triggers RASP |
| G2: Plugin default-disabled | Existing tests pass with no behavior change |
| G2: Source tiering v0.2 | `LOCAL_DIRTY` allows outbound; `EXTERNAL_DIRTY` blocks |
| G2: `riskMetadata` on `ToolDefinition` | New field added; existing tools unaffected |
| G1: 3 detectors fire correctly | Each has unit + integration test |
| G1: ReDoS defense | `safe-regex` validation + `performance.now()` budget guard |
| G9: 5 property tests pass at numRuns:100 | CI green |
| G9: Nightly numRuns:10000 | `red-team.yml` workflow configured |
| All TypeScript compiles | `tsc --noEmit` passes |
| All existing tests pass | `vitest` from `packages/core` |

---

## 11. File Change Summary

| File | Change |
|------|--------|
| `packages/core/src/mcp/a2aServer.ts` | Add `tls` config + `https.createServer` branch + devil-detail-A comment |
| `packages/core/src/runtime/types/tool.ts` | Add `riskMetadata?.sideEffect` to `ToolDefinition` |
| `packages/core/src/memory/memorySystem.ts` | Add `assertNamespaced()` method |
| `packages/core/src/security/securityInvariantVerifier.ts` | Register `MEMORY-001` in `registerDefaultInvariants()` + extend `InvariantContext` |
| `packages/core/src/plugins/builtin/taintTrackingPlugin.ts` | **NEW** — G2 plugin |
| `packages/core/src/plugins/builtin/raspExtensionsPlugin.ts` | **NEW** — G1 plugin |
| `packages/core/src/pluginManager.ts` | Re-export both plugin factories; extend `BeforeToolCallContext` / `AfterToolCallContext` with `tool?: Tool` field |
| `packages/core/src/index.ts` | Re-export both plugin factories |
| `packages/core/src/runtime/agentRuntime.ts` | Pass resolved `Tool` object at `fireBeforeToolCall` / `fireAfterToolCall` call sites (L823, L829) |
| `packages/core/tests/security/property/invariantPropertyTests.ts` | **NEW** — G9 property tests |
| `packages/core/tests/security/a2aMtls.test.ts` | **NEW** — G3 tests |
| `packages/core/tests/security/memoryIsolation.test.ts` | **NEW** — G10 tests |
| `packages/core/tests/security/taintTrackingPlugin.test.ts` | **NEW** — G2 tests |
| `packages/core/tests/security/raspExtensionsPlugin.test.ts` | **NEW** — G1 tests |
| `packages/core/package.json` | Add `fast-check` to devDeps; `safe-regex` to deps |
| `docs/security/keys-rotation.md` | Note on mTLS revocation limitation |
