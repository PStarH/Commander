// packages/core/tests/shadow/drift.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DriftReporter } from '../../src/shadow/driftReporter';
import type { DriftEntry } from '../../src/shadow/types';
import { isDriftThresholdBreached } from '../../src/shadow/types';

let tmpDir: string;
let driftFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-'));
  driftFile = path.join(tmpDir, 'drift.ndjson');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<DriftEntry> = {}): DriftEntry {
  return {
    timestamp: '2026-06-30T00:00:00Z',
    endpoint: '/api/x',
    prodStatus: 200,
    shadowStatus: 200,
    prodLatencyMs: 100,
    shadowLatencyMs: 110,
    prodCostUsd: 0.001,
    shadowCostUsd: 0.001,
    driftDetected: false,
    metrics: { statusDeltaPct: 0, latencyDeltaPct: 10, costDeltaPct: 0 },
    ...overrides,
  };
}

describe('DriftReporter', () => {
  it('record appends to NDJSON file', () => {
    const reporter = new DriftReporter(driftFile);
    reporter.record(makeEntry());
    reporter.flush();
    const content = fs.readFileSync(driftFile, 'utf-8');
    expect(content).toContain('"endpoint":"/api/x"');
  });

  it('detectAnomalies returns entries where drift > threshold for >= 10 samples', () => {
    const reporter = new DriftReporter(driftFile);
    for (let i = 0; i < 12; i++) {
      reporter.record(
        makeEntry({
          prodStatus: 200,
          shadowStatus: 500,
          driftDetected: true,
          metrics: { statusDeltaPct: 100, latencyDeltaPct: 0, costDeltaPct: 0 },
        }),
      );
    }
    reporter.flush();
    const anomalies = reporter.detectAnomalies(10);
    expect(anomalies.length).toBeGreaterThan(0);
  });

  it('isDriftThresholdBreached returns true when status differs', () => {
    expect(isDriftThresholdBreached({ statusDeltaPct: 100, latencyDeltaPct: 0, costDeltaPct: 0 })).toBe(true);
  });
});
