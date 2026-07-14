#!/usr/bin/env bash
# PostgreSQL Point-in-Time Recovery (PITR) drill for Commander kernel.
#
# This script starts an isolated temporary Postgres cluster on port 15433,
# creates a kernel run, takes a base backup, creates a second run, then
# destroys and restores the cluster to a point between the two runs.
#
# Requires PostgreSQL 17 binaries at /Library/PostgreSQL/17/bin.

set -euo pipefail

PG_BIN="${PITR_PG_BIN:-/Library/PostgreSQL/17/bin}"
PORT="${PITR_PORT:-15433}"
DB="${PITR_DB:-commander_pitr}"
BASE_DIR="${PITR_BASE_DIR:-$(mktemp -d)}"
PGDATA="$BASE_DIR/primary"
BACKUP_DIR="$BASE_DIR/basebackup"
ARCHIVE_DIR="$BASE_DIR/archive"
DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/$DB"

if [[ ! -x "$PG_BIN/pg_ctl" ]]; then
  echo "ERROR: PostgreSQL binaries not found at $PG_BIN. Set PITR_PG_BIN env var." >&2
  exit 1
fi

if command -v lsof >/dev/null 2>&1 && lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "ERROR: port $PORT is already in use" >&2
  exit 1
fi

if [[ -z "$BASE_DIR" || ( "$BASE_DIR" != /tmp/* && "$BASE_DIR" != /var/folders/* ) ]]; then
  echo "ERROR: PITR_BASE_DIR must be under /tmp or /var/folders (got: '$BASE_DIR')" >&2
  exit 1
fi

echo "==> PITR drill base directory: $BASE_DIR"

mkdir -p "$ARCHIVE_DIR"
chmod 700 "$ARCHIVE_DIR"

function cleanup() {
  echo "==> Cleaning up"
  "$PG_BIN/pg_ctl" -D "$PGDATA" stop -m fast >/dev/null 2>&1 || true
  if [[ -n "$BASE_DIR" && ( "$BASE_DIR" == /tmp/* || "$BASE_DIR" == /var/folders/* ) ]]; then
    rm -rf "$BASE_DIR"
  fi
}
trap cleanup EXIT

echo "==> Initializing primary cluster"
"$PG_BIN/initdb" -D "$PGDATA" --auth=trust --username=postgres
cat > "$PGDATA/postgresql.conf" <<EOF
port = $PORT
listen_addresses = '127.0.0.1'
wal_level = replica
archive_mode = on
archive_command = 'cp %p "$ARCHIVE_DIR"/%f'
max_wal_size = 1GB
max_connections = 100
EOF
cat >> "$PGDATA/pg_hba.conf" <<EOF
host all all 127.0.0.1/32 trust
host replication all 127.0.0.1/32 trust
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
