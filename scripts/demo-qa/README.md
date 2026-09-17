# Demo QA — Golden Path E2E

Buyer-visible end-to-end check: boots the real API server, streams SSE events,
runs the "Unbreakable Fleet" demo, and asserts recovery/fallback/completion
markers (the things a customer actually watches).

## One-time host setup (QA Postgres on port 5433)

The API fail-closes without a Postgres DSN authenticated as `commander_app`,
and the store layer requires TLS with a pinned server key. This setup uses a
**throwaway cluster that never touches any real database**.

```sh
# 1. Create an isolated cluster (trust-auth, owner = commander_owner)
mkdir -p .commander/qa-pg
/Library/PostgreSQL/17/bin/initdb -D .commander/qa-pg -U commander_owner --auth=trust -E UTF8

# 2. TLS material (3-day self-signed cert; SPKI is pinned by the test)
mkdir -p .commander/qa-pg/tls
openssl req -new -x509 -days 3 -nodes -subj '/CN=127.0.0.1' \
  -addext 'subjectAltName=IP:127.0.0.1,DNS:commander-ip-literal.invalid' \
  -keyout .commander/qa-pg/tls/server.key -out .commander/qa-pg/tls/server.crt
chmod 600 .commander/qa-pg/tls/server.key

# 3. Start with SSL on a dedicated port
/Library/PostgreSQL/17/bin/pg_ctl -D .commander/qa-pg \
  -o "-p 5433 -k /tmp -c ssl=on \
      -c ssl_cert_file=$(pwd)/.commander/qa-pg/tls/server.crt \
      -c ssl_key_file=$(pwd)/.commander/qa-pg/tls/server.key" \
  -l .commander/qa-pg/server.log start

# 4. Create the database, roles, schema, grants (idempotent)
psql -h 127.0.0.1 -p 5433 -U commander_owner -d postgres -c "CREATE DATABASE commander;"
npx tsx scripts/demo-qa/apply-qa-kernel-schema.ts
```

## Run

```sh
FAST_DEMO=1 npx tsx scripts/demo-qa/test-golden-path.ts
```

The test generates fresh random secrets per run, defaults `DATABASE_URL` to
the throwaway cluster (`postgres://commander_app:…@127.0.0.1:5433/commander?sslmode=verify-full`),
and pins the server SPKI from the QA cert. Override any of these via env:

- `DATABASE_URL`
- `COMMANDER_DATABASE_TLS_CA_FILE`
- `COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256`

To stop the cluster:

```sh
/Library/PostgreSQL/17/bin/pg_ctl -D .commander/qa-pg stop
```

## Burn-in

`burn-in-100x.sh` loops the golden path plus the marker/chaos suites. It
requires the same one-time setup above.
