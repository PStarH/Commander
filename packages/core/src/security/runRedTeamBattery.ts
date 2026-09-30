/**
 * runRedTeamBattery — CLI entry point for running the complete red team
 * security test battery against Commander's defense layers.
 *
 * Usage:
 *   npx tsx packages/core/src/security/runRedTeamBattery.ts                    # Full 47-scenario battery
 *   npx tsx packages/core/src/security/runRedTeamBattery.ts --critical-only     # Critical scenarios only
 *   npx tsx packages/core/src/security/runRedTeamBattery.ts --category=jailbreak # Single category
 *   npx tsx packages/core/src/security/runRedTeamBattery.ts --json              # JSON output for CI/CD
 *   npx tsx packages/core/src/security/runRedTeamBattery.ts --smoke             # Quick smoke test (top 5)
 *
 * Exit codes:
 *   0  the gate passed — every scenario was evaluated and none was missed
 *   1  the gate failed — see redTeamGate.ts for the fail-closed contract
 *   2  the battery itself could not run
 *
 * The pass/fail decision and the exact stdout layout live in `redTeamGate.ts`;
 * this file only parses arguments, runs the battery and delegates.
 */

import { RedTeamFramework, createComprehensiveDefender } from './redTeamFramework';
import type { AttackCategory } from './redTeamFramework';
import { evaluateRedTeamGate, renderRedTeamBatteryOutput } from './redTeamGate';

const USAGE = `
  Commander Red Team Security Battery

  Usage:
    runRedTeamBattery.ts [options]

  Options:
    --json                 Emit the machine-readable report (JSON) for CI/CD
    --critical-only        Run critical-severity scenarios only
    --category=<name>      Run a single attack category
    --smoke                Quick smoke test (5 highest-CVSS scenarios)
    --help, -h             Show this message

  Categories:
    prompt_injection, jailbreak, data_exfiltration, agent_jacking,
    tool_abuse, memory_poisoning, denial_of_wallet, supply_chain

  Exit codes:
    0 = gate passed   1 = gate failed   2 = battery could not run
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

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

  // The gate is a pure function of the report, so every mode above — including
  // a `--category` filter that matched nothing — reaches the same contract.
  const verdict = evaluateRedTeamGate(report);

  console.log(renderRedTeamBatteryOutput(report, verdict, { jsonMode }));

  process.exit(verdict.exitCode);
}

main().catch((err) => {
  console.error('Fatal error running red team battery:', err);
  process.exit(2);
});
