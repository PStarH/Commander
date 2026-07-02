// packages/core/src/plugins/builtin/gap/quarterlyAudit.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GapRegistry } from './registry';
import { loadGapConfig } from './config';
import { computeMetrics, type GapMetrics } from './metrics';
import { getGlobalLogger } from '../../../logging';

export interface AuditReport {
  quarter: string;
  generatedAt: string;
  metrics: GapMetrics;
  recentGaps: Array<{
    id: string;
    source: string;
    severity: string;
    title: string;
    status: string;
    daysOpen: number;
  }>;
  fixedThisQuarter: number;
  overdueCount: number;
  topSources: Array<{ source: string; count: number }>;
}

function getQuarter(d: Date): string {
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `Q${q}`;
}

function getQuarterStart(d: Date): Date {
  const q = Math.floor(d.getMonth() / 3);
  return new Date(Date.UTC(d.getFullYear(), q * 3, 1));
}

function daysSince(iso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
}

export function runQuarterlyAudit(now: Date = new Date()): AuditReport {
  const logger = getGlobalLogger();
  const config = loadGapConfig();
  const registry = new GapRegistry(config.registryFile);
  const all = registry.list();
  const metrics = computeMetrics(all, now);
  const quarterStart = getQuarterStart(now);

  const recentGaps = all
    .filter((e) => new Date(e.detectedAt) >= quarterStart)
    .map((e) => ({
      id: e.id,
      source: e.source,
      severity: e.severity,
      title: e.title,
      status: e.status,
      daysOpen: e.status === 'open' ? daysSince(e.detectedAt, now) : 0,
    }));

  const fixedThisQuarter = all.filter(
    (e) => e.status === 'fixed' && e.closedAt && new Date(e.closedAt) >= quarterStart,
  ).length;

  const overdueCount = metrics.overdueRepair;

  const topSources = Object.entries(metrics.bySource)
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  logger.info('QuarterlyAudit', 'audit completed', {
    quarter: `${now.getFullYear()}-${getQuarter(now)}`,
    open: metrics.open,
    fixed: fixedThisQuarter,
    overdue: overdueCount,
  });

  return {
    quarter: `${now.getFullYear()}-${getQuarter(now)}`,
    generatedAt: now.toISOString(),
    metrics,
    recentGaps,
    fixedThisQuarter,
    overdueCount,
    topSources,
  };
}

export function renderAuditMarkdown(report: AuditReport): string {
  const lines = [
    `# Architecture Audit — ${report.quarter}`,
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Open gaps | ${report.metrics.open} |`,
    `| Fixed this quarter | ${report.fixedThisQuarter} |`,
    `| Overdue | ${report.overdueCount} |`,
    `| Avg time to fix (days) | ${report.metrics.avgTimeToFixDays.toFixed(1)} |`,
    '',
    '## Top Gap Sources',
    '',
    ...report.topSources.map((s) => `- **${s.source}**: ${s.count} gaps`),
    '',
    '## Recent Gaps (this quarter)',
    '',
    '| ID | Source | Severity | Status | Days open | Title |',
    '|----|--------|----------|--------|-----------|-------|',
    ...report.recentGaps
      .slice(0, 30)
      .map(
        (g) =>
          `| ${g.id} | ${g.source} | ${g.severity} | ${g.status} | ${g.daysOpen} | ${g.title} |`,
      ),
  ];
  return lines.join('\n') + '\n';
}

export function saveAuditReport(
  report: AuditReport,
  outDir: string = path.join(process.cwd(), 'docs', 'audits'),
): string {
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${report.quarter}.md`);
  fs.writeFileSync(outFile, renderAuditMarkdown(report), 'utf-8');
  return outFile;
}
