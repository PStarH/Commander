# Smart Routing Benchmark Report

Generated: 2026-05-16T07:26:58.620Z
Tasks: 25

## Cost Summary

| Metric | Power-Only | Smart Routing | Delta |
|--------|-----------|---------------|-------|
| Total estimated cost | $16.657970 | $10.633110 | -$6.024860 (36.2%) |
| Avg cost per task | $0.666319 | $0.425324 | |

## Quality Summary

| Metric | Power-Only | Smart Routing |
|--------|-----------|---------------|
| Capability coverage | 25/23 (109%) | 24/23 (104%) |

## Tier Distribution (Smart Routing)

| Tier | Count | Tasks |
|------|-------|-------|
| eco | 8 | T01, T02, T03, T04, T05, T06, T07, T08 |
| power | 7 | T17, T18, T19, T22, T23, T24, T25 |
| standard | 10 | T09, T10, T11, T12, T13, T14, T15, T16, T20, T21 |

## Per-Task Detail

| ID | Task | Difficulty | Power Model | Smart Model | Power Cost | Smart Cost | Savings | Caps OK |
|-----|------|-----------|-------------|-------------|-----------|------------|---------|---------|
| T01 | Simple greeting | trivial | gpt-5 | gpt-4o-mini | $0.060530 | $0.000910 | 98% | - |
| T02 | Unit conversion | trivial | gpt-5 | gpt-4o-mini | $0.100560 | $0.001510 | 98% | YES |
| T03 | Simple lookup | trivial | gpt-5 | gpt-4o-mini | $0.080560 | $0.001210 | 98% | - |
| T04 | Summarize text | easy | gpt-5 | gpt-4o-mini | $0.180660 | $0.002710 | 98% | YES |
| T05 | File read | easy | gpt-5 | gpt-4o-mini | $0.140630 | $0.002110 | 98% | YES |
| T06 | Web search | easy | gpt-5 | gpt-4o-mini | $0.220640 | $0.003310 | 98% | YES |
| T07 | Simple calculation | easy | gpt-5 | gpt-4o-mini | $0.100630 | $0.001510 | 98% | YES |
| T08 | Format data | easy | gpt-5 | gpt-4o-mini | $0.140570 | $0.002110 | 98% | YES |
| T09 | Write function | medium | gpt-5 | gpt-4o | $0.340660 | $0.085170 | 75% | YES |
| T10 | Debug code | medium | gpt-5 | gpt-4o | $0.420690 | $0.105170 | 75% | YES |
| T11 | Data analysis | medium | gpt-5 | gpt-4o | $0.500700 | $0.125180 | 75% | YES |
| T12 | API design | medium | gpt-5 | gpt-4o | $0.420720 | $0.105180 | 75% | YES |
| T13 | Write tests | medium | gpt-5 | gpt-4o | $0.500670 | $0.125170 | 75% | YES |
| T14 | Research report | medium | gpt-5 | gpt-4o | $0.620690 | $0.155170 | 75% | YES |
| T15 | Refactor code | medium | gpt-5 | gpt-4o | $0.620720 | $0.155180 | 75% | YES |
| T16 | System design | hard | gpt-5 | gpt-4o | $0.820760 | $0.205190 | 75% | YES |
| T17 | Complex debugging | hard | gpt-5 | gpt-5 | $1.020880 | $1.020880 | 0% | YES |
| T18 | Multi-file refactor | hard | gpt-5 | gpt-5 | $1.220860 | $1.220860 | 0% | YES |
| T19 | Performance optimization | hard | gpt-5 | gpt-5 | $1.020830 | $1.020830 | 0% | YES |
| T20 | Creative writing | hard | gpt-5 | gpt-4o | $0.820850 | $0.205210 | 75% | YES |
| T21 | Compiler design | expert | gpt-5 | gpt-4o | $1.620830 | $0.405210 | 75% | NO |
| T22 | Distributed consensus | expert | gpt-5 | gpt-5 | $2.020860 | $2.020860 | 0% | YES |
| T23 | Critical deployment | expert | gpt-5 | gpt-5 | $1.220790 | $1.220790 | 0% | YES |
| T24 | Security audit | expert | gpt-5 | gpt-5 | $1.420800 | $1.420800 | 0% | YES |
| T25 | Cross-domain integration | hard | gpt-5 | gpt-5 | $1.020880 | $1.020880 | 0% | YES |

## Quality Regressions

Tasks where smart routing selected a model WITHOUT required capabilities:
- **T21** (Compiler design): needs [code, reasoning, math], got gpt-4o [complexity: 6/10 (short_goal, several_tools, large_budget); task_type: code; required_capabilities: code; selected_tier: standard; governor_phase: relaxed; candidates_ranked: 3; selected_model: gpt-4o]