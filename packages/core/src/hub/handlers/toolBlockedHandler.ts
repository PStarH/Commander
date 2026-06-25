/**
 * toolBlockedHandler — Phase 2 / Hub Glue handler for `tool.blocked`.
 *
 * Switches on `payload.reason` with a `never`-guard at the bottom that
 * enforces compile-time exhaustiveness — adding a new `ToolBlockedXxx`
 * variant will fail compile here until routed.
 *
 * Routing:
 *
 *   `cycle_detected` → fold into {@link CycleCorrelator.observeToolBlocked}.
 *     The correlator matches with the leading `system.alert` cycle_detected
 *     (also subscribed) and emits `runtime.cycle_correlated` once both
 *     sides have been observed.
 *
 *   `security_orchestrator_denied` → emit `security.policy_denied` so the
 *     security arc can distinguish AdaptiveHITL policy denials from hook-
 *     plugin denials downstream.
 *
 *   The other 7 atomic denials (`orchestrator_skipped`, `circuit_broken`,
 *   `hook_denied`, `not_allowed`, `hook_blocked`, `exec_policy_forbidden`,
 *   `guardian_blocked`) are routed to a metric counter (`tool_blocked_total`)
 *   with a `reason` tag and a debug log. No event emit — consumers that
 *     need atomic denial events can subscribe to `tool.blocked` directly.
 */

import { getMessageBus } from '../../runtime/messageBus';
import type { MessageBus } from '../../runtime/messageBus';
import { getMetricsCollector } from '../../runtime/metricsCollector';
import { getGlobalLogger } from '../../logging';
import type { BusMessage } from '../../runtime/types';
import type { ToolBlockedVariant } from '../../runtime/types/messageBus';
import { getCycleCorrelator } from './cycleCorrelator';

const HUB_GLUE_SOURCE = 'hub-glue';

function routeByReason(payload: ToolBlockedVariant, sourceAgentId: string): void {
  switch (payload.reason) {
    case 'cycle_detected': {
      // The matching `system.alert cycle_detected` is also subscribed (via
      // CycleCorrelator) and arrives first in dispatch order. Folding here
      // either completes the dedupe or registers the trailing edge if the
      // order was reversed in some future publisher.
      getCycleCorrelator().observeToolBlocked(
        payload.runId,
        payload.toolName,
        payload.detail ?? '',
      );
      return;
    }
    case 'security_orchestrator_denied': {
      // Forward to the security arc with the bus source as agentId (the
      // defensive publish site at agentRuntime.ts:2339 uses
      // `getMessageBus().publish('tool.blocked', agentId, ...)` so the
      // source == agentId of the agent execute() that was denied).
      getMessageBus().publish('security.policy_denied' as never, HUB_GLUE_SOURCE, {
        runId: payload.runId,
        toolName: payload.toolName,
        reason: payload.detail ?? 'AdaptiveHITL blocked',
        agentId: sourceAgentId,
      });
      return;
    }
    case 'orchestrator_skipped':
    case 'circuit_broken':
    case 'hook_denied':
    case 'not_allowed':
    case 'hook_blocked':
    case 'exec_policy_forbidden':
    case 'guardian_blocked': {
      // Atomic denial — record metric + log, no event emit.
      try {
        getMetricsCollector().incrementCounter(
          'tool_blocked_total',
          'Total tool.blocked denials',
          1,
          [{ name: 'reason', value: payload.reason }],
        );
      } catch {
        // best-effort metrics — never throw from a bus subscriber
      }
      getGlobalLogger().debug('hub.toolBlocked', `tool.blocked ${payload.reason}`, {
        runId: payload.runId,
        toolName: payload.toolName,
      });
      return;
    }
    default: {
      // never-guard: compile-time check that every ToolBlockedVariant
      // reason is handled. If a new variant is added to the union without
      // a case above, TS infers `payload` as the new variant here and the
      // assignment below fails to typecheck.
      const _exhaustive: never = payload;
      void _exhaustive;
      throw new Error(
        `hub.toolBlocked.router: unhandled tool.blocked reason: ${(payload as ToolBlockedVariant).reason}`,
      );
    }
  }
}

let unsubscribe: () => void = () => {};
let installed = false;

/**
 * Subscribe the Hub Glue handler for `tool.blocked`. Also installs the
 * `system.alert` cycle-dedupe side via {@link CycleCorrelator.install}.
 *
 * Idempotent across calls — second invocation is a no-op. Returns the
 * unsubscribe function (also exposed via {@link uninstallToolBlockedHandler}
 * for symmetry with tests / hot-reload).
 */
export function installToolBlockedHandler(bus?: MessageBus): () => void {
  if (installed) {
    return unsubscribe;
  }
  const useBus = bus ?? getMessageBus();

  // Install the cycle-dedupe side first (registers the leading-edge
  // system.alert subscriber). This must run before the tool.blocked
  // subscriber so dispatch order at runtime is system.alert → tool.blocked
  // within the same publish tick.
  getCycleCorrelator().install(useBus);

  // The bus dispatcher already wraps subscriber callbacks in try/catch,
  // so we don't re-wrap here — but we DO want to log router errors at
  // our own level (the bus logs at the dispatcher layer).
  const handler = (msg: BusMessage): void => {
    routeByReason(msg.payload as ToolBlockedVariant, msg.source);
  };
  const off = useBus.subscribe('tool.blocked' as never, handler);
  unsubscribe = () => off();
  installed = true;
  return unsubscribe;
}

/**
 * Unsubscribe — for tests and hot-reload. Safe to call when not installed.
 */
export function uninstallToolBlockedHandler(): void {
  if (!installed) return;
  unsubscribe();
  installed = false;
}

/**
 * Test-only: force-reset module-level state so install() can run again
 * with a freshly created bus (after `resetMessageBus()` in tests).
 */
export function _resetToolBlockedHandlerForTests(): void {
  uninstallToolBlockedHandler();
}
