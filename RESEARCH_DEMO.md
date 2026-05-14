# Commander Research Demo

**Commander** is a multi-agent orchestration system that dynamically selects execution topology based on task complexity. This demo shows Commander using `browser_search` to research and compare AI agent frameworks — all with real web search and multi-step reasoning.

## Demo Output

### LangGraph vs CrewAI vs AutoGen: 2026 Comparison

| Attribute | LangGraph | CrewAI | AutoGen |
|---|---|---|---|
| GitHub Stars | ~19,900 | ~39,200 | ~50,600 |
| Maintainer | LangChain Inc | CrewAI Inc | Microsoft |
| License | MIT | MIT | Apache-2.0 |
| Architecture | Graph-based workflows | Role-based collaborative agents | Multi-agent conversations |
| Difficulty | Advanced | Intermediate | Advanced |
| Key Features | State management, human-in-the-loop, streaming | Role assignment, task delegation, crew metaphor | Autonomous task solving, human-in-the-loop |
| Strengths | Full control, state persistence, production-proven (Klarna/Uber) | Intuitive design, growing community, good docs | Powerful conversation framework, Microsoft backing |
| Weaknesses | Steep learning curve, overkill for simple tasks | Less flexibility, opinionated architecture | Complex setup, debugging challenges |
| Best Use Cases | Complex customer support, business process automation | Content creation, business analysis, software dev crews | Research systems, code generation, agent simulations |
| Enterprise Ready | Yes (LangGraph Platform) | Yes (CrewAI+) | Yes |
| Community | Large | Very Large | Very Large |

### Quick Decision Guide
- **Choose LangGraph** → Complex stateful workflows, maximum control
- **Choose CrewAI** → Fast setup, role-based multi-agent teams
- **Choose AutoGen** → Research-focused, conversation-based collaboration

## How It Works

1. Commander decomposes the research task
2. Sub-agents use `browser_search` to find current information
3. Results are combined and synthesized into structured output
4. Quality gates verify accuracy and completeness

## Commander vs Other Frameworks

| Capability | Commander | LangGraph | CrewAI | AutoGen |
|---|---|---|---|---|
| Dynamic Topology | 8 types | Fixed (graph) | Fixed (role-based) | Fixed (conversation) |
| Quality Gates | 5 gates | None | None | None |
| Self-Optimization | MetaLearner | None | None | None |
| MCP Native | Yes | No | No | No |
| Tools | 13 built-in | Via LangChain | Limited | Via plugins |
| Tests | 101/101 | — | — | — |
