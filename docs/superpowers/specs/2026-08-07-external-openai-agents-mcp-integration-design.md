# External OpenAI Agents MCP Integration

**Date:** 2026-08-07
**Status:** Approved
**Scope:** A reproducible external OpenAI Agents SDK consumer that reaches the
Commander Action Gateway only through MCP and proves rollback recovery through
a verified receipt.

## Goal

Prove that a runtime outside Commander can use the OpenAI Agents SDK to discover
and invoke Commander MCP tools. The deterministic CI path must require no API
key or network access. A separate live smoke must be completed before claiming
that the integration has been verified with an OpenAI model.

## Process Boundary

The consumer lives in `integrations/openai-agents-mcp` and runs as a separate
Node process. It may depend on `@openai/agents` and general-purpose libraries,
but it must not import `@commander/*`, `packages/**`, or `apps/**`.

```text
OpenAI Agents SDK process
  -> official MCPServerStdio transport
  -> Commander MCP server process
  -> HTTP /v1/actions/*
  -> Commander API and PostgreSQL
  -> worker and fake Kubernetes API
  -> reconciliation worker
  -> signed receipt and independent verifier
```

The Commander test coordinator may start processes, inject the supported fault,
and inspect durable state. The external Agent process can observe Commander only
through MCP.

## Deterministic CI Flow

1. The external Agent connects through `MCPServerStdio` and performs real MCP
   initialization and tool discovery.
2. A deterministic Agents SDK `Model` selects `commander_action_propose` and
   submits a pinned Kubernetes deployment rollback envelope and idempotency key.
3. Commander admits the action and returns `runId`, `stepId`, `effectId`,
   `actionDigest`, and `policySnapshotId`.
4. The worker performs one rollback mutation against a local fake Kubernetes
   endpoint.
5. The worker process exits after remote commit and before local completion is
   persisted.
6. A restarted worker/reconciler recovers the original effect as
   `COMPLETION_UNKNOWN` and performs a query-only reconciliation.
7. The external Agent observes and reconciles the same action through MCP, then
   obtains its evidence through `commander_action_evidence`.
8. A read-only verifier validates the receipt with retained JWKS and records its
   SHA-256 hash.

The test must assert one rollback mutation, at least one outcome query, stable
run/step/effect identity across restart, an observed `COMPLETION_UNKNOWN` state,
an idempotent replay with no second effect, and a terminal disposition matching
the verified receipt.

## Failure Semantics

- MCP startup, initialization, discovery, schema, or child-process failures are
  terminal test failures.
- A consequential tool call has no independent write retry loop. A lost proposal
  response may be replayed only with the same idempotency key.
- Once an effect is `COMPLETION_UNKNOWN`, the consumer may only get, reconcile,
  or request evidence for that action. It may not propose the rollback again.
- Receipt absence, invalid verification, inconsistent terminal state, a second
  mutation, or failure to replace the crashed process makes the test fail.
- Every wait has a bounded timeout and reports the last durable state.

## Evidence Bundle

Each deterministic run emits a schema-validated bundle containing:

- Git commit and Node, Agents SDK, Commander MCP, MCP protocol, and evidence
  schema versions;
- external Agent, MCP server, API, crashed worker, restarted worker, and
  reconciler process IDs;
- selected MCP tool and a hash of its arguments;
- ordered MCP method/tool observations and outcome states;
- Commander action identifiers and durable state sequence;
- fault point and exact rollback mutation/query counts;
- receipt verdict, key ID, terminal disposition, and receipt SHA-256; and
- a SHA-256 manifest for retained files.

CI uploads the generated bundle. The repository retains its schema, fixed
inputs, verification command, and a redacted example. The evidence format never
uses an Agents SDK trace or MCP return value as proof of external success.

## Live OpenAI Smoke

The same consumer supports an explicit `--live` mode. It requires an API key and
an explicit model and is never part of the deterministic CI gate. The OpenAI
model selects and proposes the same action through the same SDK and MCP path.

The sanitized live record contains only the timestamp, model, SDK/MCP versions,
OpenAI request or trace identifier, Commander action ID, final receipt hash, and
verification verdict. It must not retain the API key, complete prompt, customer
data, sensitive tool arguments, or complete model response. Missing OpenAI
request/trace identity or a verified receipt prevents a successful "OpenAI
integration verified" record.

## Implementation Shape

- Add the independent consumer package and pin the OpenAI Agents SDK version.
- Add a deterministic model implementing the public Agents SDK `Model` contract.
- Use the public `MCPServerStdio` client; do not add a custom MCP client.
- Reuse the existing Action Gateway, PostgreSQL authority, Kubernetes rollback
  adapter, reconciliation worker, evidence issuer, and verifier.
- Add a black-box integration coordinator and a static import-boundary test.
- Add root scripts for deterministic verification and the opt-in live smoke.
- Add a CI job that runs the deterministic command and uploads its evidence.

## Non-Goals

- Publishing an npm package is not required for the five-day acceptance.
- Live model quality and prompt benchmarking are not CI gates.
- The integration does not add a second action API, state machine, retry system,
  receipt format, or compatibility layer.
