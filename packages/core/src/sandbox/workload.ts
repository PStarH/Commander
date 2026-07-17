import { createHash, randomUUID } from 'node:crypto';
import { SandboxPolicyError } from './productionPolicy';
import type { SandboxWorkloadContext } from './types';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function validateSandboxWorkloadContext(context: SandboxWorkloadContext): void {
  for (const [field, value] of Object.entries(context)) {
    if (!value || !SAFE_ID.test(value)) {
      throw new SandboxPolicyError(`Invalid sandbox workload context ${field}.`);
    }
  }
}

export function createSandboxWorkloadContext(input: {
  tenantId: string;
  runId: string;
  stepId: string;
  workloadId?: string;
}): SandboxWorkloadContext {
  const context: SandboxWorkloadContext = {
    tenantId: input.tenantId,
    runId: input.runId,
    stepId: input.stepId,
    workloadId: input.workloadId ?? `${input.runId}-${input.stepId}-${randomUUID().slice(0, 12)}`,
  };
  validateSandboxWorkloadContext(context);
  return context;
}

/** Map context object fields to runtime-metadata args keys (_tenantId, …). */
export function toRuntimeWorkloadMetadata(context: SandboxWorkloadContext): {
  _tenantId: string;
  _runId: string;
  _stepId: string;
  _workloadId: string;
} {
  return {
    _tenantId: context.tenantId,
    _runId: context.runId,
    _stepId: context.stepId,
    _workloadId: context.workloadId,
  };
}

export function workloadContainerName(context: SandboxWorkloadContext): string {
  validateSandboxWorkloadContext(context);
  const digest = createHash('sha256')
    .update(`${context.tenantId}\0${context.runId}\0${context.stepId}\0${context.workloadId}`)
    .digest('hex')
    .slice(0, 24);
  return `commander-sbx-${digest}`;
}

export function buildWorkloadDockerOptions(context: SandboxWorkloadContext): string[] {
  validateSandboxWorkloadContext(context);
  return [
    '--name',
    workloadContainerName(context),
    '--label',
    `commander.tenant_id=${context.tenantId}`,
    '--label',
    `commander.run_id=${context.runId}`,
    '--label',
    `commander.step_id=${context.stepId}`,
    '--label',
    `commander.workload_id=${context.workloadId}`,
  ];
}
