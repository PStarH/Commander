#!/usr/bin/env bash
# =============================================================================
# Integration test for tenant deployment scripts.
# Creates a temporary config + data root so the real repo is never touched.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CREATE_SCRIPT="$SCRIPT_DIR/../create-tenant.sh"
DESTROY_SCRIPT="$SCRIPT_DIR/../destroy-tenant.sh"
MIGRATE_SCRIPT="$SCRIPT_DIR/../migrate-tenant.sh"

if ! command -v python3 >/dev/null 2>&1; then
  echo "SKIP: python3 is not installed" >&2
  exit 0
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

CONFIG_FILE="$TMP_DIR/config/tenants.json"
DATA_ROOT="$TMP_DIR/data"
KEYS_FILE="$TMP_DIR/keys/tenant-api-keys.json"

mkdir -p "$(dirname "$CONFIG_FILE")" "$DATA_ROOT" "$(dirname "$KEYS_FILE")"

# Seed with a minimal tenants.json
cat >"$CONFIG_FILE" <<'EOF'
{
  "$schema": "../commander.schema.json",
  "description": "Test tenant config",
  "tenants": []
}
EOF

export TENANT_CONFIG_PATH="$CONFIG_FILE"
export COMMANDER_DATA_ROOT="$DATA_ROOT"
export TENANT_KEYS_PATH="$KEYS_FILE"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
assert_exists() {
  if [[ ! -e "$1" ]]; then
    echo "FAIL: expected '$1' to exist" >&2
    exit 1
  fi
}

assert_not_exists() {
  if [[ -e "$1" ]]; then
    echo "FAIL: expected '$1' to NOT exist" >&2
    exit 1
  fi
}

get_isolation() {
  python3 -c "import json; print(next((t['isolation'] for t in json.load(open('$CONFIG_FILE'))['tenants'] if t['tenantId']=='$1'), 'MISSING'))"
}

# -----------------------------------------------------------------------------
# Test create-tenant.sh
# -----------------------------------------------------------------------------
echo "[test] create pool tenant"
"$CREATE_SCRIPT" test-pool starter pool >/dev/null
assert_exists "$CONFIG_FILE"
[[ "$(get_isolation test-pool)" == "pool" ]]
assert_not_exists "$DATA_ROOT/tenants/test-pool"
assert_not_exists "$DATA_ROOT/bridge/test-pool"
python3 -c "import json; d=json.load(open('$KEYS_FILE')); assert 'test-pool' in d and len(d['test-pool']['apiKey'])==64"

echo "[test] create bridge tenant"
"$CREATE_SCRIPT" test-bridge standard bridge >/dev/null
[[ "$(get_isolation test-bridge)" == "bridge" ]]
assert_exists "$DATA_ROOT/bridge/test-bridge/memory"
assert_exists "$DATA_ROOT/bridge/test-bridge/runs"
assert_exists "$DATA_ROOT/bridge/test-bridge/logs"
assert_exists "$DATA_ROOT/bridge/test-bridge/artifacts"
assert_exists "$DATA_ROOT/bridge/test-bridge/storage"
python3 -c "import json; d=json.load(open('$KEYS_FILE')); assert 'test-bridge' in d"

echo "[test] create silo tenant"
"$CREATE_SCRIPT" test-silo premium silo >/dev/null
[[ "$(get_isolation test-silo)" == "silo" ]]
assert_exists "$DATA_ROOT/tenants/test-silo/memory"
assert_exists "$DATA_ROOT/tenants/test-silo/runs"
assert_exists "$DATA_ROOT/tenants/test-silo/logs"
assert_exists "$DATA_ROOT/tenants/test-silo/artifacts"
assert_exists "$DATA_ROOT/tenants/test-silo/storage"
python3 -c "import json; d=json.load(open('$KEYS_FILE')); assert 'test-silo' in d"

echo "[test] duplicate tenant is rejected"
if "$CREATE_SCRIPT" test-silo premium silo >/dev/null 2>&1; then
  echo "FAIL: duplicate tenant should be rejected" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Test migrate-tenant.sh
# -----------------------------------------------------------------------------
echo "[test] migrate pool -> bridge"
"$MIGRATE_SCRIPT" test-pool bridge >/dev/null
[[ "$(get_isolation test-pool)" == "bridge" ]]
assert_exists "$DATA_ROOT/bridge/test-pool/memory"

echo "[test] migrate bridge -> silo with dry-run then for real"
# Put some data in the bridge directory to verify copy
mkdir -p "$DATA_ROOT/bridge/test-bridge/memory"
echo "memory-data" >"$DATA_ROOT/bridge/test-bridge/memory/db.sqlite"
"$MIGRATE_SCRIPT" test-bridge silo --dry-run >/dev/null
# dry-run must NOT copy
assert_not_exists "$DATA_ROOT/tenants/test-bridge/memory/db.sqlite"
"$MIGRATE_SCRIPT" test-bridge silo >/dev/null
[[ "$(get_isolation test-bridge)" == "silo" ]]
assert_exists "$DATA_ROOT/tenants/test-bridge/memory/db.sqlite"
[[ "$(cat "$DATA_ROOT/tenants/test-bridge/memory/db.sqlite")" == "memory-data" ]]

# -----------------------------------------------------------------------------
# Test destroy-tenant.sh
# -----------------------------------------------------------------------------
echo "[test] destroy tenants"
"$DESTROY_SCRIPT" test-pool --force >/dev/null
"$DESTROY_SCRIPT" test-bridge --force >/dev/null
"$DESTROY_SCRIPT" test-silo --force >/dev/null

python3 -c "import json; ids=[t['tenantId'] for t in json.load(open('$CONFIG_FILE'))['tenants']]; assert not any(t in ids for t in ['test-pool','test-bridge','test-silo'])"
assert_not_exists "$DATA_ROOT/tenants/test-pool"
assert_not_exists "$DATA_ROOT/bridge/test-bridge"
assert_not_exists "$DATA_ROOT/tenants/test-silo"
python3 -c "import json; d=json.load(open('$KEYS_FILE')); assert not any(t in d for t in ['test-pool','test-bridge','test-silo'])"

echo "[test] destroy non-existent tenant fails"
if "$DESTROY_SCRIPT" missing-tenant --force >/dev/null 2>&1; then
  echo "FAIL: destroying missing tenant should fail" >&2
  exit 1
fi

echo ""
echo "All tenant deployment tests passed."
