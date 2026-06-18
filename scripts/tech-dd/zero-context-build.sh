#!/usr/bin/env bash
# Zero-Context Build Validation — Tech DD Extreme Scenario #1
#
# Simulates a fresh checkout on a CI machine:
#   1. Copy the repo to a temporary directory WITHOUT node_modules / dist / .git
#   2. Run pnpm install --frozen-lockfile
#   3. Run pnpm build
#   4. Assert both succeed
#
# This catches hidden implicit dependencies, stale lockfiles, and build scripts
# that only work because the current workspace has leftover artifacts.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR="${TMPDIR:-/tmp}"
STAGING="$(mktemp -d "${TMPDIR}/commander-zero-context.XXXXXX")"

cleanup() {
  if [[ -n "${STAGING:-}" && -d "${STAGING}" ]]; then
    echo "[zero-context] Cleaning up staging dir: ${STAGING}"
    rm -rf "${STAGING}"
  fi
}
trap cleanup EXIT

echo "[zero-context] Staging fresh copy at: ${STAGING}"

# Copy the repo, excluding large/generated directories and VCS metadata.
rsync -a \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='dist' \
  --exclude='.commander' \
  --exclude='.commander_state' \
  --exclude='coverage' \
  --exclude='*.log' \
  "${ROOT}/" "${STAGING}/"

cd "${STAGING}"

echo "[zero-context] Running pnpm install --frozen-lockfile ..."
if ! pnpm install --frozen-lockfile; then
  echo "❌ Zero-context build failed at pnpm install"
  exit 1
fi

echo "[zero-context] Running pnpm build ..."
if ! pnpm build; then
  echo "❌ Zero-context build failed at pnpm build"
  exit 1
fi

echo "✅ Zero-context build passed"
echo "   Staging dir: ${STAGING}"
exit 0
