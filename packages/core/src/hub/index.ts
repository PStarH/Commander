/**
 * Hub Glue — Phase 2 closed-loop event handler installation.
 *
 * Central install function for all Hub Glue handlers. Call once at
 * application startup (serviceInitializer wires this near the bus
 * singleton acquisition). Idempotent — multiple calls are no-ops.
 *
 * Handlers that fan in here:
 *   - toolBlockedHandler: routes 9 `tool.blocked` variants. cycle_detected
 *     and security_orchestrator_denied fold into fresh events; the other 7
 *     atomic denials feed `tool_blocked_total` metric + debug log.
 *   - CycleCorrelator: subscribed to `system.alert` (`cycle_detected`
 *     subtype only). Folds the leading edge of an agentRuntime cycle into
 *     the same `runtime.cycle_correlated` emit as the trailing tool.blocked.
 */

export {
  installToolBlockedHandler,
  uninstallToolBlockedHandler,
  _resetToolBlockedHandlerForTests,
} from './handlers/toolBlockedHandler';

export {
  CycleCorrelator,
  getCycleCorrelator,
  _resetCycleCorrelatorForTests,
} from './handlers/cycleCorrelator';

export {
  RetryHookCorrelator,
  getRetryHookCorrelator,
  _resetRetryHookCorrelatorForTests,
} from './handlers/retryHookCorrelator';

export {
  SemanticCircuitCorrelator,
  getSemanticCircuitCorrelator,
  _resetSemanticCircuitCorrelatorForTests,
} from './handlers/semanticCircuitCorrelator';

import { installToolBlockedHandler } from './handlers/toolBlockedHandler';

let hubInstalled = false;

/**
 * Install every Hub Glue handler. Idempotent.
 *
 * Returns an uninstall function that detaches the tool.blocked subscriber
 * and disposes the cycle correlator. Tests use the per-handler uninstall
 * functions for fine-grained cleanup; production usually calls
 * installHubGlue() exactly once at boot.
 */
export function installHubGlue(): () => void {
  if (hubInstalled) {
    return () => {
      // already installed — no-op uninstall
    };
  }
  hubInstalled = true;
  return installToolBlockedHandler();
}

/** Test-only: clear module-level installed flag without tearing down subs. */
export function _resetHubGlueForTests(): void {
  hubInstalled = false;
}
