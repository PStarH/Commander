import type { TerminalEvidenceRecord } from '@commander/effect-broker';
import type { KernelEffect } from './types.js';

export interface EvidenceLookup {
  tenantId: string;
  runId: string;
  effectId: string;
  actionDigest: string;
}

export interface EvidenceRepository {
  appendEvidence(record: TerminalEvidenceRecord): Promise<{ inserted: boolean }>;
  getEvidence(binding: EvidenceLookup): Promise<TerminalEvidenceRecord | null>;
}

export function assertEvidenceRecordBinding(record: TerminalEvidenceRecord): void {
  const { receipt } = record;
  if (
    record.bundleId !== `evidence_${record.effectId}` ||
    receipt.bundleId !== record.bundleId ||
    receipt.scope.tenantId !== record.tenantId ||
    receipt.scope.runId !== record.runId ||
    receipt.scope.effectId !== record.effectId ||
    receipt.actionDigest !== record.actionDigest ||
    !receipt.signature ||
    !record.anchoredAt
  ) {
    throw new Error('EVIDENCE_RECORD_BINDING_INVALID');
  }
}

export function assertEvidenceRecordBoundToEffect(
  record: TerminalEvidenceRecord,
  effect: Pick<KernelEffect, 'id' | 'tenantId' | 'runId' | 'actionDigest' | 'state'>,
): void {
  assertEvidenceRecordBinding(record);
  const expectedDisposition =
    effect.state === 'COMPLETED'
      ? 'SUCCEEDED'
      : effect.state === 'FAILED'
        ? 'FAILED'
        : effect.state === 'COMPLETION_UNKNOWN'
          ? 'ESCALATED'
          : null;
  const receiptEffect = record.receipt.effects.find(
    (candidate) => candidate.effectId === effect.id,
  );
  if (
    record.effectId !== effect.id ||
    record.tenantId !== effect.tenantId ||
    record.runId !== effect.runId ||
    record.actionDigest !== effect.actionDigest ||
    expectedDisposition === null ||
    record.receipt.terminalDisposition !== expectedDisposition ||
    receiptEffect?.state !== effect.state
  ) {
    throw new Error('EVIDENCE_RECORD_BINDING_INVALID');
  }
}
