/**
 * ToolResultShape — Canonical shape shared across all tool-error row
 * construction sites in the runtime.
 *
 * The synthetic-error row shape was historically inlined in two distinct
 * subsystems: the pre-tool-call gate helper inside AgentRuntime
 * (`applyPreToolCallGates`) and the orchestrator's tool-execution path
 * (`ToolOrchestrator.executeSingleWithRetry` + post-execution result
 * formatting). Each subsystem hand-rolled its own `{ toolCallId, name,
 * output, error, durationMs }` literal — drifting whenever one site gained
 * a new field (e.g. `fromCache: true` on cached ToolResults, `attempt`
 * metadata on retry paths).
 *
 * Centralizing in this file lets:
 *   1. AgentRuntime gates and ToolOrchestrator boundary produce byte-identical
 *      rows when the underlying cause is structurally the same
 *      (cancellation, retry, hook denial, real execution failure).
 *   2. Consumers downstream (verification pipeline, observability exporters,
 *      trace rectangles) treat any `SyntheticErrorRow` uniformly.
 *   3. A discriminated-union `PreToolCallGateResult` be exported for callers
 *      who want to type their own gate-aware logic against the same shape.
 *
 * Module-scope (not class-scope) so TS 6.x's stricter class-body type-alias
 * hoisting (TS1068) does not reject the declarations.
 */
import type { ToolCall } from './types';

/**
 * Canonical shape for synthetic-error rows pushed into a parallel-results
 * array (concurrent execution), rawResults (serial execution), or returned
 * as a Promise.allSettled resolved value when a pre-tool-call gate or a
 * real execution boundary blocks a tool call.
 *
 * Field semantics:
 *   - `toolCallId`: the original tool call's stable id (kept for traceability
 *     back to the LLM's tool-call request).
 *   - `name`: the tool name (matches the registered Tool schema).
 *   - `output`: empty string because no real tool execution occurred.
 *   - `error`: human-/model-readable diagnostic, prefixed by an error class
 *     tag (e.g. `HOOK_BLOCKED:`, `RETRY_LOOP_DETECTED:`, `CYCLE_DETECTED:`,
 *     `CANCELLED:`, `TOOL_NOT_FOUND:`, `TOOL_TIMEOUT:`).
 *   - `durationMs`: zero because no execution happened. (Real-execution
 *     errors carry a real duration via the standard `ToolResult` path
 *     inside `executeSingleWithRetry`.)
 */
export type SyntheticErrorRow = {
  toolCallId: string;
  name: string;
  output: string;
  error: string;
  durationMs: number;
};

/**
 * Pure factory for the canonical SyntheticErrorRow shape.
 *
 * Powers:
 *   - AgentRuntime.applyPreToolCallGates — siblingAbort branch returns a
 *     pre-built row; every gate kind that produces a row uses this factory.
 *   - AgentRuntime.applyBeforeToolCallSecurity — security-orchestrator
 *     denies construct a row + a ToolResult twin via this factory.
 *   - ToolOrchestrator — turn timeout, approval skip, circuit-broken
 *     skip, tool-not-found, and executeSingleWithRetry's final-failure
 *     path all build rows through this factory.
 *
 * Centralization ensures that a schema change (e.g. adding
 * `circularBufferRef` or `securitySalt`) is one diff, not N duplicates.
 */
export function toolErrorRow(tc: ToolCall, errorMsg: string): SyntheticErrorRow {
  return {
    toolCallId: tc.id,
    name: tc.name,
    output: '',
    error: errorMsg,
    durationMs: 0,
  };
}

/**
 * Discriminated-union return type for `AgentRuntime.applyPreToolCallGates`.
 *
 * The helper is a pure decision function:
 *   - inspects the four pre-tool-call gates (hook, sibling-abort, retry,
 *     cycle) and returns ONE OF these tags plus minimal context.
 *   - NEVER calls `getMessageBus().publish(...)` itself — all side
 *     effects (bus publishes, metrics, intent logs) live at the call site
 *     so a spy on the bus can prove there is no double-fire path.
 *
 * This shape is exhaustive: each `kind` carries the minimum context the
 * caller needs; TypeScript exhaustiveness checks surface any missed case
 * at compile time.
 *
 * `'allowed'` is the only `kind` indicating the gate pipeline fully cleared;
 *   - `'hooked'`: a plugin denied via HookManager.fireBeforeToolCall.
 *   - `'siblingAbort'`: an earlier concurrent tool error fired the sibling
 *     AbortSignal; row is pre-synthesized so caller can return/continue
 *     identically.
 *   - `'retry'`: retry-loop detector found ≥3 identical calls in window;
 *     caller sets retryLoopDetected=true and breaks the outer tool loop.
 *   - `'cycle'`: CycleDetector found a cycle; caller publishes both
 *     system.alert + tool.blocked then breaks the outer tool loop.
 */
export type PreToolCallGateResult =
  | { kind: 'allowed' }
  | { kind: 'hooked'; errorMsg: string }
  | { kind: 'siblingAbort'; row: SyntheticErrorRow }
  | { kind: 'retry'; count: number }
  | { kind: 'cycle'; description: string };
