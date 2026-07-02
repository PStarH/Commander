// packages/core/src/cli/commands/audit-quarterly.ts
import { runQuarterlyAudit, saveAuditReport } from '../../plugins/builtin/gap/quarterlyAudit';

export async function runQuarterlyAuditCli(): Promise<void> {
  const report = runQuarterlyAudit();
  const outFile = saveAuditReport(report);
  console.log(`Audit written to ${outFile}`);
  console.log(
    `Open: ${report.metrics.open} | Fixed this quarter: ${report.fixedThisQuarter} | Overdue: ${report.overdueCount}`,
  );
  if (report.metrics.open > 0) {
    process.exitCode = 1; // non-zero exit if there are open gaps
  }
}
