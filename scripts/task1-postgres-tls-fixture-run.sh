#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
FIXTURE_DIR="$ROOT_DIR/deploy/testing/postgres-tls"
STATE_DIR=${COMMANDER_POSTGRES_TLS_FIXTURE_STATE_DIR:-"$ROOT_DIR/.tmp/task1-postgres-tls-fixture"}
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-commander-postgres-tls-fixture}

export COMPOSE_PROJECT_NAME
export FIXTURE_STATE_DIR="$STATE_DIR"
export DIRECT_PORT=${DIRECT_PORT:-55432}
export L4_PORT=${L4_PORT:-55433}
export TERMINATING_PORT=${TERMINATING_PORT:-55434}

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
    docker compose -f "$FIXTURE_DIR/compose.yaml" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  # Disable the trap to avoid re-entry, then exit with the captured status.
  trap - EXIT
  exit "$status"
}
trap cleanup EXIT INT TERM

"$FIXTURE_DIR/generate-certificates.sh" "$STATE_DIR"
# Ensure a clean slate: tear down any previously kept fixture and its volumes.
docker compose -f "$FIXTURE_DIR/compose.yaml" down --volumes --remove-orphans >/dev/null 2>&1 || true
docker compose -f "$FIXTURE_DIR/compose.yaml" up --detach --wait
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
