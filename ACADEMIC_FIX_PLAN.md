# Academic Fix Plan — Internal

## WP1: Unbounded Message Growth → MemGPT-style Virtual Context Management

**Papers**:
- MemGPT: Towards LLMs as Operating Systems (arXiv 2310.08560) — virtual memory paging for LLM context
- StreamingLLM: Efficient Streaming Language Models with Attention Sinks (ICLR 2024) — sliding window + attention sinks

**Algorithm**: Maintain a sliding window of recent messages + a compressed summary of older context. When context budget exceeds 70%, trigger compaction. The summary is structured (goal, progress, key decisions) so the model can continue coherently.

**Implementation**: ContextCompactor (already built!) needs to be called from the tool loop in agentRuntime.ts. Insert after each tool iteration (line 286) to check context pressure and compact before sending next request.

**Risk**: Low. Compaction may lose nuance, but the structured summary format preserves goal/decisions/files.

---

## WP2: Silent Error Swallowing → Structured Error Classification

**Papers**:
- Tool Calling Patterns for Reliable AI Agents (Mikul Gohil, 2025) — retryable vs non-retryable error classification
- Retry Patterns for LLM API Errors (learnwithparam, 2026) — 429/5xx vs 4xx distinction

**Algorithm**: Classify errors into retryable (429, 5xx, timeout, network) and permanent (400, 401, 403, 422). Return structured error objects instead of null. Surface permanent errors immediately without retry.

**Implementation**: Modify `callWithTimeout()` to return typed errors instead of null. The retry loop checks error type before retrying.

**Risk**: Low. Pure improvement — no behavioral changes for existing flows.

---

## WP3: Duplicate Self-Correction → Reflexion-style Memory

**Papers**:
- Self-Refine: Iterative Refinement with Self-Feedback (arXiv 2303.17651) — iterative feedback → refine loop
- Reflexion: Language Agents with Verbal Reinforcement Learning (arXiv 2303.11366) — episodic memory of past attempts
- LATS: Language Agent Tree Search — tree search over action trajectories

**Algorithm**: Add a "previous attempts" buffer to the quality gate fix loop. Each attempt stores what was tried and what the quality score was. The second attempt's prompt includes "Previous fix attempt failed with score X. Do NOT repeat the same approach."

**Implementation**: Modify the auto-fix loop in orchestrator.ts (lines 260-318) to pass previous attempt context.

**Risk**: Medium. The LLM could over-index on "don't repeat" and produce a worse fix. Mitigation: only include context if first attempt made zero improvement.

---

## WP4: Error Type Blindness → Exponential Backoff with Jitter

**Papers**:
- How to Handle Errors and Retries in Claude Agent SDK (ClaudeGuide, 2026)
- Retry Patterns for LLM API Errors (learnwithparam, 2026)

**Algorithm**: Replace linear retry with exponential backoff + jitter. Initial delay 1s, multiplier 2x, cap 30s, jitter ±2s. Classify errors: 4xx (except 429) = permanent, 5xx/429 = transient, timeout = transient.

**Implementation**: Modify retry logic in agentRuntime.ts lines 322-328.

**Risk**: Low. Well-understood pattern.

---

## WP5: Circuit Breaker → Production Resilience Pattern

**Papers**:
- Circuit breakers for agentic AI (2026)
- LM-Kit.NET Resilience Patterns — CircuitBreakerPolicy with OPEN/HALF_OPEN/CLOSED states

**Algorithm**: Implement a proper circuit breaker with three states: CLOSED (normal), OPEN (failing fast), HALF_OPEN (testing recovery). Track failures in a sliding window. Trip circuit after N consecutive failures. Half-open after M seconds.

**Implementation**: Create `CircuitBreaker` class and integrate it into agentRuntime.execute(). Check before each LLM call.

**Risk**: Low. Self-contained module.
