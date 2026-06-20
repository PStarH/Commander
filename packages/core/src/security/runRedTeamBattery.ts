/**
 * runRedTeamBattery — CLI entry point for running the complete red team
 * security test battery against Commander's defense layers.
 *
 * Usage:
 *   npx tsx packages/core/src/security/runRedTeamBattery.ts                    # Full 44-scenario battery
 *   npx tsx packages/core/src/security/runRedTeamBattery.ts --critical-only     # Critical scenarios only
 *   npx tsx packages/core/src/security/runRedTeamBattery.ts --category=jailbreak # Single category
 *   npx tsx packages/core/src/security/runRedTeamBattery.ts --json              # JSON output for CI/CD
 *   npx tsx packages/core/src/security/runRedTeamBattery.ts --smoke             # Quick smoke test (top 5)
 */

import {
  RedTeamFramework,
  createComprehensiveDefender,
  generateSecurityReport,
  generateSecurityReportJson,
} from './redTeamFramework';
import type { AttackCategory } from './redTeamFramework';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const criticalOnly = args.includes('--critical-only');
  const smokeMode = args.includes('--smoke');
  const categoryArg = args.find((a) => a.startsWith('--category='));
  const category = categoryArg?.split('=')[1] as AttackCategory | undefined;

  console.log('\n🔴 Commander Red Team Security Battery');
  console.log('───────────────────────────────────────────────\n');

  const framework = new RedTeamFramework({
    onProgress: (result) => {
      const icon =
        result.result === 'blocked'
          ? '🛡️'
          : result.result === 'detected'
            ? '⚠️'
            : result.result === 'missed'
              ? '🔴'
              : '⚡';
      console.log(
        `  ${icon} [${result.scenario.id}] ${result.scenario.name.padEnd(45)} → ${result.result}`,
      );
    },
  });

  const defender = createComprehensiveDefender();

  let report;
  if (smokeMode) {
    console.log('Mode: Smoke test (top 5 critical scenarios)\n');
    report = await framework.smokeTest(defender);
  } else if (criticalOnly) {
    console.log('Mode: Critical-only\n');
    report = await framework.runCriticalOnly(defender);
  } else if (category) {
    console.log(`Mode: Category = ${category}\n`);
    report = await framework.runByCategory(category, defender);
  } else {
    console.log(`Mode: Full battery (${framework.getScenarios().length} scenarios)\n`);
    report = await framework.runAll(defender);
  }

  console.log('\n───────────────────────────────────────────────\n');

  if (jsonMode) {
    console.log(generateSecurityReportJson(report));
  } else {
    console.log(generateSecurityReport(report));
  }

  // Exit with non-zero code if any critical attacks were missed
  if (report.criticalFindings.length > 0) {
    console.log(
      `\n❌ FAILED: ${report.criticalFindings.length} critical attack(s) were not blocked.`,
    );
    process.exit(1);
  }

  console.log(`\n✅ Security score: ${report.securityScore}/100\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error running red team battery:', err);
  process.exit(2);
});
