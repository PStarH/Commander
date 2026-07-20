/**
 * L3-07 — step-scoped short-lived workload identity.
 *
 * Tenant/run/step for capability mint and EffectBroker admission come from
 * kernel-claimed step context + ControlPlane-issued identity, never ambient env.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { getControlPlane, type WorkloadIdentity } from './workerRuntimeAdapter.js';
import {
  canonicalRequestHash,
  type CapabilityTokenIssuer,
  type WorkloadBinding,
} from '@commander/effect-broker';
import type { ClaimedStep } from './types.js';

export interface StepWorkloadBinding extends WorkloadBinding {
  workloadId: string;
  /** From run/step input — must match EffectBroker policy decision snapshot. */
  policySnapshotId?: string;
}

export interface StepWorkloadContext {
  identity: WorkloadIdentity;
  binding: StepWorkloadBinding;
}

const stepWorkloadStorage = new AsyncLocalStorage<StepWorkloadContext>();

function isProductionProfile(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.COMMANDER_PROFILE === 'enterprise' ||
    process.env.COMMANDER_REQUIRE_WORKLOAD_BINDING === '1'
  );
}

export function runWithStepWorkloadIdentity<T>(step: ClaimedStep, fn: () => T): T {
  const identity = getControlPlane().issueStepIdentity({
    tenantId: step.tenantId,
    runId: step.runId,
    stepId: step.id,
  });
  const policySnapshotId =
    typeof step.input.policySnapshotId === 'string' && step.input.policySnapshotId.length > 0
      ? step.input.policySnapshotId
      : undefined;
  const binding: StepWorkloadBinding = {
    tenantId: identity.tenantId,
    runId: step.runId,
    stepId: step.id,
    workloadId: identity.workloadId,
    ...(policySnapshotId ? { policySnapshotId } : {}),
  };
  return stepWorkloadStorage.run({ identity, binding }, fn);
}

export function getStepWorkloadContext(): StepWorkloadContext | undefined {
  return stepWorkloadStorage.getStore();
}

export function getStepWorkloadBinding(): StepWorkloadBinding | undefined {
  return stepWorkloadStorage.getStore()?.binding;
}

/** Fail-closed when production profile requires step identity but ALS is empty. */
export function requireStepWorkloadBinding(): StepWorkloadBinding {
  const ctx = stepWorkloadStorage.getStore();
  if (!ctx) {
    if (isProductionProfile()) {
      throw new Error(
        'WORKLOAD_IDENTITY_REQUIRED: step-scoped identity missing for effect admission',
      );
    }
    throw new Error('WORKLOAD_IDENTITY_REQUIRED: step-scoped identity missing');
  }
  if (Date.parse(ctx.identity.expiresAt) <= Date.now()) {
    throw new Error('WORKLOAD_IDENTITY_EXPIRED: step-scoped identity expired');
  }
  const verified = getControlPlane().verifyIdentityByToken(ctx.identity.token);
  if (!verified) {
    throw new Error('WORKLOAD_IDENTITY_INVALID: step-scoped identity revoked or expired');
  }
  return ctx.binding;
}

/** Mint a capability grant bound to the active step identity (tenant from identity only). */
export function mintStepCapabilityToken(input: {
  issuer: CapabilityTokenIssuer;
  effectType: string;
  request: Record<string, unknown>;
  ttlMs?: number;
  policySnapshotId?: string;
}): string {
  const binding = requireStepWorkloadBinding();
  const ttlMs = input.ttlMs ?? 5 * 60_000;
  const policySnapshotId =
    input.policySnapshotId ?? binding.policySnapshotId ?? 'policy';
  return input.issuer.issue({
    jti: randomUUID(),
    tenantId: binding.tenantId,
    runId: binding.runId,
    stepId: binding.stepId,
    workloadId: binding.workloadId,
    effectTypes: [input.effectType],
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    requestHash: canonicalRequestHash(input.request),
    policySnapshotId,
    nonce: randomUUID(),
  });
}
