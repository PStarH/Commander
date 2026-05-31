#!/bin/bash
# Commander Demo — Shows all key features in one run
# Usage: ./scripts/demo.sh
#
# Prerequisites:
#   - API key configured in .env
#   - Commander built (pnpm build)

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Load API key
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

if [ -z "$OPENAI_API_KEY" ]; then
  echo "ERROR: No API key found. Set OPENAI_API_KEY in .env"
  exit 1
fi

export OPENAI_API_KEY OPENAI_BASE_URL OPENAI_MODEL

CLI="npx tsx $ROOT_DIR/packages/core/src/cli.ts"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  COMMANDER DEMO"
echo "  transparent · trustworthy · cost-effective"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 1. Plan ──────────────────────────────────────────────
echo "━━━ 1/3 ━━━ Commander Plan ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
$CLI plan "write a TypeScript function to validate email addresses"
echo ""

# ── 2. Run ───────────────────────────────────────────────
echo "━━━ 2/3 ━━━ Commander Run ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
$CLI run "write a TypeScript function to check if a number is prime"
echo ""

# ── 3. Summary ───────────────────────────────────────────
echo "━━━ 3/3 ━━━ Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Commander demonstrated:"
echo "    Transparent — You saw every phase: deliberation, topology,"
echo "                  decomposition, execution, synthesis"
echo "    Trustworthy — Quality gates verified the output"
echo "    Cost-effective — ~6,500 tokens, ~\$0.10 for a complete task"
echo ""
echo "  Try it yourself:"
echo "    npx commander watch \"your task here\""
echo "    npx commander benchmark"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
