#!/usr/bin/env bash
# =============================================================================
# destroy-tenant.sh — Decommission a tenant and optionally delete its data.
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
FORCE=false

usage() {
  cat <<EOF
Usage: $(basename "$0") <tenantId> [--force] [--config path]

  --force   Skip interactive confirmation before deleting data directories

Environment overrides:
  TENANT_CONFIG_PATH   Override tenants.json location
  COMMANDER_DATA_ROOT  Override data directory root
  TENANT_KEYS_PATH     Override tenant API key store location
EOF
  exit 1
}

# -----------------------------------------------------------------------------
# Argument parsing
# -----------------------------------------------------------------------------
if [[ $# -lt 1 ]]; then
  usage
fi

TENANT_ID="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE=true
      shift
      ;;
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

# -----------------------------------------------------------------------------

# Locate tenant and determine its deployment model
# -----------------------------------------------------------------------------
export _CONFIG_PATH="$CONFIG_FILE"
export _TENANT_ID="$TENANT_ID"

MODEL="$($PYTHON - <<'PY'
import json
import os
import sys

config_path = os.environ['_CONFIG_PATH']
tid = os.environ['_TENANT_ID']

if not os.path.exists(config_path):
    print('__missing__')
    sys.exit(0)

with open(config_path) as f:
    data = json.load(f)

for t in data.get('tenants', []):
    if t.get('tenantId') == tid:
        print(t.get('isolation', 'pool'))
        sys.exit(0)

print('__missing__')
PY
)" || {
  echo "Error: failed to read $CONFIG_FILE" >&2
  exit 1
}

if [[ "$MODEL" == "__missing__" ]]; then
  echo "Error: tenant '$TENANT_ID' not found in $CONFIG_FILE" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Confirm data directory deletion for silo / bridge tenants
# -----------------------------------------------------------------------------
DATA_DIR=""
if [[ "$MODEL" == "silo" ]]; then
  DATA_DIR="$DATA_ROOT/tenants/$TENANT_ID"
elif [[ "$MODEL" == "bridge" ]]; then
  DATA_DIR="$DATA_ROOT/bridge/$TENANT_ID"
fi

if [[ -n "$DATA_DIR" && -e "$DATA_DIR" && "$FORCE" == false ]]; then
  read -r -p "Delete tenant data directory $DATA_DIR? [y/N] " ans
  if ! [[ "$ans" =~ ^[Yy]$ ]]; then
    echo "Aborted. No changes were made."
    exit 0
  fi
fi

# -----------------------------------------------------------------------------
# Remove tenant from tenants.json
# -----------------------------------------------------------------------------
$PYTHON - <<'PY'
import json
import os

config_path = os.environ['_CONFIG_PATH']
tid = os.environ['_TENANT_ID']

with open(config_path) as f:
    data = json.load(f)

data['tenants'] = [t for t in data.get('tenants', []) if t.get('tenantId') != tid]

with open(config_path, 'w') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write('\n')
PY

# -----------------------------------------------------------------------------
# Delete data directories for silo / bridge tenants
# -----------------------------------------------------------------------------
if [[ -n "$DATA_DIR" && -e "$DATA_DIR" ]]; then
  rm -rf "$DATA_DIR"
  echo "Deleted $DATA_DIR"
fi

# -----------------------------------------------------------------------------
# Remove tenant API key
# -----------------------------------------------------------------------------
export _KEYS_PATH="$KEYS_FILE"
$PYTHON - <<'PY'
import json
import os
from pathlib import Path

keys_path = os.environ['_KEYS_PATH']
tid = os.environ['_TENANT_ID']
keys_path_obj = Path(keys_path)

if not keys_path_obj.exists():
    sys.exit(0)

try:
    with open(keys_path) as f:
        keys = json.load(f)
except Exception:
    keys = {}

if isinstance(keys, dict) and tid in keys:
    del keys[tid]
    with open(keys_path, 'w') as f:
        json.dump(keys, f, indent=2, ensure_ascii=False)
        f.write('\n')
PY

echo "Tenant '$TENANT_ID' destroyed."
