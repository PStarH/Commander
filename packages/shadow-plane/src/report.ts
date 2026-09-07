import { sign, type KeyObject } from 'node:crypto';
import { actionGatewayPolicySnapshot } from '@commander/contracts';
import { canonicalBytes, sha256Hex, verifyEd25519 } from './canonical.js';
import {
  parseShadowManifest,
  parseShadowObservation,
  type ShadowManifestV1,
  type ShadowObservationV1,
  type ShadowProductionDecision,
} from './contracts.js';
import { compareShadowDecision, type ShadowComparison } from './comparison.js';
import {
  evaluateShadowObservation,
  observationDigest,
  type ShadowHypotheticalDecision,
} from './evaluator.js';
import type { ShadowCampaignReportData } from './repository.js';

export const SHADOW_REPORT_SCHEMA = 'commander.shadow-report/v1' as const;

export type ShadowTerminalStatus = 'missing' | 'rejected' | 'failed' | 'uncomparable' | 'compared';

export interface ShadowReportRecord {
  batchId: string;
  index: number;
  observationId: string;
  digest: string;
  status: ShadowTerminalStatus;
  attempt?: { digest: string; code: string; attemptedAt: string };
  facts?: ShadowObservationV1;
  hypotheticalDecision?: ShadowHypotheticalDecision;
  hypotheticalDecisionId?: string;
  hypotheticalReasonCode?: string;
  productionDecision?: ShadowProductionDecision;
  productionReasonCode?: string;
  comparison?: ShadowComparison;
}

export interface ShadowReportCounts {
  expected: number;
  missing: number;
  rejected: number;
  failed: number;
  uncomparable: number;
  compared: number;
  matches: number;
  mismatches: number;
}

type MatrixRow = Record<'allow' | 'deny' | 'require_approval', number>;
export type ShadowDecisionMatrix = Record<'allow' | 'deny' | 'require_approval', MatrixRow>;

export interface ShadowReportBundle {
  schema: typeof SHADOW_REPORT_SCHEMA;
  generatedAt: string;
  sourceRevision: string;
  evaluatorVersion: 'shadow-evaluator-v1';
  campaignId: string;
  policySnapshot: ReturnType<typeof actionGatewayPolicySnapshot>;
  manifests: ShadowManifestV1[];
  records: ShadowReportRecord[];
  counts: ShadowReportCounts;
  decisionMatrix: ShadowDecisionMatrix;
  differences: Array<{
    observationId: string;
    productionDecision: ShadowProductionDecision;
    hypotheticalDecision: ShadowHypotheticalDecision;
    productionReasonCode?: string;
    hypotheticalReasonCode: string;
    policyDigest: string;
  }>;
  hashes: { manifestsSha256: string; recordsSha256: string; policySha256: string };
  keyId: string;
  signature: string;
}

export interface ShadowReportSigningOptions {
  keyId: string;
  privateKey: KeyObject;
  generatedAt: string;
  sourceRevision: string;
}

const TERMINAL = new Set<ShadowTerminalStatus>([
  'missing',
  'rejected',
  'failed',
  'uncomparable',
  'compared',
]);
const COMPARABLE = ['allow', 'deny', 'require_approval'] as const;

function stringField(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') throw new Error('SHADOW_REPORT_DATA_INVALID');
  return value;
}

function integerField(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error('SHADOW_REPORT_DATA_INVALID');
  return value as number;
}

function digestField(row: Record<string, unknown>, name: string): string {
  const value = stringField(row, name);
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('SHADOW_REPORT_DATA_INVALID');
  return value;
}

function timestampField(row: Record<string, unknown>, name: string): string {
  const value = stringField(row, name);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
    throw new Error('SHADOW_REPORT_DATA_INVALID');
  return value;
}

function emptyMatrix(): ShadowDecisionMatrix {
  return {
    allow: { allow: 0, deny: 0, require_approval: 0 },
    deny: { allow: 0, deny: 0, require_approval: 0 },
    require_approval: { allow: 0, deny: 0, require_approval: 0 },
  };
}

function reportRecords(rows: Record<string, unknown>[]): ShadowReportRecord[] {
  return rows.map((row) => {
    const status = stringField(row, 'status') as ShadowTerminalStatus;
    if (!TERMINAL.has(status)) throw new Error('SHADOW_REPORT_NOT_TERMINAL');
    const base: ShadowReportRecord = {
      batchId: stringField(row, 'batch_id'),
      index: integerField(row, 'record_index'),
      observationId: stringField(row, 'observation_id'),
      digest: digestField(row, 'digest'),
      status,
    };
    if (status === 'missing') return base;
    if (status === 'rejected' || status === 'failed') {
      return {
        ...base,
        attempt: {
          digest: digestField(row, 'attempt_digest'),
          code: stringField(row, 'attempt_code'),
          attemptedAt: timestampField(row, 'attempted_at'),
        },
      };
    }
    const facts = parseShadowObservation(row.canonical_observation);
    return {
      ...base,
      facts,
      hypotheticalDecision: stringField(row, 'hypothetical_decision') as ShadowHypotheticalDecision,
      hypotheticalDecisionId: stringField(row, 'hypothetical_decision_id'),
      hypotheticalReasonCode: stringField(row, 'hypothetical_reason_code'),
      productionDecision: stringField(row, 'production_decision') as ShadowProductionDecision,
      ...(typeof row.production_reason_code === 'string'
        ? { productionReasonCode: row.production_reason_code }
        : {}),
      comparison: stringField(row, 'comparison') as ShadowComparison,
    };
  });
}

function aggregate(records: ShadowReportRecord[], policyDigest: string) {
  const counts: ShadowReportCounts = {
    expected: records.length,
    missing: 0,
    rejected: 0,
    failed: 0,
    uncomparable: 0,
    compared: 0,
    matches: 0,
    mismatches: 0,
  };
  const matrix = emptyMatrix();
  const differences: ShadowReportBundle['differences'] = [];
  for (const record of records) {
    counts[record.status] += 1;
    if (record.status === 'compared') {
      if (record.comparison === 'match') counts.matches += 1;
      else if (record.comparison === 'mismatch') counts.mismatches += 1;
      else throw new Error('SHADOW_REPORT_COMPARISON_INVALID');
      if (
        record.productionDecision &&
        record.productionDecision !== 'unknown' &&
        record.hypotheticalDecision &&
        record.hypotheticalDecision !== 'insufficient_evidence'
      )
        matrix[record.productionDecision][record.hypotheticalDecision] += 1;
      if (record.comparison === 'mismatch') {
        differences.push({
          observationId: record.observationId,
          productionDecision: record.productionDecision!,
          hypotheticalDecision: record.hypotheticalDecision!,
          ...(record.productionReasonCode
            ? { productionReasonCode: record.productionReasonCode }
            : {}),
          hypotheticalReasonCode: record.hypotheticalReasonCode!,
          policyDigest,
        });
      }
    }
  }
  return { counts, matrix, differences };
}

function validateManifestRecordBinding(report: ShadowReportBundle): boolean {
  const expected = new Map<string, { observationId: string; digest: string }>();
  for (const rawManifest of report.manifests) {
    const manifest = parseShadowManifest(rawManifest);
    if (
      manifest.campaignId !== report.campaignId ||
      manifest.policyId !== report.policySnapshot.policyId ||
      manifest.policyDigest !== report.policySnapshot.descriptorDigest
    )
      return false;
    for (const record of manifest.records) {
      const key = `${manifest.batchId}\u0000${record.index}`;
      if (expected.has(key)) return false;
      expected.set(key, { observationId: record.observationId, digest: record.digest });
    }
  }
  if (expected.size !== report.records.length) return false;
  const seen = new Set<string>();
  for (const record of report.records) {
    const key = `${record.batchId}\u0000${record.index}`;
    const declared = expected.get(key);
    if (
      !declared ||
      seen.has(key) ||
      declared.observationId !== record.observationId ||
      declared.digest !== record.digest
    )
      return false;
    seen.add(key);
    if (
      record.facts &&
      (record.facts.campaignId !== report.campaignId ||
        record.facts.batchId !== record.batchId ||
        record.facts.index !== record.index ||
        record.facts.observationId !== record.observationId)
    )
      return false;
  }
  return true;
}

export function buildSignedShadowReport(
  data: ShadowCampaignReportData,
  options: ShadowReportSigningOptions,
): ShadowReportBundle {
  if (!data.campaign) throw new Error('SHADOW_REPORT_CAMPAIGN_NOT_FOUND');
  if (data.batches.some((batch) => batch.state !== 'closed'))
    throw new Error('SHADOW_REPORT_BATCH_OPEN');
  const campaignId = stringField(data.campaign, 'campaign_id');
  const policyDigest = stringField(data.campaign, 'policy_digest');
  const snapshot = actionGatewayPolicySnapshot();
  if (data.campaign.policy_id !== snapshot.policyId || policyDigest !== snapshot.descriptorDigest) {
    throw new Error('SHADOW_POLICY_MISMATCH');
  }
  const manifests = data.batches.map((batch) => {
    const manifest = parseShadowManifest(batch.manifest);
    if (digestField(batch, 'manifest_digest') !== sha256Hex(canonicalBytes(manifest))) {
      throw new Error('SHADOW_MANIFEST_DIGEST_MISMATCH');
    }
    return manifest;
  });
  const records = reportRecords(data.records);
  const { counts, matrix, differences } = aggregate(records, policyDigest);
  const hashes = {
    manifestsSha256: sha256Hex(canonicalBytes(manifests)),
    recordsSha256: sha256Hex(canonicalBytes(records)),
    policySha256: sha256Hex(canonicalBytes(snapshot)),
  };
  const unsigned = {
    schema: SHADOW_REPORT_SCHEMA,
    generatedAt: options.generatedAt,
    sourceRevision: options.sourceRevision,
    evaluatorVersion: 'shadow-evaluator-v1' as const,
    campaignId,
    policySnapshot: snapshot,
    manifests,
    records,
    counts,
    decisionMatrix: matrix,
    differences,
    hashes,
    keyId: options.keyId,
  };
  return {
    ...unsigned,
    signature: sign(null, canonicalBytes(unsigned), options.privateKey).toString('base64url'),
  };
}

export function verifyShadowReport(
  value: unknown,
  trust: { publicKey: KeyObject; revokedKeyIds?: ReadonlySet<string> },
): { valid: boolean; code: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { valid: false, code: 'SHADOW_REPORT_INVALID' };
  const report = value as ShadowReportBundle;
  if (
    report.schema !== SHADOW_REPORT_SCHEMA ||
    typeof report.keyId !== 'string' ||
    typeof report.signature !== 'string'
  ) {
    return { valid: false, code: 'SHADOW_REPORT_INVALID' };
  }
  if (trust.revokedKeyIds?.has(report.keyId))
    return { valid: false, code: 'SHADOW_REPORT_KEY_REVOKED' };
  const { signature, ...signedBody } = report;
  if (!verifyEd25519(signedBody, signature, trust.publicKey))
    return { valid: false, code: 'SHADOW_REPORT_SIGNATURE_INVALID' };
  try {
    if (
      report.hashes.manifestsSha256 !== sha256Hex(canonicalBytes(report.manifests)) ||
      report.hashes.recordsSha256 !== sha256Hex(canonicalBytes(report.records)) ||
      report.hashes.policySha256 !== sha256Hex(canonicalBytes(report.policySnapshot))
    )
      return { valid: false, code: 'SHADOW_REPORT_HASH_INVALID' };
    const snapshot = actionGatewayPolicySnapshot();
    if (canonicalBytes(report.policySnapshot).compare(canonicalBytes(snapshot)) !== 0) {
      return { valid: false, code: 'SHADOW_REPORT_POLICY_INVALID' };
    }
    const recomputed = aggregate(report.records, snapshot.descriptorDigest);
    if (canonicalBytes(recomputed.counts).compare(canonicalBytes(report.counts)) !== 0) {
      return { valid: false, code: 'SHADOW_REPORT_COUNTS_INVALID' };
    }
    if (
      canonicalBytes(recomputed.matrix).compare(canonicalBytes(report.decisionMatrix)) !== 0 ||
      canonicalBytes(recomputed.differences).compare(canonicalBytes(report.differences)) !== 0
    ) {
      return { valid: false, code: 'SHADOW_REPORT_AGGREGATES_INVALID' };
    }
    if (!validateManifestRecordBinding(report)) {
      return { valid: false, code: 'SHADOW_REPORT_MANIFEST_RECORD_MISMATCH' };
    }
    for (const record of report.records) {
      if (!record.facts) continue;
      if (observationDigest(record.facts) !== record.digest)
        return { valid: false, code: 'SHADOW_REPORT_RECORD_DIGEST_INVALID' };
      const evaluation = evaluateShadowObservation(record.facts, {
        policyId: snapshot.policyId,
        policyDigest: snapshot.descriptorDigest,
        expectedDigest: record.digest,
      });
      if (
        evaluation.decision !== record.hypotheticalDecision ||
        evaluation.decisionId !== record.hypotheticalDecisionId ||
        evaluation.reasonCode !== record.hypotheticalReasonCode ||
        compareShadowDecision(record.facts.productionDecision, evaluation.decision) !==
          record.comparison
      )
        return { valid: false, code: 'SHADOW_REPORT_REEVALUATION_INVALID' };
    }
    return { valid: true, code: 'SHADOW_REPORT_VALID' };
  } catch {
    return { valid: false, code: 'SHADOW_REPORT_INVALID' };
  }
}
