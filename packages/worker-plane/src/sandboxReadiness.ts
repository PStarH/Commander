import type { WorkerSandboxReadiness } from './types.js';
import { isProductionEffectGate } from './effectGate.js';

export function createProductionWorkerSandboxReadiness(
  env: NodeJS.ProcessEnv = process.env,
): WorkerSandboxReadiness {
  // WP-08: a `NODE_ENV`-only check made this guard a silent no-op under
  // COMMANDER_PROFILE=enterprise (and the other production profiles), so the
  // sandbox was never verified even though every other gate treated the
  // deployment as production. Reuse the one shared production predicate.
  if (!isProductionEffectGate(env)) {
    return { assertReady: async () => undefined };
  }

  return {
    async assertReady(): Promise<void> {
      // Import via the single sanctioned worker-plane→core bridge
      // (workerRuntimeAdapter), keeping the arch-guard constitution intact.
      const { SandboxManager } = await import('./workerRuntimeAdapter.js');
      // packages/core derives its sandbox fail-closed policy from NODE_ENV alone
      // (sandbox/productionPolicy.ts resolveSandboxPolicy → assertProductionSandboxPolicy),
      // so a deployment that is production by COMMANDER_PROFILE/COMMANDER_REQUIRE_* would
      // otherwise reach verifyReady() only for it to return at `!policy.failClosed`.
      // Present the signal the sandbox layer reads; the rest of the operator env is kept.
      const sandboxEnv: NodeJS.ProcessEnv = { ...env, NODE_ENV: 'production' };
      const manager = new SandboxManager({ environment: sandboxEnv });
      await manager.verifyReady();
    },
  };
}
