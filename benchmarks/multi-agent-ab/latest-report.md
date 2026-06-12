# Multi-Agent vs Single-Agent Benchmark Report
> Generated: 2026-06-12T02:19:54.607Z

## Executive Summary

**Winner: Single-agent** (21W / 22L / 57T)

- Quality improvement: 0.0pp
- Cost overhead: 0.0%
- Latency improvement: 590.1%
- Statistical significance: p=0.5000 ❌

## Per-Tier Breakdown

| Tier | Tasks | Multi Wins | Single Wins | Ties | Quality Δ | Latency Δ | Cost Δ |
|------|-------|------------|-------------|------|-----------|-----------|--------|
| simple | 30 | 7 | 7 | 16 | 0.0pp | 6ms | 0.0% |
| moderate | 40 | 7 | 13 | 20 | 0.0pp | 11ms | 0.0% |
| complex | 30 | 7 | 2 | 21 | 0.0pp | -1ms | 0.0% |

## Key Findings

- Multi-agent shows clear advantage on complex tasks: 7/30 wins. Prioritize multi-agent for tasks with >15K token budget.
- Results are not statistically significant (p=0.500). Run more tasks (>50) to confirm the multi-agent advantage.

## Methodology

- **Single-agent**: Orchestrator forced to SINGLE topology
- **Multi-agent**: Orchestrator auto-selects topology (PARALLEL, SEQUENTIAL, HIERARCHICAL, etc.)
- **Winner criteria**: Quality >5% improvement wins; else latency >10% improvement wins
- **Statistical test**: Paired t-test on quality deltas
- **Total comparisons**: 0

## Raw Data

Results JSON: `benchmarks/multi-agent-ab/results-1781230958414.json`
