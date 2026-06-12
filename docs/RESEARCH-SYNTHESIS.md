# Multi-Agent vs Single-Agent Research Synthesis

> **For**: Commander — TypeScript multi-agent runtime  
> **Compiled**: June 2026  
> **Scope**: Measured performance gains, token efficiency, architectural patterns, and failure modes across 10+ peer-reviewed papers, industry blogs, and conference proceedings.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Measured Performance Gains](#2-measured-performance-gains)
3. [Token Efficiency & Cost Tradeoffs](#3-token-efficiency--cost-tradeoffs)
4. [Architectural Patterns That Work](#4-architectural-patterns-that-work)
5. [Failure Modes & When NOT to Use Multi-Agent](#5-failure-modes--when-not-to-use-multi-agent)
6. [Design Principles for Commander](#6-design-principles-for-commander)
7. [Citations Matrix](#citations-matrix)

---

## 1. Executive Summary

Multi-agent systems demonstrably outperform single-agent baselines — but **only when the task demands breadth, parallelism, or specialized roles**. The dominant finding across every source surveyed: **multi-agent wins by spending more tokens intelligently**, not by architectural sophistication alone.

### Key takeaway for Commander

| If the task is... | Use topology | Why |
|---|---|---|
| Narrow, sequential, well-defined | **SINGLE** (1 agent) | Cheaper, faster, equally accurate |
| Multi-source research, breadth-first | **PARALLEL / HIERARCHICAL** | 90%+ quality gains over single-agent |
| Code generation with multiple roles | **SEQUENTIAL** (analyst→coder→tester) | MetaGPT: 28% relative improvement over GPT-4 |
| Debating uncertain answers | **DEBATE** | Improves factuality, reduces hallucinations |
| Long-horizon, multi-step reasoning | **HIERARCHICAL / EVALUATOR-OPT** | ROMA: 9.9% improvement on SEAL-0 |
| Efficiency-critical | **SINGLE** (with ReWOO pattern) | 5× token reduction vs ReAct, 4% accuracy gain |

---

## 2. Measured Performance Gains

### 2.1 Anthropic Multi-Agent Research System (Jun 2025)

**Source**: [Anthropic Engineering Blog](https://www.anthropic.com/engineering/multi-agent-research-system)

| Metric | Value |
|--------|-------|
| Multi-agent vs single-agent (internal eval) | **+90.2%** |
| Token multiplier (multi-agent vs chat) | **~15×** |
| Token multiplier (single agent vs chat) | **~4×** |
| Performance variance explained by token usage | **80%** (BrowseComp eval) |
| Performance variance explained by token usage + tool calls + model | **95%** |
| Research time reduction (parallel subagents + parallel tools) | **up to 90%** |
| Subagents per task | 3–5 |

**Architecture**: Claude Opus 4 as lead orchestrator, spawning Claude Sonnet 4 subagents. Each subagent operates independently with its own context window and tool set. The lead agent plans the research, delegates to subagents, and synthesizes results.

**Critical insight from Anthropic**: "Multi-agent systems work mainly because they help spend enough tokens to solve the problem." The performance gain is not from the multi-agent pattern itself but from the increased token budget distributed across independent context windows.

### 2.2 MetaGPT (ICLR 2024, Oral)

**Source**: [arXiv:2308.00352](https://arxiv.org/abs/2308.00352)

| Benchmark | MetaGPT | GPT-4 (baseline) | Relative Improvement |
|-----------|:-------:|:-----------------:|:-------------------:|
| HumanEval (Pass@1) | **85.9%** | 67.0% | **+28.2%** |
| MBPP (Pass@1) | **87.7%** | — | State-of-the-art |
| SoftwareDev executability (0–4) | **3.75** | — | Near-flawless |
| Executable feedback gain (HumanEval) | +4.2% | — | — |
| Executable feedback gain (MBPP) | +5.4% | — | — |

**Architecture**: Assembly-line paradigm with SOPs. Roles: Product Manager, Architect, Project Manager, Engineer, QA. Each role processes the output of the previous role in sequence, with executable feedback loops.

**Cost comparison** (SoftwareDev benchmark):

| Metric | ChatDev | MetaGPT w/o Feedback | MetaGPT |
|--------|:-------:|:--------------------:|:-------:|
| Running time (s) | 762 | 503 | 541 |
| Token usage | 19,292 | 24,613 | 31,255 |
| Tokens per line of code | 248.9 | 126.5 | 124.3 |
| Human revision cost (lower=better) | 2.5 | 2.25 | **0.83** |

### 2.3 ReWOO: Decoupling Reasoning from Observations (2023)

**Source**: [arXiv:2305.18323](https://arxiv.org/abs/2305.18323)

| Metric | Value |
|--------|-------|
| Token efficiency vs ReAct | **5× reduction** |
| Accuracy improvement on HotpotQA | **+4%** |
| Architecture | Modular: Planner (reasoning) → Worker (tool calls) → Solver (synthesis) |

**Key insight**: Detaching reasoning from observation eliminates redundant prompts and repeated execution. The plan is generated once, then workers execute tool calls in parallel, and a solver synthesizes the final answer. This is the blueprint for Commander's Atomizer→Planner→Executor→Aggregator pipeline.

### 2.4 Graph-of-Thoughts (AAAI 2024)

**Source**: [arXiv:2308.09687](https://arxiv.org/abs/2308.09687)

| Metric | Value |
|--------|-------|
| Sorting quality vs ToT | **+62%** |
| Cost reduction vs ToT | **>31%** |
| Sorting quality vs CoT | **+70%** |
| Sorting quality vs IO | **+83%** |
| Advantages increase with problem size | Yes (P=32→P=128) |

**Key insight**: Modeling LLM thoughts as an arbitrary graph (not chain or tree) enables aggregation, merging, and feedback loops. This is the conceptual foundation for Commander's DAG-based topology routing.

### 2.5 ROMA (2026)

**Source**: [arXiv:2602.01848](https://arxiv.org/abs/2602.01848)

| Benchmark | ROMA | Baseline | Improvement |
|-----------|:----:|:--------:|:-----------:|
| SEAL-0 (reasoning) | — | Kimi-Researcher | **+9.9%** |
| EQ-Bench (long-form writing) | DeepSeek-V3 | Claude Sonnet 4.5 | **Match** |

**Architecture**: Recursive plan-execute-aggregate loop with four modular roles: Atomizer (is atomic?), Planner (decompose), Executor (solve), Aggregator (synthesize). This is the closest published architecture to Commander's own design.

**Key insight**: Recursive decomposition with bounded aggregation solves context explosion. Each node returns a concise summary, not raw child outputs. The same control loop applies uniformly at every node, making the framework task-agnostic.

### 2.6 Multi-Agent Debate (Du et al., 2023)

**Source**: [arXiv:2305.14325](https://arxiv.org/abs/2305.14325)

- Significantly improves mathematical and strategic reasoning
- Reduces hallucination and improves factual validity
- Multiple LLM instances propose and debate responses over multiple rounds
- Works with existing black-box models (no fine-tuning required)

### 2.7 ACO-ToT: Ant Colony + LLM Reasoning (2025)

**Source**: [arXiv:2501.19278](https://arxiv.org/abs/2501.19278)

- Combines ant colony optimization with Tree-of-Thought reasoning
- Multiple fine-tuned LLM "ants" traverse a shared thought tree
- Pheromone trails reinforce productive reasoning paths
- Tested on GSM8K, ARC-Challenge, MATH — outperforms existing CoT approaches

### 2.8 Blackboard Architecture for MAS (2025)

**Source**: [arXiv:2507.01701](https://arxiv.org/abs/2507.01701)

- Dynamic agent selection based on blackboard content
- Shared information repository for all agents
- Competitive with SOTA while spending fewer tokens
- Round-based: select agent → execute → write to blackboard → repeat until consensus

---

## 3. Token Efficiency & Cost Tradeoffs

### 3.1 The Token Multiplier Reality

| System | Relative Token Cost | Performance Gain | Cost-Effective? |
|--------|:-------------------:|:----------------:|:---------------:|
| Single LLM call (chat) | 1× | Baseline | — |
| Single agent (ReAct loop) | ~4× chat | High | For complex tasks |
| Multi-agent (Anthropic) | ~15× chat | +90.2% internal eval | For research tasks only |
| ReWOO | ~5× less than ReAct | +4% accuracy | **Highly efficient** |
| MetaGPT | 1.3× ChatDev | 3.75 vs 2.25 executability | For complex software |
| GoT | >31% less than ToT | +62% quality | **More efficient + higher quality** |

### 3.2 When Multi-Agent Is Worth the Cost

From Anthropic: Multi-agent systems *only* make economic sense for **high-value tasks** where the 15× token multiplier is justified by the quality gains. For routine tasks, a single agent or even a bare LLM call suffices.

From MetaGPT: Adding agents (Product Manager, Architect, etc.) costs tokens but reduces human revision cost from 2.5 to 0.83 — a 67% reduction in human labor.

From ReWOO: The right architecture can *reduce* token consumption even while improving accuracy. The key is decoupling reasoning from observation — a pattern Commander's Atomizer→Planner→Executor→Aggregator directly implements.

### 3.3 Commander's Token Strategy

Commander addresses the cost challenge via:

1. **Deliberation**: Analyzes task complexity BEFORE spending tokens
2. **Effort scaling**: 1 agent for simple tasks, up to 20 for deep research
3. **Topology routing**: Single for narrow tasks, parallel for breadth, hierarchical for depth
4. **Tool result caching**: SHA-256 based, per-tenant key isolation
5. **Context compaction**: Token-aware message compression
6. **Token governor**: Hard budget enforcement per run

---

## 4. Architectural Patterns That Work

### 4.1 The ReAct Loop (Foundation)

Every system surveyed builds on ReAct (Reasoning + Acting). The pattern: **Thought → Action → Observation → Thought**. This is the atomic unit of agent execution, whether single or multi-agent.

### 4.2 Composable Patterns (Anthropic)

Anthropic's "Building effective agents" (Dec 2024) identifies these production-validated patterns:

| Pattern | When to Use | Example |
|---------|-------------|---------|
| **Augmented LLM** | Simple tasks | LLM + retrieval + tools |
| **Prompt chaining** | Sequential subtasks | Write → Review → Refine |
| **Routing** | Classify then route | Customer support triage |
| **Parallelization** | Independent subtasks | Research multiple sources |
| **Orchestrator-workers** | Dynamic delegation | Lead agent spawns subagents |
| **Evaluator-optimizer** | Iterative refinement | Code → Test → Fix |

### 4.3 SOP-Based Assembly Line (MetaGPT)

MetaGPT's key innovation: encoding Standardized Operating Procedures (SOPs) into prompt sequences. Each agent role follows a predefined process, with intermediate verification between stages. This reduces cascading hallucinations common in naively chained LLMs.

### 4.4 Recursive Decomposition (ROMA)

ROMA's recursive plan-execute-aggregate loop is the most general pattern surveyed:

```
solve(task):
  if is_atomic(task):
    return execute(task)
  else:
    subtasks = plan(task)           # Decompose into MECE DAG
    results = [solve(s) for s in subtasks]  # Recurse (parallel when possible)
    return aggregate(results)       # Synthesize + compress
```

This is Commander's Atomizer → Planner → Executor → Aggregator pipeline — the same pattern.

### 4.5 Debate & Ensemble (Du et al., ChatDev)

Multiple agents propose solutions independently, then debate or vote. ChatDev uses "chat chains" (structured multi-turn dialogues) and "communicative dehallucination" to improve software development outcomes.

### 4.6 Blackboard (Shared Memory)

The blackboard architecture (arXiv:2507.01701) lets agents share information through a central repository. Agents are selected dynamically based on what's currently on the blackboard. This is analogous to Commander's message bus + three-layer memory.

---

## 5. Failure Modes & When NOT to Use Multi-Agent

### 5.1 MAST Taxonomy (arXiv:2503.13657)

The Multi-Agent System Failure Taxonomy (MAST) identifies **14 failure modes** across **3 categories**:

#### Category 1: System Design Issues
| Failure Mode | Description |
|---|---|
| Ambiguous Role Definition | Agents unclear on their responsibilities |
| Poor Decomposition Strategy | Tasks split at wrong granularity |
| Inefficient Communication Protocol | Too much/too little information sharing |
| Lack of Shared Context | Agents operate without common understanding |

#### Category 2: Inter-Agent Misalignment
| Failure Mode | Description |
|---|---|
| Conflicting Objectives | Agents work at cross-purposes |
| Redundant Work | Multiple agents doing the same thing |
| Cascading Errors | One agent's mistake propagates |
| Misattributed Credit | Wrong agent blamed/rewarded |

#### Category 3: Task Verification
| Failure Mode | Description |
|---|---|
| Incomplete Verification | Outputs not fully checked |
| False Confidence | Agent overestimates own quality |
| Verification Slippage | Quality degrades across rounds |

**Critical finding**: "Performance gains on popular benchmarks are often minimal compared to single-agent formulations." (MAST, 2025)

### 5.2 When Single-Agent Is Better

| Scenario | Why Single-Agent Wins |
|----------|----------------------|
| Simple, well-defined tasks | Overhead of multi-agent adds cost without benefit |
| Sequential logic with shared context | Multi-agent loses context across agent boundaries |
| Real-time/low-latency requirements | Coordination overhead adds latency |
| Budget-constrained environments | 15× token multiplier is prohibitive |
| Tasks where a single LLM call suffices | Anthropic: "start with simple prompts" |
| Debugging/troubleshooting | Single agent has simpler trace |

### 5.3 Cognition's Anti-Multi-Agent Argument

Cognition (makers of Devin) published "why not to build multi-agents" — arguing that multi-agent adds coordination complexity without proportional benefit for most coding tasks. This was published the day before Anthropic's multi-agent research blog, highlighting the ongoing debate.

---

## 6. Design Principles for Commander

Synthesizing all evidence, these principles guide Commander's architecture:

### Principle 1: Right-Size First
Start with a single agent. Add agents only when deliberation detects a task that benefits from parallel exploration, role specialization, or debate. Commander's deliberation engine implements this gate.

### Principle 2: Token Budget Determines Topology
80% of performance variance is explained by token usage (Anthropic). Commander scales agents not by architectural fiat but by token budget: more budget → more agents → better results for complex tasks.

### Principle 3: Decouple Reasoning from Execution
ReWOO's 5× token reduction proves that separating planning from tool execution is the single most impactful optimization. Commander's Atomizer→Planner→Executor pipeline implements this directly.

### Principle 4: Aggregate Then Compress
ROMA proves that bounded aggregation (returning summaries, not raw outputs) prevents context explosion. Commander's Aggregator synthesizes and compresses before passing results up the tree.

### Principle 5: Fail Transparently
MAST proves that multi-agent failures are systematic, not random. Commander's circuit breakers, dead letter queues, execution traces, and checkpoints make every failure inspectable.

### Principle 6: Measure, Don't Assume
MetaGPT's 28% relative improvement and Anthropic's 90.2% gains are *measured*, not claimed. Commander's metrics collection (Prometheus counters/gauges/histograms) ensures every topology decision can be validated empirically.

---

## Citations Matrix

| # | Source | Type | Year | Venue | Key Claim |
|---|--------|------|------|-------|-----------|
| 1 | [Anthropic — Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | Industry blog | 2024 | — | Simple composable patterns > complex frameworks |
| 2 | [Anthropic — Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | Industry blog | 2025 | — | +90.2% multi-agent vs single-agent; 15× tokens; 80% variance explained by token usage |
| 3 | [MetaGPT (Hong et al.)](https://arxiv.org/abs/2308.00352) | Peer-reviewed | 2024 | ICLR Oral | 85.9% HumanEval, 87.7% MBPP, 28.2% relative improvement over GPT-4 |
| 4 | [AutoGen (Wu et al.)](https://arxiv.org/abs/2308.08155) | Peer-reviewed | 2023 | arXiv | Multi-agent conversation framework for diverse applications |
| 5 | [ChatDev (Qian et al.)](https://arxiv.org/abs/2307.07924) | Peer-reviewed | 2024 | ACL | Chat chain for software development; communicative dehallucination |
| 6 | [MAST (Cemri et al.)](https://arxiv.org/abs/2503.13657) | Peer-reviewed | 2025 | arXiv | 14 failure modes; MAS gains "often minimal" vs single-agent; 1600+ annotated traces |
| 7 | [Multi-agent debate (Du et al.)](https://arxiv.org/abs/2305.14325) | Peer-reviewed | 2023 | arXiv | Improves mathematical reasoning; reduces hallucinations |
| 8 | [ReWOO (Xu et al.)](https://arxiv.org/abs/2305.18323) | Peer-reviewed | 2023 | arXiv | 5× token efficiency; +4% HotpotQA |
| 9 | [Graph-of-Thoughts (Besta et al.)](https://arxiv.org/abs/2308.09687) | Peer-reviewed | 2024 | AAAI | +62% sorting quality; >31% cost reduction vs ToT |
| 10 | [ROMA (Alzu'bi et al.)](https://arxiv.org/abs/2602.01848) | Peer-reviewed | 2026 | arXiv | +9.9% SEAL-0; recursive Atomizer→Planner→Executor→Aggregator |
| 11 | [Google A2A Protocol](https://developers.google.com/a2a) | Industry standard | 2025 | — | Open agent interoperability protocol |
| 12 | [Blackboard MAS (Han & Zhang)](https://arxiv.org/abs/2507.01701) | Peer-reviewed | 2025 | arXiv | SOTA performance with fewer tokens; dynamic agent selection |
| 13 | [ACO-ToT (Chari et al.)](https://arxiv.org/abs/2501.19278) | Peer-reviewed | 2025 | arXiv | Ant colony + LLM reasoning; outperforms CoT on GSM8K/ARC/MATH |
| 14 | [LLM-based Multi-Agents Survey (Guo et al.)](https://arxiv.org/abs/2402.01680) | Survey | 2024 | arXiv | Comprehensive taxonomy of profiling, communication, benchmarks |

---

*This document is living — update as new evidence emerges. Commander's architecture should be validated against these claims every quarter.*
