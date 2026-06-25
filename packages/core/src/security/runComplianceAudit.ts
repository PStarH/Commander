/**
 * runComplianceAudit — CLI entry point for generating enterprise compliance
 * audit reports (ISO 42001, NIST AI RMF) from the Commander security posture.
 *
 * Usage:
 *   npx tsx packages/core/src/security/runComplianceAudit.ts                     # Markdown report to stdout
 *   npx tsx packages/core/src/security/runComplianceAudit.ts --json              # JSON report to stdout
 *   npx tsx packages/core/src/security/runComplianceAudit.ts --markdown          # Markdown report to stdout (default)
 *   npx tsx packages/core/src/security/runComplianceAudit.ts --output=/tmp/audit-report.md  # Save to file
 *   npx tsx packages/core/src/security/runComplianceAudit.ts --all               # Both markdown and JSON
 *   npx tsx packages/core/src/security/runComplianceAudit.ts --no-sign           # Skip HMAC signing
 *   npx tsx packages/core/src/security/runComplianceAudit.ts --threshold=85      # Fail if score below 85
 *
 * CI/CD usage (markdown + JSON as separate files):
 *   npx tsx packages/core/src/security/runComplianceAudit.ts --all --output=/tmp/compliance-audit
 *   # → /tmp/compliance-audit.md + /tmp/compliance-audit.json
 */

import * as fs from 'node:fs';
import { ComplianceAuditManager } from './complianceAuditReport';
import { getAuditChainLedger } from './auditChainLedger';

function parseArgs(args: string[]): {
  json: boolean;
  markdown: boolean;
  all: boolean;
  output: string | null;
  noSign: boolean;
  threshold: number;
  commitHash: string | undefined;
} {
  const json = args.includes('--json');
  const markdown = args.includes('--markdown');
  const all = args.includes('--all');
  const noSign = args.includes('--no-sign');

  const outputArg = args.find((a) => a.startsWith('--output='));
  const output = outputArg?.split('=')[1] ?? null;

  const thresholdArg = args.find((a) => a.startsWith('--threshold='));
  const threshold = thresholdArg ? parseInt(thresholdArg.split('=')[1], 10) : 75;

  const commitHash = process.env.GITHUB_SHA ?? process.env.COMMANDER_COMMIT_HASH ?? undefined;

  return { json, markdown, all, output, noSign, threshold, commitHash };
}

function writeToFile(basePath: string, ext: string, content: string): void {
  const filePath = basePath.endsWith(`.${ext}`) ? basePath : `${basePath}.${ext}`;
  fs.writeFileSync(filePath, content, 'utf-8');
  console.error(`📄 Written: ${filePath}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // D1 hardening-sprint §3 Verify command: surface missing prod keys via
  // process exit code (caught by the .catch below → exit 2), not a silent
  // stderr warning. AuditChainLedger resolves its master key at singleton
  // construction; in production without COMMANDER_AUDIT_CHAIN_KEY set
  // this throws immediately and the CLI fails loudly before any output.
  getAuditChainLedger();

  // Default: markdown if neither --json nor --all specified
  const showMarkdown = args.all || args.markdown || (!args.json && !args.all);
  const showJson = args.all || args.json;

  console.error('\n🔒 Commander Compliance Audit Report Generator');
  console.error('─────────────────────────────────────────────────\n');

  const manager = new ComplianceAuditManager({
    signReports: !args.noSign,
  });

  console.error('📊 Generating full compliance audit report...');

  const report = manager.generateFullReport({
    commitHash: args.commitHash,
    branch: process.env.GITHUB_REF_NAME,
  });

  console.error(`   Score: ${report.posture.overallScore}/100 (Grade ${report.posture.grade})`);
  console.error(
    `   ISO 42001: ${report.isoCompliance.compliancePercentage}% | NIST AI RMF: ${report.nistRmfAlignment.alignmentPercentage}%`,
  );
  console.error(
    `   Trend: ${report.trendAnalysis.trend} | Snapshots: ${report.postureHistory.length}`,
  );

  // Generate outputs
  const md = showMarkdown ? manager.formatAsMarkdown(report) : '';
  const json = showJson ? manager.formatAsJson(report) : '';

  // Write to files or stdout
  if (args.output) {
    if (showMarkdown) {
      writeToFile(args.output, 'md', md);
    }
    if (showJson) {
      writeToFile(args.output, 'json', json);
    }
  } else {
    // Write to stdout — JSON first if both, then markdown
    if (showJson && showMarkdown) {
      console.log(json);
      console.log('\n---\n');
      console.log(md);
    } else if (showJson) {
      console.log(json);
    } else {
      console.log(md);
    }
  }

  console.error('\n─────────────────────────────────────────────────');

  // Exit with non-zero if score below threshold
  if (report.posture.overallScore < args.threshold) {
    console.error(
      `\n❌ FAILED: Compliance score ${report.posture.overallScore}/100 is below threshold ${args.threshold}/100.`,
    );
    process.exit(1);
  }

  // Check for critical ISO gaps
  const criticalGaps = report.isoCompliance.gaps.filter((g) => g.severity === 'critical');
  if (criticalGaps.length > 0) {
    console.error(`\n❌ FAILED: ${criticalGaps.length} critical ISO 42001 gap(s) detected:`);
    for (const gap of criticalGaps) {
      console.error(`   - ${gap.clause}: ${gap.description}`);
    }
    process.exit(1);
  }

  console.error(`\n✅ Compliance audit report generated successfully.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error generating compliance audit report:', err);
  process.exit(2);
});
