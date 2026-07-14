export type EvidenceLevel = 'live' | 'simulated' | 'synthetic';

export interface BaselineBinding {
  gitSha?: string;
  imageDigest?: string;
  nodeVersion?: string;
  pnpmVersion?: string;
  pgVersion?: string;
  postgresVersion?: string;
  topology?: string | object;
  datasetVersion?: string;
}

export interface BaselineEnv extends BaselineBinding {
  evidence: EvidenceLevel;
}

export interface BaselineSummary {
  passed: boolean;
  errors?: number;
  failed?: number;
  skipped?: number;
  reason?: string;
}

export interface BaselineDocument {
  /** Schema v2 introduces the env evidence envelope. */
  schemaVersion?: number;
  /** Legacy v1 evidence field (kept for backwards compatibility). */
  evidenceLevel?: EvidenceLevel;
  /** Legacy v1 binding field (kept for backwards compatibility). */
  baseline?: BaselineBinding;
  /** v2 evidence envelope. */
  env?: BaselineEnv;
  summary?: BaselineSummary;
}

export interface ValidateBaselineCurrent {
  gitSha: string;
  imageDigest?: string;
  nodeVersion?: string;
  pnpmVersion?: string;
}

function normalizeEvidence(doc: BaselineDocument): { evidence?: EvidenceLevel; binding: BaselineBinding } {
  const legacyEvidence = doc.evidenceLevel;
  const legacyBinding = doc.baseline ?? {};

  if (doc.schemaVersion === 2 && doc.env) {
    return {
      evidence: doc.env.evidence ?? legacyEvidence,
      binding: {
        ...legacyBinding,
        gitSha: doc.env.gitSha ?? legacyBinding.gitSha,
        imageDigest: doc.env.imageDigest ?? legacyBinding.imageDigest,
        nodeVersion: doc.env.nodeVersion ?? legacyBinding.nodeVersion,
        pnpmVersion: doc.env.pnpmVersion ?? legacyBinding.pnpmVersion,
        pgVersion: doc.env.pgVersion ?? doc.env.postgresVersion ?? legacyBinding.pgVersion,
        postgresVersion: doc.env.postgresVersion ?? doc.env.pgVersion ?? legacyBinding.postgresVersion,
        topology: doc.env.topology ?? legacyBinding.topology,
        datasetVersion: doc.env.datasetVersion ?? legacyBinding.datasetVersion,
      },
    };
  }

  return { evidence: legacyEvidence, binding: legacyBinding };
}

export function validateBaseline(
  doc: BaselineDocument,
  current: ValidateBaselineCurrent,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const summary: Partial<BaselineSummary> = doc.summary ?? {};

  // Schema v2 validation
  if (doc.schemaVersion === 2) {
    if (!doc.env) {
      reasons.push('schemaVersion=2 but env envelope is missing');
    } else if (!doc.env.evidence) {
      reasons.push('schemaVersion=2 but env.evidence is missing');
    }
  }

  const { evidence, binding } = normalizeEvidence(doc);

  if (!evidence || !(['live', 'simulated', 'synthetic'] as EvidenceLevel[]).includes(evidence)) {
    reasons.push('missing or invalid evidenceLevel/env.evidence');
  }

  if (summary.passed !== true) {
    reasons.push('summary.passed is not true');
  }

  if ((summary.errors ?? 0) > 0) {
    reasons.push('errors > 0');
  }
  if ((summary.failed ?? 0) > 0) {
    reasons.push('failed > 0');
  }
  if ((summary.skipped ?? 0) > 0) {
    reasons.push('skipped > 0');
  }

  // Runtime consistency checks
  if (binding.gitSha && binding.gitSha !== current.gitSha) {
    reasons.push('gitSha mismatch');
  }

  if (current.imageDigest && binding.imageDigest && binding.imageDigest !== current.imageDigest) {
    reasons.push('imageDigest mismatch');
  }

  if (current.nodeVersion && binding.nodeVersion && binding.nodeVersion !== current.nodeVersion) {
    reasons.push(`nodeVersion mismatch: baseline=${binding.nodeVersion} current=${current.nodeVersion}`);
  }

  if (current.pnpmVersion && binding.pnpmVersion && binding.pnpmVersion !== current.pnpmVersion) {
    reasons.push(`pnpmVersion mismatch: baseline=${binding.pnpmVersion} current=${current.pnpmVersion}`);
  }

  return { ok: reasons.length === 0, reasons };
}
