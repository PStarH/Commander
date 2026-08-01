# Proposed Design: OpenAI Agents SDK + MCP Action Boundary

**Date:** 2026-08-01
**Status:** Proposed; implementation is blocked on the state-machine and error-semantics freeze owned by task A.
**Scope:** Contract and adapter-boundary design only. This document does not add an OpenAI Agents SDK dependency, a hosted MCP integration, or a production execution path.

## 1. Intent

The comparative experiment in the design-partner runbook has three arms: direct
tool retry, OpenAI Agents SDK direct tool retry, and OpenAI Agents SDK routed
through Commander. The third arm must measure the control-plane contribution,
not create a second authority for external effects.

The boundary therefore has one rule:

> OpenAI Agents SDK and MCP may decide when to request a capability. Commander
> alone decides whether a consequential action is admitted, executed,
> reconciled, and evidenced.

This design freezes the translation between those surfaces without changing the
existing production state machine. It covers:

- action identity and mapping;
- `pending`, `error`, and `unknown` bridge outcomes;
- idempotency and replay behavior; and
- independent evidence verification.

It does not cover model quality, prompt design, agent handoffs, adapter
implementation, database migrations, or production wiring.

## 2. Existing Anchors

The design follows the current repository contracts rather than introducing a
parallel vocabulary:

| Boundary | Existing anchor |
| --- | --- |
| Public action states and evidence DTOs | `packages/contracts/src/effects.ts` |
| Gateway action projection | `projectCanonicalActionState` in `apps/api/src/actionGatewayEndpoints.ts` |
| Gateway action digest and run identity | `canonicalValueHash` and `deriveGatewayRunId` in `apps/api/src/v1GatewayKernel.ts` |
| MCP effect routing | `buildMcpActionEnvelope` and `toolRequiresActionGateway` in `packages/core/src/mcp/server.ts` |
| Publishable MCP surface | `packages/mcp-server/src/stdioServer.ts` |
| Query-only unknown reconciliation | `EffectRemoteOutcome` and `reconcileUnknown` in `packages/effect-broker/src/index.ts` |
| Evidence construction and terminal checks | `packages/effect-broker/src/evidenceBundle.ts` |
| Launch requirements | `docs/runbooks/design-partner-launch-readiness.md` (G4/G5) |

The OpenAI documentation describes the same useful split: the Agents SDK owns
the agent loop and resumable approval state, while the application still
executes function tools; local/private MCP connections keep connectivity and
approval in the application runtime. See the references at the end of this
document.

## 3. Boundary Model

```text
OpenAI Agent loop
  model tool call / approval interruption / resumable state
                    |
                    v
SDK bridge or MCP adapter
  validates tool arguments, attaches trusted context and idempotency key
                    |
                    v
Commander Action Gateway (/v1/actions)
  simulation -> policy/approval -> durable run/step/effect -> worker lease
                    |
                    v
EffectBroker + external adapter
  one write attempt, or query-only outcome reconciliation
                    |
                    v
Independent evidence verifier
  receipt + retained JWKS -> verified/rejected
```

The SDK trace, MCP JSON-RPC result, and Commander evidence receipt are three
different artifacts:

- an SDK trace explains how the agent loop behaved;
- an MCP result transports a tool outcome to the caller; and
- a Commander receipt proves the authorized action lifecycle.

None of the first two is evidence of a successful external write.

### 3.1 Capability classes

| Capability | Allowed execution path | Authority |
| --- | --- | --- |
| Read-only local/router tool | Direct MCP/tool execution | Tool runtime, with normal tenant checks |
| Consequential Commander action | Action Gateway, then EffectBroker | Commander kernel and policy |
| Third-party or hosted MCP action | MCP transport into a Commander action adapter, when enabled | Commander remains authority; the MCP server is untrusted |
| OpenAI approval interruption | SDK pause and resume | Commander interaction record for consequential actions |

MCP tool metadata is descriptive, not authorization. A missing Action Gateway
executor for a non-read-only tool is a fail-closed configuration error, not a
permission to execute locally.

## 4. Canonical Action Identity

The bridge creates one `ActionEnvelope` for every consequential tool request.
The tenant is taken from authenticated runtime context; it is never accepted
from model output or an MCP argument.

```ts
interface ActionEnvelope {
  tenantId: string;       // trusted identity context
  source: string;         // e.g. openai-agents-sdk or mcp
  package: string;
  model: string;
  tool: string;
  destination: string;
  effectType: string;
  args: Record<string, unknown>;
  idempotencyKey: string;
}
```

The initial bridge uses the exact envelope canonicalization already used by
`buildSimulation`: `actionDigest = canonicalValueHash(envelope)`. This includes
the supplied idempotency key and therefore treats a new key as a new action.
Changing that relationship to a separate immutable intent digest is a future
contract change and is outside this task.

The bridge must carry these identifiers back to the SDK/MCP caller whenever an
action is admitted:

```text
actionDigest, runId, stepId, effectId, policySnapshotId, state
```

An SDK tool-call ID or an MCP JSON-RPC request ID may be recorded as correlation
metadata, but neither is an action identity and neither is an idempotency key.

## 5. Bridge Outcome Contract

The SDK/MCP adapter uses a small outcome vocabulary that is intentionally
separate from `ActionStateV1`:

```text
ok       externally consequential action is terminal and evidenced
pending  Commander still owns work or approval; no terminal claim
error    deterministic denial/failure, or a failure whose commit state is known
unknown  an admitted effect may have committed but its outcome is not proven
```

The minimum response shape is:

```ts
type BridgeOutcome =
  | { outcome: 'ok'; action: GovernedActionV1; evidence: EvidenceRef }
  | { outcome: 'pending'; action: GovernedActionV1; resume: ResumeRef }
  | { outcome: 'error'; error: ActionError; action?: GovernedActionV1 }
  | { outcome: 'unknown'; action: GovernedActionV1; reconcile: ReconcileRef };
```

`EvidenceRef`, `ResumeRef`, `ReconcileRef`, and `ActionError` are bridge DTOs;
they do not replace the public contract types in `packages/contracts`.

### 5.1 Mapping table

| Source observation | Commander action state | Bridge outcome | SDK/MCP behavior |
| --- | --- | --- | --- |
| Input validation, authentication, tenant, or policy fails before admission | `FAILED` when an action record exists; otherwise no action | `error` | Return stable error code; do not retry an effect |
| Approval interruption or durable human interaction is open | `AWAITING_APPROVAL` | `pending` | Return `actionId`/`interactionId`; resume the same SDK state or poll the action |
| Admitted but queued or waiting for a worker | `ADMITTED` | `pending` | Poll the same action; no second proposal |
| Worker/effect is executing | `RUNNING` | `pending` | Do not interpret a tool return as terminal until Commander says so |
| Effect is completed and terminal evidence verifies | `SUCCEEDED` | `ok` | Return receipt reference; this is the only success claim |
| Effect failed or is confirmed not applied | `FAILED` | `error` | Include disposition and commit state; retry only through an explicit policy path |
| Effect may have committed and remote/local completion is ambiguous | `COMPLETION_UNKNOWN` | `unknown` | Do not call the write tool again; schedule or poll reconciliation |
| Unknown outcome is explicitly escalated | `ESCALATED` | `unknown` | Surface escalation and evidence; no blind retry |

An OpenAI Agents SDK `interruptions` result is a pause, not an error and not a
remote unknown. Its resumable `state` is serialized and resumed after the
approval decision. `finalOutput` is a conversational result and does not by
itself move an external action to `SUCCEEDED`.

For the current Gateway projection, a run/step that is still `PENDING` projects
to `ADMITTED`; `AWAITING_APPROVAL`, `RUNNING`, `COMPLETION_UNKNOWN`, terminal
states, and escalation retain the precedence documented by
`projectCanonicalActionState`. The bridge must not invent a public `PENDING`
action state while task A is freezing the canonical enum.

### 5.2 Error contract

An `error` outcome must include a stable code and a commit-state classification:

```ts
type CommitState = 'not_attempted' | 'not_committed' | 'committed' | 'unknown';

interface ActionError {
  code: string;
  message?: string;
  retryable: boolean;
  commitState: CommitState;
  details?: Record<string, unknown>;
}
```

The code is authoritative for the class of failure; the message is diagnostic
and must not be parsed by the SDK. Existing Gateway codes such as
`INVALID_REQUEST`, `ACTION_POLICY_DENIED`, `KILL_SWITCH_ACTIVE`,
`OPERATIONS_NOT_READY`, `IDEMPOTENCY_KEY_CONFLICT`, `STEP_ID_CONFLICT`,
`EVIDENCE_INVALID`, and `EVIDENCE_NOT_READY` remain the source vocabulary until
task A publishes the final error registry.

Retry rules are deliberately narrow:

1. Admission, read, and poll requests may be retried with the same key when
   their operation is safe to repeat.
2. An effect write may only be retried when the broker has established
   `not_attempted` or an explicit policy says that a `NOT_APPLIED` outcome is
   safe to retry.
3. A timeout, connection reset, SDK exception, or MCP error is not enough to
   classify a write as `not_attempted`.
4. The bridge must never turn an `unknown` outcome into a generic retryable
   `error` so that the model loop retries it automatically.

## 6. `COMPLETION_UNKNOWN` and `UNKNOWN`

`unknown` is reserved for an admitted consequential effect where the external
commit could have happened but the control plane cannot prove the result. It is
not a catch-all for malformed input, policy denial, or a normal transient model
failure.

The only permitted transition out of this condition is query-first
reconciliation:

```text
COMPLETION_UNKNOWN
  -> query remote outcome (read-only)
       -> APPLIED       -> complete existing effect, no write adapter call
       -> NOT_APPLIED   -> CONFIRMED_NOT_APPLIED / failed disposition
       -> UNKNOWN       -> remain unknown or escalate
```

The reconciler receives the durable effect ID, idempotency key, effect type,
request, and tenant scope. It may not invoke the original write executor. A
stale worker may not complete the effect after its lease expires.

For the SDK bridge, an unknown result ends the current action turn. The model
may be told that reconciliation is pending, but it must not be given a tool
surface that can immediately repeat the write. A later resume/poll observes the
same `effectId` and outcome.

## 7. Idempotency and Replay

The idempotency key is generated before the first network request and is reused
for every SDK, MCP, Gateway, and worker retry of the same action intent.

| Replay input | Required result | External write |
| --- | --- | ---: |
| Same tenant + same key + same canonical envelope | Return original action/outcome; mark `idempotentReplay` | 0 new writes |
| Same tenant + same key + different canonical envelope | `IDEMPOTENCY_KEY_CONFLICT` | 0 |
| Different tenant + same key | Independent tenant-scoped action | Per policy |
| Replay of `COMPLETION_UNKNOWN` | Return `unknown`/existing reconcile handle | 0 |
| Duplicate approval or reconcile request | Return the existing interaction/reconcile disposition | 0 |

The Gateway's deterministic run identity is scoped by `(tenantId,
idempotencyKey)`. The step and effect IDs are derived from that durable run and
must not be regenerated by an SDK retry.

The current MCP helper derives a fallback key from `toolName` and `args`. That
fallback is acceptable only as a local deterministic default; it is not a
universal business idempotency key because repeated identical calls in one
tenant can collide. The future bridge contract must prefer a caller-provided
key scoped to the agent turn or business intent. Changing the helper is
production integration work and is intentionally deferred.

SDK retry configuration must not wrap a consequential tool with an independent
write retry loop. A retry of the HTTP request to `/v1/actions` is safe only when
it carries the same key; a retry after `COMPLETION_UNKNOWN` is a reconcile call,
not a new action proposal.

## 8. Evidence Verifier

The verifier is a separate, read-only trust boundary. It accepts a receipt and
retained public JWKS plus optional expected scope:

```ts
interface EvidenceVerificationInput {
  receipt: unknown;
  jwks: unknown;
  expected?: {
    tenantId?: string;
    runId?: string;
    effectId?: string;
    actionDigest?: string;
  };
}
```

The verifier checks, in order:

1. receipt shape and supported schema/body versions;
2. tenant/run/effect scope against the requested resource;
3. action digest format and expected digest binding;
4. effect and audit-event hash chains (`entryHash`/`prevEntryHash`);
5. canonical body `contentHash`;
6. terminal disposition consistency;
7. Ed25519 signature, algorithm, key ID, and retained non-revoked public key;
8. DLP/redaction policy for credentials, tokens, private keys, and customer data.

The result is a discriminated, non-throwing read-only verdict for callers:

```ts
type EvidenceVerdict =
  | {
      verdict: 'verified';
      bundleId: string;
      actionDigest: string;
      terminalDisposition: 'SUCCEEDED' | 'FAILED' | 'ESCALATED';
      keyId: string;
    }
  | {
      verdict: 'rejected';
      code:
        | 'EVIDENCE_SCHEMA_INVALID'
        | 'EVIDENCE_SCOPE_MISMATCH'
        | 'EVIDENCE_CHAIN_INVALID'
        | 'EVIDENCE_CONTENT_HASH_INVALID'
        | 'EVIDENCE_TERMINAL_DISPOSITION_INVALID'
        | 'EVIDENCE_SIGNATURE_INVALID'
        | 'EVIDENCE_KEY_UNTRUSTED'
        | 'EVIDENCE_DLP_VIOLATION';
      reason: string;
      index?: number;
    };
```

This is an adapter-level shape for the design. It must be reconciled with the
existing `ActionEvidenceVerificationV1` before any public type is changed.

An unresolved `COMPLETION_UNKNOWN` effect cannot produce a verified success
receipt. An `ESCALATED` receipt is valid only when the bundle contains an
explicit reconciliation-escalation event and the unresolved effect is still
`COMPLETION_UNKNOWN`. Verification never calls an adapter, mutates the ledger,
approves an action, or schedules compensation.

OpenAI traces and MCP tool results may be linked as audit metadata, but they do
not replace a signed Commander receipt. Evidence persistence or verification
failure blocks a terminal success claim or leaves the effect in a durable
actionable unknown state.

## 9. MCP and Agents SDK Rules

### 9.1 SDK function tools

- A tool function that can cause an external write is a proposal boundary, not
  an adapter boundary.
- `needsApproval`/human review can pause the SDK run, but Commander still owns
  the durable approval interaction and action digest for consequential work.
- The tool returns the bridge outcome as structured data; the agent may render
  it, but the model cannot change `state`, `actionDigest`, or disposition.
- A thrown exception from the tool is normalized only after commit state is
  known. Otherwise it becomes `unknown`, not a blind retry.

### 9.2 MCP tools

- Read-only local/router tools may execute directly.
- Non-read-only tools require an Action Gateway executor; without one, return
  `ACTION_GATEWAY_REQUIRED` and do not call the local tool implementation.
- Policy denials preserve the stable Gateway code in the MCP result rather than
  becoming an indistinguishable generic tool failure.
- Hosted MCP can provide a remote capability, and local/private MCP can own
  network connectivity, but neither surface is the Commander authority for a
  consequential write.
- MCP server tool descriptions, prompt text, and tool results are untrusted
  inputs and must not override tenant, policy, approval, lease, or evidence
  checks.

## 10. Pure Contract/Fixture Test Plan

The first implementation slice after task A freezes the wire semantics will be
pure tests and fixtures. It must not start an API server, a database, an MCP
process, an OpenAI client, or an external adapter.

Suggested fixtures under `packages/contracts/fixtures/actions/v1/agents-mcp-boundary/`:

```text
pending-approval.json
pending-admitted.json
error-policy-denied.json
error-idempotency-conflict.json
error-not-attempted.json
unknown-after-commit.json
unknown-query-applied.json
unknown-query-not-applied.json
unknown-query-unknown.json
replay-same-outcome.json
replay-conflict.json
evidence-valid.json
evidence-invalid-signature.json
evidence-unknown-unresolved.json
evidence-escalated.json
```

Required assertions:

1. Every mapping result is a member of the frozen public action enum or the
   bridge outcome enum; no `pending`/`unknown` value is silently coerced to
   success.
2. Approval interruption resumes the same action and does not create a second
   proposal.
3. `COMPLETION_UNKNOWN` calls a querier and never a write executor.
4. `APPLIED` reconciliation completes the existing effect without a second
   write; `NOT_APPLIED` and unprovable `UNKNOWN` retain their distinct
   dispositions.
5. Same-key replay returns the original result; digest mismatch returns a
   conflict; replayed unknown never invokes an adapter.
6. The evidence verifier rejects scope, chain, content hash, signature, key,
   terminal-disposition, and DLP violations.
7. An unresolved unknown receipt is rejected unless there is an explicit
   escalation event and `ESCALATED` disposition.

The tests are semantic locks, not production integration tests. A later
integration campaign must still prove the runbook's real Kubernetes/Postgres
fault matrix.

## 11. Freeze and Non-Goals

Before implementation, task A must freeze:

- the canonical action/run/step/effect state machine and precedence;
- the public error-code registry and retryability rules;
- whether `CONFIRMED_NOT_APPLIED` is exposed as a disposition only or as a
  first-class public state; and
- the final public shape of evidence verification results.

Until that freeze:

- do not add `@openai/agents` or an OpenAI-specific runtime package;
- do not change `ActionStateV1`, Gateway routes, effect transitions, or error
  handling in production code;
- do not treat OpenAI-hosted MCP approval as a substitute for Commander
  approval;
- do not publish comparative benchmark results; and
- do not claim a tool result or SDK trace is independently verifiable evidence.

## 12. References

Repository:

- [Design-partner launch readiness runbook](../../runbooks/design-partner-launch-readiness.md)
- [Action contracts](../../../packages/contracts/src/effects.ts)
- [MCP action routing](../../../packages/core/src/mcp/server.ts)
- [Effect reconciliation](../../../packages/effect-broker/src/index.ts)
- [Evidence bundle](../../../packages/effect-broker/src/evidenceBundle.ts)

OpenAI developer docs:

- [Using tools: Agents SDK tool semantics](https://developers.openai.com/api/docs/guides/tools#usage-in-the-agents-sdk)
- [Guardrails and human review](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)
- [Running agents](https://developers.openai.com/api/docs/guides/agents/running-agents)
- [Results and state](https://developers.openai.com/api/docs/guides/agents/results)
- [Integrations and observability: MCP](https://developers.openai.com/api/docs/guides/agents/integrations-observability#mcp)
