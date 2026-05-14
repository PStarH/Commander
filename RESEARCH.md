# Tool Calling Research — Best Practices 2026

## Claude Code
- **Loop**: `while (tool_calls) { execute → feed back → call model }`
- **Concurrent execution**: Read-only tools in parallel, state-mutating serially
- **Speculative execution**: Start tools WHILE model is still streaming response
- **Tool partitioning**: Consecutive same-safety tools batched, concurrent via Promise.race()
- **14-step pipeline**: Lookup → Validation → Permission → Execution → Budgeting → Error
- **Deferred tools**: Only tool names loaded, schema fetched on demand via ToolSearch
- **Programmatic tool calling**: Model writes Python → code calls tools → only final output to context (-24% tokens, +11% accuracy)

## OpenClaw
- **Gateway + Agent runtime**: Gateway handles channels, runtime runs ReAct loop
- **Plugin-based tools**: Even built-in tools registered as plugins at startup
- **5-layer permission system**: deny-wins, prevents privilege escalation
- **Sub-agent spawning**: Configurable timeout, cleanup (delete/keep), sandbox modes

## Hermes Agent
- **Monolithic AIAgent class**: Loop + tools + memory + skill creation in one class
- **Self-improvement loop**: Creates/refines skills from experience automatically
- **47 tools + 40 toolsets**: Largest tool surface
- **Serverless execution**: Daytona/Modal for compute-heavy tasks

## OhMyOpenCode (Sisyphus)
- **Category-based delegation**: Pick category → category maps to model
- **Parallel background agents**: Fire subagents in background, collect on completion
- **Intent Gate**: Classify BEFORE acting
- **Ralph Loop**: Self-referential loop until 100% done

## What Commander Must Steal/Improve

| # | Improvement | Priority | Impact |
|---|-----------|----------|--------|
| 1 | **Concurrent tool execution** within single turn | Critical | 2-5x speedup |
| 2 | **Speculative execution** during model streaming | High | 30-50% latency reduction |
| 3 | **Result budgeting** — cap tool output, persist large results | High | Token savings |
| 4 | **Tool safety flags** — isConcurrencySafe, isReadOnly, timeout | Critical | Reliability |
| 5 | **Agent SDK pattern** — clean Tool interface with lifecycle hooks | High | Extensibility |
| 6 | **Sub-agent isolation** — per-agent context, budget, allowlist | Medium | Safety |
| 7 | **Programmatic tool calling** — model writes code, not per-tool round trips | Medium | -24% tokens |
| 8 | **Learning loop** — improve from execution outcomes | Low | Long-term |
