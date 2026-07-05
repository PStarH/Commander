/**
 * Retry-loop detector — extracted from `AgentRuntime.checkRetryLoop()`.
 *
 * Checks if the same tool+args pattern appears ≥3 times in recent calls.
 * Uses stable (alphabetically-sorted) JSON.stringify for deterministic keys.
 * On detection, publishes system.alert, increments metrics, and writes intent log.
 * Returns { retryLoopDetected, count } — caller should break the execution loop.
 */
import {
  RETRY_LOOP_THRESHOLD,
  RETRY_LOOP_PATTERN_HISTORY,
  TOOL_PATTERN_MAX_CHARS,
} from '../runtimeConstants';
import { getMessageBus } from '../messageBus';
import { getMetricsCollector } from '../metricsCollector';
import { getIntentLog } from '../intentLog';
import { reportSilentFailure } from '../../silentFailureReporter';

/** Recursively sort object keys for stable JSON comparison of tool arguments. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

export class ToolCallRetryLoopDetector {
  /**
   * Check if the same tool+args pattern appears ≥3 times in recent calls.
   */
  checkRetryLoop(
    toolName: string,
    args: Record<string, unknown>,
    patterns: string[],
    runId: string,
    tenantId: string | undefined,
    toolLoopCount: number,
  ): { detected: boolean; count: number } {
    // Stable key ordering: recursively sort object keys so nested arguments
    // (e.g. payload.round) are included deterministically.
    const canonicalArgs = canonicalJson(args);
    const pattern = `${toolName}:${canonicalArgs}`;
    patterns.push(pattern);
    if (patterns.length > RETRY_LOOP_PATTERN_HISTORY) patterns.shift();
    const count = patterns.filter((p) => p === pattern).length;
    if (count >= RETRY_LOOP_THRESHOLD) {
      const bus = getMessageBus();
      bus.publish('system.alert', 'runtime', {
        type: 'retry_loop_detected',
        toolName,
        pattern: `${toolName}:${canonicalArgs.slice(0, TOOL_PATTERN_MAX_CHARS)}`,
        consecutiveCalls: count,
        toolLoopCount,
        // `runId` propagates so Phase 2 Hub Glue
        // RetryHookCorrelator can dedup by run
        // (key `${runId}:${toolName}:${pattern}`) instead of
        // collapsing concurrent runs that hit the same
        // tool/args within the 5s TTL window. `runId`
        // is the local param from `checkRetryLoop`'s
        // closure — same value as agentRuntime.execute()'s
        // top-level `const runId = generateId()`.
        runId,
      });
      try {
        getMetricsCollector().incrementCounter(
          'retry_loops_detected_total',
          'Retry loops detected',
          1,
          [{ name: 'tool', value: toolName }],
        );
      } catch (err) {
        reportSilentFailure(err, 'agentRuntime:798');
        /* best-effort */
      }
      try {
        getIntentLog(tenantId).write({
          schemaVersion: 1,
          runId,
          capturedAt: new Date().toISOString(),
          stage: 'agentRuntime.tool_loop',
          decision: 'retry_loop_detected',
          reason: `${toolName} called ${count} times with identical arguments`,
          payload: { toolName, calls: count, toolLoopCount },
        });
      } catch (err) {
        reportSilentFailure(err, 'agentRuntime:812');
        /* best-effort */
      }
      return { detected: true, count };
    }
    return { detected: false, count: 0 };
  }
}
