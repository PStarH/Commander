import type { KernelRepository } from '@commander/kernel';
import type { ClaimedStep, KernelWorkerPort } from './types.js';

/** Narrow kernel repository claims to the worker-plane ClaimedStep contract. */
export function createKernelWorkerPort(repository: KernelRepository): KernelWorkerPort {
  return {
    claimNextStep: async (request) => {
      const step = await repository.claimNextStep(request);
      if (!step?.lease) return null;
      const claimed: ClaimedStep = {
        id: step.id,
        runId: step.runId,
        tenantId: step.tenantId,
        kind: step.kind,
        version: step.version,
        attempt: step.attempt,
        input: step.input,
        lease: step.lease,
      };
      return claimed;
    },
    heartbeatStep: (stepId, tenantId, lease, leaseTtlMs) =>
      repository.heartbeatStep(stepId, tenantId, lease, leaseTtlMs),
    completeStep: (request) => repository.completeStep(request),
    failStep: (request) => repository.failStep(request),
  };
}
