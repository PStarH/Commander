# Commander Integrations

First-class MCP integrations that let external coding agents (Codex CLI, Pi /
OH-MY-PI) reach Commander's governed Action Gateway instead of running
unreviewed tool calls locally.

## What this gives you

| Capability            | Behavior                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Tool discovery**    | Two mutually exclusive surfaces, selected by `COMMANDER_MCP_LOCAL_RUNTIME`. Default (unset): the four agent-facing gateway tools (`commander_action_propose`, `commander_action_simulate`, `commander_action_get`, `commander_action_evidence`). Local runtime mode (`COMMANDER_MCP_LOCAL_RUNTIME=1`): the model-router tools (`execute_agent`, `list_models`, `route_task`) plus the local Commander tools. |
| **Governed routing**  | Tools that require human approval are **not** executed locally. The server derives trusted MCP provenance (`source`, `package`, and `model`) and sends the action envelope to the Action Gateway, which returns a `WAITING_FOR_APPROVAL` action. Approval and rejection are deliberately absent from the agent MCP surface and remain available only to a human through the governance UI / API.             |
| **Fail closed**       | Without a configured gateway executor the server refuses the call with an `ACTION_GATEWAY_REQUIRED` error — never falls through to a silent local execution.                                                                                                                                                                                                                                                 |
| **Idempotent replay** | Gateway-proposed actions carry an idempotency key derived from the tool call, so re-submitting the same call returns `idempotentReplay: true` instead of creating a duplicate.                                                                                                                                                                                                                               |

For proposal and simulation, agents submit a registered action name such as
`ticket.create` plus `args`. The MCP server derives the tool, effect type, and
destination; callers cannot choose those governance dimensions.

## Requirements

- Built MCP server: `pnpm run build:integrations`
  (or `pnpm --filter @commander/mcp-server build`)
- Action Gateway reachable at `COMMANDER_ACTION_GATEWAY_URL`
  (default `http://127.0.0.1:4000`, started with `pnpm dev:api`)
- Optional `COMMANDER_API_KEY` when the gateway requires an API key.

## Codex CLI (OpenAI Codex)

Codex only auto-discovers `<repo-root>/.codex/config.toml`, and this repo's
`.gitignore` excludes `.codex/`. The committed reference lives at
`integrations/codex/config.toml`; copy it into place:

```bash
cp integrations/codex/config.toml .codex/config.toml
pnpm run build:integrations
pnpm dev:api
codex
```

## Pi (OH-MY-PI)

OH-MY-PI reads `integrations/pi/.omp/mcp.json`. Merge its `commander` entry
into your project's MCP config (`.omp/mcp.json`), then:

```bash
pnpm run build:integrations
pnpm dev:api
pi
```

## Running the example

`integrations/examples/governed-ticket-lifecycle.ts` drives a
`ticket.create` tool call through the gateway executor and prints the
proposed action + human-approval gateway response:

```bash
COMMANDER_API_KEY=your-key pnpm exec tsx integrations/examples/governed-ticket-lifecycle.ts
```

## Tests

```bash
pnpm run test:codex         # integrations/codex — TOML config + MCP discovery + governed lifecycle + fail-closed
pnpm run test:pi            # integrations/pi   — mcp.json config + same MCP suite
pnpm run test:integrations  # build + run both suites
```

Each suite asserts:

1. The committed config advertises the Commander MCP server pointing at
   `./packages/mcp-server/dist/cli.js` and the gateway URL.
2. `tools/list` returns the four agent-facing gateway tools (`commander_action_*`), excluding approval and reconciliation.
3. Routing a `requireApproval` tool through the gateway executor completes
   the full governed lifecycle (propose → digest-mismatch 409 at approve →
   approve → claim/admit/complete effect+step → evidence export with PII
   redaction → terminal reconcile).
4. Calling the tool **without** a gateway executor fails closed with
   `ACTION_GATEWAY_REQUIRED` and never runs the local handler.
