#!/usr/bin/env bash
# =============================================================================
# migrate-tenant.sh — Move a tenant between Pool / Bridge / Silo models.
# Supported transitions: pool -> bridge, pool -> silo, bridge -> silo
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CONFIG_FILE="${TENANT_CONFIG_PATH:-"$PROJECT_ROOT/config/tenants.json"}"
DATA_ROOT="${COMMANDER_DATA_ROOT:-"$PROJECT_ROOT/data"}"

TENANT_ID_RE='^[a-zA-Z0-9._:-]{1,128}$'
DRY_RUN=false

usage() {
  cat <<EOF
Usage: $(basename "$0") <tenantId> <bridge|silo> [--dry-run] [--config path]

  Migrates a tenant to a stronger isolation model:
    pool   -> bridge
    pool   -> silo
    bridge -> silo

  Use --dry-run to preview changes without copying data.

Environment overrides:
  TENANT_CONFIG_PATH   Override tenants.json location
  COMMANDER_DATA_ROOT  Override data directory root
EOF
  exit 1
}

# -----------------------------------------------------------------------------
# Argument parsing
# -----------------------------------------------------------------------------
if [[ $# -lt 2 ]]; then
  usage
fi

TENANT_ID="$1"
TARGET_MODEL="$2"
shift 2

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
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

case "$TARGET_MODEL" in
  bridge | silo | pool) ;;
  *)
    echo "Error: target model must be bridge, silo, or pool" >&2
    usage
    ;;
esac

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is required" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Resolve current model from tenants.json
# -----------------------------------------------------------------------------
export _CONFIG_PATH="$CONFIG_FILE"
export _TENANT_ID="$TENANT_ID"

CURRENT_MODEL="$(python3 - <<'PY'
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

if [[ "$CURRENT_MODEL" == "__missing__" ]]; then
  echo "Error: tenant '$TENANT_ID' not found in $CONFIG_FILE" >&2
  exit 1
fi

if [[ "$CURRENT_MODEL" == "$TARGET_MODEL" ]]; then
  echo "Tenant '$TENANT_ID' is already deployed as '$TARGET_MODEL'. Nothing to do."
  exit 0
fi

# -----------------------------------------------------------------------------
# Validate supported transition
# -----------------------------------------------------------------------------
ALLOWED=false
case "$CURRENT_MODEL:$TARGET_MODEL" in
  pool:bridge | pool:silo | bridge:silo) ALLOWED=true ;;
  bridge:pool) ALLOWED=true ;; # downgrade is allowed when explicitly requested
  silo:bridge) ALLOWED=true ;;
  silo:pool) ALLOWED=true ;;
esac

if [[ "$ALLOWED" == false ]]; then
  echo "Error: migration from '$CURRENT_MODEL' to '$TARGET_MODEL' is not supported." >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Compute source / destination directories
# -----------------------------------------------------------------------------
data_dir_for_model() {
  local model="$1"
  local tid="$2"
  case "$model" in
    silo)  echo "$DATA_ROOT/tenants/$tid" ;;
    bridge) echo "$DATA_ROOT/bridge/$tid" ;;
    pool)   echo "" ;;
  esac
}

SRC_DIR="$(data_dir_for_model "$CURRENT_MODEL" "$TENANT_ID")"
DST_DIR="$(data_dir_for_model "$TARGET_MODEL" "$TENANT_ID")"

# -----------------------------------------------------------------------------
# Dry-run preview
# -----------------------------------------------------------------------------
if [[ "$DRY_RUN" == true ]]; then
  echo "[dry-run] Would migrate '$TENANT_ID' from '$CURRENT_MODEL' to '$TARGET_MODEL'"
  if [[ -n "$SRC_DIR" && -e "$SRC_DIR" ]]; then
    echo "[dry-run] Would copy: $SRC_DIR -> $DST_DIR"
  elif [[ -n "$DST_DIR" ]]; then
    echo "[dry-run] Would create empty directory: $DST_DIR"
  fi
  echo "[dry-run] Would update isolation in $CONFIG_FILE to '$TARGET_MODEL'"
  exit 0
fi

# -----------------------------------------------------------------------------
# Copy data when moving from a model that had on-disk storage
# -----------------------------------------------------------------------------
if [[ -n "$SRC_DIR" && -e "$SRC_DIR" ]]; then
  mkdir -p "$DST_DIR"
  # Copy contents including hidden files; preserve permissions/timestamps
  cp -Rp "$SRC_DIR/"* "$SRC_DIR/".[^.]* "$DST_DIR/" 2>/dev/null || true
  # Fallback: some shells may not expand hidden-file glob; use find for safety
  find "$SRC_DIR" -mindepth 1 -maxdepth 1 -exec cp -Rp {} "$DST_DIR/" \;
  echo "Copied tenant data: $SRC_DIR -> $DST_DIR"
else
  if [[ -n "$DST_DIR" ]]; then
    mkdir -p "$DST_DIR"/{memory,runs,logs,artifacts,storage}
    echo "Created empty tenant directory: $DST_DIR"
  fi
fi

# -----------------------------------------------------------------------------
# Update tenants.json
# -----------------------------------------------------------------------------
export _TARGET_MODEL="$TARGET_MODEL"
export _DATA_ROOT="$DATA_ROOT"

python3 - <<'PY'
import json
import os
import sys
from pathlib import Path

config_path = os.environ['_CONFIG_PATH']
tid = os.environ['_TENANT_ID']
target = os.environ['_TARGET_MODEL']
data_root = os.environ['_DATA_ROOT']

with open(config_path) as f:
    data = json.load(f)

tenant = None
for t in data.get('tenants', []):
    if t.get('tenantId') == tid:
        tenant = t
        break

if tenant is None:
    print(f"Error: tenant '{tid}' not found", file=sys.stderr)
    sys.exit(1)

tenant['isolation'] = target

if target == 'pool':
    tenant.pop('workspacePath', None)
    tenant.pop('storagePath', None)
else:
    subdir = 'tenants' if target == 'silo' else 'bridge'
    prefix = str(Path(data_root) / subdir / tid)
    tenant['workspacePath'] = prefix
    tenant['storagePath'] = str(Path(prefix) / 'storage')

with open(config_path, 'w') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write('\n')
PY

echo "Tenant '$TENANT_ID' migrated from '$CURRENT_MODEL' to '$TARGET_MODEL'."
