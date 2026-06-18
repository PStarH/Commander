#!/usr/bin/env bash
# 100x Burn-In Test — runs the golden demo path 100 times unattended.
# If any single iteration crashes, hangs, or misses an assertion, the script
# exits non-zero immediately.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CORE_DIR="$ROOT/packages/core"
LOG_DIR="$ROOT/.commander/burn-in"
mkdir -p "$LOG_DIR"

TOTAL=100
PASS=0
FAIL=0

for i in $(seq 1 $TOTAL); do
  run_log="$LOG_DIR/run-$(printf '%04d' $i).log"
  echo "[burn-in] Run $i / $TOTAL ..."

  # Run the E2E + marker + chaos tests in sequence and capture everything.
  if (
    cd "$ROOT" && FAST_DEMO=1 npx tsx scripts/demo-qa/test-golden-path.ts && \
    cd "$CORE_DIR" && npx tsx tests/demo-qa/test-guardian-block.ts && \
    cd "$CORE_DIR" && npx tsx tests/demo-qa/test-provider-fallback.ts && \
    cd "$CORE_DIR" && npx tsx tests/demo-qa/test-tool-truncation.ts && \
    cd "$CORE_DIR" && npx tsx tests/demo-qa/test-chaos-failover.ts
  ) > "$run_log" 2>&1; then
    PASS=$((PASS + 1))
    echo "[burn-in] Run $i ✅ PASS"
  else
    FAIL=$((FAIL + 1))
    echo "[burn-in] Run $i ❌ FAIL — see $run_log"
    echo "[burn-in] Aborting burn-in after first failure."
    tail -50 "$run_log"
    exit 1
  fi
done

echo ""
echo "[burn-in] Completed: $PASS passed, $FAIL failed out of $TOTAL"
exit 0
