#!/usr/bin/env bash
# scripts/install-hooks.sh — idempotent installer for the D3 hardening-sprint
# git hooks (pre-commit + pre-push). Safe to re-run; never clobbers an
# existing hook without taking a timestamped backup.
#
# Usage:
#   bash scripts/install-hooks.sh                  # install both hooks
#   bash scripts/install-hooks.sh --uninstall      # restore most-recent backups
#
# Side effect: copies .githooks/<name> -> .git/hooks/<name> for every hook
# listed in HOOKS below; chmod +x each. Does NOT touch any other git hooks.
# Does NOT enable core.hooksPath (we delegate git hook lookup the standard
# way for tool-agnostic compatibility).
#
# Adding a new hook in the future? Append a row to HOOKS below so the new
# hook gets installed, uninstalled, and documented in lockstep.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  echo "❌ Not in a git working directory — install-hooks.sh must run inside the repo." >&2
  exit 1
fi
cd "$REPO_ROOT"

# HOOKS — ordered list of git hook names this installer manages. Adding a
# new D3 gate (e.g. commit-msg)? Append here. The corresponding bypass
# variable convention is COMMANDER_SKIP<NAME_UPPER> — e.g. pre-commit →
# COMMANDER_SKIP_PRECOMMIT, pre-push → COMMANDER_SKIP_PREPUSH. Mirror this
# pattern so the bypass env var remains predictable for downstream consumers.
HOOKS=(
  "pre-commit"
  "pre-push"
)

backup_and_install() {
  local hook_name="$1"
  local src="$REPO_ROOT/.githooks/$hook_name"
  local dst="$REPO_ROOT/.git/hooks/$hook_name"

  if [ ! -f "$src" ]; then
    echo "❌ Source hook missing: $src" >&2
    echo "   (was .githooks/$hook_name deleted or never committed?)" >&2
    exit 1
  fi

  if [ -e "$dst" ] || [ -L "$dst" ]; then
    TS="$(date +%s)"
    BACKUP="$dst.bak.$TS"
    mv "$dst" "$BACKUP"
    echo "📦 Backed up existing $hook_name hook → $BACKUP"
  fi

  cp "$src" "$dst"
  chmod +x "$dst"
  echo "✅ Installed $hook_name hook at $dst"
}

restore_backup() {
  local hook_name="$1"
  local dst="$REPO_ROOT/.git/hooks/$hook_name"

  if [ ! -e "$dst" ]; then
    echo "ℹ️  No $hook_name hook at $dst — nothing to uninstall."
    return 0
  fi

  local LATEST_BACKUP
  LATEST_BACKUP=$(ls -1t "$REPO_ROOT/.git/hooks/$hook_name.bak."* 2>/dev/null | head -1 || true)
  if [ -n "$LATEST_BACKUP" ]; then
    mv "$LATEST_BACKUP" "$dst"
    echo "✅ Restored $LATEST_BACKUP -> $dst"
  else
    rm -f "$dst"
    echo "✅ Removed $dst (no backup to restore)."
  fi
}

if [ "${1:-}" = "--uninstall" ]; then
  for hook_name in "${HOOKS[@]}"; do
    restore_backup "$hook_name"
  done
  exit 0
fi

for hook_name in "${HOOKS[@]}"; do
  backup_and_install "$hook_name"
done

cat << 'EOF'

All D3 hardening-sprint hooks installed:
  • pre-commit  → scripts/precommitHook.ts  (security: scanner + ExecPolicy smoke)
  • pre-push    → scripts/prepushHook.ts    (style:    Prettier baseline check)

Re-run with --uninstall to restore the most-recent backups.

Bypass individual hooks (logged) with their respective env vars:
  COMMANDER_SKIP_PRECOMMIT=1 git commit -m "emergency"
  COMMANDER_SKIP_PREPUSH=1   git push origin master

Run the same gates in CI without git via:
  CORE_PRECOMMIT_HOOK=1 npx tsx scripts/precommitHook.ts <files…>
  CORE_PREPUSH_HOOK=1   npx tsx scripts/prepushHook.ts
EOF
