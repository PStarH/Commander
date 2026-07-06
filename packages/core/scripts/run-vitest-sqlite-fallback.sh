#!/usr/bin/env bash
# packages/core/scripts/run-vitest-sqlite-fallback.sh
#
# Runs the @commander/core vitest suite with SQLite-dependent test files
# excluded, intended to be invoked from the "Run core tests" step of
# .github/workflows/ci.yml when the binding-probe step reports
# SQLITE_BINDING_OK=false (the better-sqlite3 native binding could not be
# compiled / extracted on this runner OS × ABI combo).
#
# Why a script instead of inlining the long --exclude list in the workflow:
#   1. Single source of truth — adding a new SqliteWorkQueueStore /
#      CheckpointStore / SqliteDriver / better-sqlite3 caller under
#      packages/core/tests/ only requires updating the SUITES array below,
#      not editing .github/workflows/ci.yml (the loud failure surface for
#      non-CI readers).
#   2. Easy to dry-run locally with `./scripts/run-vitest-sqlite-fallback.sh
#      --reporter=default` — preserves operator path parity with CI.
#   3. Forwarded arguments ("$@") let callers add reporter / coverage
#      toggles without forking the script.
#
# This is the *fallback* path — when binding loads successfully CI runs
# `pnpm --filter @commander/core test` with the full suite intact.

set -euo pipefail

# ── SQLite-dependent test suites ────────────────────────────────────────────
# Listed alphabetically by full path (relative to packages/core/) so future
# additions always land at a predictable location. CI runs these only when
# better-sqlite3's native binding successfully loads.
SUITES=(
  'tests/atr/adapters/github.test.ts'
  'tests/atr/atrHttp.test.ts'
  'tests/atr/c6AgentRuntimeLease.test.ts'
  'tests/atr/checkpointLease.test.ts'
  'tests/atr/executionScheduler.test.ts'
  'tests/atr/leaseManager.test.ts'
  'tests/atr/policy/e2e.test.ts'
  'tests/atr/policy/integration.test.ts'
  'tests/atr/runLedger.test.ts'
  'tests/checkpointStore.test.ts'
  'tests/e2e/sloMeasurement.test.ts'
  'tests/recovery/kill9.test.ts'
  'tests/runtime/determinismCapture.test.ts'
  'tests/runtime/processCrashSafety.test.ts'
  'tests/runtime/runRecovery.test.ts'
  'tests/security/filePermissions.test.ts'
  'tests/storage/persistentStore.test.ts'
  'tests/storage/sqliteDriver.test.ts'
  'tests/tools/conversationSearchTool.test.ts'
  'tests/ultimate/chaos/_workers/t1-claimWorker.ts'
  'tests/ultimate/tenantWorkCoordinatorRegistry.test.ts'
  'tests/ultimate/workCoordinator.test.ts'
  'tests/ultimate/workQueueStore.test.ts'
)

# Build --exclude args once. Glob `**/<file>.test.ts` is intentional so
# vitest matches regardless of the cwd vitest is invoked from.
EXCLUDES=()
for s in "${SUITES[@]}"; do
  EXCLUDES+=(--exclude "**/$s")
done

# Resolve this script's directory and cd into packages/core (where
# vitest.config.ts lives). NO_OF_TESTS-style positional overrides will
# be appended through "$@" below.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Make the operator-visible log line explicit so a manual local run is
# unambiguous about what it's skipping.
echo "[run-vitest-sqlite-fallback] excluding ${#SUITES[@]} SQLite-dependent suites:" >&2
for s in "${SUITES[@]}"; do
  echo "  • $s" >&2
done

exec pnpm exec vitest run --no-cache "${EXCLUDES[@]}" "$@"
