// packages/core/tests/plugins/gap/registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { GapRegistry } from '../../../src/plugins/builtin/gap/registry';

let tmpDir: string;
let registryFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-reg-'));
  registryFile = path.join(tmpDir, 'gaps.ndjson');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GapRegistry', () => {
  it('record creates entry with auto-generated id', () => {
    const reg = new GapRegistry(registryFile);
    const entry = reg.record({
      source: 'chaos',
      severity: 'high',
      title: 'Test gap',
      description: 'Description',
      detectedAt: new Date().toISOString(),
      status: 'open',
      relatedIssues: [],
    });
    expect(entry.id).toMatch(/^gap-\d{4}-\d{2}-\d{2}-\d{3}-[0-9a-f]{4}$/);
    expect(entry.slaDeadline).toBeDefined();
  });

  it('list returns recorded entries', () => {
    const reg = new GapRegistry(registryFile);
    reg.record({
      source: 'chaos',
      severity: 'high',
      title: 'A',
      description: 'd',
      detectedAt: new Date().toISOString(),
      status: 'open',
      relatedIssues: [],
    });
    reg.record({
      source: 'shadow-drift',
      severity: 'critical',
      title: 'B',
      description: 'd',
      detectedAt: new Date().toISOString(),
      status: 'open',
      relatedIssues: [],
    });
    expect(reg.list()).toHaveLength(2);
  });

  it('list filters by source', () => {
    const reg = new GapRegistry(registryFile);
    reg.record({
      source: 'chaos',
      severity: 'high',
      title: 'A',
      description: 'd',
      detectedAt: new Date().toISOString(),
      status: 'open',
      relatedIssues: [],
    });
    reg.record({
      source: 'shadow-drift',
      severity: 'high',
      title: 'B',
      description: 'd',
      detectedAt: new Date().toISOString(),
      status: 'open',
      relatedIssues: [],
    });
    const result = reg.list({ source: 'chaos' });
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('chaos');
  });

  it('close updates status and sets closedAt', () => {
    const reg = new GapRegistry(registryFile);
    const entry = reg.record({
      source: 'chaos',
      severity: 'high',
      title: 'A',
      description: 'd',
      detectedAt: new Date().toISOString(),
      status: 'open',
      relatedIssues: [],
    });
    reg.close(entry.id, 'fixed by commit X', ['chaos-test-001']);
    const closed = reg.get(entry.id);
    expect(closed?.status).toBe('fixed');
    expect(closed?.closedAt).toBeDefined();
    expect(closed?.regressionCheck?.testIds).toContain('chaos-test-001');
  });

  it('detectOverdueSla returns gaps past deadline and still open', () => {
    const reg = new GapRegistry(registryFile);
    const past = new Date(Date.now() - 10000).toISOString();
    reg.record({
      source: 'chaos',
      severity: 'high',
      title: 'A',
      description: 'd',
      detectedAt: past,
      status: 'open',
      relatedIssues: [],
      slaDeadline: past,
    });
    const overdue = reg.detectOverdueSla();
    expect(overdue).toHaveLength(1);
  });
});
