#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
FIXTURE_DIR="$ROOT_DIR/deploy/testing/postgres-tls"
STATE_DIR=${OPENAI_AGENTS_MCP_FIXTURE_STATE_DIR:-"$ROOT_DIR/.tmp/openai-agents-mcp-acceptance-$$"}
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-"commander-openai-agents-acceptance-$$"}
COMPOSE_PROGRESS=plain

allocate_port() {
  node --input-type=module <<'NODE'
import { createServer } from 'node:net';
const server = createServer();
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') process.exit(1);
process.stdout.write(String(address.port));
await new Promise((resolve) => server.close(resolve));
NODE
}

new_secret() {
  openssl rand -hex 32
}

DIRECT_PORT=${OPENAI_AGENTS_MCP_POSTGRES_PORT:-$(allocate_port)}
mkdir -p "$STATE_DIR"
STATE_DIR=$(CDPATH= cd -- "$STATE_DIR" && pwd)

export COMPOSE_PROJECT_NAME COMPOSE_PROGRESS DIRECT_PORT
export FIXTURE_STATE_DIR="$STATE_DIR"
export FIXTURE_POSTGRES_PASSWORD=$(new_secret)
export FIXTURE_OWNER_PASSWORD=$(new_secret)
export FIXTURE_APP_PASSWORD=$(new_secret)
export FIXTURE_TENANT_AUTHORITY_PASSWORD=$(new_secret)
export FIXTURE_SCHEDULER_PASSWORD=$(new_secret)
export FIXTURE_WORKER_PASSWORD=$(new_secret)
export FIXTURE_ADAPTER_OPS_PASSWORD=$(new_secret)

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker compose -f "$FIXTURE_DIR/compose.yaml" logs --no-color postgres >&2 || true
  fi
  if [ "${KEEP_FIXTURE:-0}" = "2" ]; then
    printf '%s\n' "OPENAI_AGENTS_MCP_FIXTURE_PRESERVED=$COMPOSE_PROJECT_NAME" >&2
  elif ! docker compose -f "$FIXTURE_DIR/compose.yaml" down --volumes --remove-orphans >/dev/null; then
    [ "$status" -ne 0 ] || status=1
  fi
  if [ "${KEEP_FIXTURE:-0}" != "1" ]; then
    find "$STATE_DIR" -type f -delete 2>/dev/null || true
    find "$STATE_DIR" -depth -type d -empty -delete 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

"$FIXTURE_DIR/generate-certificates.sh" "$STATE_DIR"
docker compose -f "$FIXTURE_DIR/compose.yaml" up --detach --wait

attempt=0
until docker compose -f "$FIXTURE_DIR/compose.yaml" exec -T postgres sh -eu -c '
  [ "$(cat /proc/1/comm)" = postgres ]
  [ "$(psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --command "SELECT count(*) FROM pg_roles WHERE rolname IN ('\''commander_owner'\'', '\''commander_app'\'', '\''commander_tenant_authority'\'', '\''commander_scheduler'\'', '\''commander_worker'\'', '\''commander_adapter_ops'\'')")" = 6 ]
' >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ]; then
    echo "OPENAI_AGENTS_MCP_POSTGRES_NOT_READY" >&2
    exit 1
  fi
  sleep 0.1
done

docker compose -f "$FIXTURE_DIR/compose.yaml" exec -T postgres \
  psql --set ON_ERROR_STOP=1 --username fixture_bootstrap --dbname fixture <<'SQL'
ALTER DATABASE fixture OWNER TO commander_owner;
ALTER SCHEMA public OWNER TO commander_owner;
GRANT commander_app TO commander_owner WITH ADMIN OPTION, INHERIT FALSE, SET TRUE;
GRANT commander_tenant_authority TO commander_owner WITH ADMIN OPTION, INHERIT FALSE, SET TRUE;
GRANT commander_scheduler TO commander_owner WITH ADMIN OPTION, INHERIT FALSE, SET TRUE;
GRANT commander_worker TO commander_owner WITH ADMIN OPTION, INHERIT FALSE, SET TRUE;
GRANT commander_adapter_ops TO commander_owner WITH ADMIN OPTION, INHERIT FALSE, SET TRUE;
SQL

EXPECTED_SPKI=$(openssl x509 -in "$STATE_DIR/postgres.crt" -pubkey -noout \
  | openssl pkey -pubin -outform DER \
  | openssl dgst -sha256 -hex \
  | awk '{print $2}')
if ! printf '%s\n' "$EXPECTED_SPKI" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "OPENAI_AGENTS_MCP_POSTGRES_SPKI_INVALID" >&2
  exit 1
fi

export OPENAI_AGENTS_MCP_FIXTURE_STATE_DIR="$STATE_DIR"
export OPENAI_AGENTS_MCP_POSTGRES_PORT="$DIRECT_PORT"
export COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256="$EXPECTED_SPKI"
export NODE_EXTRA_CA_CERTS="$STATE_DIR/ca.crt"

cd "$ROOT_DIR"
node --import tsx scripts/openai-agents-mcp-acceptance.ts
