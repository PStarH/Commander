import type { WorkerSandboxReadiness } from './types.js';

export function createProductionWorkerSandboxReadiness(
  env: NodeJS.ProcessEnv = process.env,
): WorkerSandboxReadiness {
  if (env.NODE_ENV !== 'production') {
    return { assertReady: async () => undefined };
  }

  return {
    async assertReady(): Promise<void> {
      const { SandboxManager } = await import('@commander/core');
      const manager = new SandboxManager({ environment: env });
      await manager.verifyReady();
    },
  };
}
