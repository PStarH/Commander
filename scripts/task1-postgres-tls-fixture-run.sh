#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
FIXTURE_DIR="$ROOT_DIR/deploy/testing/postgres-tls"
STATE_DIR=${COMMANDER_POSTGRES_TLS_FIXTURE_STATE_DIR:-"$ROOT_DIR/.tmp/task1-postgres-tls-fixture"}
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-commander-postgres-tls-fixture}

mkdir -p "$STATE_DIR"
STATE_DIR=$(CDPATH= cd -- "$STATE_DIR" && pwd)

export COMPOSE_PROJECT_NAME
export FIXTURE_STATE_DIR="$STATE_DIR"

allocate_fixture_ports() {
  node --input-type=module <<'NODE'
import { createServer } from 'node:net';

const servers = [];
try {
  for (let index = 0; index < 3; index += 1) {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    servers.push(server);
  }
  process.stdout.write(`${servers.map((server) => server.address().port).join(' ')}\n`);
} finally {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
}
NODE
}

assert_port_available() {
  node --input-type=module - "$1" <<'NODE'
import { createServer } from 'node:net';

const raw = process.argv[2];
if (!/^[1-9][0-9]*$/.test(raw ?? '') || Number(raw) > 65535) process.exit(2);
const server = createServer();
server.once('error', () => process.exit(1));
server.listen(Number(raw), '127.0.0.1', () => server.close(() => process.exit(0)));
NODE
}

if [ -z "${DIRECT_PORT:-}" ] && [ -z "${L4_PORT:-}" ] && [ -z "${TERMINATING_PORT:-}" ]; then
  set -- $(allocate_fixture_ports)
  DIRECT_PORT=$1
  L4_PORT=$2
  TERMINATING_PORT=$3
elif [ -z "${DIRECT_PORT:-}" ] || [ -z "${L4_PORT:-}" ] || [ -z "${TERMINATING_PORT:-}" ]; then
  echo "DIRECT_PORT, L4_PORT, and TERMINATING_PORT must be set together" >&2
  exit 1
else
  for fixture_port in "$DIRECT_PORT" "$L4_PORT" "$TERMINATING_PORT"; do
    if ! assert_port_available "$fixture_port"; then
      echo "fixture port is invalid or already occupied: $fixture_port" >&2
      exit 1
    fi
  done
fi
export DIRECT_PORT L4_PORT TERMINATING_PORT

new_secret() {
  openssl rand -hex 32
}

export FIXTURE_POSTGRES_PASSWORD=$(new_secret)
export FIXTURE_OWNER_PASSWORD=$(new_secret)
export FIXTURE_APP_PASSWORD=$(new_secret)
export FIXTURE_TENANT_AUTHORITY_PASSWORD=$(new_secret)
export FIXTURE_SCHEDULER_PASSWORD=$(new_secret)
export FIXTURE_WORKER_PASSWORD=$(new_secret)
export FIXTURE_ADAPTER_OPS_PASSWORD=$(new_secret)

cleanup() {
  status=$?
  if [ -n "${PROXY_PID:-}" ]; then
    kill "$PROXY_PID" >/dev/null 2>&1 || true
    wait "$PROXY_PID" >/dev/null 2>&1 || true
  fi
  if [ "${KEEP_FIXTURE:-0}" != "1" ]; then
    if ! docker compose -f "$FIXTURE_DIR/compose.yaml" down --volumes --remove-orphans >/dev/null; then
      echo "failed to clean up the PostgreSQL TLS fixture" >&2
      if [ "$status" -eq 0 ]; then
        status=1
      fi
    fi
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

docker compose -f "$FIXTURE_DIR/compose.yaml" down --volumes --remove-orphans >/dev/null
"$FIXTURE_DIR/generate-certificates.sh" "$STATE_DIR"
docker compose -f "$FIXTURE_DIR/compose.yaml" up --detach --wait

# Compose can report healthy while the official image is still running its
# temporary initialization server. Wait for PID 1 to become the final postgres
# process and for every fixture role to exist before opening concurrent pools.
attempt=0
until docker compose -f "$FIXTURE_DIR/compose.yaml" exec -T postgres sh -eu -c '
  [ "$(cat /proc/1/comm)" = postgres ]
  [ "$(psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --command "SELECT count(*) FROM pg_roles WHERE rolname IN ('\''commander_owner'\'', '\''commander_app'\'', '\''commander_tenant_authority'\'', '\''commander_scheduler'\'', '\''commander_worker'\'', '\''commander_adapter_ops'\'')")" = 6 ]
' >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ]; then
    echo "fixture PostgreSQL did not finish six-role initialization" >&2
    docker compose -f "$FIXTURE_DIR/compose.yaml" logs postgres >&2
    exit 1
  fi
  sleep 0.1
done

PROXY_LOG="$STATE_DIR/proxy.log"
node "$FIXTURE_DIR/fixture-proxies.mjs" >"$PROXY_LOG" 2>&1 &
PROXY_PID=$!
attempt=0
until grep -q '^READY postgres-tls-fixture-proxies$' "$PROXY_LOG"; do
  if ! kill -0 "$PROXY_PID" >/dev/null 2>&1; then
    cat "$PROXY_LOG" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 50 ]; then
    echo "fixture proxies did not become ready" >&2
    exit 1
  fi
  sleep 0.1
done
cd "$ROOT_DIR"
pnpm exec tsx scripts/task1-postgres-tls-fixture.ts --state-dir "$STATE_DIR"
