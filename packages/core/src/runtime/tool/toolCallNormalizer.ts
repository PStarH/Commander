/**
 * Tool-call normalizer — extracted from `AgentRuntime.normalizeToolCall()`.
 *
 * Converts tool-call payloads from either the internal flat format or the
 * OpenAI-style `{ function: { name, arguments } }` format into the flat
 * `{ id, name, arguments }` shape the rest of the runtime expects.
 */
import type { ToolCall } from '../types';

export function normalizeToolCall(
  tc: ToolCall & { function?: { name?: string; arguments?: string } },
): ToolCall {
  if (tc.name && tc.arguments !== undefined) {
    return tc;
  }
  const fn = tc.function;
  let args: Record<string, unknown> = {};
  if (fn?.arguments) {
    try {
      args = JSON.parse(fn.arguments);
    } catch {
      args = { raw: fn.arguments };
    }
  }
  return {
    id: tc.id ?? `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: fn?.name ?? tc.name ?? '',
    arguments: args,
  };
}
