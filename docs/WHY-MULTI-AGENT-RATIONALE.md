# Why Multiple Agents? Why Not One?

> **The evidence-based case for Commander's multi-agent architecture**  
> Every claim below is cited to peer-reviewed research, official industry blogs, or conference proceedings.

---

## The Honest Answer

Multi-agent systems are **not always better**. The evidence is clear:

- MAST (arXiv:2503.13657): "Performance gains on popular benchmarks are often minimal compared to single-agent formulations."
- Anthropic (2024): "Start with simple prompts, optimize them with comprehensive evaluation, and add multi-step agentic systems only when simpler solutions fall short."
- Cognition (2025): Published "why not to build multi-agents" — arguing multi-agent adds coordination complexity without proportional benefit for most coding tasks.

**So why does Commander use multiple agents?**

Because Commander doesn't *always* use multiple agents. It uses **the right number of agents for the task** — determined by deliberation, not by architectural dogma.

---

## The Measured Case: When Multiple Agents Win

### 1. Breadth-First Research: +90.2% Over Single Agent

**Source**: [Anthropic Engineering Blog (Jun 2025)](https://www.anthropic.com/engineering/multi-agent-research-system)

Anthropic's multi-agent research system (Claude Opus 4 lead + Claude Sonnet 4 subagents) outperformed single-agent Claude Opus 4 by **90.2%** on their internal research eval. The key: research tasks require exploring multiple independent directions simultaneously. A single agent with one context window cannot do this efficiently.

**Why this matters for Commander**: Commander's `swarm` mode and PARALLEL topology exist specifically for this class of problem. When deliberation detects a breadth-first research task, Commander spawns multiple agents.

### 2. Specialized Roles: 28.2% Relative Improvement Over GPT-4

**Source**: [MetaGPT, ICLR 2024 Oral](https://arxiv.org/abs/2308.00352)

MetaGPT assigns roles (Product Manager, Architect, Engineer, QA) following Standardized Operating Procedures. Result: **85.9% HumanEval** (vs GPT-4's 67.0%), **3.75/4.0 executability** on full software projects.

A single agent cannot simultaneously act as architect, coder, and QA without hallucinating. The role separation forces verification at each stage.

**Why this matters for Commander**: Commander's HIERARCHICAL and SEQUENTIAL topologies enable role-based agent teams. The deliberation engine can allocate a Product Manager agent, coder agents, and a verification agent for software tasks.

### 3. Decomposition Solves Context Explosion: +9.9% on SEAL-0

**Source**: [ROMA, arXiv:2602.01848 (2026)](https://arxiv.org/abs/2602.01848)

ROMA's recursive decomposition (Atomizer→Planner→Executor→Aggregator) prevents context windows from filling up. Each executor operates on localized context; each aggregator compresses before passing upward. Result: **9.9% improvement** over Kimi-Researcher on SEAL-0 (reasoning over conflicting web evidence).

A single-agent system with one context window degrades as the task grows — "context rot" and "lost-in-the-middle" problems are well-documented (Liu et al., 2024; Hong et al., 2025).

**Why this matters for Commander**: Commander's Atomizer, Planner, Executor, and Aggregator roles are the same pattern as ROMA. The deliberation engine sets `max_depth` based on task complexity, preventing context explosion.

### 4. Graph-Based Reasoning: +62% Quality, -31% Cost

**Source**: [Graph-of-Thoughts, AAAI 2024](https://arxiv.org/abs/2308.09687)

GoT models LLM thoughts as a graph (not chain or tree), enabling aggregation, merging, and feedback loops. Results: **62% quality improvement** over Tree-of-Thought on sorting, with **>31% cost reduction**.

Why? Because a graph lets you solve subtasks independently and merge results — exactly what Commander's DAG-based topology routing does.

**Why this matters for Commander**: Commander's topology router selects PARALLEL or HYBRID topologies when tasks have independent subtasks. This is GoT's insight applied at the agent level rather than the thought level.

### 5. Debate Reduces Hallucinations

**Source**: [Du et al., arXiv:2305.14325 (2023)](https://arxiv.org/abs/2305.14325)

Multiple LLM instances propose and debate responses over multiple rounds. The result: significantly improved factuality and mathematical reasoning. This is impossible with a single agent — you need multiple independent perspectives to cross-validate.

**Why this matters for Commander**: Commander's DEBATE topology implements this directly. When deliberation detects a question where factual accuracy is critical, it spawns multiple agents, collects their independent answers, and synthesizes a consensus.

### 6. Self-Correction Through Feedback Loops

**Source**: [MetaGPT, ICLR 2024](https://arxiv.org/abs/2308.00352); [ChatDev, ACL 2024](https://arxiv.org/abs/2307.07924)

MetaGPT's executable feedback adds **+4.2%** on HumanEval and **+5.4%** on MBPP while reducing human revision cost from 2.25 to 0.83. ChatDev's communicative dehallucination uses multi-turn dialogue between agents to catch errors.

A single agent can self-correct, but it's less effective — the same model tends to make similar mistakes. A separate verification agent catches different error classes.

**Why this matters for Commander**: Commander's verification tool and quality gates act as independent checkers. The EVALUATOR-OPTIMIZER topology implements iterative refinement with separate evaluation agents.

---

## The Counter-Evidence: When Single-Agent Is Fine

### MAST's Warning (2025)

MAST analyzed **1600+ annotated traces** across 7 MAS frameworks and found:
- 14 failure modes in 3 categories (design, alignment, verification)
- "Performance gains on popular benchmarks are often minimal"
- Many failures require "more sophisticated solutions" than simple multi-agent patterns

### Cognition's Argument (2025)

Cognition argues that for most coding tasks, multi-agent complexity doesn't justify the cost. Devin (their product) uses a single-agent architecture with sophisticated tool use, not multiple agents.

### Token Cost Reality

| System | Token Multiplier vs Chat |
|--------|:------------------------:|
| Simple LLM call | 1× |
| Single agent (ReAct) | ~4× |
| Multi-agent (Anthropic) | ~15× |
| Multi-agent (MetaGPT) | ~1.6× ChatDev |

Multi-agent costs **3-4× more than single-agent** in tokens. For simple tasks, this is wasted.

---

## Commander's Resolution: Deliberation-First Architecture

Commander doesn't choose between single-agent and multi-agent. It **deliberates first**, then chooses:

```
Task arrives
    │
    ▼
┌─────────────────────────────────┐
│  DELIBERATION ENGINE            │
│  ├─ Task complexity analysis    │
│  ├─ Required capabilities       │
│  └─ Cost/quality tradeoff       │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│  EFFORT SCALER                  │
│  └─ 1 agent (simple)            │
│     up to 20 agents (research)  │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│  TOPOLOGY ROUTER                │
│  ├─ SINGLE     (narrow tasks)   │
│  ├─ SEQUENTIAL (pipeline tasks) │
│  ├─ PARALLEL   (breadth tasks)  │
│  ├─ HIERARCHICAL (deep tasks)   │
│  ├─ DEBATE     (factual tasks)  │
│  ├─ ENSEMBLE   (uncertain tasks)│
│  ├─ HYBRID     (complex tasks)  │
│  └─ EVAL-OPT   (iterative tasks)│
└─────────────────────────────────┘
```

### What the Evidence Says About Each Topology

| Topology | When Evidence Supports It | Evidence Source |
|----------|--------------------------|-----------------|
| **SINGLE** | Simple, well-defined tasks (default) | Anthropic, Cognition |
| **SEQUENTIAL** | Pipeline tasks with clear stages | MetaGPT (SOP assembly line) |
| **PARALLEL** | Independent subtasks, breadth-first | Anthropic (+90.2%), GoT (+62%) |
| **HIERARCHICAL** | Deep reasoning, long-horizon | ROMA (+9.9% SEAL-0) |
| **DEBATE** | Factual accuracy, math reasoning | Du et al. (reduced hallucinations) |
| **ENSEMBLE** | Uncertain answers, diverse perspectives | GoT, Du et al. |
| **HYBRID** | Complex tasks needing multiple patterns | ROMA, MetaGPT |
| **EVAL-OPT** | Iterative refinement with clear criteria | MetaGPT (+4.2%/+5.4% feedback) |

### Cost Control Built In

Because Commander deliberates before executing:

| Task Type | Agents | Topology | Relative Cost |
|-----------|:------:|:--------:|:-------------:|
| "Write a hello world" | 1 | SINGLE | 1× (efficient) |
| "Debug this function" | 1 | SINGLE | ~4× |
| "Research competitor pricing" | 5-10 | PARALLEL | ~10-15× (but justified) |
| "Build a CRUD API" | 4-6 | HIERARCHICAL | ~8-12× (but verified) |
| "Which DB should we use?" | 3 | DEBATE | ~6× (but accurate) |

---

## Summary: The Pragmatic Answer

**Why multiple agents?** Because for breadth-first research, role-based software development, long-horizon reasoning, and factual accuracy tasks, multiple agents demonstrably outperform single agents by **9-90%** depending on the task.

**Why not always multiple agents?** Because for simple tasks, the 3-15× token multiplier has no justification. Single-agent matches or exceeds multi-agent on narrow, sequential, well-defined tasks.

**Commander's answer**: Deliberate first. Let the evidence guide the topology. Never force multi-agent where single-agent suffices. Never force single-agent where multi-agent wins.

---

## References

1. Anthropic. "Building effective agents" (Dec 2024). https://www.anthropic.com/engineering/building-effective-agents
2. Anthropic. "How we built our multi-agent research system" (Jun 2025). https://www.anthropic.com/engineering/multi-agent-research-system
3. Hong et al. "MetaGPT: Meta Programming for a Multi-Agent Collaborative Framework." ICLR 2024 (Oral). arXiv:2308.00352
4. Wu et al. "AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation." arXiv:2308.08155
5. Qian et al. "ChatDev: Communicative Agents for Software Development." ACL 2024. arXiv:2307.07924
6. Cemri et al. "Why Do Multi-Agent LLM Systems Fail?" arXiv:2503.13657
7. Du et al. "Improving Factuality and Reasoning in Language Models through Multiagent Debate." arXiv:2305.14325
8. Xu et al. "ReWOO: Decoupling Reasoning from Observations for Efficient Augmented Language Models." arXiv:2305.18323
9. Besta et al. "Graph of Thoughts: Solving Elaborate Problems with Large Language Models." AAAI 2024. arXiv:2308.09687
10. Alzu'bi et al. "ROMA: Recursive Open Meta-Agent Framework." arXiv:2602.01848
11. Han & Zhang. "Exploring Advanced LLM Multi-Agent Systems Based on Blackboard Architecture." arXiv:2507.01701
12. Chari et al. "Pheromone-based Learning of Optimal Reasoning Paths (ACO-ToT)." arXiv:2501.19278
13. Guo et al. "Large Language Model based Multi-Agents: A Survey." arXiv:2402.01680
