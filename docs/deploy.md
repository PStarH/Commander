# Commander — Deployment Guide

Commander ships as a Local-First application: a single `docker compose up`
starts only the **api** and **web** services with an in-memory EventBus and no
external dependencies. Distributed execution, observability, and tracing stacks
are opt-in via Docker Compose **profiles**.

## Quick start (single-box)

```bash
cp .env.example .env
# Edit .env: set COMMANDER_API_KEY (required) and at least one LLM provider key
docker compose up
```

This starts:
- `api` on port 4000 (Commander execution engine + War Room REST API)
- `web` on port 3000 (Agent dashboard UI)

State is persisted in named volumes (`commander_state`, `commander_traces`,
`commander_memory`, `commander_results`).

## Opt-in profiles

| Profile | Adds | When to enable |
|---|---|---|
| `distributed` | Redis | Multi-node EventBus fan-out, >1 api replica |
| `observability` | Prometheus + Grafana | Production metrics collection + dashboards |
| `tracing` | Jaeger | OTLP distributed tracing of LLM + tool calls |
| `cell` | api + worker + kernel-ops + adapter-ops + postgres | L4-07 Cell v0 topology smoke |
| `v2` / `worker` | worker + kernel-ops + migrate | Durable kernel (see docker-compose.v2.yml) |

Profiles compose freely:

```bash
# Single-box with metrics dashboard
docker compose --profile observability up

# Optional ops stack (Redis + metrics + tracing) — not a certified multi-tenant SaaS deploy
docker compose --profile distributed --profile observability --profile tracing up
```

## Service endpoints (default ports)

| Service | Port | URL | Notes |
|---|---|---|---|
| api | 4000 | http://localhost:4000 | Bearer-auth via `COMMANDER_API_KEY` |
| web | 3000 | http://localhost:3000 | Reverse-proxied to api |
| Redis | 6379 | redis://redis:6379 | `distributed` profile only |
| Prometheus | 9090 | http://localhost:9090 | `observability` profile |
| Grafana | 3001 | http://localhost:3001 | `observability` profile, admin/admin default |
| Jaeger UI | 16686 | http://localhost:16686 | `tracing` profile |
| OTLP (HTTP) | 4318 | — | `tracing` profile, used by api exporter |
| OTLP (gRPC) | 4317 | — | `tracing` profile |

## Health checks

Long-running compose services expose healthchecks. The `api` service serves
`/health` and `/ready`; **kernel-ops** (worker/v2 profiles) serves
`GET /health` (process up) and `GET /ready` (ops loops started + Postgres
`SELECT 1`) on `COMMANDER_OPS_HEALTH_PORT` (compose default `8081`; `expose`
and the in-container healthcheck use the same variable). Helm values may
choose another port and must keep probes in sync. The Helm chart
wires matching `livenessProbe` / `readinessProbe` on the kernel-ops
Deployment. The `web` service waits for `api` to become healthy
(`depends_on: condition: service_healthy`), and `grafana` waits for
`prometheus`. A single `docker compose up --profile observability` therefore
boots in dependency order without manual orchestration.

Default compose is the **local / single-box** path. Durable multi-tenant
Enterprise Gateway needs a Postgres DSN + `/v1` kernel and remains **alpha**
(`ENTERPRISE_READINESS.md`).

## Environment variables

See `.env.example` for the full list. Highlights:

- `COMMANDER_API_KEY` — required, fail-fast if unset. Generate with `openssl rand -hex 32`.
- `COMMANDER_EVENT_BUS_BACKEND=redis` — switch from in-memory to Redis-backed EventBus (requires `distributed` profile).
- `COMMANDER_EVENT_BUS_REDIS_URL` — Redis connection URL (defaults to `redis://redis:6379`, the compose service name).
- `OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318` — point the OTLP exporter at the Jaeger collector (requires `tracing` profile).
- `GRAFANA_ADMIN_PASSWORD` — change from the default `admin` in production.

## Production checklist

1. **Set `COMMANDER_API_KEY`** to a strong random secret (≥32 chars). Required.
2. **Set `HOST=127.0.0.1`** when behind a reverse proxy / TLS terminator.
3. **Set `CORS_ORIGINS`** explicitly — never use `*` in production.
4. **Enable `distributed` profile** when running >1 api replica (Redis is required for cross-node EventBus consistency).
5. **Change `GRAFANA_ADMIN_PASSWORD`** from the default `admin`.
6. **Configure log persistence**: set `COMMANDER_LOG_PERSIST=true` and rotate the volume (the system auto-degrades to Error-only logging at 10000 entries of backlog).
7. **Back up the `commander_state` volume** — it contains the EventSourcingEngine WAL and is the source of truth for crash recovery.

### SQLite kernel (cell / v2 worker)

Durable kernel on SQLite (`SqliteKernelRepository`) is intended for **single-writer** cell
topology: one `kernel-ops` (or equivalent) process owns the DB file. Claims and reclaims use
`BEGIN IMMEDIATE` so concurrent connections serialize instead of emulating Postgres
`FOR UPDATE SKIP LOCKED`. Do not point multiple writers at the same SQLite file without
external locking; use Postgres for multi-writer outbox/lease throughput.

## Extending Commander

### Adding an LLM provider

One step: append a `registerProvider()` call in
[packages/core/src/runtime/providers/providerRegistry.ts](../packages/core/src/runtime/providers/providerRegistry.ts).
The registry derives `PROVIDER_ORDER` / `ENV_MAP` / `DEFAULT_URLS` / `DEFAULT_MODELS` /
`DISPLAY_NAMES` / `API_TYPE` and the factory chain automatically. No other files need
to change. See [packages/core/tests/providerRegistry.test.ts](../packages/core/tests/providerRegistry.test.ts)
for the contract that locks this in place.

### Adding an HTTP endpoint

One step: append a `registerRouter()` call in the manifest section of
[apps/api/src/index.ts](../apps/api/src/index.ts). No scattered `app.use()` needed —
`mountRegisteredRouters(app)` mounts everything in registration order. See
[apps/api/tests/routerRegistry.test.ts](../apps/api/tests/routerRegistry.test.ts) for the contract.

### Adding a plugin

Implement the `CommanderPlugin` interface (see
[packages/core/src/pluginTypes.ts](../packages/core/src/pluginTypes.ts) for the full
hook surface: 16 fire points, config schema, tool adapter). Register via
`getHookManager().register(plugin)` at boot. Third-party plugins are sandboxed
through `buildSandboxedLoadContext` so their permissions stay strictly below
the host's (see `packages/core/tests/pluginPermissions.test.ts`).

## Helm (Kubernetes) — Cell v0

The **single** Helm chart lives at [deploy/helm/commander](deploy/helm/commander).
The legacy top-level `helm/commander` chart has been removed.

Profiles:
- `values-demo.yaml` — bundled Postgres, all cell components (local/kind only)
- `values-enterprise.yaml` — external Postgres + `existingSecret` references

```bash
helm lint deploy/helm/commander -f deploy/helm/commander/values-demo.yaml
helm install commander deploy/helm/commander \
  -f deploy/helm/commander/values-enterprise.yaml \
  --set database.postgres.existingSecret=cmdr-db \
  --set api.secrets.existingSecret=cmdr-api \
  --set worker.authTokenSecret=cmdr-worker \
  --set adapterOps.secrets.existingSecret=cmdr-adapters
pnpm helm:cell-assert
```

### Cell compose profile

```bash
export COMMANDER_API_KEY="$(openssl rand -hex 32)"
export POSTGRES_PASSWORD="$(openssl rand -hex 16)"
export COMMANDER_MASTER_KEY="$(openssl rand -hex 32)"
export JWT_SECRET="$(openssl rand -hex 32)"
export COMMANDER_CAPABILITY_TOKEN_KEY="$(openssl rand -hex 32)"
export COMMANDER_INTEGRITY_KEY="$(openssl rand -hex 32)"
export COMMANDER_WORKER_AUTH_TOKEN="$(openssl rand -hex 32)"
docker compose -f docker-compose.yml -f docker-compose.cell.yml --profile cell up -d --build
pnpm cell:smoke
```

### NetworkPolicy and FQDN egress

Standard Kubernetes `NetworkPolicy` matches IP/CIDR only — not FQDN hostnames.
For SaaS adapters (GitHub, ServiceNow), configure `networkPolicy.egress.adapterCidrs`
with provider IP ranges, or use Cilium `CiliumNetworkPolicy`, Calico egress rules,
or a cluster egress proxy / service mesh. The chart **never** renders `0.0.0.0/0`
as an egress allowlist.

`sandboxd` is disabled by default (`values.sandboxd.enabled: false`) and renders
**zero** Kubernetes resources when enabled (placeholder only).
