#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
FIXTURE_DIR="$ROOT_DIR/deploy/testing/postgres-tls"
STATE_DIR=${COMMANDER_P0_TLS_FIXTURE_STATE_DIR:-"$ROOT_DIR/.tmp/p0-full-loop-tls-fixture"}
COMPOSE_PROJECT_NAME=${COMMANDER_P0_TLS_FIXTURE_PROJECT:-commander-p0-full-loop-tls}
DIRECT_PORT=${COMMANDER_P0_TLS_FIXTURE_PORT:-55440}

case "$DIRECT_PORT" in
  ''|*[!0-9]*) echo "COMMANDER_P0_TLS_FIXTURE_PORT_INVALID" >&2; exit 2 ;;
esac
if [ "$DIRECT_PORT" -lt 1 ] || [ "$DIRECT_PORT" -gt 65535 ]; then
  echo "COMMANDER_P0_TLS_FIXTURE_PORT_INVALID" >&2
  exit 2
fi
if [ -z "${AUTH_FAILURE_REDIS_URL:-}" ]; then
  echo "AUTH_FAILURE_REDIS_URL_REQUIRED" >&2
  exit 2
fi

mkdir -p "$STATE_DIR"
STATE_DIR=$(CDPATH= cd -- "$STATE_DIR" && pwd)
FIXTURE_STATE_DIR="$STATE_DIR"
export COMPOSE_PROJECT_NAME DIRECT_PORT FIXTURE_STATE_DIR

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
  if [ "${KEEP_FIXTURE:-0}" != "1" ]; then
    if ! docker compose -f "$FIXTURE_DIR/compose.yaml" down --volumes --remove-orphans >/dev/null; then
      echo "P0_TLS_FIXTURE_CLEANUP_FAILED" >&2
      [ "$status" -ne 0 ] || status=1
    fi
    find "$STATE_DIR" -type f -delete 2>/dev/null || true
    find "$STATE_DIR" -depth -type d -empty -delete 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

docker compose -f "$FIXTURE_DIR/compose.yaml" down --volumes --remove-orphans >/dev/null
"$FIXTURE_DIR/generate-certificates.sh" "$STATE_DIR"
docker compose -f "$FIXTURE_DIR/compose.yaml" up --detach --wait

attempt=0
until docker compose -f "$FIXTURE_DIR/compose.yaml" exec -T postgres sh -eu -c '
  [ "$(cat /proc/1/comm)" = postgres ]
  [ "$(psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --command "SELECT count(*) FROM pg_roles WHERE rolname IN ('\''commander_owner'\'', '\''commander_app'\'', '\''commander_tenant_authority'\'', '\''commander_scheduler'\'', '\''commander_worker'\'', '\''commander_adapter_ops'\'')")" = 6 ]
' >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ]; then
    echo "P0_TLS_FIXTURE_ROLES_NOT_READY" >&2
    exit 1
  fi
  sleep 0.1
done

# Match the production bootstrap: the migration owner owns the database/schema
# and can administer the least-privilege runtime memberships.
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
  echo "P0_TLS_FIXTURE_SPKI_INVALID" >&2
  exit 1
fi

export COMMANDER_DATABASE_TLS_CA_FILE="$STATE_DIR/ca.crt"
export COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256="$EXPECTED_SPKI"
export COMMANDER_KERNEL_DATABASE_URL="postgres://commander_owner:${FIXTURE_OWNER_PASSWORD}@localhost:${DIRECT_PORT}/fixture?sslmode=verify-full"

pnpm p0:full-loop
