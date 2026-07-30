#!/usr/bin/env bash
# PostgreSQL streaming-replication failover drill for Commander kernel.
#
# This script starts a primary Postgres cluster on port 15433 and a standby on
# port 15434, writes a kernel run to the primary, kills the primary, promotes
# the standby, and verifies that the run is still readable.
#
# Requires PostgreSQL binaries on PATH or in FAILOVER_PG_BIN.

set -euo pipefail

PG_BIN="${FAILOVER_PG_BIN:-}"
if [[ -z "$PG_BIN" ]]; then
  if PATH_PG_CTL="$(command -v pg_ctl 2>/dev/null)" && [[ -n "$PATH_PG_CTL" ]]; then
    PG_BIN="$(dirname "$PATH_PG_CTL")"
  else
    PG_BIN="/Library/PostgreSQL/17/bin"
  fi
fi
PRIMARY_PORT="${FAILOVER_PRIMARY_PORT:-15433}"
STANDBY_PORT="${FAILOVER_STANDBY_PORT:-15434}"
DB="${FAILOVER_DB:-commander_failover}"
PRIMARY_URL="postgres://postgres@127.0.0.1:$PRIMARY_PORT/$DB?sslmode=verify-full"
STANDBY_URL="postgres://postgres@127.0.0.1:$STANDBY_PORT/$DB?sslmode=verify-full"
CATCHUP_ATTEMPTS="${FAILOVER_CATCHUP_ATTEMPTS:-50}"
CATCHUP_DELAY="${FAILOVER_CATCHUP_DELAY:-0.2}"
OPENSSL_BIN="${FAILOVER_OPENSSL_BIN:-$(command -v openssl 2>/dev/null || true)}"
# Generate a 32-character hex password without the SIGPIPE caused by head
# closing the pipe while tr is still writing.
REPLICATOR_PASSWORD="${FAILOVER_REPLICATOR_PASSWORD:-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')}"

for tool in pg_ctl initdb createdb psql pg_basebackup; do
  if [[ ! -x "$PG_BIN/$tool" ]]; then
    echo "ERROR: required PostgreSQL executable not found: $PG_BIN/$tool" >&2
    exit 1
  fi
done

if [[ -z "$OPENSSL_BIN" || ! -x "$OPENSSL_BIN" ]]; then
  echo "ERROR: openssl is required to generate the failover TLS fixture" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required to verify port availability" >&2
  exit 1
fi

validate_port() {
  local label="$1"
  local port="$2"
  if ! [[ "$port" =~ ^[0-9]+$ ]] || (( 10#$port < 1 || 10#$port > 65535 )); then
    echo "ERROR: $label port must be an integer in 1..65535 (got: '$port')" >&2
    exit 1
  fi
}

assert_port_available() {
  local port="$1"
  local status
  if node - "$port" <<'NODE'
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
    return 0
  else
    status=$?
  fi

  if [[ "$status" -eq 2 ]]; then
    echo "ERROR: port $port is already in use" >&2
  else
    echo "ERROR: unable to establish whether port $port is available" >&2
  fi
  exit 1
}

validate_port "primary" "$PRIMARY_PORT"
validate_port "standby" "$STANDBY_PORT"
if (( 10#$PRIMARY_PORT == 10#$STANDBY_PORT )); then
  echo "ERROR: primary and standby ports must be different" >&2
  exit 1
fi
if ! [[ "$CATCHUP_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: FAILOVER_CATCHUP_ATTEMPTS must be a positive integer" >&2
  exit 1
fi
if ! [[ "$CATCHUP_DELAY" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "ERROR: FAILOVER_CATCHUP_DELAY must be a non-negative number" >&2
  exit 1
fi
assert_port_available "$PRIMARY_PORT"
assert_port_available "$STANDBY_PORT"

if [[ -n "${FAILOVER_BASE_DIR:-}" ]]; then
  mkdir -p "$FAILOVER_BASE_DIR"
  BASE_DIR="$(mktemp -d "$FAILOVER_BASE_DIR/.commander-failover.XXXXXX")"
else
  BASE_DIR="$(mktemp -d)"
fi
PRIMARY_DATA="$BASE_DIR/primary"
STANDBY_DATA="$BASE_DIR/standby"
ARCHIVE_DIR="$BASE_DIR/archive"
TLS_DIR="$BASE_DIR/tls"
CA_CERT="$TLS_DIR/ca.crt"
SERVER_CERT="$TLS_DIR/server.crt"
SERVER_KEY="$TLS_DIR/server.key"
OWNERSHIP_FILE="$BASE_DIR/.commander-failover-owned"
OWNERSHIP_TOKEN="commander-failover:$$:$BASE_DIR"
printf '%s\n' "$OWNERSHIP_TOKEN" > "$OWNERSHIP_FILE"

echo "==> Failover drill base directory: $BASE_DIR"

mkdir -p "$ARCHIVE_DIR" "$TLS_DIR"
chmod 700 "$ARCHIVE_DIR"

function cleanup() {
  echo "==> Cleaning up"
  "$PG_BIN/pg_ctl" -D "$PRIMARY_DATA" stop -m fast >/dev/null 2>&1 || true
  "$PG_BIN/pg_ctl" -D "$STANDBY_DATA" stop -m fast >/dev/null 2>&1 || true
  if [[ -f "$OWNERSHIP_FILE" ]] && [[ "$(<"$OWNERSHIP_FILE")" == "$OWNERSHIP_TOKEN" ]]; then
    rm -rf -- "$BASE_DIR"
  else
    echo "ERROR: refusing to remove unowned failover directory: $BASE_DIR" >&2
  fi
}
trap cleanup EXIT

generate_database_tls() {
  "$OPENSSL_BIN" genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
    -out "$TLS_DIR/ca.key" >/dev/null 2>&1
  "$OPENSSL_BIN" req -x509 -new -sha256 -days 2 -key "$TLS_DIR/ca.key" \
    -subj "/CN=commander-failover-ca" -out "$CA_CERT"
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
  echo "ERROR: failed to derive the failover PostgreSQL server SPKI" >&2
  exit 1
fi
export COMMANDER_DATABASE_TLS_CA_FILE="$CA_CERT"
export COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256="$SERVER_SPKI_SHA256"
export PGSSLMODE=verify-full
export PGSSLROOTCERT="$CA_CERT"

echo "==> Initializing primary cluster"
"$PG_BIN/initdb" -D "$PRIMARY_DATA" --auth=trust --username=postgres \
  --locale=C --encoding=UTF8
cp "$SERVER_CERT" "$PRIMARY_DATA/server.crt"
cp "$SERVER_KEY" "$PRIMARY_DATA/server.key"
chmod 600 "$PRIMARY_DATA/server.key"
cat > "$PRIMARY_DATA/postgresql.conf" <<EOF
port = $PRIMARY_PORT
listen_addresses = '127.0.0.1'
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
wal_level = replica
archive_mode = on
archive_command = 'cp %p "$ARCHIVE_DIR"/%f'
max_wal_senders = 10
max_replication_slots = 10
max_wal_size = 1GB
max_connections = 100
EOF
cat > "$PRIMARY_DATA/pg_hba.conf" <<EOF
local all all trust
hostssl all all 127.0.0.1/32 trust
hostssl replication all 127.0.0.1/32 trust
hostnossl all all 127.0.0.1/32 reject
hostnossl replication all 127.0.0.1/32 reject
EOF
"$PG_BIN/pg_ctl" -D "$PRIMARY_DATA" -l "$PRIMARY_DATA/log" start -w
"$PG_BIN/createdb" -h 127.0.0.1 -p "$PRIMARY_PORT" -U postgres "$DB"

"$PG_BIN/psql" -h 127.0.0.1 -p "$PRIMARY_PORT" -U postgres -d "$DB" \
  -c "CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '$REPLICATOR_PASSWORD'" >/dev/null
"$PG_BIN/psql" -h 127.0.0.1 -p "$PRIMARY_PORT" -U postgres -d "$DB" \
  -c "SELECT pg_create_physical_replication_slot('failover_slot')" >/dev/null

echo "==> Cloning standby from primary"
"$PG_BIN/pg_basebackup" -h 127.0.0.1 -p "$PRIMARY_PORT" -U replicator \
  -D "$STANDBY_DATA" -Fp -Xs -P -R -S failover_slot
cat >> "$STANDBY_DATA/postgresql.conf" <<EOF
port = $STANDBY_PORT
hot_standby = on
EOF
"$PG_BIN/pg_ctl" -D "$STANDBY_DATA" -l "$STANDBY_DATA/log" start -w

echo "==> Creating workload on primary"
RUN_JSON=$(pnpm --workspace-root exec tsx packages/kernel/src/drillWorkload.ts "$PRIMARY_URL")
RUN_ID=$(echo "$RUN_JSON" | pnpm --workspace-root exec tsx -e 'process.stdin.on("data", d => console.log(JSON.parse(d).id))')
RUN_TENANT=$(echo "$RUN_JSON" | pnpm --workspace-root exec tsx -e 'process.stdin.on("data", d => console.log(JSON.parse(d).tenantId))')
echo "    run: $RUN_ID (tenant $RUN_TENANT)"

echo "==> Waiting for standby to catch up"
STANDBY_CAUGHT_UP=false
for ((attempt = 1; attempt <= CATCHUP_ATTEMPTS; attempt++)); do
  PRIMARY_LSN=$("$PG_BIN/psql" -h 127.0.0.1 -p "$PRIMARY_PORT" -U postgres -tAc "SELECT pg_current_wal_lsn()" || true)
  if [[ "$PRIMARY_LSN" =~ ^[0-9A-Fa-f]+/[0-9A-Fa-f]+$ ]]; then
    REPLAYED=$("$PG_BIN/psql" -h 127.0.0.1 -p "$STANDBY_PORT" -U postgres \
      -tAc "SELECT COALESCE(pg_last_wal_replay_lsn() >= '$PRIMARY_LSN'::pg_lsn, false)" || true)
    if [[ "$REPLAYED" == "t" ]]; then
      STANDBY_CAUGHT_UP=true
      break
    fi
  fi
  sleep "$CATCHUP_DELAY"
done
if [[ "$STANDBY_CAUGHT_UP" != true ]]; then
  echo "ERROR: standby failed to catch up after $CATCHUP_ATTEMPTS attempts" >&2
  exit 1
fi

echo "==> Verifying run is readable on standby before failover"
pnpm --workspace-root exec tsx packages/kernel/src/disasterRecovery.ts exists "$STANDBY_URL" "$RUN_ID" "$RUN_TENANT"

echo "==> Killing primary and promoting standby"
"$PG_BIN/pg_ctl" -D "$PRIMARY_DATA" stop -m fast
"$PG_BIN/pg_ctl" -D "$STANDBY_DATA" promote -w

echo "==> Verifying run is still readable on promoted standby"
pnpm --workspace-root exec tsx packages/kernel/src/disasterRecovery.ts exists "$STANDBY_URL" "$RUN_ID" "$RUN_TENANT"

echo "==> Failover drill PASSED"
