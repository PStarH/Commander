#!/usr/bin/env bash
# scripts/install-hooks.sh — idempotent installer for the D3 hardening-sprint
# pre-commit hook. Safe to re-run; never clobbers an existing hook without
# taking a timestamped backup.
#
# Usage:
#   bash scripts/install-hooks.sh           # install
#   bash scripts/install-hooks.sh --uninstall   # restore most-recent backup
#
# Side effect: copies .githooks/pre-commit -> .git/hooks/pre-commit and
# chmod +x it. Does NOT touch any other git hooks. Does NOT enable
# core.hooksPath (we delegate git hook lookup the standard way for
# tool-agnostic compatibility).

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  echo "❌ Not in a git working directory — install-hooks.sh must run inside the repo." >&2
  exit 1
fi
cd "$REPO_ROOT"

SRC="$REPO_ROOT/.githooks/pre-commit"
DST="$REPO_ROOT/.git/hooks/pre-commit"

if [ "${1:-}" = "--uninstall" ]; then
  if [ ! -f "$DST" ]; then
    echo "ℹ️  No hook at $DST — nothing to uninstall."
    exit 0
  fi
  # Find most recent timestamped backup
  LATEST_BACKUP=$(ls -1t "$REPO_ROOT/.git/hooks/pre-commit.bak."* 2>/dev/null | head -1 || true)
  if [ -n "$LATEST_BACKUP" ]; then
    mv "$LATEST_BACKUP" "$DST"
    echo "✅ Restored $LATEST_BACKUP -> $DST"
  else
    rm -f "$DST"
    echo "✅ Removed $DST (no backup to restore)."
  fi
  exit 0
fi

if [ ! -f "$SRC" ]; then
  echo "❌ Source hook missing: $SRC" >&2
  echo "   (was .githooks/pre-commit deleted or never committed?)" >&2
  exit 1
fi

# Backup existing hook if it exists or is a symlink.
if [ -e "$DST" ] || [ -L "$DST" ]; then
  TS="$(date +%s)"
  BACKUP="$DST.bak.$TS"
  mv "$DST" "$BACKUP"
  echo "📦 Backed up existing hook → $BACKUP"
fi

cp "$SRC" "$DST"
chmod +x "$DST"

echo
echo "✅ Installed D3 hardening-sprint pre-commit hook at $DST"
echo
echo "Re-run with --uninstall to restore the most-recent backup."
echo "Bypass an individual commit (logged) with:"
echo "   COMMANDER_SKIP_PRECOMMIT=1 git commit -m \"emergency\""
echo "Run the same scanner gate in CI without git via:"
echo "   CORE_PRECOMMIT_HOOK=1 npx tsx scripts/precommitHook.ts <files…>"
