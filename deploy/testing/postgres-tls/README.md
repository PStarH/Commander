# Task 1 PostgreSQL TLS Live Fixture

This directory contains a self-contained, six-role PostgreSQL TLS fixture used to
prove that direct TLS and L4 passthrough connections succeed, while wrong CA,
wrong hostname, wrong SPKI, and a terminating TLS proxy are rejected.

## Why fixture roles?

The fixture uses its own `fixture_*` PostgreSQL roles instead of the production
`commander_*` roles. This keeps the fixture isolated from kernel, migration,
Compose, Helm, and spec files, which must not be modified for this task.

## Roles

| Logical role | PostgreSQL role |
|--------------|-----------------|
| owner | `fixture_owner` |
| app | `fixture_app` |
| tenant-authority | `fixture_tenant_authority` |
| scheduler | `fixture_scheduler` |
| worker | `fixture_worker` |
| adapter-ops | `fixture_adapter_ops` |

All six roles connect to the same `fixture` database and therefore observe the
same database OID, database name, and server SPKI.

## Run the fixture

From the repository root (the worktree needs its own `node_modules` because the
runner uses `pnpm exec tsx`):

```bash
pnpm install --frozen-lockfile
bash scripts/task1-postgres-tls-fixture-run.sh
```

The script:

1. Generates a trusted CA, an untrusted CA, a server certificate, and a
   terminator certificate into `.tmp/task1-postgres-tls-fixture`.
2. Starts PostgreSQL 16 via Docker Compose with TLS enabled.
3. Starts an L4 passthrough proxy and a terminating TLS proxy on
   `127.0.0.1:55433` and `127.0.0.1:55434`.
4. Runs `scripts/task1-postgres-tls-fixture.ts` to exercise the matrix and
   produce `tls-evidence.json`.
5. Tears down proxies and Compose on exit (set `KEEP_FIXTURE=1` to keep it).

## Test without Docker

```bash
node --import tsx --test scripts/task1-postgres-tls-fixture.test.ts
```

## Ports

| Port | Purpose |
|------|---------|
| 55432 | Direct PostgreSQL TLS |
| 55433 | L4 TLS passthrough proxy |
| 55434 | Terminating TLS proxy |

## Files

- `compose.yaml` — PostgreSQL container with TLS.
- `generate-certificates.sh` — Generates CA and leaf certificates.
- `postgres-entrypoint.sh` — Installs TLS material before starting Postgres.
- `fixture-role-init.sh` — Creates the six fixture roles.
- `fixture-proxies.mjs` — L4 passthrough and terminating TLS proxies.
