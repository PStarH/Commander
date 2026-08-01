#!/usr/bin/env bash
# PostgreSQL Point-in-Time Recovery (PITR) drill for Commander kernel.
#
# This script starts an isolated temporary Postgres cluster on port 15433,
# creates a kernel run, takes a base backup, creates a second run, then
# destroys and restores the cluster to a point between the two runs.
#
# Requires PostgreSQL binaries on PATH or in PITR_PG_BIN.

set -euo pipefail

PG_BIN="${PITR_PG_BIN:-}"
if [[ -z "$PG_BIN" ]]; then
  if PATH_PG_CTL="$(command -v pg_ctl 2>/dev/null)" && [[ -n "$PATH_PG_CTL" ]]; then
    PG_BIN="$(dirname "$PATH_PG_CTL")"
  else
    PG_BIN="/Library/PostgreSQL/17/bin"
  fi
fi
PORT="${PITR_PORT:-15433}"
DB="${PITR_DB:-commander_pitr}"
DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/$DB?sslmode=verify-full"
OPENSSL_BIN="${PITR_OPENSSL_BIN:-$(command -v openssl 2>/dev/null || true)}"

for tool in pg_ctl initdb createdb psql pg_basebackup; do
  if [[ ! -x "$PG_BIN/$tool" ]]; then
    echo "ERROR: required PostgreSQL executable not found: $PG_BIN/$tool" >&2
    exit 1
  fi
done

if [[ -z "$OPENSSL_BIN" || ! -x "$OPENSSL_BIN" ]]; then
  echo "ERROR: openssl is required to generate the PITR TLS fixture" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required to verify port availability" >&2
  exit 1
fi

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( 10#$PORT < 1 || 10#$PORT > 65535 )); then
  echo "ERROR: PITR port must be an integer in 1..65535 (got: '$PORT')" >&2
  exit 1
fi

if node - "$PORT" <<'NODE'
const net = require('node:net');
const port = Number(process.argv[2]);
const server = net.createServer();
server.once('error', (error) => {
  process.exitCode = error && error.code === 'EADDRINUSE' ? 2 : 3;
});
server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
  server.close((error) => {
    process.exitCode = error ? 3 : 0;
  });
});
NODE
then
  :
else
  PORT_STATUS=$?
  if [[ "$PORT_STATUS" -eq 2 ]]; then
    echo "ERROR: port $PORT is already in use" >&2
  else
    echo "ERROR: unable to establish whether port $PORT is available" >&2
  fi
  exit 1
fi

if [[ -n "${PITR_BASE_DIR:-}" ]]; then
  mkdir -p "$PITR_BASE_DIR"
  BASE_DIR="$(mktemp -d "$PITR_BASE_DIR/.commander-pitr.XXXXXX")"
else
  BASE_DIR="$(mktemp -d)"
fi
PGDATA="$BASE_DIR/primary"
BACKUP_DIR="$BASE_DIR/basebackup"
ARCHIVE_DIR="$BASE_DIR/archive"
TLS_DIR="$BASE_DIR/tls"
CA_CERT="$TLS_DIR/ca.crt"
SERVER_CERT="$TLS_DIR/server.crt"
SERVER_KEY="$TLS_DIR/server.key"
OWNERSHIP_FILE="$BASE_DIR/.commander-pitr-owned"
OWNERSHIP_TOKEN="commander-pitr:$$:$BASE_DIR"
printf '%s\n' "$OWNERSHIP_TOKEN" > "$OWNERSHIP_FILE"

echo "==> PITR drill base directory: $BASE_DIR"

mkdir -p "$ARCHIVE_DIR" "$TLS_DIR"
chmod 700 "$ARCHIVE_DIR"

function cleanup() {
  echo "==> Cleaning up"
  "$PG_BIN/pg_ctl" -D "$PGDATA" stop -m fast >/dev/null 2>&1 || true
  if [[ -f "$OWNERSHIP_FILE" ]] && [[ "$(<"$OWNERSHIP_FILE")" == "$OWNERSHIP_TOKEN" ]]; then
    rm -rf -- "$BASE_DIR"
  else
    echo "ERROR: refusing to remove unowned PITR directory: $BASE_DIR" >&2
  fi
}
trap cleanup EXIT

generate_database_tls() {
  "$OPENSSL_BIN" genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
    -out "$TLS_DIR/ca.key" >/dev/null 2>&1
  "$OPENSSL_BIN" req -x509 -new -sha256 -days 2 -key "$TLS_DIR/ca.key" \
    -subj "/CN=commander-pitr-ca" -out "$CA_CERT"
  "$OPENSSL_BIN" genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
    -out "$SERVER_KEY" >/dev/null 2>&1
  "$OPENSSL_BIN" req -new -sha256 -key "$SERVER_KEY" \
    -subj "/CN=localhost" -out "$TLS_DIR/server.csr"
  cat > "$TLS_DIR/server.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
EOF
  "$OPENSSL_BIN" x509 -req -sha256 -days 2 -in "$TLS_DIR/server.csr" \
    -CA "$CA_CERT" -CAkey "$TLS_DIR/ca.key" -CAcreateserial \
    -extfile "$TLS_DIR/server.ext" -out "$SERVER_CERT" >/dev/null 2>&1
  chmod 600 "$TLS_DIR/ca.key" "$SERVER_KEY"
  chmod 644 "$CA_CERT" "$SERVER_CERT"
}

generate_database_tls
SERVER_SPKI_SHA256=$(
  "$OPENSSL_BIN" x509 -in "$SERVER_CERT" -pubkey -noout |
    "$OPENSSL_BIN" pkey -pubin -outform DER 2>/dev/null |
    "$OPENSSL_BIN" dgst -sha256 -hex | sed 's/^.*= //'
)
if ! [[ "$SERVER_SPKI_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
  echo "ERROR: failed to derive the PITR PostgreSQL server SPKI" >&2
  exit 1
fi
export COMMANDER_DATABASE_TLS_CA_FILE="$CA_CERT"
export COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256="$SERVER_SPKI_SHA256"
export PGSSLMODE=verify-full
export PGSSLROOTCERT="$CA_CERT"

echo "==> Initializing primary cluster"
"$PG_BIN/initdb" -D "$PGDATA" --auth=trust --username=postgres \
  --locale=C --encoding=UTF8
cp "$SERVER_CERT" "$PGDATA/server.crt"
cp "$SERVER_KEY" "$PGDATA/server.key"
chmod 600 "$PGDATA/server.key"
cat > "$PGDATA/postgresql.conf" <<EOF
port = $PORT
listen_addresses = '127.0.0.1'
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
wal_level = replica
archive_mode = on
archive_command = 'cp %p "$ARCHIVE_DIR"/%f'
max_wal_size = 1GB
max_connections = 100
EOF
cat > "$PGDATA/pg_hba.conf" <<EOF
local all all trust
hostssl all all 127.0.0.1/32 trust
hostssl replication all 127.0.0.1/32 trust
hostnossl all all 127.0.0.1/32 reject
hostnossl replication all 127.0.0.1/32 reject
EOF
"$PG_BIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/log" start -w
"$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U postgres "$DB"

echo "==> Creating runA"
RUNA_JSON=$(pnpm --workspace-root exec tsx packages/kernel/src/drillWorkload.ts "$DATABASE_URL")
RUNA_ID=$(echo "$RUNA_JSON" | pnpm --workspace-root exec tsx -e 'process.stdin.on("data", d => console.log(JSON.parse(d).id))')
RUNA_TENANT=$(echo "$RUNA_JSON" | pnpm --workspace-root exec tsx -e 'process.stdin.on("data", d => console.log(JSON.parse(d).tenantId))')
echo "    runA: $RUNA_ID (tenant $RUNA_TENANT)"

echo "==> Taking base backup"
"$PG_BIN/pg_basebackup" -h 127.0.0.1 -p "$PORT" -U postgres -D "$BACKUP_DIR" -Fp -Xs -P

# Force WAL switch so the archive contains the WAL covering the backup.
"$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d "$DB" -c "SELECT pg_switch_wal()" >/dev/null
sleep 1

# Include an explicit +0000 offset so PostgreSQL does not interpret the target
# in the server's local timezone (e.g. Asia/Shanghai).
PITR_TIME=$(date -u +"%Y-%m-%d %H:%M:%S%z")
echo "==> PITR target time: $PITR_TIME"
sleep 1

echo "==> Creating runB (should not appear after restore)"
RUNB_JSON=$(pnpm --workspace-root exec tsx packages/kernel/src/drillWorkload.ts "$DATABASE_URL")
RUNB_ID=$(echo "$RUNB_JSON" | pnpm --workspace-root exec tsx -e 'process.stdin.on("data", d => console.log(JSON.parse(d).id))')
RUNB_TENANT=$(echo "$RUNB_JSON" | pnpm --workspace-root exec tsx -e 'process.stdin.on("data", d => console.log(JSON.parse(d).tenantId))')
echo "    runB: $RUNB_ID (tenant $RUNB_TENANT)"

echo "==> Destroying primary data directory and restoring from backup"
"$PG_BIN/pg_ctl" -D "$PGDATA" stop -m fast
rm -rf "$PGDATA"
cp -r "$BACKUP_DIR" "$PGDATA"

cat > "$PGDATA/recovery.signal" <<EOF
EOF
cat >> "$PGDATA/postgresql.conf" <<EOF
recovery_target_time = '$PITR_TIME'
recovery_target_inclusive = true
restore_command = 'cp "$ARCHIVE_DIR/%f" %p'
EOF

echo "==> Starting restored cluster"
"$PG_BIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/log" start -w

echo "==> Verifying PITR"
pnpm --workspace-root exec tsx packages/kernel/src/disasterRecovery.ts exists "$DATABASE_URL" "$RUNA_ID" "$RUNA_TENANT"
pnpm --workspace-root exec tsx packages/kernel/src/disasterRecovery.ts missing "$DATABASE_URL" "$RUNB_ID" "$RUNB_TENANT"

echo "==> PITR drill PASSED"
