# SWE-bench Integration for Commander

## Overview

Commander's multi-agent approach to SWE-bench uses a **4-phase pipeline**:
1. **Planner** — Analyzes the GitHub issue, identifies the bug type, creates a fix plan
2. **Localizer** — Searches the codebase to find exact file/function locations of the bug
3. **Coder** — Generates a minimal unified diff patch
4. **Tester** — Validates the patch by running tests (with retry loop)

### Why Multi-Agent Beats Single-Agent

| Approach | Architecture | Key Limitation |
|----------|-------------|----------------|
| SWE-Agent | Single agent | Everything in one context window — easily overwhelmed |
| Agentless | Pipeline (no loop) | No iterative refinement — fails if first attempt is wrong |
| **Commander** | Multi-agent + retry | Specialized agents, test-driven feedback, iterative refinement |

## Quick Start

```bash
# 1. Set up API key in .env
echo "OPENAI_API_KEY=your-key" >> .env
echo "MIMO_BASE_URL=https://your-endpoint/v1" >> .env

# 2. Run on SWE-bench Verified (first 10 instances)
npx tsx benchmarks/swebench/run_swebench_commander.ts --max 10 --subset verified

# 3. Evaluate results
cd benchmarks/swebench
python3 evaluate.py --predictions results/predictions.jsonl
```

## Full Run

```bash
# Run all 500 verified instances
npx tsx benchmarks/swebench/run_swebench_commander.ts --max 500 --subset verified

# Or run SWE-bench Lite (300 instances, faster)
npx tsx benchmarks/swebench/run_swebench_commander.ts --max 300 --subset lite
```

## Output Format

### predictions.jsonl (SWE-bench standard)
```json
{"instance_id": "sympy__sympy-20590", "model_name_or_path": "commander-swebench", "model_patch": "diff --git a/..."}
```

### results.json (Commander summary)
```json
{
  "benchmark": "swebench",
  "subset": "verified",
  "total": 500,
  "resolved": 180,
  "resolve_rate": "36.0%",
  "total_tokens": 12500000,
  "avg_duration_ms": 45000
}
```

## Agent Pipeline Details

### Phase 1: Planner
- Input: GitHub issue text
- Output: Bug analysis + fix plan
- Tokens: ~800-1500

### Phase 2: Localizer
- Input: Fix plan + repo structure
- Output: Exact file/line locations of bug
- Tokens: ~1000-2000
- Uses `grep` and `find` to search codebase

### Phase 3: Coder
- Input: Localization + source code
- Output: Unified diff patch
- Tokens: ~1500-3000
- Minimal changes — only modifies what's needed

### Phase 4: Tester
- Input: Patch + test commands
- Output: Pass/fail + feedback
- Tokens: 0 (pure execution)
- Feeds failures back to Coder for retry (max 2 retries)

## Optimization Tips

1. **Model selection**: Use the strongest model available (Claude Opus > Sonnet > Haiku)
2. **Temperature**: 0.1 for deterministic outputs
3. **Max retries**: 2 is optimal (more rarely helps, wastes tokens)
4. **Timeout**: 5 minutes per instance is generous; most complete in 1-2 min

## Comparison with Other Approaches

| System | SWE-bench Verified | Cost/Instance | Key Feature |
|--------|-------------------|---------------|-------------|
| OpenHands | ~77% | ~$2-5 | Full sandboxed environment |
| Codex | ~70% | ~$1-3 | Strong base model |
| SWE-Agent | ~33% | ~$0.50 | ACI design |
| Agentless | ~27% | ~$0.20 | No agent loop |
| **Commander** | TBD | ~$0.10-0.50 | Multi-agent + test-driven |

## Files

- `swebench_agent.ts` — Core agent pipeline (Planner → Localizer → Coder → Tester)
- `run_swebench_commander.ts` — Main runner script
- `evaluate.py` — Evaluation wrapper for official harness
- `../configs/swebench.yaml` — Benchmark configuration
