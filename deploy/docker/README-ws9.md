# WS9 Live-Fire Environment

Isolated docker-compose stack for the WS9 cross-tenant live-fire isolation and
compliance evidence suite (`spec/ws9-tenant-livefire-compliance.md` §3).

> **TESTING ONLY — NOT FOR PRODUCTION.** This stack uses a Vault dev server
> with root token `root`, non-HA PostgreSQL, and synthetic test fixtures. It
> exists to produce `evidenceLevel=live` test artifacts, not to run real
> workloads.

## Services

| Service         | Image / source        | Port | Purpose                                            |
|-----------------|-----------------------|------|----------------------------------------------------|
| `postgres`      | `postgres:16-alpine`  | 5432 | Real PG, RLS + `WITH CHECK`, `commander_app` non-owner role |
| `vault`         | `hashicorp/vault:latest` | 8200 | Vault dev server (KV v2), root token `root`        |
| `vault-init`    | `hashicorp/vault:latest` | —    | One-shot: writes test secrets into Vault           |
| `commander-api` | repo `Dockerfile` (`api` target) | 3000 | API on `/v1`, `/health`, `/metrics` only           |

## Prerequisites

- Docker + Docker Compose v2 (`docker compose ...`).
- Node.js + `pnpm` + `tsx` (the live-fire scripts run on the host, not in a container).
- `psql` client on the host (used by `ws9-env-check.ts` to verify the DB role/RLS).
- **gVisor (`runsc`) installed on the HOST.** `runsc` is a host-level OCI runtime
  and cannot live in a container. It also requires a **Linux host** — `runsc` is
  not available under macOS Docker Desktop. On Linux, install runsc and register
  it with the Docker daemon (`/etc/docker/daemon.json`: `{"runtimes":{"runsc":{"path":"/usr/bin/runsc"}}}`).
  Without `runsc`, the `EXEC-*` gVisor tests will skip/fail (reported as a WARN
  by `ws9-env-check`); the data/audit tests still run.
- The host shell must **not** have forbidden env vars set (`OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `*_API_KEY`, `*_SECRET`, `*_TOKEN`) — `ws9-env-check`
  enforces the allowlist at `config/keypath-allowlist.json`.

## Start

```bash
docker compose -f deploy/docker/docker-compose.ws9-livefire.yml up -d
```

The first run builds the `commander-api` image, which takes several minutes.
`vault-init` runs automatically and populates the test secrets before the API starts.

## Host-side environment for the test scripts

The scripts connect to the published ports from the host. Export these before
running `ws9-env-check` / `ws9-livefire`:

```bash
export COMMANDER_DB_HOST=localhost COMMANDER_DB_PORT=5432
export COMMANDER_DB_NAME=commander COMMANDER_DB_USER=commander_app
export COMMANDER_DB_PASSWORD=commander_app
export COMMANDER_VAULT_ADDR=http://localhost:8200 COMMANDER_VAULT_TOKEN=root
export COMMANDER_API_HOST=localhost COMMANDER_API_PORT=3000
```

## Run the environment readiness gate

Verifies (spec §3.2): PG role is non-owner/non-superuser, all target tables have
RLS with `WITH CHECK`, Vault is reachable + sealed-healthy, no forbidden env vars,
`runsc` present, and `/v1` is the only reachable gateway surface.

```bash
pnpm exec tsx scripts/ws9-env-check.ts
```

Exit code `0` = all required checks pass (WARNs are advisory). Non-zero = do not
run the live-fire suite.

## Run the live-fire suite

```bash
pnpm exec tsx scripts/ws9-livefire.ts
```

Evidence artifacts are written to `docs/baselines/ws9/`.

## Tear down

```bash
docker compose -f deploy/docker/docker-compose.ws9-livefire.yml down -v
```

`-v` removes the `pg-data`, `audit-log`, and `chain-manifest` volumes so the next
run starts from a clean schema.
