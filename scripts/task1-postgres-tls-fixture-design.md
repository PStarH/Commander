# Task 1 PostgreSQL TLS Live Fixture — Design Spec

## Scope

Create a self-contained live fixture that proves the six Task 1 PostgreSQL roles can connect to a real PostgreSQL 16 instance over TLS with SPKI pinning, and that TLS termination, wrong CA, wrong hostname, and wrong SPKI are all rejected.

Only these paths may be changed:

- `scripts/task1-postgres-tls-fixture*` (design, runner, implementation, test, pool helper)
- `deploy/testing/postgres-tls/*` (Docker Compose, certificate generation, entrypoint, role init, proxies)

No changes to kernel, migrations, Compose/Helm, spec, or other packages.

## Roles and DSNs

Because we must not modify production kernel/migration/Compose/Helm/spec files, the fixture uses six fixture-only PostgreSQL roles instead of the real `commander_*` roles. The TLS and SPKI properties being proven are independent of the role names, and using fixture roles keeps the fixture self-contained.

Six fixture-only PostgreSQL roles:

| Logical role | PostgreSQL role | Environment variable for password |
|--------------|-----------------|-----------------------------------|
| owner        | `fixture_owner` | `FIXTURE_OWNER_PASSWORD` |
| app          | `fixture_app` | `FIXTURE_APP_PASSWORD` |
| tenant-authority | `fixture_tenant_authority` | `FIXTURE_TENANT_AUTHORITY_PASSWORD` |
| scheduler    | `fixture_scheduler` | `FIXTURE_SCHEDULER_PASSWORD` |
| worker       | `fixture_worker` | `FIXTURE_WORKER_PASSWORD` |
| adapter-ops  | `fixture_adapter_ops` | `FIXTURE_ADAPTER_OPS_PASSWORD` |

Each role gets an distinct `postgres://<role>:<password>@localhost:<port>/fixture?sslmode=verify-full` DSN.

## Network topology

Three ports are exposed on `127.0.0.1`:

| Port | Route | Purpose |
|------|-------|---------|
| `DIRECT_PORT` (default 55432) | Direct to PostgreSQL | TLS terminates at PostgreSQL with `postgres.crt`. |
| `L4_PORT` (default 55433) | L4 passthrough proxy | Raw TCP proxy to DIRECT_PORT; SPKI stays the same. |
| `TERMINATING_PORT` (default 55434) | Terminating TLS proxy | Presents a different leaf cert (`terminator.crt`) and closes after handshake. |

## Identity invariant

All six roles connect to the same PostgreSQL cluster and therefore observe the same:

- `database_oid` (`SELECT database.oid FROM pg_database WHERE datname = current_database()`)
- `database_name` (`fixture`)
- server SPKI SHA-256 fingerprint (`COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256`)

The test asserts one unique identity tuple across all positive proofs.

## Success cases

For every role, two success cases must pass:

1. Direct TLS to PostgreSQL.
2. TLS through the L4 passthrough proxy.

Each success proof records:

```ts
{
  role,          // logical role name
  databaseRole,  // PostgreSQL role name
  route,         // 'direct' | 'l4-passthrough'
  databaseOid,
  databaseName,
  serverSpkiSha256,
  tlsActive,     // must be true (from pg_stat_ssl.ssl)
  challenge,     // fresh UUID returned by Postgres per query
}
```

## Failure cases

Negative checks using the owner DSN:

| Name | Expected rejection |
|------|-------------------|
| untrusted CA | `ca-rejection` |
| wrong hostname (`127.0.0.1`) | `hostname-rejection` |
| wrong SPKI pin | `spki-rejection` (`COMMANDER_DATABASE_SERVER_SPKI_MISMATCH`) |
| terminating proxy | `spki-rejection` (different SPKI from terminator cert) |

## SPKI-verified pool helper

Because `packages/postgres-runtime` does not exist on the target branch, the SPKI verification logic is inlined into `scripts/task1-postgres-tls-fixture-pool.ts`.

Behavior:

- Parses DSN as a URL, enforces `sslmode=verify-full`, and rejects any other `ssl*` query parameters.
- Reads trusted CA from `COMMANDER_DATABASE_TLS_CA_FILE`.
- Reads expected SPKI from `COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256`.
- Builds a `pg.Pool` with `rejectUnauthorized: true`, a custom `checkServerIdentity` callback, and an SNI `servername` that forces the callback even for IP literal hosts.
- In `checkServerIdentity`, first validates hostname using Node's default TLS identity check, then extracts the leaf SPKI from the raw certificate and compares it against the expected SHA-256 using `timingSafeEqual`.

## Evidence hygiene

The fixture writes `tls-evidence.json` to the state directory. Before writing, the runner asserts that:

- The JSON does not contain a `postgres://` DSN, `password`, `credential`, `secret`, `dsn`, or `connectionString`.
- The proof count is exactly `roles × 2` (12).
- All proofs share the same `databaseOid`, `databaseName`, and `serverSpkiSha256`.
- Every proof has a unique `challenge` UUID returned by Postgres.

## Running the fixture

The maintained command is the shell script; no root `package.json` script is added because that file is outside the allowed change set.

```bash
bash scripts/task1-postgres-tls-fixture-run.sh
```

Implemented by `scripts/task1-postgres-tls-fixture-run.sh`:

1. Generate CA/server/terminator certificates into a state directory.
2. Spin up PostgreSQL via `deploy/testing/postgres-tls/compose.yaml`.
3. Start L4 and terminating proxies.
4. Run `scripts/task1-postgres-tls-fixture.ts`.
5. Tear down proxies and Compose on exit (unless `KEEP_FIXTURE=1`).

## Automated tests

`scripts/task1-postgres-tls-fixture.test.ts` covers:

- Matrix construction: 12 success cases (6 roles × 2 routes) and 4 negative cases.
- Evidence scrubbing: secret leak detection, duplicate challenge rejection, proof count, route coverage per role.
- Failure pattern matching: CA, hostname, and SPKI rejection patterns are accepted; generic network errors are not.

## Verification plan

1. Run the unit tests with `node --import tsx --test scripts/task1-postgres-tls-fixture.test.ts`.
2. Run the live fixture with `pnpm task1-postgres-tls-fixture` (requires Docker).
3. Inspect `tls-evidence.json` to confirm no secrets and a single shared SPKI/OID/name.
