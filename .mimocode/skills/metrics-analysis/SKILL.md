---
name: metrics-analysis
description: Parse and analyze stress test metrics from JSONL files, producing summaries of task success rates, durations, and cost efficiency
version: 1.0
tags: [metrics, analysis, stress-test, performance]
---

# Metrics Analysis Skill

Parse and analyze stress test metrics from JSONL files, producing summaries of task success rates, durations, and cost efficiency.

## When to Use

- Analyzing results from stress test runs
- Tracking performance trends over time
- Identifying bottlenecks and failure patterns
- Reporting on cost efficiency and token usage

## Workflow

### 1. Locate Metrics File

```bash
# Check for metrics file
ls -la .stress-test-output/metrics.jsonl 2>/dev/null

# Or from specific run
cat .stress-test-output/metrics.jsonl 2>/dev/null | head -5
```

### 2. Parse and Analyze

```bash
cat .stress-test-output/metrics.jsonl | python3 -c "
import json, sys
from collections import defaultdict

lines = [json.loads(l) for l in sys.stdin if l.strip()]
tasks = [l for l in lines if 'task' in l]

# Success rate
passed = sum(1 for t in tasks if t.get('success', False))
total = len(tasks)
print(f'Success Rate: {passed}/{total} ({passed/total:.1%})')

# Duration stats
durations = [t.get('duration_ms', 0) for t in tasks]
print(f'Avg Duration: {sum(durations)/len(durations)/1000:.1f}s')
print(f'Max Duration: {max(durations)/1000:.1f}s')

# Token usage
tokens = [t.get('total_tokens', 0) for t in tasks]
print(f'Total Tokens: {sum(tokens):,}')
print(f'Avg Tokens/Task: {sum(tokens)//len(tokens):,}')

# Cost estimate (approximate)
cost = sum(t.get('cost_usd', 0) for t in tasks)
print(f'Estimated Cost: \${cost:.2f}')
"
```

### 3. Identify Failures

```bash
# Find failed tasks
cat .stress-test-output/metrics.jsonl | python3 -c "
import json, sys

lines = [json.loads(l) for l in sys.stdin if l.strip()]
failed = [l for l in lines if not l.get('success', True)]

for f in failed[:10]:  # Show first 10
    print(f\"Task: {f.get('task_name', 'unknown')}\")
    print(f\"Error: {f.get('error', 'no error')}\")
    print('---')
"
```

### 4. Generate Report

```bash
# Save analysis to file
cat .stress-test-output/metrics.jsonl | python3 -c "
import json, sys
from datetime import datetime

lines = [json.loads(l) for l in sys.stdin if l.strip()]
report = {
    'timestamp': datetime.now().isoformat(),
    'total_tasks': len(lines),
    'passed': sum(1 for l in lines if l.get('success', False)),
    'avg_duration_ms': sum(l.get('duration_ms', 0) for l in lines) / len(lines),
    'total_tokens': sum(l.get('total_tokens', 0) for l in lines),
    'estimated_cost_usd': sum(l.get('cost_usd', 0) for l in lines),
}

import json
print(json.dumps(report, indent=2))
" > .stress-test-output/analysis-$(date +%Y%m%d).json
```

## Common Metrics Fields

- `task_name`: Name of the task
- `success`: Boolean indicating success/failure
- `duration_ms`: Task duration in milliseconds
- `total_tokens`: Total tokens used (input + output)
- `cost_usd`: Estimated cost in USD
- `error`: Error message if failed
- `timestamp`: When the task ran

## Output Location

- Raw metrics: `.stress-test-output/metrics.jsonl`
- Analysis: `.stress-test-output/analysis-[DATE].json`
- Summary: Console output

## Validation

After analysis:
1. Verify JSONL file is valid (no malformed lines)
2. Check for missing fields in metrics
3. Validate cost estimates against actual provider bills
4. Ensure success rate calculations are accurate

## Example Usage

**Quick summary:**
> Analyze stress test metrics and show success rate

**Failure investigation:**
> Find all failed tasks and their error messages

**Cost analysis:**
> Calculate total cost and cost per successful task
