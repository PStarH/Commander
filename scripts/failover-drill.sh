#!/usr/bin/env bash
# PostgreSQL streaming-replication failover drill for Commander kernel.
#
# This script starts a primary Postgres cluster on port 15433 and a standby on
# port 15434, writes a kernel run to the primary, kills the primary, promotes
# the standby, and verifies that the run is still readable.
#
# Requires PostgreSQL 17 binaries at /Library/PostgreSQL/17/bin.

set -euo pipefail

PG_BIN="${FAILOVER_PG_BIN:-/Library/PostgreSQL/17/bin}"
PRIMARY_PORT="${FAILOVER_PRIMARY_PORT:-15433}"
STANDBY_PORT="${FAILOVER_STANDBY_PORT:-15434}"
DB="${FAILOVER_DB:-commander_failover}"
BASE_DIR="${FAILOVER_BASE_DIR:-$(mktemp -d)}"
PRIMARY_DATA="$BASE_DIR/primary"
STANDBY_DATA="$BASE_DIR/standby"
ARCHIVE_DIR="$BASE_DIR/archive"
PRIMARY_URL="postgres://postgres@127.0.0.1:$PRIMARY_PORT/$DB"
STANDBY_URL="postgres://postgres@127.0.0.1:$STANDBY_PORT/$DB"
# Generate a 32-character hex password without the SIGPIPE caused by head
# closing the pipe while tr is still writing.
REPLICATOR_PASSWORD="${FAILOVER_REPLICATOR_PASSWORD:-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')}"

if [[ ! -x "$PG_BIN/pg_ctl" ]]; then
  echo "ERROR: PostgreSQL binaries not found at $PG_BIN. Set FAILOVER_PG_BIN env var." >&2
  exit 1
fi

for p in "$PRIMARY_PORT" "$STANDBY_PORT"; do
  if command -v lsof >/dev/null 2>&1 && lsof -ti:"$p" >/dev/null 2>&1; then
    echo "ERROR: port $p is already in use" >&2
    exit 1
  fi
done

if [[ -z "$BASE_DIR" || ( "$BASE_DIR" != /tmp/* && "$BASE_DIR" != /var/folders/* ) ]]; then
  echo "ERROR: FAILOVER_BASE_DIR must be under /tmp or /var/folders (got: '$BASE_DIR')" >&2
  exit 1
fi

echo "==> Failover drill base directory: $BASE_DIR"

mkdir -p "$ARCHIVE_DIR"
chmod 700 "$ARCHIVE_DIR"

function cleanup() {
  echo "==> Cleaning up"
  "$PG_BIN/pg_ctl" -D "$PRIMARY_DATA" stop -m fast >/dev/null 2>&1 || true
  "$PG_BIN/pg_ctl" -D "$STANDBY_DATA" stop -m fast >/dev/null 2>&1 || true
  if [[ -n "$BASE_DIR" && ( "$BASE_DIR" == /tmp/* || "$BASE_DIR" == /var/folders/* ) ]]; then
    rm -rf "$BASE_DIR"
  fi
}
trap cleanup EXIT

echo "==> Initializing primary cluster"
"$PG_BIN/initdb" -D "$PRIMARY_DATA" --auth=trust --username=postgres
cat > "$PRIMARY_DATA/postgresql.conf" <<EOF
port = $PRIMARY_PORT
listen_addresses = '127.0.0.1'
wal_level = replica
archive_mode = on
archive_command = 'cp %p "$ARCHIVE_DIR"/%f'
max_wal_senders = 10
max_replication_slots = 10
max_wal_size = 1GB
max_connections = 100
EOF
cat >> "$PRIMARY_DATA/pg_hba.conf" <<EOF
host all all 127.0.0.1/32 trust
host replication all 127.0.0.1/32 trust
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
for _ in $(seq 1 50); do
  PRIMARY_LSN=$("$PG_BIN/psql" -h 127.0.0.1 -p "$PRIMARY_PORT" -U postgres -tAc "SELECT pg_current_wal_lsn()" || true)
  STANDBY_LSN=$("$PG_BIN/psql" -h 127.0.0.1 -p "$STANDBY_PORT" -U postgres -tAc "SELECT pg_last_wal_replay_lsn()" || true)
  if [ -n "$PRIMARY_LSN" ] && [ -n "$STANDBY_LSN" ] && awk -v s="$STANDBY_LSN" -v p="$PRIMARY_LSN" 'BEGIN { exit !(s >= p) }'; then
    break
  fi
  sleep 0.2
done

echo "==> Verifying run is readable on standby before failover"
pnpm --workspace-root exec tsx packages/kernel/src/disasterRecovery.ts exists "$STANDBY_URL" "$RUN_ID" "$RUN_TENANT"

echo "==> Killing primary and promoting standby"
"$PG_BIN/pg_ctl" -D "$PRIMARY_DATA" stop -m fast
"$PG_BIN/pg_ctl" -D "$STANDBY_DATA" promote -w

echo "==> Verifying run is still readable on promoted standby"
pnpm --workspace-root exec tsx packages/kernel/src/disasterRecovery.ts exists "$STANDBY_URL" "$RUN_ID" "$RUN_TENANT"

echo "==> Failover drill PASSED"
