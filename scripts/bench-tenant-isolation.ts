#!/usr/bin/env tsx
/**
 * bench-tenant-isolation.ts — 跨租户隔离 fuzz test benchmark
 *
 * 使用 CrossTenantFuzzTest 对内存存储目标进行变异模糊测试，
 * 验证 Tenant A 的数据不会泄漏给 Tenant B。
 *
 * 满足 ENTERPRISE_READINESS.md SOC2-6 / TEN-3 的自动化验证需求。
 *
 * Usage:
 *   pnpm exec tsx scripts/bench-tenant-isolation.ts
 *   pnpm exec tsx scripts/bench-tenant-isolation.ts --mutations=2000
 *   pnpm exec tsx scripts/bench-tenant-isolation.ts --output=docs/baselines/tenant-isolation.json
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { withBenchmarkEnv } from './benchmarkEnv';

async function main() {
  const args = process.argv.slice(2);
  const mutationsArg = args.find((a) => a.startsWith('--mutations='));
  const maxMutations = mutationsArg ? parseInt(mutationsArg.slice(12), 10) : 1000;
  const outputArg = args.find((a) => a.startsWith('--output='));
  const outputPath = outputArg
    ? outputArg.slice('--output='.length)
    : `docs/baselines/tenant-isolation.${new Date().toISOString().slice(0, 10)}.json`;

  console.log('Cross-Tenant Isolation Fuzz Benchmark');
  console.log('═'.repeat(70));
  console.log(`  Max mutations: ${maxMutations}`);
  console.log('═'.repeat(70));

  const { CrossTenantFuzzTest, createInMemoryCrossTenantTarget } =
    await import('../packages/core/src/security/crossTenantFuzz');

  // Create an in-memory target that simulates a tenant-aware memory store
  const target = createInMemoryCrossTenantTarget<string>({
    name: 'memory_store',
    store: new Map(),
    seedValue: (tenantId) => `secret-for-${tenantId}`,
    valueToString: (value) => value,
  });

  const fuzz = new CrossTenantFuzzTest({
    maxMutations,
    victimTenants: ['tenant-a', 'tenant-b', 'tenant-c'],
    attackerTenants: ['attacker-1', 'attacker-2', ''],
  });

  fuzz.registerTarget(target);

  const start = Date.now();
  const report = await fuzz.run();
  const durationMs = Date.now() - start;

  console.log(`  Target:       ${report.targetName}`);
  console.log(`  Total cases:  ${report.totalCases}`);
  console.log(`  Defended:     ${report.defended}`);
  console.log(`  Leaks:        ${report.leaks.length}`);
  console.log(`  Errors:       ${report.errors}`);
  console.log(`  Duration:     ${durationMs}ms`);
  console.log('─'.repeat(70));

  if (report.leaks.length > 0) {
    console.log('  🚨 LEAKS DETECTED:');
    for (const leak of report.leaks.slice(0, 10)) {
      console.log(
        `    • ${leak.vector}: tenant ${leak.attackerTenant} accessed ${leak.leakedKey} ` +
          `from tenant ${leak.victimTenant}`,
      );
    }
    if (report.leaks.length > 10) {
      console.log(`    ... and ${report.leaks.length - 10} more`);
    }
  }

  console.log('═'.repeat(70));

  const isolationOk = report.leaks.length === 0 && report.errors === 0;

  const baseline = withBenchmarkEnv(
    {
      benchmark: 'tenant-isolation',
      config: { maxMutations },
      report: {
        targetName: report.targetName,
        totalCases: report.totalCases,
        defended: report.defended,
        leaks: report.leaks.length,
        errors: report.errors,
        durationMs,
        leakDetails: report.leaks,
      },
      summary: {
        passed: isolationOk,
        errors: report.errors,
        failed: report.leaks.length,
        skipped: 0,
        leakCount: report.leaks.length,
        errorCount: report.errors,
      },
    },
    { evidence: 'simulated' },
  );

  const fullPath = resolve(outputPath);
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(fullPath, JSON.stringify(baseline, null, 2), { mode: 0o644 });
  console.log(`Baseline saved to ${fullPath}`);

  if (!isolationOk) {
    const reasons: string[] = [];
    if (report.leaks.length > 0) reasons.push(`${report.leaks.length} tenant isolation leak(s)`);
    if (report.errors > 0) reasons.push(`${report.errors} fuzz error(s)`);
    console.log(`❌ FAIL: ${reasons.join('; ')}`);
    process.exit(1);
  }
  console.log('✅ PASS: No tenant isolation leaks or errors detected');
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(2);
});
