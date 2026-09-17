/**
 * Explicit unit fixture for AgentRuntime tool-loop tests (LM-03).
 *
 * Why this exists
 * ---------------
 * `tests/setup.ts` used to install an always-admit `SideEffectGate` into the
 * module singleton in a global `beforeEach`. That made "permissive admission"
 * the default security state of *every* test in `packages/core`, so no test
 * could observe a regression in the production fail-closed path: whatever
 * `ToolExecutionService` did, the injected stub returned `allow: true`.
 *
 * The stub is now opt-in. A test that genuinely needs a tool body to run
 * without a full ATR run handle must say so:
 *
 *     import { installAlwaysAdmitGate } from '../helpers/runtimeUnitFixture';
 *
 *     let restore: () => void;
 *     beforeEach(() => { restore = installAlwaysAdmitGate(); });
 *     afterEach(() => { restore(); });
 *
 * or, for a single test:
 *
 *     await withAlwaysAdmitGate(async () => { ... });
 *
 * This fixture is a **unit convenience, not an admission proof**. It must not
 * be imported by security-composition tests
 * (`tests/runtime/productionBoundaryComposition.test.ts`) — those assert the
 * real gate's behaviour and install it explicitly via
 * `resetSideEffectGate()`.
 *
 * The fixture never touches `src/`: it only calls the module's own public
 * `setSideEffectGate` / `resetSideEffectGate` seams.
 */

import {
  resetSideEffectGate,
  setSideEffectGate,
  type SideEffectAdmission,
  type SideEffectGate,
  type SideEffectRequest,
} from '../../src/runtime/sideEffectGate';

/**
 * Always-admit stub for unit/integration tests that exercise tool bodies
 * without a full ATR run handle.
 *
 * It answers every request with a synthetic `allow` admission, so a test using
 * it cannot make any claim about policy, approval or ATR admission. Individual
 * `SideEffectGate` unit tests construct real gates instead.
 */
export function createAlwaysAdmitGate(): SideEffectGate {
  return {
    admit: async (req: SideEffectRequest): Promise<SideEffectAdmission> => ({
      replayed: false,
      actionId: `test-admit:${req.stepId}`,
      decision: {
        decisionId: 'test_always_admit',
        allow: true,
        effect: 'allow',
      },
      decisionId: 'test_always_admit',
    }),
  } as unknown as SideEffectGate;
}

/**
 * Install the always-admit stub on the module singleton and return a restore
 * function. Always call the returned function from `afterEach`/`finally` so a
 * later test in the same file sees the real gate again.
 */
export function installAlwaysAdmitGate(): () => void {
  setSideEffectGate(createAlwaysAdmitGate());
  return () => {
    resetSideEffectGate();
  };
}

/**
 * Run `fn` with the always-admit stub installed, restoring the real gate
 * afterwards even when `fn` throws.
 */
export async function withAlwaysAdmitGate<T>(fn: () => Promise<T> | T): Promise<T> {
  const restore = installAlwaysAdmitGate();
  try {
    return await fn();
  } finally {
    restore();
  }
}
