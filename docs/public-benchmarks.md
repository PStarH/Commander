# Commander Benchmark Results

> **Date**: 2026-05-17 | **Model**: MiMo-V2.5-Pro | **Evidence**: `docs/benchmark-results/`

## Results

| Benchmark | Score | Sample Size | Evidence | Notes |
|-----------|:-----:|:-----------:|:--------:|-------|
| **HumanEval pass@1** | **96.3%** | 164 tasks | [results](benchmark-results/humaneval-results.json) | evalplus-style, base tests |
| **HumanEval+ pass@1** | **91.5%** | 164 tasks | [results](benchmark-results/humaneval-results.json) | includes extra edge-case tests |
| **GAIA (Exact Match)** | **69.7%** | 165 tasks | [results](benchmark-results/gaia-commander-final/) | Commander pipeline with tools |
| **PinchBench** | **97.7%** | 43 tasks | [results](benchmark-results/pinchbench-final42/) | 12-domain agent tasks |

## Smaller-Scale Evaluations (interpret with caution)

| Benchmark | Score | Sample Size | Evidence | Caveat |
|-----------|:-----:|:-----------:|:--------:|--------|
| **BFCL tool selection** | **80.0%** | 30 tasks | [results](benchmark-results/bfcl/) | Official BFCL has 2000+ tasks. Not comparable to leaderboard. |
| **MT-Bench** | **7.8/10** | 5 questions | [results](benchmark-results/mtbench/) | Standard MT-Bench has 80 questions. Not comparable. |

## Baseline Comparisons

| Metric | Commander + MiMo | Bare MiMo (no tools) | Delta |
|--------|:----------------:|:--------------------:|:-----:|
| GAIA 165 tasks | 69.7% | 21.2% | **+48.5pp** |

## How to Reproduce

```bash
# HumanEval (requires evalplus + API key)
npx tsx benchmarks/humaneval-eval.ts

# GAIA (requires API key)
npx tsx benchmarks/gaia-commander-benchmark.ts

# PinchBench (requires API key)
npx tsx benchmarks/pinchbench-eval.ts

# All unit tests + performance
npx tsx --test tests/*.test.ts benchmarks/performance.test.ts benchmarks/telos.benchmark.test.ts
```

## Methodology

- **HumanEval/HumanEval+**: Generated solutions for all 164 HumanEval problems, scored with evalplus base+extra test suites
- **GAIA**: 165 GAIA-style questions (3 difficulty levels), exact-match scoring after text normalization. Commander pipeline: task detection → tool selection → multi-step execution → answer extraction
- **PinchBench**: 43 tasks across coding, research, writing, data analysis, DevOps, security, finance. Binary pass/fail per task
- **BFCL**: 30 function-calling scenarios testing tool selection and parameter accuracy
- **MT-Bench**: 5 open-ended questions scored 1-10 by MiMo acting as judge

## Known Limitations

1. **BFCL sample too small**: 30 tasks does not represent the full BFCL benchmark. The 80% score should not be compared to official leaderboard entries.
2. **MT-Bench sample too small**: 5 questions does not represent the standard 80-question benchmark.
3. **GAIA dataset is GAIA-style, not official**: We used 165 questions modeled after GAIA, not the official GAIA validation set. Exact scores may differ on the real dataset.
4. **Self-evaluation risk**: Commander evaluates itself. Some benchmarks (PinchBench, GAIA) were designed alongside the system. Independent third-party evaluation would be more credible.
5. **Single model**: All results are with MiMo-V2.5-Pro. Performance with other models (GPT-4o, Claude, etc.) is unknown.
