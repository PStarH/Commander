#!/usr/bin/env bash
# packages/core/scripts/run-vitest-safe.sh
#
# Run vitest with SIGSEGV-tolerant exit handling.
#
# better-sqlite3's native module can cause a SIGSEGV during Node.js process
# exit when the garbage collector unloads the native addon while database
# connections are still open. This is a known issue with vitest + better-sqlite3
# and does NOT indicate test failures.
#
# This wrapper:
#   1. Runs vitest with all arguments forwarded
#   2. Captures the output to a temp file
#   3. If the process was killed by SIGSEGV (exit 139), parses the output
#      to determine if all tests actually passed
#   4. Exits 0 if all tests passed, even if SIGSEGV occurred

set -euo pipefail

OUTPUT_FILE="$(mktemp -t vitest-output.XXXXXX)"
EXIT_CODE=0

# Run vitest, capturing both stdout and stderr
# Use direct node_modules/.bin/vitest instead of pnpm exec because pnpm
# sometimes triggers better-sqlite3 rebuild which overwrites our symlink.
# The direct binary avoids the unintended rebuild in the sandbox.
./node_modules/.bin/vitest run --no-cache "$@" > "$OUTPUT_FILE" 2>&1 || EXIT_CODE=$?

# Determine if this was SIGSEGV (128 + 11 = 139) or SIGBUS (128 + 10 = 138)
if [ "$EXIT_CODE" -eq 139 ] || [ "$EXIT_CODE" -eq 138 ]; then
  # Check if the output contains a passing test summary
  # Look for the "Test Files" summary line with no failures
  if grep -q "Tests.*failed" "$OUTPUT_FILE"; then
    # Check if there are zero failed tests
    FAILED_TESTS=$(grep -oE "Tests\s+[0-9]+\s+failed" "$OUTPUT_FILE" | grep -oE "[0-9]+" | tail -1)
    if [ "${FAILED_TESTS:-999}" -eq 0 ]; then
      echo "[vitest-safe] SIGSEGV detected but all tests passed — exiting 0" >&2
      cat "$OUTPUT_FILE"
      rm -f "$OUTPUT_FILE"
      exit 0
    fi
  fi
  
  # If we can't confirm all tests passed, report the SIGSEGV
  echo "[vitest-safe] SIGSEGV detected, unable to confirm test results" >&2
  cat "$OUTPUT_FILE"
  rm -f "$OUTPUT_FILE"
  exit 1
fi

# Normal exit — just forward the output
cat "$OUTPUT_FILE"
rm -f "$OUTPUT_FILE"
exit "$EXIT_CODE"