#!/bin/bash
# PinchBench Runner for Commander
#
# Runs PinchBench multiple times and calculates average score
#
# Usage:
#   ./benchmarks/pinchbench/run_pinchbench.sh [--runs N] [--model MODEL]
#
# Requirements:
#   - Python 3.10+
#   - uv package manager
#   - OpenClaw installed

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PINCHBENCH_DIR="$SCRIPT_DIR/skill"
RESULTS_DIR="$SCRIPT_DIR/results"

# Default values
RUNS=3
MODEL="mimo-v2.5-pro"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --runs)
      RUNS="$2"
      shift 2
      ;;
    --model)
      MODEL="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

echo "=========================================="
echo "  PinchBench Runner for Commander"
echo "=========================================="
echo "  Model: $MODEL"
echo "  Runs: $RUNS"
echo "  Results dir: $RESULTS_DIR"
echo "=========================================="
echo ""

# Create results directory
mkdir -p "$RESULTS_DIR"

# Clone PinchBench if not exists
if [ ! -d "$PINCHBENCH_DIR" ]; then
  echo "📥 Cloning PinchBench repository..."
  git clone https://github.com/pinchbench/skill.git "$PINCHBENCH_DIR"
fi

# Change to PinchBench directory
cd "$PINCHBENCH_DIR"

# Install dependencies
echo "📦 Installing dependencies..."
uv sync 2>/dev/null || pip install -e . 2>/dev/null

# Run benchmarks
echo ""
echo "🚀 Running PinchBench $RUNS times with model: $MODEL"
echo ""

for run in $(seq 1 $RUNS); do
  echo "=========================================="
  echo "  Run $run/$RUNS"
  echo "=========================================="

  OUTPUT_DIR="$RESULTS_DIR/run_$run"
  mkdir -p "$OUTPUT_DIR"

  # Run PinchBench
  uv run pinchbench run \
    --model "$MODEL" \
    --output "$OUTPUT_DIR" \
    --timeout-multiplier 2 \
    2>&1 | tee "$OUTPUT_DIR/output.log"

  echo ""
  echo "Run $run completed. Results saved to $OUTPUT_DIR"
  echo ""
done

# Calculate average
echo "=========================================="
echo "  Calculating Average Results"
echo "=========================================="

python3 << 'PYEOF'
import json, os, sys

results_dir = os.environ.get('RESULTS_DIR', 'benchmarks/pinchbench/results')
runs = int(os.environ.get('RUNS', '3'))

all_scores = []
all_passed = []
all_total = []

for run in range(1, runs + 1):
    run_dir = os.path.join(results_dir, f'run_{run}')

    # Look for results file
    result_files = [
        os.path.join(run_dir, 'results.json'),
        os.path.join(run_dir, 'summary.json'),
        os.path.join(run_dir, 'pinchbench_results.json'),
    ]

    for result_file in result_files:
        if os.path.exists(result_file):
            with open(result_file) as f:
                data = json.load(f)

                # Extract score
                if 'accuracy' in data:
                    score = float(data['accuracy'].replace('%', ''))
                elif 'score' in data:
                    score = float(data['score'])
                elif 'passed' in data and 'total' in data:
                    score = (data['passed'] / data['total']) * 100
                else:
                    continue

                all_scores.append(score)
                all_passed.append(data.get('passed', 0))
                all_total.append(data.get('total', 0))
                break

if all_scores:
    avg_score = sum(all_scores) / len(all_scores)
    min_score = min(all_scores)
    max_score = max(all_scores)
    avg_passed = sum(all_passed) / len(all_passed)
    avg_total = sum(all_total) / len(all_total)

    print(f"\n📊 PinchBench Results Summary")
    print(f"{'='*50}")
    print(f"  Runs: {len(all_scores)}")
    print(f"  Average Score: {avg_score:.1f}%")
    print(f"  Min Score: {min_score:.1f}%")
    print(f"  Max Score: {max_score:.1f}%")
    print(f"  Average Passed: {avg_passed:.1f}/{avg_total:.1f}")
    print(f"{'='*50}")

    # Save summary
    summary = {
        'benchmark': 'PinchBench',
        'model': os.environ.get('MODEL', 'unknown'),
        'runs': len(all_scores),
        'avg_score': avg_score,
        'min_score': min_score,
        'max_score': max_score,
        'avg_passed': avg_passed,
        'avg_total': avg_total,
        'all_scores': all_scores,
    }

    summary_file = os.path.join(results_dir, 'summary.json')
    with open(summary_file, 'w') as f:
        json.dump(summary, f, indent=2)

    print(f"\n  Summary saved to: {summary_file}")
else:
    print("\n❌ No results found. Check the output logs for errors.")
    sys.exit(1)
PYEOF

echo ""
echo "✅ PinchBench benchmark completed!"
