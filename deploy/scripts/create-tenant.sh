#!/usr/bin/env bash
# =============================================================================
# create-tenant.sh — Provision a new tenant in a Pool / Bridge / Silo model.
# =============================================================================
set -euo pipefail

find_working_python() {
  for cmd in /usr/bin/python3 /usr/local/bin/python3 python3; do
    if command -v "$cmd" >/dev/null 2>&1 && "$cmd" -c "import sys; sys.exit(0)" >/dev/null 2>&1; then
      printf '%s\n' "$cmd"
      return 0
    fi
  done
  echo "Error: no working python3 found" >&2
  exit 1
}
PYTHON="$(find_working_python)"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CONFIG_FILE="${TENANT_CONFIG_PATH:-"$PROJECT_ROOT/config/tenants.json"}"
DATA_ROOT="${COMMANDER_DATA_ROOT:-"$PROJECT_ROOT/data"}"
KEYS_FILE="${TENANT_KEYS_PATH:-"$PROJECT_ROOT/.commander/tenant-api-keys.json"}"

TENANT_ID_RE='^[a-zA-Z0-9._:-]{1,128}$'

usage() {
  cat <<EOF
Usage: $(basename "$0") <tenantId> <tier> <pool|bridge|silo> [--config path]

  tenantId  1-128 chars matching: ${TENANT_ID_RE//^/}
  tier      premium | standard | starter
  model     pool | bridge | silo

Environment overrides:
  TENANT_CONFIG_PATH   Override tenants.json location
  COMMANDER_DATA_ROOT  Override data directory root (default: \$PROJECT_ROOT/data)
  TENANT_KEYS_PATH     Override tenant API key store location
EOF
  exit 1
}

# -----------------------------------------------------------------------------
# Argument parsing
# -----------------------------------------------------------------------------
if [[ $# -lt 3 ]]; then
  usage
fi

TENANT_ID="$1"
TIER="$2"
MODEL="$3"
shift 3

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      [[ $# -ge 2 ]] || usage
      CONFIG_FILE="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

# -----------------------------------------------------------------------------
# Validation
# -----------------------------------------------------------------------------
if ! [[ $TENANT_ID =~ $TENANT_ID_RE ]]; then
  echo "Error: invalid tenant id '$TENANT_ID'" >&2
  exit 1
fi

case "$TIER" in
  premium | standard | starter) ;;
  *)
    echo "Error: tier must be premium, standard, or starter" >&2
    usage
    ;;
esac

case "$MODEL" in
  pool | bridge | silo) ;;
  *)
    echo "Error: deployment model must be pool, bridge, or silo" >&2
    usage
    ;;
esac

# -----------------------------------------------------------------------------
# Tier defaults
# -----------------------------------------------------------------------------
case "$TIER" in
  premium)
    TOKEN_BUDGET=500000
    MAX_CONCURRENCY=10
    MAX_RPM=120
    MAX_STORAGE_BYTES=10737418240 # 10 GiB
    ;;
  standard)
    TOKEN_BUDGET=100000
    MAX_CONCURRENCY=5
    MAX_RPM=60
    MAX_STORAGE_BYTES=1073741824 # 1 GiB
    ;;
  starter)
    TOKEN_BUDGET=25000
    MAX_CONCURRENCY=2
    MAX_RPM=20
    MAX_STORAGE_BYTES=268435456 # 256 MiB
    ;;
esac

# -----------------------------------------------------------------------------
# Generate tenant API key
# -----------------------------------------------------------------------------
if command -v openssl >/dev/null 2>&1; then
  API_KEY="$(openssl rand -hex 32)"
else
  API_KEY="$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 64)"
fi

# -----------------------------------------------------------------------------
# Build tenant configuration object
# -----------------------------------------------------------------------------
TENANT_JSON_FILE="$(mktemp)"
trap 'rm -f "$TENANT_JSON_FILE"' EXIT

WORKSPACE_PATH=""
STORAGE_PATH=""
if [[ "$MODEL" == "silo" ]]; then
  WORKSPACE_PATH="$DATA_ROOT/tenants/$TENANT_ID"
  STORAGE_PATH="$DATA_ROOT/tenants/$TENANT_ID/storage"
elif [[ "$MODEL" == "bridge" ]]; then
  WORKSPACE_PATH="$DATA_ROOT/bridge/$TENANT_ID"
  STORAGE_PATH="$DATA_ROOT/bridge/$TENANT_ID/storage"
fi

cat >"$TENANT_JSON_FILE" <<EOF
{
  "tenantId": "$TENANT_ID",
  "tokenBudget": $TOKEN_BUDGET,
  "maxConcurrency": $MAX_CONCURRENCY,
  "maxRunsPerMinute": $MAX_RPM,
  "enabled": true,
  "isolation": "$MODEL",
  "maxStorageBytes": $MAX_STORAGE_BYTES,
  "metadata": {
    "tier": "$TIER",
    "deploymentModel": "$MODEL"
  }
}
EOF

if [[ -n "$WORKSPACE_PATH" ]]; then
  $PYTHON - <<PY
import json
with open("$TENANT_JSON_FILE") as f:
    t = json.load(f)
t["workspacePath"] = "$WORKSPACE_PATH"
t["storagePath"] = "$STORAGE_PATH"
with open("$TENANT_JSON_FILE", "w") as f:
    json.dump(t, f, indent=2)
PY
fi

# -----------------------------------------------------------------------------
# Append to tenants.json and store API key
# -----------------------------------------------------------------------------
export _CONFIG_PATH="$CONFIG_FILE"
export _KEYS_PATH="$KEYS_FILE"
export _TENANT_JSON_PATH="$TENANT_JSON_FILE"
export _API_KEY="$API_KEY"

$PYTHON - <<'PY'
import json
import os
import sys
import datetime
from pathlib import Path

config_path = os.environ['_CONFIG_PATH']
keys_path = os.environ['_KEYS_PATH']
tenant_path = os.environ['_TENANT_JSON_PATH']
api_key = os.environ['_API_KEY']

with open(tenant_path) as f:
    tenant = json.load(f)

config_path_obj = Path(config_path)
if config_path_obj.exists():
    with open(config_path) as f:
        data = json.load(f)
else:
    data = {
        "$schema": "../commander.schema.json",
        "description": "Multi-tenant configuration.",
        "tenants": [],
    }

if not isinstance(data.get('tenants'), list):
    data['tenants'] = []

for t in data['tenants']:
    if t.get('tenantId') == tenant['tenantId']:
        print(f"Error: tenant '{tenant['tenantId']}' already exists in {config_path}", file=sys.stderr)
        sys.exit(1)

data['tenants'].append(tenant)

config_path_obj.parent.mkdir(parents=True, exist_ok=True)
with open(config_path, 'w') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write('\n')

keys = {}
keys_path_obj = Path(keys_path)
if keys_path_obj.exists():
    try:
        with open(keys_path) as f:
            keys = json.load(f)
        if not isinstance(keys, dict):
            keys = {}
    except Exception:
        keys = {}

keys[tenant['tenantId']] = {
    "apiKey": api_key,
    "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
keys_path_obj.parent.mkdir(parents=True, exist_ok=True)
with open(keys_path, 'w') as f:
    json.dump(keys, f, indent=2, ensure_ascii=False)
    f.write('\n')

print(tenant['tenantId'])
PY

# -----------------------------------------------------------------------------
# Create on-disk data directories for bridge / silo tenants
# -----------------------------------------------------------------------------
if [[ "$MODEL" == "silo" ]]; then
  mkdir -p "$DATA_ROOT/tenants/$TENANT_ID"/{memory,runs,logs,artifacts,storage}
elif [[ "$MODEL" == "bridge" ]]; then
  mkdir -p "$DATA_ROOT/bridge/$TENANT_ID"/{memory,runs,logs,artifacts,storage}
fi

# -----------------------------------------------------------------------------
# Output
# -----------------------------------------------------------------------------
cat <<EOF
Tenant created: $TENANT_ID
  Tier:            $TIER
  Deployment:      $MODEL
  Token budget:    $TOKEN_BUDGET
  Max concurrency: $MAX_CONCURRENCY
  Max runs/min:    $MAX_RPM
  API key:         $API_KEY
  Config file:     $CONFIG_FILE
EOF

if [[ "$MODEL" != "pool" ]]; then
  echo "  Data directory:  $DATA_ROOT/$(if [[ "$MODEL" == "silo" ]]; then echo "tenants"; else echo "bridge"; fi)/$TENANT_ID"
fi
