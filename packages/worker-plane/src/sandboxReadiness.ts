import type { WorkerSandboxReadiness } from './types.js';

export function createProductionWorkerSandboxReadiness(
  env: NodeJS.ProcessEnv = process.env,
): WorkerSandboxReadiness {
  if (env.NODE_ENV !== 'production') {
    return { assertReady: async () => undefined };
  }

  return {
    async assertReady(): Promise<void> {
      // Import via the single sanctioned worker-plane→core bridge
      // (workerRuntimeAdapter), keeping the arch-guard constitution intact.
      const { SandboxManager } = await import('./workerRuntimeAdapter.js');
      const manager = new SandboxManager({ environment: env });
      await manager.verifyReady();
    },
  };
}
