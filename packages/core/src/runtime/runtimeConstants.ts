/**
 * Constants for AgentRuntime — extracted from magic numbers.
 *
 * These defaults govern token budgets, verification thresholds, and truncation
 * limits used throughout the runtime. Centralising them here makes tuning
 * explicit and keeps agentRuntime.ts focused on logic.
 */

// ── Token budgets ─────────────────────────────────────────────────────────────

/** Default maximum context window size (tokens) when not overridden by config. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/** Hard-cap fallback for token governor when config.budgetHardCapTokens is unset. */
export const DEFAULT_TOKEN_GOVERNOR_BUDGET = 200_000;

/** Maximum tokens allocated to tool output per turn. */
export const TOOL_OUTPUT_TURN_BUDGET = 32_000;

/** Safety margin added to estimated input tokens. */
export const INPUT_TOKEN_SAFETY_MARGIN = 2_048;

/** Maximum tokens for a single verification LLM call. */
export const VERIFICATION_BUDGET_TOKENS = 300;

/** Minimum token budget below which verification is skipped. */
export const VERIFICATION_FLOOR_TOKENS = 1_500;

// ── Truncation / display limits ───────────────────────────────────────────────

/** Max characters for goal strings in telemetry / intent-log payloads. */
export const GOAL_TELEMETRY_MAX_CHARS = 200;

/** Max characters for goal strings in result payloads. */
export const GOAL_RESULT_MAX_CHARS = 500;

/** Max characters for goal strings in full context. */
export const GOAL_FULL_MAX_CHARS = 1_000;

/** Max characters for LLM output prefix in tracing. */
export const OUTPUT_PREFIX_MAX_CHARS = 5_000;

/** Max characters for summary content in bus events. */
export const SUMMARY_MAX_CHARS = 5_000;

/** Max characters for error content in bus events. */
export const ERROR_MAX_CHARS = 2_000;

/** Max characters for memory recall snippets. */
export const MEMORY_SNIPPET_MAX_CHARS = 300;

/** Max characters for tool pattern labels. */
export const TOOL_PATTERN_MAX_CHARS = 200;

/** Max characters for verification feedback snippets. */
export const VERIFICATION_FEEDBACK_MAX_CHARS = 100;

/** Max characters for final result content. */
export const RESULT_CONTENT_MAX_CHARS = 200;

/** Max characters for concise output mode threshold. */
export const CONCISE_OUTPUT_THRESHOLD = 500;

// ── Reflexion / verification ──────────────────────────────────────────────────

/** Maximum number of reflexion injectable memories. */
export const MAX_REFLEXION_MEMORIES = 3;

/** Maximum tokens per reflexion memory entry. */
export const MAX_TOKENS_PER_REFLEXION = 50;

// ── Retry / loop detection ────────────────────────────────────────────────────

/** Number of identical tool calls before declaring a retry loop. */
export const RETRY_LOOP_THRESHOLD = 3;

/** Maximum pattern history retained for loop detection. */
export const RETRY_LOOP_PATTERN_HISTORY = 20;

// ── Context token allocation ──────────────────────────────────────────────────

/** Fraction of token budget allocated to context window messages. */
export const CONTEXT_TOKEN_FRACTION = 0.2;

/** Minimum context token allocation regardless of budget. */
export const MIN_CONTEXT_TOKENS = 2_000;

// ── Cost estimation ───────────────────────────────────────────────────────────

/** Estimated cost per 1K input tokens for fallback cost model. */
export const FALLBACK_COST_PER_1K_INPUT = 0.003;

/** Maximum output tokens for batch estimation. */
export const MAX_OUTPUT_TOKENS_ESTIMATE = 200_000;

// ── Timeout ───────────────────────────────────────────────────────────────────

/** Default LLM call timeout in milliseconds. */
export const DEFAULT_LLM_TIMEOUT_MS = 120_000;

// ── Circuit breaker ───────────────────────────────────────────────────────────

/** Number of consecutive failures before circuit opens. */
export const CIRCUIT_BREAKER_THRESHOLD = 5;

/** Time in ms before circuit transitions to half-open. */
export const CIRCUIT_BREAKER_RECOVERY_MS = 30_000;

// ── Tool orchestrator ─────────────────────────────────────────────────────────

/** Maximum retries for tool orchestrator. */
export const TOOL_ORCHESTRATOR_MAX_RETRIES = 1;

/** Failure threshold before tool circuit opens. */
export const TOOL_ORCHESTRATOR_CIRCUIT_THRESHOLD = 3;

// ── Content scanner ───────────────────────────────────────────────────────────

/** Minimum truncation intensity threshold. */
export const MIN_TRUNCATION_THRESHOLD = 200;
