# Architecture V2 Gateway

**Canonical control-plane HTTP entry:** `apps/api` (default port 4000).

## Rule

- Production and enterprise deployments expose **only** `apps/api`.
- `packages/core/src/runtime/httpServer.ts` (`CommanderHttpServer`) is **deprecated**
  as a product Gateway. It may still run for embedded/CLI local tooling and ATR
  helper routes during the strangler migration.
- Do not add new product routes to `CommanderHttpServer`.

## Why

Dual HTTP planes caused overlapping auth, metrics, and lifecycle semantics.
Architecture V2 requires a single Gateway in front of the control plane
(identity, policy, audit, registries) that schedules work into the ATR kernel.

## Migration

1. Point ingress / Helm service at `apps/api`.
2. Move any unique `CommanderHttpServer` routes into `apps/api` routers.
3. Keep ATR HTTP helpers reachable via Gateway proxy if needed.
4. Remove `CommanderHttpServer` listen path from production compose/Helm.

## V1 execution resources

`/v1/runs` is the Architecture V2 submission surface. It is intentionally
asynchronous: `POST /v1/runs` requires a tenant-bound identity and an
`Idempotency-Key`, then returns `202 Accepted` with a durable run identifier.
`GET /v1/runs/{runId}` and `/events` query kernel-owned state and evidence.

Set `COMMANDER_KERNEL_ENABLED=1` and provide
`COMMANDER_KERNEL_DATABASE_URL` (or `DATABASE_URL`) before enabling V1 traffic.
The gateway initializes the shared PostgreSQL kernel at startup; V1 routes fail
closed with `KERNEL_UNAVAILABLE` when it is absent. They must never fall back
to `/api/runtime/execute`, `AgentRuntimeRegistry`, or a pod-local store.
