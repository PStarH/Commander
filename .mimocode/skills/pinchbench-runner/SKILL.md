---
name: pinchbench-runner
description: Run PinchBench benchmarks, monitor progress, and analyze results for Commander performance evaluation
version: 1.0
tags: [benchmark, pinchbench, performance, testing]
---

# PinchBench Runner Skill

Run PinchBench benchmarks, monitor progress, and analyze results for Commander performance evaluation.

## When to Use

- Evaluating Commander's performance on standardized tasks
- Comparing against other coding assistants (Claude Code, Codex CLI, OpenCode)
- Tracking performance improvements over time
- Identifying bottlenecks and areas for optimization

## Workflow

### 1. Run Benchmark

```bash
# Set API keys
export OPENAI_API_KEY=$(cat .secrets/api-key)
export MIMO_API_KEY=$(cat .secrets/api-key)

# Run PinchBench
npx tsx benchmarks/pinchbench/run_pinchbench_commander.ts 2>&1
```

### 2. Monitor Progress

```bash
# Check if still running
ps aux | grep "run_pinchbench" | grep -v grep | wc -l

# Check output
tail -30 /private/tmp/claude-501/[SESSION]/tasks/[TASK_ID].output 2>/dev/null
```

### 3. Analyze Results

```bash
# Read summary
cat benchmarks/pinchbench/results/run_1/summary.json 2>/dev/null | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'Total: {d[\"total_tasks\"]}')
print(f'Passed: {d[\"passed\"]}')
print(f'Success Rate: {d[\"success_rate\"]:.1%}')
"

# Check individual results
cat benchmarks/pinchbench/results/run_1/task_calendar/result.json | python3 -m json.tool
```

### 4. Compare Results

```bash
# Compare with previous runs
ls -la benchmarks/pinchbench/results/

# Generate comparison report
python3 << 'EOF'
import json
from pathlib import Path

results = []
for run_dir in Path("benchmarks/pinchbench/results").iterdir():
    if run_dir.is_dir():
        summary = json.loads((run_dir / "summary.json").read_text())
        results.append({"run": run_dir.name, **summary})

# Sort by success rate
results.sort(key=lambda x: x.get("success_rate", 0), reverse=True)
for r in results:
    print(f"{r['run']}: {r.get('success_rate', 0):.1%}")
EOF
```

## Common Issues

### Process Not Starting

```bash
# Check if port is in use
lsof -i :3000

# Kill existing process
pkill -f "run_pinchbench"
```

### API Key Issues

```bash
# Verify key is set
echo $OPENAI_API_KEY | head -c 10

# Test connection
curl -H "Authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/models
```

### Timeout Issues

```bash
# Increase timeout
timeout 600 npx tsx benchmarks/pinchbench/run_pinchbench_commander.ts 2>&1
```

## Output Location

- Results: `benchmarks/pinchbench/results/run_N/`
- Summary: `benchmarks/pinchbench/results/run_N/summary.json`
- Individual tasks: `benchmarks/pinchbench/results/run_N/task_[NAME]/result.json`

## Validation

After running:

1. Verify all tasks completed (check summary.json)
2. Validate success rate against baseline
3. Check for regressions in specific task categories
4. Ensure cost metrics are accurate

## Example Usage

**Full benchmark:**

> Run PinchBench and compare with Claude Code and Codex CLI

**Quick check:**

> Run PinchBench calendar task and check result

**Regression test:**

> Run PinchBench to verify recent changes didn't break anything
