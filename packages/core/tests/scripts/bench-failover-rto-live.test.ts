import { describe, it, expect } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../../../../scripts/bench-failover-rto-live.ts';
import { validateBaseline, type BaselineDocument } from '../../src/benchmarks/baselineSchema';
import { getCurrentBaseline } from '../../../../scripts/check-readiness.ts';

const TEMP_BASELINE = path.join(os.tmpdir(), 'failover-rto-live.test.json');

describe('bench-failover-rto-live baseline output', () => {
  it('writes a valid passing simulated baseline in local mode', async () => {
    const { report, baselinePath, passed } = await run([
      '--mode=local',
      `--output=${TEMP_BASELINE}`,
    ]);

    expect(passed).toBe(true);
    expect(report.summary.passed).toBe(true);
    expect(baselinePath).toBe(TEMP_BASELINE);

    const raw = readFileSync(baselinePath, 'utf-8');
    const doc = JSON.parse(raw) as BaselineDocument;

    expect(doc.schemaVersion).toBe(2);
    expect(doc.env?.evidence).toBe('simulated');
    expect(doc.evidenceLevel).toBe('simulated');
    expect(doc.summary).toMatchObject({
      passed: true,
      errors: 0,
      failed: 0,
      skipped: 0,
    });

    const measurement = (doc.measurements as Array<Record<string, unknown>>)?.[0];
    expect(measurement).toBeDefined();
    expect(measurement?.name).toBe('failover_rto_simulated');
    expect(typeof measurement?.actualMs).toBe('number');
    expect(Number.isFinite(measurement?.actualMs)).toBe(true);
    expect(measurement?.passed).toBe(true);

    const current = getCurrentBaseline();
    const validation = validateBaseline(doc, current);
    expect(validation.ok).toBe(true);
    expect(validation.reasons).toEqual([]);

    rmSync(baselinePath, { force: true });
  });

  it('reports failure clearly in docker mode when docker is unavailable', async () => {
    const { report, baselinePath, passed } = await run([
      '--mode=docker',
      `--output=${TEMP_BASELINE}`,
    ]);

    expect(passed).toBe(false);
    expect(report.summary.passed).toBe(false);

    const raw = readFileSync(baselinePath, 'utf-8');
    const doc = JSON.parse(raw) as BaselineDocument;

    expect(doc.env?.evidence).toBe('live');
    expect(doc.evidenceLevel).toBe('live');

    const measurement = (doc.measurements as Array<Record<string, unknown>>)?.[0];
    expect(measurement?.name).toBe('failover_rto_live');
    expect(measurement?.passed).toBe(false);
    expect(String(measurement?.reason)).toContain('docker');

    rmSync(baselinePath, { force: true });
  });
});
