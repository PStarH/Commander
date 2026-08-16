import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export interface ScannerWarning {
  severity: string;
  category: string;
  message: string;
  evidence: string;
}

export interface ScannerPolicyAuditWarning {
  fingerprint: string;
  severity: string;
  category: string;
  message: string;
}

export interface ScannerPolicyViolation extends ScannerPolicyAuditWarning {
  reason: 'new_high_warning' | 'duplicate_high_warning' | 'malware_or_critical';
}

export function warningFingerprint(warning: ScannerWarning): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        severity: warning.severity,
        category: warning.category,
        message: warning.message,
        evidenceSha256: createHash('sha256').update(warning.evidence).digest('hex'),
      }),
    )
    .digest('hex');
}

function isMalwareOrCritical(warning: ScannerWarning): boolean {
  return warning.severity === 'critical' || warning.category.startsWith('malware.');
}

function isHighWarning(warning: ScannerWarning): boolean {
  return warning.severity === 'high';
}

function auditWarning(warning: ScannerWarning): ScannerPolicyAuditWarning {
  return {
    fingerprint: warningFingerprint(warning),
    severity: warning.severity,
    category: warning.category,
    message: warning.message,
  };
}

const MAX_HIGH_WARNING_OCCURRENCES = 1_024;

function warningEvidencePrefix(evidence: string): string {
  return evidence.endsWith('...') ? evidence.slice(0, -3) : evidence;
}

export function readGitBlob(
  repoRoot: string,
  revision: string,
  relativePath: string,
): string | undefined {
  try {
    return execFileSync('git', ['show', revision + ':' + relativePath], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

export function readIndexedContent(repoRoot: string, relativePath: string): string {
  const staged = readGitBlob(repoRoot, '', relativePath);
  if (staged === undefined) {
    throw new Error('D3_INDEX_BLOB_UNAVAILABLE:' + relativePath);
  }
  return staged;
}

export async function enumerateHighWarnings(
  content: string,
  scan: (content: string) => Promise<readonly ScannerWarning[]> | readonly ScannerWarning[],
): Promise<ScannerWarning[]> {
  const warnings: ScannerWarning[] = [];
  let remaining = content;

  for (let iteration = 0; iteration < MAX_HIGH_WARNING_OCCURRENCES; iteration += 1) {
    const highWarnings = (await scan(remaining)).filter(
      (warning) => isHighWarning(warning) && !isMalwareOrCritical(warning),
    );
    if (highWarnings.length === 0) return warnings;

    for (const warning of highWarnings) {
      const evidence = warningEvidencePrefix(warning.evidence);
      const index = remaining.indexOf(evidence);
      if (index < 0 || evidence.length === 0) {
        throw new Error('D3_SCANNER_WARNING_EVIDENCE_UNRESOLVABLE');
      }
      warnings.push(warning);
      remaining =
        remaining.slice(0, index) +
        ' '.repeat(evidence.length) +
        remaining.slice(index + evidence.length);
    }
  }

  throw new Error('D3_SCANNER_WARNING_OCCURRENCE_LIMIT');
}

export function evaluateIndexedWarnings(
  stagedWarnings: readonly ScannerWarning[],
  headWarnings: readonly ScannerWarning[],
): {
  inherited: ScannerPolicyAuditWarning[];
  violations: ScannerPolicyViolation[];
} {
  const inherited: ScannerPolicyAuditWarning[] = [];
  const violations: ScannerPolicyViolation[] = [];
  const headHighCounts = new Map<string, number>();
  const stagedHighCounts = new Map<string, number>();

  for (const warning of headWarnings) {
    if (!isHighWarning(warning) || isMalwareOrCritical(warning)) continue;
    const fingerprint = warningFingerprint(warning);
    headHighCounts.set(fingerprint, (headHighCounts.get(fingerprint) ?? 0) + 1);
  }

  for (const warning of stagedWarnings) {
    const audit = auditWarning(warning);
    if (isMalwareOrCritical(warning)) {
      violations.push({ ...audit, reason: 'malware_or_critical' });
      continue;
    }
    if (!isHighWarning(warning)) continue;

    const occurrence = (stagedHighCounts.get(audit.fingerprint) ?? 0) + 1;
    stagedHighCounts.set(audit.fingerprint, occurrence);
    const baselineCount = headHighCounts.get(audit.fingerprint) ?? 0;
    if (occurrence > baselineCount) {
      violations.push({
        ...audit,
        reason: baselineCount === 0 ? 'new_high_warning' : 'duplicate_high_warning',
      });
    } else {
      inherited.push(audit);
    }
  }

  return { inherited, violations };
}
