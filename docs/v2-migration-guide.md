# Commander V2 Migration Guide

This document guides operators and developers through the migration from
legacy V1 execution paths to the Architecture V2 durable execution kernel.

## Overview

Architecture V2 enforces a strict separation between the **control plane**
(Gateway API) and the **execution plane** (Worker Service). In V2:

- The Gateway **schedules** durable work but **never executes** agents.
- Workers claim steps from the kernel and execute them in isolation.
- All state lives in PostgreSQL, not in pod-local files or process memory.

## Environment Variables

| Variable                           | Default                      | Description                                                                                                                                                                                                                          |
| ---------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `COMMANDER_V2_MODE`                | `0`                          | Set to `1` to enable V2 mode (disables legacy routes).                                                                                                                                                                               |
| `COMMANDER_KERNEL_ENABLED`         | auto                         | Durable `/v1` kernel: unset = **auto** (ON when `NODE_ENV=production`, `COMMANDER_V2_MODE=1`, or a kernel DSN is set); `1`/`true`/`on` force ON; `0`/`false`/`off` force OFF (non-prod escape hatch only — production refuses `=0`). |
| `NODE_ENV`                         | —                            | When set to `production`, V2 mode is automatically enabled.                                                                                                                                                                          |
| `COMMANDER_LEGACY_EXECUTION`       | `0`                          | Set to `1` to re-enable legacy routes in V2 mode (temporary bridge).                                                                                                                                                                 |
| `DATABASE_URL`                     | —                            | PostgreSQL connection string (required for V2 kernel).                                                                                                                                                                               |
| `COMMANDER_KERNEL_DATABASE_URL`    | falls back to `DATABASE_URL` | Preferred DSN for the shared execution kernel.                                                                                                                                                                                       |
| `COMMANDER_WORKER_BOOTSTRAP`       | —                            | Path to worker bootstrap module (default: `@commander/worker-plane/bootstrap`).                                                                                                                                                      |
| `COMMANDER_WORKER_KIND`            | `agent`                      | Worker type: `agent`, `tool`, `evaluator`.                                                                                                                                                                                           |
| `COMMANDER_WORKER_CAPABILITIES`    | `agent`                      | Comma-separated capability list.                                                                                                                                                                                                     |
| `COMMANDER_WORKER_MAX_CONCURRENCY` | `10`                         | Maximum concurrent steps per worker.                                                                                                                                                                                                 |
| `COMMANDER_WORKER_TENANTS`         | `*`                          | Comma-separated tenant IDs, or `*` for all.                                                                                                                                                                                          |
| `COMMANDER_WORKER_AUTH_TOKEN`      | —                            | Worker authentication token (required).                                                                                                                                                                                              |
| `COMMANDER_PLUGIN_SANDBOX`         | `in_process`                 | Sandbox mode: `in_process`, `subprocess`, `required`.                                                                                                                                                                                |

### Dual path (temporary)

| Surface                     | Authority                                 | Notes                                                                                                   |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POST/GET /v1/runs*`        | Shared durable kernel (`packages/kernel`) | Fail closed with `KERNEL_UNAVAILABLE` when kernel is not configured. Never writes through WarRoomStore. |
| War Room missions / UI logs | `WarRoomStore`                            | Non-`/v1` mission store only. Demoted; not the durable run authority.                                   |

## Route Migration

### Legacy Routes (Disabled in V2 Mode)

| Legacy Route                      | V2 Replacement                         | Migration Steps                                        |
| --------------------------------- | -------------------------------------- | ------------------------------------------------------ |
| `POST /api/runtime/execute`       | `POST /v1/runs`                        | Submit a WorkGraph instead of direct execution.        |
| `POST /api/orchestrator/execute`  | `POST /v1/runs`                        | Convert orchestration to a multi-step WorkGraph.       |
| `POST /api/chat`                  | `POST /v1/runs` (with agent step)      | Submit a single-step run with the chat prompt as goal. |
| `POST /api/webhook/:platform/:id` | `POST /v1/runs` (triggered by webhook) | Create a webhook handler that submits a run.           |
| `POST /api/pause/:runId`          | `POST /v1/runs/:id/pause`              | Use kernel lifecycle API.                              |
| `POST /api/resume/:runId`         | `POST /v1/runs/:id/resume`             | Use kernel lifecycle API.                              |
| `POST /api/cancel/:runId`         | `POST /v1/runs/:id/cancel`             | Use kernel lifecycle API.                              |

### V2 API Endpoints (Always Available)

| Endpoint                    | Method | Description                        |
| --------------------------- | ------ | ---------------------------------- |
| `/v1/runs`                  | POST   | Submit a new run with a WorkGraph. |
| `/v1/runs/:id`              | GET    | Get run status.                    |
| `/v1/runs/:id/steps`        | GET    | List steps for a run.              |
| `/v1/runs/:id/events`       | GET    | Get event log for a run.           |
| `/v1/runs/:id/pause`        | POST   | Pause a running run.               |
| `/v1/runs/:id/resume`       | POST   | Resume a paused run.               |
| `/v1/runs/:id/cancel`       | POST   | Cancel a run.                      |
| `/v1/runs/:id/interactions` | GET    | List human-agent interactions.     |
| `/v1/interactions/:id`      | POST   | Answer a pending interaction.      |
| `/v1/slo`                   | GET    | Get SLO status.                    |
| `/v1/alerts`                | GET    | Get active alerts.                 |
| `/v1/incidents`             | GET    | Get active incidents.              |
| `/metrics`                  | GET    | Prometheus metrics.                |
| `/health`                   | GET    | Health check.                      |

## Storage Migration

### Pod-Local → PostgreSQL

| Legacy Storage                         | V2 Storage                                      | Migration                                                    |
| -------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| `.commander/api_state.db` (SQLite)     | PostgreSQL `commander_*` tables                 | Set `DATABASE_URL`; run `pnpm db:migrate`.                   |
| `.commander/webhooks.json`             | PostgreSQL `commander_webhooks`                 | Export existing webhooks, import via control-plane API.      |
| `.commander/api_keys.json`             | PostgreSQL `commander_api_keys`                 | Export existing keys, import via control-plane API.          |
| `.commander_state/` checkpoints        | PostgreSQL `commander_runs` + `commander_steps` | Old checkpoints are incompatible; runs must be re-submitted. |
| In-memory `Map<string, ChatHistory[]>` | PostgreSQL event sourcing                       | Chat history is reconstructed from event log.                |

## Worker Deployment

### Starting a Worker

```bash
# Set required environment variables
export DATABASE_URL="postgresql://user:pass@host:5432/commander"
export COMMANDER_WORKER_AUTH_TOKEN="your-secret-token"
export COMMANDER_WORKER_ID="worker-1"
export COMMANDER_WORKER_CAPABILITIES="agent,tool"
export COMMANDER_WORKER_MAX_CONCURRENCY=10
export COMMANDER_WORKER_TENANTS="tenant-a,tenant-b"

# Start the worker
npx @commander/worker-plane
```

### Worker Authentication

Workers authenticate using a pre-shared API key. The `ApiKeyWorkerAuthenticator`
validates:

1. Token validity (timing-safe comparison)
2. Token expiry
3. Tenant scope (workers can only claim steps for authorized tenants)
4. Capability scope (workers can only execute matching step kinds)

For multi-cluster or zero-trust environments, replace `ApiKeyWorkerAuthenticator`
with a JWT/OIDC or SPIFFE-based authenticator.

## Plugin Sandbox Configuration

| Mode         | Description                                              | Use Case               |
| ------------ | -------------------------------------------------------- | ---------------------- |
| `in_process` | Execute directly in worker process (no isolation).       | Development only.      |
| `subprocess` | Execute in OS-level sandbox (seccomp/bubblewrap/Docker). | Production.            |
| `required`   | Fail-closed if no sandbox backend is available.          | Enterprise production. |

```bash
# Production sandbox configuration
export COMMANDER_PLUGIN_SANDBOX=required
export COMMANDER_PLUGIN_SANDBOX_SOFT=0  # No soft fallback
```

## Step-by-Step Migration

1. **Set up PostgreSQL** and run schema migrations:

   ```bash
   export DATABASE_URL="postgresql://..."
   pnpm db:migrate
   ```

2. **Enable V2 mode** (non-disruptive — legacy routes still work):

   ```bash
   export COMMANDER_V2_MODE=1
   export COMMANDER_LEGACY_EXECUTION=1  # temporary bridge
   ```

3. **Start workers** alongside the Gateway:

   ```bash
   export DATABASE_URL="..."
   export COMMANDER_WORKER_AUTH_TOKEN="..."
   npx @commander/worker-plane
   ```

4. **Migrate clients** to V2 API (`POST /v1/runs`).

5. **Disable legacy routes**:

   ```bash
   export COMMANDER_LEGACY_EXECUTION=0  # or simply unset it
   ```

6. **Verify** no legacy routes are accessible:
   ```bash
   curl -s http://localhost:3000/api/runtime/execute | jq .
   # Should return 404
   ```

## Verification Checklist

- [ ] `DATABASE_URL` is set and PostgreSQL is reachable.
- [ ] `COMMANDER_V2_MODE=1` is set.
- [ ] At least one worker is registered and active (`commander_workers_active > 0`).
- [ ] `POST /v1/runs` returns `202 Accepted` with a run ID.
- [ ] Steps transition from `PENDING` → `RUNNING` → `SUCCEEDED`.
- [ ] `/metrics` exposes `commander_workers_active`, `commander_runs_total`, etc.
- [ ] Legacy routes (`/api/runtime`, `/api/orchestrator`) return `404`.
- [ ] SLO dashboard at `/slo` shows 6 SLOs.
- [ ] Prometheus alerting rules are loaded.
- [ ] DR backup script runs successfully (`tsx scripts/dr-backup-verify.ts --full`).
