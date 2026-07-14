/**
 * Shared AgentRuntime singleton for API endpoints.
 *
 * Ensures pause/resume/execute endpoints all operate on the same runtime instance.
 */
import { AgentRuntime } from '@commander/core';

let runtime: AgentRuntime | null = null;

export function getSharedRuntime(): AgentRuntime {
  if (!runtime) {
    runtime = new AgentRuntime({ maxRetries: 1, timeoutMs: 30000 });
  }
  return runtime;
}
