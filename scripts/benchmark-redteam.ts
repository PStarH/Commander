#!/usr/bin/env tsx
/**
 * benchmark-redteam.ts — Red Team Battery 标准化 benchmark 入口
 *
 * 将 RedTeamFramework 的 47 个攻击场景接入标准 benchmark 流程，
 * 使用 createComprehensiveDefender 作为默认 defender，输出 JSON baseline。
 *
 * Usage:
 *   npx tsx scripts/benchmark-redteam.ts                   # 全量 47 场景
 *   npx tsx scripts/benchmark-redteam.ts --critical-only    # 仅 critical
 *   npx tsx scripts/benchmark-redteam.ts --smoke            # top 5 by CVSS
 *   npx tsx scripts/benchmark-redteam.ts --category=jailbreak
 *   npx tsx scripts/benchmark-redteam.ts --output=docs/baselines/redteam.json
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

async function main() {
  const args = process.argv.slice(2);
  const outputArg = args.find((a) => a.startsWith('--output='));
  const outputPath = outputArg
    ? outputArg.slice('--output='.length)
    : `docs/baselines/redteam-baseline.${new Date().toISOString().slice(0, 10)}.json`;

  console.log('Red Team Battery Benchmark');
  console.log('═'.repeat(70));

  const { RedTeamFramework, createComprehensiveDefender } =
    await import('../packages/core/src/security/redTeamFramework');

  const defender = createComprehensiveDefender();
  const framework = new RedTeamFramework();

  let report;
  let mode: string;

  if (args.includes('--smoke')) {
    report = await framework.smokeTest(defender);
    mode = 'smoke (top 5 by CVSS)';
  } else if (args.includes('--critical-only')) {
    report = await framework.runCriticalOnly(defender);
    mode = 'critical-only';
  } else {
    const categoryArg = args.find((a) => a.startsWith('--category='));
    if (categoryArg) {
      const category = categoryArg.slice('--category='.length);
      report = await framework.runByCategory(category as any, defender);
      mode = `category=${category}`;
    } else {
      report = await framework.runAll(defender);
      mode = 'full (all scenarios)';
    }
  }

  console.log(`  Mode: ${mode}`);
  console.log(`  Total tests: ${report.totalTests}`);
  console.log('─'.repeat(70));
  console.log(`  Blocked:  ${report.summary.blocked}`);
  console.log(`  Detected: ${report.summary.detected}`);
  console.log(`  Missed:   ${report.summary.missed}`);
  console.log(`  Errors:   ${report.summary.error}`);
  console.log(`  Security Score: ${report.securityScore}/100`);
  console.log(`  Duration: ${report.durationMs}ms`);
  console.log('─'.repeat(70));

  if (report.criticalFindings.length > 0) {
    console.log('  🚨 CRITICAL FINDINGS (unblocked attacks):');
    for (const finding of report.criticalFindings) {
      console.log(`    • ${finding}`);
    }
  }

  console.log('═'.repeat(70));

  const baseline = {
    benchmark: 'redteam',
    runAt: report.runAt,
    nodeVersion: process.version,
    mode,
    totalTests: report.totalTests,
    summary: report.summary,
    securityScore: report.securityScore,
    criticalFindings: report.criticalFindings,
    durationMs: report.durationMs,
    results: report.results.map((r) => ({
      scenarioId: r.scenario.id,
      scenarioName: r.scenario.name,
      category: r.scenario.category,
      severity: r.scenario.severity,
      cvssScore: r.scenario.cvssScore,
      blocked: r.blocked,
      detected: r.detected,
      defense: r.defense,
      details: r.details,
    })),
  };

  const fullPath = resolve(outputPath);
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(fullPath, JSON.stringify(baseline, null, 2), { mode: 0o644 });
  console.log(`Baseline saved to ${fullPath}`);

  if (report.criticalFindings.length > 0) {
    console.log(`❌ FAIL: ${report.criticalFindings.length} critical attack(s) not blocked`);
    process.exit(1);
  }
  console.log('✅ PASS: All critical attacks blocked');
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(2);
});
