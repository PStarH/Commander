# Commander Benchmark Roadmap

> Strategic benchmark targets to prove Commander's multi-agent orchestration excellence.

## Current Scores (2026-05-28)

| Benchmark | Score | Status |
|-----------|-------|--------|
| PinchBench (43 agentic tasks) | **100.0%** | Maxed out |
| HumanEval+ (164 Python) | **96.3%** | Near ceiling |
| BFCL 12-core (12 scenarios) | **91.7%** / 91.7% | Strong |
| BFCL 30-task (30 scenarios) | **80.0%** / 80.0% | Good |
| GAIA (165 multi-step) | ⏳ 待重跑 | Previous 69.7% invalid (scoring bug); bare MiMo 21.2% |
| BFCL 35-scenario (35 scenarios) | **85.7%** / 85.7% | Updated 2026-05-29 via system prompt improvements |
| SWE-bench (10 instances) | **0.0%** (0/10) | Initial test — pipeline needs tuning |

## Priority 1: Re-run Existing Benchmarks

### GAIA (target: 75-80%)
- **Current**: ⏳ 待重跑 (previous 69.7% was invalid — scoring bug: empty expected field auto-passed)
- **Baseline**: Bare MiMo 21.2% (165 tasks, no tools)
- **Fix**: Scoring logic fixed (empty expected now returns False); answer extraction improved
- **Expected gain**: Re-run needed to establish honest baseline
- **Action**: Re-run with fixed scoring through Commander agent pipeline

### BFCL 35-scenario (target: 75-85%)
- **Current**: 60% tool selection, 60% parameter
- **Fixes applied**: System prompt improvements (irrelevance, multi-step, email defaults)
- **Expected gain**: +15-20pp from fixing irrelevance (4/5→1/5 wrong) and email refusal (2→0)
- **Action**: Re-run through Commander runtime with new scoring

## Priority 2: New High-Visibility Benchmarks

### SWE-Bench Verified ⭐ TOP PRIORITY
- **What**: Resolve 500 human-validated GitHub issues
- **SOTA**: ~50-70% (dynamic leaderboard)
- **Why Commander wins**: Multi-agent orchestration (planner → localizer → coder → tester)
- **Relevance**: Directly tests code understanding, bug reproduction, patch generation
- **Effort**: Medium — need to integrate with SWE-Bench harness
- **Impact**: HIGH — most visible agentic benchmark in 2026
- **Status**: ⚠️ IMPLEMENTED (0% on 10-instance initial test — pipeline needs tuning)
  - `swebench_agent.ts` — Planner → Localizer → Coder → Tester with test-driven retry
  - `run_swebench_commander.ts` — Main runner
  - `evaluate.py` — Official harness wrapper
  - `../configs/swebench.yaml` — Config with SWE-bench-specific tools

### tau-bench ⭐ HIGH PRIORITY
- **What**: Multi-turn conversations with tool use + policy adherence
- **SOTA**: GPT-4o <50% pass rate, pass^8 <25%
- **Why Commander wins**: Reliability gap is wide open; Commander's verification + self-improvement
- **Relevance**: Tests multi-turn interaction, tool calling, rule-following
- **Effort**: Low — uses standard tool-calling interface
- **Impact**: HIGH — demonstrates reliability, not just capability

### ToolBench
- **What**: 16,464 real-world APIs across 3,451 tools
- **SOTA**: GPT-4 71.1% pass rate
- **Why Commander wins**: Multi-tool orchestration at scale
- **Relevance**: Natural extension of BFCL tool selection
- **Effort**: Medium — need API catalog integration
- **Impact**: MEDIUM — proves tool orchestration at scale

### AgentBench
- **What**: 8 environments (OS, DB, knowledge graph, web, etc.)
- **SOTA**: Varies by environment
- **Why Commander wins**: Multi-agent specialization per environment type
- **Relevance**: Comprehensive agent evaluation
- **Effort**: High — multiple environment integrations
- **Impact**: MEDIUM — comprehensive but complex

## Priority 3: Complementary Evidence

### MINT (Multi-turn Interactive)
- **What**: Multi-turn tool use across conversations
- **Relevance**: Combines MT-Bench + BFCL capabilities
- **Effort**: Low

### WorkArena
- **What**: Enterprise web tasks on ServiceNow
- **Relevance**: Knowledge-worker automation
- **Effort**: Medium

### OSWorld
- **What**: 369 real computer tasks (file I/O, cross-app, GUI)
- **SOTA**: Best AI ~12%, Human 72%
- **Why**: Massive gap = massive opportunity
- **Effort**: High — needs GUI integration

## Recommended Execution Order

1. **Re-run GAIA** with fixed extraction (1 day)
2. **Re-run BFCL** through Commander runtime (1 day)
3. **tau-bench integration** (3-5 days) — highest ROI, lowest effort
4. **SWE-Bench integration** (1-2 weeks) — highest visibility
5. **ToolBench integration** (1 week) — natural BFCL extension

## Key Differentiators to Highlight

1. **GAIA orchestration gain** — bare MiMo 21.2%, Commander target 75-80% (re-run pending)
2. **97.7% PinchBench** — 42/43 agentic tasks passed (multifile.json failed)
3. **Reliability** (tau-bench target) — Commander's verification + self-improvement = consistent results
4. **Cost efficiency** — ~$0.10/task with quality gates
5. **Multi-agent orchestration** — 8 topologies, automatic selection
