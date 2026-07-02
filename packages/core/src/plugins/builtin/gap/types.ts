// packages/core/src/plugins/builtin/gap/types.ts
export type GapSource =
  | 'chaos'
  | 'shadow-drift'
  | 'redteam-missed'
  | 'postmortem'
  | 'cve-feed'
  | 'customer-report'
  | 'security-audit'
  | 'quarterly-audit';

export type GapSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type GapStatus =
  | 'open'
  | 'investigating'
  | 'fix-scheduled'
  | 'fix-in-progress'
  | 'fixed'
  | 'wontfix';

export interface GapRegressionCheck {
  lastVerified: string;
  testIds: string[];
}

export interface GapEntry {
  id: string;
  source: GapSource;
  severity: GapSeverity;
  title: string;
  description: string;
  detectedAt: string;
  status: GapStatus;
  owner?: string;
  relatedIssues: string[];
  slaDeadline: string;
  resolutionNotes?: string;
  closedAt?: string;
  regressionCheck?: GapRegressionCheck;
}

const DETECT_SLA_DAYS: Record<GapSeverity, number> = {
  critical: 1, // 24h
  high: 7, // 7d
  medium: 30, // 30d
  low: 90, // 90d
  info: 365, // info
};

const REPAIR_SLA_DAYS: Record<GapSeverity, number> = {
  critical: 7, // 7d
  high: 14, // 14d
  medium: 30, // 30d
  low: 90, // 90d
  info: 365,
};

export function isCritical(severity: GapSeverity): boolean {
  return severity === 'critical';
}

export function isOverdue(deadline: string, now: Date = new Date()): boolean {
  return new Date(deadline).getTime() < now.getTime();
}

export function computeSlaDeadline(severity: GapSeverity, from: Date = new Date()): string {
  const days = DETECT_SLA_DAYS[severity];
  const deadline = new Date(from);
  deadline.setUTCDate(deadline.getUTCDate() + days);
  return deadline.toISOString();
}

export function computeRepairDeadline(severity: GapSeverity, from: Date = new Date()): string {
  const days = REPAIR_SLA_DAYS[severity];
  const deadline = new Date(from);
  deadline.setUTCDate(deadline.getUTCDate() + days);
  return deadline.toISOString();
}
