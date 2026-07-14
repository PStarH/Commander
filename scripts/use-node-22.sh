#!/usr/bin/env bash
# Ensures Node.js 22 is used and native modules (better-sqlite3) are rebuilt.
# Source this script before running tests or development commands:
#   source scripts/use-node-22.sh

set -euo pipefail

NODE_VERSION="22"

# Try common Node 22 locations
find_node22() {
  if command -v nvm &>/dev/null && [[ -n "${NVM_DIR:-}" ]]; then
    local nvm_node="$NVM_DIR/versions/node/v22.22.0/bin/node"
    if [[ -x "$nvm_node" ]]; then
      echo "$nvm_node"
      return
    fi
    # Let nvm select it
    nvm use 22 &>/dev/null || true
    if node --version 2>/dev/null | grep -q "^v22"; then
      command -v node
      return
    fi
  fi

  for prefix in \
    "$HOME/.nvm/versions/node/v22.22.0/bin" \
    "/usr/local/bin" \
    "/opt/homebrew/bin"; do
    local candidate="$prefix/node"
    if [[ -x "$candidate" ]] && "$candidate" --version 2>/dev/null | grep -q "^v22"; then
      echo "$candidate"
      return
    fi
  done
}

NODE_BIN=$(find_node22)

if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: Node.js $NODE_VERSION not found." >&2
  echo "Install it with: nvm install 22" >&2
  exit 1
fi

echo "Using Node.js $NODE_BIN ($($NODE_BIN --version))"

export PATH="$(dirname "$NODE_BIN"):$PATH"

# Rebuild native modules against this Node ABI if needed
if command -v pnpm &>/dev/null; then
  pnpm rebuild better-sqlite3
else
  npm rebuild better-sqlite3
fi
