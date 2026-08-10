# Enterprise Pilot Quickstart

This is the shortest supported path for one dedicated, self-hosted design-partner
deployment. It is an acceptance workflow, not a general SaaS signup. Shared
multi-tenant hosting remains alpha.

## What this proves

The pilot proves one reversible Kubernetes `Deployment` rollback can be proposed
by an external Agent Runtime, approved by a named operator, recovered after a
process failure, reconciled without a second write, and closed with an
independently verifiable receipt.

The Web workflow editor is a preview tool. `POST /api/workflows/:id/execute`
returns an ordered pipeline; it does not perform an external write. Consequential
work must use the Action Gateway (`/v1/actions`) or its MCP surface.

## Prerequisites

- Node 22, pnpm 9, Docker, `kind`, `kubectl`, and PostgreSQL client tools.
- A dedicated sandbox Kubernetes namespace and a named approver/escalation owner.
- A Commander API key scoped to the pilot tenant.
- A provider key supplied only at runtime. Never commit it or put it in an
  acceptance artifact.

The exact Postgres roles, TLS requirements, evidence keys, and Kind image are in
[`ci-handoff-cd.md`](../runbooks/ci-handoff-cd.md). A missing prerequisite is a
failed preflight, not permission to substitute a fake external system.

## 1. Start the dedicated stack

Use the repository's V2 compose topology for technical acceptance:

```bash
export COMMANDER_MASTER_KEY="$(openssl rand -hex 32)"
export JWT_SECRET="$(openssl rand -hex 32)"
docker compose -f deploy/docker/v2-compose.yml up -d
```

Wait for `/health` and `/ready` on the configured Gateway endpoint. Keep the
Gateway, kernel-ops, worker, and adapter-ops identities separate.

## 2. Connect the external runtime

The MCP client receives only the public Commander MCP server. Configure the
client with the installed `commander-mcp-server` binary and the Gateway identity:

```json
{
  "mcpServers": {
    "commander": {
      "command": "commander-mcp-server",
      "env": {
        "COMMANDER_PROFILE": "enterprise",
        "COMMANDER_ACTION_GATEWAY_URL": "https://commander.example",
        "COMMANDER_API_KEY": "${COMMANDER_API_KEY}",
        "COMMANDER_TENANT_ID": "${COMMANDER_TENANT_ID}"
      }
    }
  }
}
```

The Agent Runtime must discover and invoke `commander_action_*` tools over MCP.
It must not import Commander packages or call kernel/adapter functions directly.

## 3. Run the action workflow

Use the sequence below for the Kubernetes template:

1. `commander_action_simulate` checks the destination, policy, and expected
   effect without writing.
2. `commander_action_propose` records the immutable action digest.
3. A named approver calls `commander_action_approve` with the simulation id,
   policy snapshot id, and action digest.
4. The worker executes one rollback. If the process dies after the remote commit,
   restart it and call `commander_action_reconcile`.
5. Confirm reconciliation reports the external outcome and zero writes during
   reconciliation.
6. Call `commander_action_evidence` and verify the signed receipt in a separate
   process.

The deterministic external Agent Runtime acceptance is the no-key CI reference.
The live provider smoke is an opt-in compatibility check and is not a CI gate.

## 4. Stop and remove

Before teardown, export the receipt hash and the sanitized verification result.
Disable the tenant kill switch only after the action is terminal, then remove the
dedicated stack and sandbox namespace using the deployment runbook. Keep only the
sanitized evidence bundle; remove provider keys, raw payloads, and temporary
credentials.

## Acceptance rule

An independent reader who did not build the workflow must complete the install,
proposal, approval, recovery, receipt verification, kill-switch check, and
teardown from this page and the linked support runbook. Every confusion is a G7
blocker until the documentation or product path is corrected.
