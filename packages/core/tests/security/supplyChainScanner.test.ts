import assert from 'node:assert/strict';
import test from 'node:test';
import { SupplyChainScanner } from '../../src/security/supplyChainScanner.js';

test('source scans can skip syntax heuristics without disabling malware detection', () => {
  const scanner = new SupplyChainScanner({ auditAllScans: false });
  const source = "child.exec('echo ready')";

  const skillScan = scanner.scan({ name: 'skill.md', content: source, tools: [] });
  assert.equal(skillScan.passed, false);
  assert.ok(skillScan.warnings.some((warning) => warning.category === 'pre_scan.shell_injection'));

  const sourceScan = scanner.scan({
    name: 'apps/api/src/worker.ts',
    content: source,
    tools: [],
    skipPreScanHeuristics: true,
  });
  assert.equal(sourceScan.passed, true);
  assert.ok(!sourceScan.warnings.some((warning) => warning.category.startsWith('pre_scan.')));

  const destructiveContent = ['rm', '-rf', '/', ''].join(' ');
  const maliciousSourceScan = scanner.scan({
    name: 'apps/api/src/worker.ts',
    content: destructiveContent,
    tools: [],
    skipPreScanHeuristics: true,
  });
  assert.equal(maliciousSourceScan.passed, false);
  assert.ok(
    maliciousSourceScan.warnings.some((warning) => warning.category === 'malware.Data destruction'),
  );
});
