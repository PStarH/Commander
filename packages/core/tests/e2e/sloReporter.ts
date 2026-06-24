/**
 * SLO Reporter — reusable helper for measuring and reporting
 * task-package-5 service-level objectives.
 *
 * Thresholds:
 *   recovery   < 5s  (run resume / crash recovery)
 *   failover   < 10s (provider fallback chain)
 *   compensation < 30s (compensation handler execution)
 *   dlq        < 60s (dead-letter queue retry)
 */

import * as fs from 'fs';
import * as path from 'path';

export interface SLOMeasurement {
  id: string;
  name: string;
  metric: 'latency_ms';
  thresholdMs: number;
  actualMs: number;
  passed: boolean;
  timestamp: string;
}

export interface SLOResport {
  version: string;
  timestamp: string;
  measurements: SLOMeasurement[];
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
}

export const SLO_THRESHOLDS = {
  recovery: 5000,
  failover: 10000,
  compensation: 30000,
  dlq: 60000,
} as const;

export function measureLatency<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  return fn().then((result) => ({
    result,
    durationMs: performance.now() - start,
  }));
}

export function createSLOResport(measurements: Omit<SLOMeasurement, 'passed'>[]): SLOResport {
  const evaluated = measurements.map((m) => ({
    ...m,
    passed: m.actualMs < m.thresholdMs,
  }));

  const passed = evaluated.filter((m) => m.passed).length;
  const failed = evaluated.filter((m) => !m.passed).length;

  return {
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    measurements: evaluated,
    summary: {
      total: evaluated.length,
      passed,
      failed,
    },
  };
}

export function saveSLOResport(report: SLOResport): string {
  const outputDir = path.join(process.cwd(), '.commander_benchmarks');
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `slo-report-${Date.now()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

export function formatSLOSummary(report: SLOResport): string {
  const lines = [
    '📊 SLO Measurement Report',
    `Timestamp: ${report.timestamp}`,
    `Total: ${report.summary.total} | Passed: ${report.summary.passed} | Failed: ${report.summary.failed}`,
    '',
    '| SLO | Threshold | Actual | Status |',
    '|-----|-----------|--------|--------|',
  ];

  for (const m of report.measurements) {
    const status = m.passed ? '✅ PASS' : '❌ FAIL';
    lines.push(`| ${m.name} | ${m.thresholdMs}ms | ${m.actualMs.toFixed(2)}ms | ${status} |`);
  }

  return lines.join('\n');
}
