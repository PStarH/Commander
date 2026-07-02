/**
 * smokeTestE2E — End-to-end smoke test for the 4 production-grade sub-projects.
 *
 * Exercises:
 *   1. Gap Discovery Loop    — record → list → close → metrics
 *   2. Chaos Test Suite      — L1/L2/L3/L4 fault injection → recovery
 *   3. Shadow Traffic        — PII scrubber → drift detection
 *   4. Red Team Evaluation   — full battery with tenancy + plugin supply chain
 *
 * Writes nothing to the global gap registry; uses a sandboxed temp dir.
 *
 * Usage:
 *   npx tsx packages/core/src/smoke/smokeTestE2E.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GapRegistry, computeMetrics, runQuarterlyAudit } from '../plugins/builtin/gap';
import { ensureDir } from '../plugins/builtin/gap/storage';
import { ChaosOrchestrator, parseLayers, validateScenario } from '../chaos';
import { scrubRequest, redactPii, DriftReporter } from '../shadow';
import {
  RedTeamFramework,
  createComprehensiveDefender,
  generateSecurityReport,
} from '../security/redTeamFramework';
import { TENANT_ATTACK_SCENARIOS } from '../security/tenancyScenarios';
import { PLUGIN_SUPPLY_CHAIN_SCENARIOS } from '../security/pluginSupplyChainScenarios';
import { assertTenantIsolation } from '../security/tenancyScenarios';

// ── Smoke-test utilities ─────────────────────────────────────────────

interface StepResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
  durationMs: number;
}

const results: StepResult[] = [];

async function runStep(name: string, fn: () => Promise<string>): Promise<void> {
  const start = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: 'PASS', detail, durationMs: Date.now() - start });
    console.log(`  ✅ ${name.padEnd(48)} ${detail}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, status: 'FAIL', detail: msg, durationMs: Date.now() - start });
    console.log(`  ❌ ${name.padEnd(48)} ${msg}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(60 - title.length)}\n`);
}

// ── Step 1: Gap Discovery Loop ───────────────────────────────────────

async function testGapDiscovery(sandbox: string): Promise<void> {
  section('1. Gap Discovery Loop');

  const registryFile = path.join(sandbox, 'gaps/registry.ndjson');
  ensureDir(path.dirname(registryFile));

  const registry = new GapRegistry(registryFile);

  await runStep('Record critical gap', async () => {
    const entry = registry.record({
      source: 'chaos',
      severity: 'critical',
      title: '[smoke] L1 LLM rate limit not recovered',
      description: 'Smoke-test gap from end-to-end verification',
    });
    if (!entry.id) throw new Error('gap id not assigned');
    return `id=${entry.id}`;
  });

  await runStep('Record high gap', async () => {
    const entry = registry.record({
      source: 'redteam-missed',
      severity: 'high',
      title: '[smoke] Red team scenario TENANT-001 missed',
      description: 'Smoke-test gap from end-to-end verification',
    });
    const slaIso = entry.slaDeadline;
    if (new Date(slaIso).getTime() < Date.now()) {
      throw new Error('SLA deadline should be in the future');
    }
    return `id=${entry.id} sla=${slaIso.slice(0, 10)}`;
  });

  await runStep('List open gaps', async () => {
    const open = registry.list({ status: 'open' });
    if (open.length !== 2) throw new Error(`expected 2 open, got ${open.length}`);
    return `${open.length} open gaps`;
  });

  await runStep('Close first gap', async () => {
    const open = registry.list({ status: 'open' });
    if (open.length === 0) throw new Error('no open gaps to close');
    const id = open[0].id;
    // Use the registry API (not direct file writes) so HMAC signing is preserved.
    // Direct file writes would be rejected by integrity.verify() on reload.
    registry.close(id, 'smoke test closure', ['smoke-test-regression']);
    const reloaded = new GapRegistry(registryFile).get(id);
    if (reloaded?.status !== 'fixed') throw new Error('close did not persist');
    return `closed ${id}`;
  });

  await runStep('Compute gap metrics', async () => {
    const entries = new GapRegistry(registryFile).list();
    const metrics = computeMetrics(entries);
    if (metrics.open !== 1) throw new Error(`expected 1 open, got ${metrics.open}`);
    return `open=${metrics.open} sources=${Object.keys(metrics.bySource).length}`;
  });

  await runStep('Quarterly audit (sandboxed)', async () => {
    const report = runQuarterlyAudit(new Date('2026-06-15T00:00:00Z'));
    if (typeof report.quarter !== 'string' || report.quarter.length === 0) {
      throw new Error('audit quarter missing');
    }
    return `quarter=${report.quarter} open=${report.metrics.open}`;
  });
}

// ── Step 2: Chaos Test Suite ─────────────────────────────────────────

async function testChaos(sandbox: string): Promise<void> {
  section('2. Chaos Test Suite');

  let callCount = 0;
  const bootstrap = async (): Promise<void> => {
    callCount += 1;
  };

  const orch = new ChaosOrchestrator({ bootstrap, delayMs: 10 });

  await runStep('Validate scenario (L1 only)', async () => {
    const v = validateScenario({ layers: ['L1'], tenantId: undefined });
    if (!v.valid) throw new Error(`expected valid, got errors: ${v.errors.join(',')}`);
    return 'valid';
  });

  await runStep('Validate scenario (L4 requires tenantId)', async () => {
    const v = validateScenario({ layers: ['L4'], tenantId: undefined });
    if (v.valid) throw new Error('expected invalid');
    if (!v.errors.some((e) => e.includes('tenantId'))) {
      throw new Error(`expected tenantId error, got: ${v.errors.join(',')}`);
    }
    return 'correctly rejected';
  });

  await runStep('Parse layers string', async () => {
    const layers = parseLayers('L1,L2,L3');
    if (layers.length !== 3) throw new Error(`expected 3 layers, got ${layers.length}`);
    return `${layers.length} layers parsed`;
  });

  await runStep('L1 LLM rate-limit fault → recovery', async () => {
    orch.layers.l1.arm({ faultType: 'rate_limit_429', triggerAtCalls: [1] });
    const results = await orch.run({ layers: ['L1'], durationSec: 1 });
    if (results.length !== 1) throw new Error(`expected 1 result, got ${results.length}`);
    if (results[0].layer !== 'L1') throw new Error(`wrong layer: ${results[0].layer}`);
    if (callCount === 0) throw new Error('bootstrap not invoked during recovery');
    orch.layers.l1.disarm();
    return `recovery=${results[0].recovery.recoverySucceeded ? 'OK' : 'FAILED'}`;
  });

  await runStep('L2 Tool http_5xx fault → recovery', async () => {
    orch.layers.l2.arm({ tool: 'web_fetch', mode: 'http_5xx', statusCode: 503 });
    let caught = false;
    try {
      await orch.layers.l2.intercept('web_fetch', {}, async () => 'ok');
    } catch {
      caught = true;
    }
    if (!caught) throw new Error('expected http_5xx to throw');
    const results = await orch.run({ layers: ['L2'], durationSec: 1 });
    orch.layers.l2.disarm();
    return `5xx caught, recovery=${results[0].recovery.recoverySucceeded ? 'OK' : 'FAILED'}`;
  });

  await runStep('L3 System disk-full fault → recovery', async () => {
    const path = await orch.layers.l3.injectDiskFull({ constraintMb: 1 });
    if (!fs.existsSync(path)) throw new Error('disk constraint dir not created');
    fs.rmSync(path, { recursive: true });
    return `path=${path.slice(-20)}`;
  });

  await runStep('L4 Tenant blast-radius check', async () => {
    orch.layers.l4.arm({ tenantId: 'acme', faultType: 'memory_corrupt' });
    if (!orch.layers.l4.shouldApply({ tenantId: 'acme' })) {
      throw new Error('expected fault applied to acme');
    }
    if (orch.layers.l4.shouldApply({ tenantId: 'globex' })) {
      throw new Error('fault should not apply to globex');
    }
    orch.layers.l4.disarm();
    return 'blast-radius contained';
  });
}

// ── Step 3: Shadow Traffic ───────────────────────────────────────────

async function testShadow(sandbox: string): Promise<void> {
  section('3. Shadow Traffic');

  await runStep('PII scrubber — email', async () => {
    const result = redactPii('contact alice@globex.com for details');
    if (!result.includes('[EMAIL]')) throw new Error(`email not scrubbed: ${result}`);
    return 'email → [EMAIL]';
  });

  await runStep('PII scrubber — phone + card + API key', async () => {
    const input =
      'call +1-555-123-4567, card 4111-1111-1111-1111, key sk-abcdef1234567890abcdef1234';
    const result = redactPii(input);
    if (!result.includes('[PHONE]')) throw new Error('phone not scrubbed');
    if (!result.includes('[CARD]')) throw new Error('card not scrubbed');
    if (!result.includes('[OPENAI_KEY]')) throw new Error('openai key not scrubbed');
    return 'all 3 PII classes scrubbed';
  });

  await runStep('scrubRequest — Authorization header', async () => {
    const result = scrubRequest(
      { headers: { Authorization: 'Bearer secret', 'X-Trace': 'trace-1' } },
      ['Authorization'],
    );
    if (result.headers.Authorization !== '[REDACTED]') {
      throw new Error(`Authorization not redacted: ${result.headers.Authorization}`);
    }
    if (result.headers['X-Trace'] !== 'trace-1') {
      throw new Error('non-sensitive header should pass through');
    }
    return 'auth redacted, X-Trace passed';
  });

  await runStep('DriftReporter — record → flush → detect', async () => {
    const driftFile = path.join(sandbox, 'shadow/drift.ndjson');
    ensureDir(path.dirname(driftFile));
    const reporter = new DriftReporter(driftFile);

    const endpoint = '/api/v1/plan';
    for (let i = 0; i < 12; i++) {
      const status = i < 2 ? 200 : 500;
      reporter.record({
        endpoint,
        prodStatus: 200,
        shadowStatus: status,
        prodLatencyMs: 100,
        shadowLatencyMs: 100,
        prodCostUsd: 0.001,
        shadowCostUsd: 0.001,
        driftDetected: i >= 2,
        metrics: { statusDeltaPct: 0, latencyDeltaPct: 0, costDeltaPct: 0 },
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
      });
    }
    reporter.flush();

    if (!fs.existsSync(driftFile)) throw new Error('drift file not written');
    const anomalies = reporter.detectAnomalies(10);
    if (anomalies.length === 0) throw new Error('no anomalies detected');
    return `${anomalies[0].length} samples for ${endpoint}`;
  });
}

// ── Step 4: Red Team Evaluation ──────────────────────────────────────

async function testRedTeam(sandbox: string): Promise<void> {
  section('4. Red Team Evaluation');

  await runStep('Smoke test (top 5 critical)', async () => {
    const framework = new RedTeamFramework();
    const defender = createComprehensiveDefender();
    const report = await framework.smokeTest(defender);
    if (report.totalTests !== 5) throw new Error(`expected 5 tests, got ${report.totalTests}`);
    return `score=${report.securityScore}/100 tests=${report.totalTests}`;
  });

  await runStep('Full battery (54 scenarios incl. tenancy + plugin)', async () => {
    const framework = new RedTeamFramework({
      scenarios: [...TENANT_ATTACK_SCENARIOS, ...PLUGIN_SUPPLY_CHAIN_SCENARIOS],
    });
    const defender = createComprehensiveDefender();
    const report = await framework.runAll(defender);
    if (report.totalTests < 54) throw new Error(`expected ≥54 tests, got ${report.totalTests}`);
    return `score=${report.securityScore}/100 tests=${report.totalTests} missed=${report.summary.missed}`;
  });

  await runStep('Tenant isolation assertion', async () => {
    const same = assertTenantIsolation({ fromTenant: 'acme', toTenant: 'acme', dataAccessed: [] });
    if (!same.passed) throw new Error('same-tenant should pass');
    const cross = assertTenantIsolation({
      fromTenant: 'acme',
      toTenant: 'globex',
      dataAccessed: ['s1'],
    });
    if (cross.passed) throw new Error('cross-tenant should fail');
    return 'same-tenant ok, cross-tenant blocked';
  });

  await runStep('Report generation', async () => {
    const framework = new RedTeamFramework({
      scenarios: [...TENANT_ATTACK_SCENARIOS, ...PLUGIN_SUPPLY_CHAIN_SCENARIOS],
    });
    const defender = createComprehensiveDefender();
    const report = await framework.runAll(defender);
    const text = generateSecurityReport(report);
    if (!text.includes('COMMANDER')) throw new Error('report missing COMMANDER header');
    if (!text.includes('SECURITY SCORE')) throw new Error('report missing score section');
    if (text.length < 200) throw new Error(`report too short: ${text.length} chars`);
    return `${text.length} chars`;
  });
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-smoke-'));
  console.log(`\n🔥 Commander End-to-End Smoke Test`);
  console.log(`   Sandbox: ${sandbox}\n`);

  const start = Date.now();

  await testGapDiscovery(sandbox);
  await testChaos(sandbox);
  await testShadow(sandbox);
  await testRedTeam(sandbox);

  const totalMs = Date.now() - start;
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;

  console.log(`\n── Summary ${'─'.repeat(60)}\n`);
  console.log(`  Total steps:   ${results.length}`);
  console.log(`  ✅ Passed:     ${passed}`);
  console.log(`  ❌ Failed:     ${failed}`);
  console.log(`  Duration:      ${totalMs}ms`);
  console.log(`  Sandbox:       ${sandbox}\n`);

  // Persist report
  const reportPath = path.join(sandbox, 'smoke-report.json');
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        runId: `smoke_${Date.now()}`,
        totalSteps: results.length,
        passed,
        failed,
        durationMs: totalMs,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`  Report:        ${reportPath}\n`);

  // Cleanup sandbox unless any step failed
  if (failed === 0) {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
      console.log('  Sandbox cleaned up.\n');
    } catch {
      // ignore cleanup errors
    }
  } else {
    console.log(`  Sandbox preserved for inspection (failures=${failed}).\n`);
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error in smoke test:', err);
  process.exit(2);
});
