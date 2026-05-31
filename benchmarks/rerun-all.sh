#!/bin/bash
# Re-run all Commander benchmarks with latest fixes
# Usage: ./benchmarks/rerun-all.sh [--bfcl-only] [--gaia-only]

set -e
cd "$(dirname "$0")/.."

echo "=========================================="
echo "  Commander Benchmark Re-run"
echo "  $(date)"
echo "=========================================="

# Check for API key
if [ -z "$OPENAI_API_KEY" ] && [ -z "$MIMO_API_KEY" ]; then
    if [ -f .env ]; then
        export $(grep -E '^(OPENAI_API_KEY|MIMO_API_KEY)=' .env | xargs)
    fi
fi

if [ -z "$OPENAI_API_KEY" ] && [ -z "$MIMO_API_KEY" ]; then
    echo "Error: No API key found. Set OPENAI_API_KEY or MIMO_API_KEY"
    exit 1
fi

# Parse args
RUN_BFCL=true
RUN_GAIA=true
if [ "$1" = "--bfcl-only" ]; then RUN_GAIA=false; fi
if [ "$1" = "--gaia-only" ]; then RUN_BFCL=false; fi

# BFCL 35-scenario re-run
if [ "$RUN_BFCL" = true ]; then
    echo ""
    echo "=== BFCL 35-scenario (through Commander runtime) ==="
    echo "Expected improvements:"
    echo "  - Irrelevance: 1/5 → 3-4/5 (system prompt fix)"
    echo "  - Email refusal: 2 failures → 0 (reasonable defaults)"
    echo "  - Multi-step: 2/5 → 4/5 (execute all steps)"
    echo ""
    npx tsx -e "
import { main } from './packages/core/src/benchmark/benchmarkRunner.ts';
main(['benchmarks/configs/bfcl.yaml', '--output', 'benchmarks/bfcl-commander']).catch(console.error);
"
fi

# GAIA re-run
if [ "$RUN_GAIA" = true ]; then
    echo ""
    echo "=== GAIA (with fixed answer extraction) ==="
    echo "Expected improvements:"
    echo "  - Better answer extraction (FINAL ANSWER: pattern)"
    echo "  - Fuzzy matching normalization"
    echo ""
    npx tsx -e "
import { main } from './packages/core/src/benchmark/benchmarkRunner.ts';
main(['benchmarks/configs/gaia.yaml', '--output', 'benchmarks/gaia-commander']).catch(console.error);
"
fi

echo ""
echo "=========================================="
echo "  Re-run complete!"
echo "=========================================="
echo ""
echo "Results saved to:"
if [ "$RUN_BFCL" = true ]; then echo "  - benchmarks/bfcl-commander/bfcl/results.json"; fi
if [ "$RUN_GAIA" = true ]; then echo "  - benchmarks/gaia-commander/gaia/results.json"; fi
