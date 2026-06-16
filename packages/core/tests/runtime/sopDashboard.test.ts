/**
 * Tests for SOP Dashboard module.
 *
 * Covers:
 * - listSOPs() with empty directory
 * - listSOPs() with sample SOP files
 * - getSOP() with existing and missing SOPs
 * - getSOPMarkdown() with existing and missing SOPs
 * - getSOPDashboardData() aggregate
 * - renderSOPDashboardHtml() output structure
 * - Path traversal protection
 */

import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Helpers
// ============================================================================

const TEST_DIR = path.join(process.cwd(), '.commander_test_sops');

function cleanTestDir(): void {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch { /* ok */ }
}

function createSampleSOP(agentId: string, runId: string, overrides?: Record<string, unknown>): void {
  const agentDir = path.join(TEST_DIR, agentId);
  fs.mkdirSync(agentDir, { recursive: true });

  const sop = {
    schemaVersion: 1,
    goal: (overrides?.goal as string) || `Test goal for ${runId}`,
    executedAt: new Date().toISOString(),
    sourceRunId: runId,
    totalSteps: (overrides?.stepCount as number) ?? 5,
    totalTokens: 1500,
    totalDurationMs: 12000,
    modelUsed: 'gpt-4',
    topology: 'single',
    phases: [
      {
        name: 'Analysis',
        description: 'Analyzed requirements',
        toolsUsed: ['web_search', 'file_read'],
        decisions: [],
        outcome: 'Completed',
      },
    ],
    toolCallChain: [
      {
        stepNumber: 1,
        toolName: 'web_search',
        phase: 'Analysis',
        args: { query: 'test' },
        resultSnippet: 'found results',
        durationMs: 2000,
        hadError: false,
      },
    ],
    files: [{ path: '/tmp/test.md', action: 'read' as const, summary: 'read test file' }],
    summary: 'A test SOP',
    tags: (overrides?.tags as string[]) ?? ['test', runId],
  };

  fs.writeFileSync(path.join(agentDir, `${runId}.json`), JSON.stringify(sop, null, 2), 'utf-8');
  fs.writeFileSync(path.join(agentDir, `${runId}.md`), `# SOP: Test\n\nSummary: ${sop.summary}\n`, 'utf-8');
}

function seedTestData(): void {
  cleanTestDir();
  fs.mkdirSync(TEST_DIR, { recursive: true });
  createSampleSOP('agent-alpha', 'run-001', { tags: ['test', 'alpha'], stepCount: 3 });
  createSampleSOP('agent-alpha', 'run-002', { tags: ['test', 'alpha', 'urgent'], stepCount: 7 });
  createSampleSOP('agent-beta', 'run-003', { tags: ['test', 'beta'], stepCount: 12 });
}

// ============================================================================
// Tests
// ============================================================================

describe('sopDashboard', () => {
  let sopModule: typeof import('../../src/runtime/sopDashboard');

  beforeAll(async () => {
    cleanTestDir();
    sopModule = await import('../../src/runtime/sopDashboard');
  });

  afterAll(() => {
    cleanTestDir();
  });

  describe('listSOPs()', () => {
    beforeAll(() => {
      cleanTestDir();
      fs.mkdirSync(TEST_DIR, { recursive: true });
    });

    it('returns empty array when SOP directory does not exist', () => {
      const result = sopModule.listSOPs('/nonexistent/sops/dir');
      assert.deepStrictEqual(result, []);
    });

    it('returns empty array when SOP directory has no agent subdirectories', () => {
      const result = sopModule.listSOPs(TEST_DIR);
      assert.deepStrictEqual(result, []);
    });

    it('returns SOPs from filesystem', () => {
      createSampleSOP('agent-alpha', 'run-001', { tags: ['test', 'alpha'], stepCount: 3 });
      createSampleSOP('agent-alpha', 'run-002', { tags: ['test', 'alpha', 'urgent'], stepCount: 7 });
      createSampleSOP('agent-beta', 'run-003', { tags: ['test', 'beta'], stepCount: 12 });

      const result = sopModule.listSOPs(TEST_DIR);
      assert.strictEqual(result.length, 3);
      assert.ok(result.some(s => s.agentId === 'agent-alpha'));
      assert.ok(result.some(s => s.agentId === 'agent-beta'));
      assert.ok(result.some(s => s.runId === 'run-001'));
      assert.ok(result.some(s => s.runId === 'run-003'));
    });

    it('returns correct SOPListItem fields', () => {
      const result = sopModule.listSOPs(TEST_DIR);
      const item = result.find(s => s.runId === 'run-001');
      assert.ok(item, 'Should find run-001');
      assert.strictEqual(item!.agentId, 'agent-alpha');
      assert.strictEqual(item!.goal, 'Test goal for run-001');
      assert.strictEqual(item!.status, 'success');
      assert.strictEqual(item!.stepCount, 3);
      assert.deepStrictEqual(item!.tags, ['test', 'alpha']);
      assert.ok(item!.hasMarkdown);
      assert.ok(item!.hasJson);
      assert.ok(typeof item!.generatedAt === 'string');
    });

    it('sorts results by generatedAt descending (most recent first)', () => {
      const result = sopModule.listSOPs(TEST_DIR);
      for (let i = 1; i < result.length; i++) {
        const prev = new Date(result[i - 1].generatedAt).getTime();
        const curr = new Date(result[i].generatedAt).getTime();
        assert.ok(prev >= curr, 'Should be sorted descending by date');
      }
    });

    it('skips corrupt JSON files gracefully', () => {
      const badDir = path.join(TEST_DIR, 'corrupt-agent');
      fs.mkdirSync(badDir, { recursive: true });
      fs.writeFileSync(path.join(badDir, 'bad.json'), 'not valid json', 'utf-8');

      const len = sopModule.listSOPs(TEST_DIR).length;
      // Should still have 3 valid SOPs, corrupt file is skipped
      assert.strictEqual(len, 3);
    });
  });

  describe('getSOP()', () => {
    beforeAll(() => {
      seedTestData();
    });

    it('returns SOPTemplate for existing SOP', () => {
      const sop = sopModule.getSOP('agent-alpha', 'run-001', TEST_DIR);
      assert.ok(sop, 'Should return SOP');
      assert.strictEqual(sop!.goal, 'Test goal for run-001');
      assert.strictEqual(sop!.sourceRunId, 'run-001');
      assert.strictEqual(sop!.totalSteps, 3);
      assert.ok(Array.isArray(sop!.phases));
      assert.ok(Array.isArray(sop!.toolCallChain));
      assert.ok(Array.isArray(sop!.files));
    });

    it('returns null for non-existent SOP', () => {
      const sop = sopModule.getSOP('agent-alpha', 'nonexistent', TEST_DIR);
      assert.strictEqual(sop, null);
    });

    it('returns null for non-existent agent', () => {
      const sop = sopModule.getSOP('nonexistent-agent', 'run-001', TEST_DIR);
      assert.strictEqual(sop, null);
    });

    it('protects against path traversal in agentId', () => {
      const sop = sopModule.getSOP('../evil', 'run-001', TEST_DIR);
      assert.strictEqual(sop, null);
    });

    it('protects against path traversal in runId', () => {
      const sop = sopModule.getSOP('agent-alpha', '../../etc/passwd', TEST_DIR);
      assert.strictEqual(sop, null);
    });
  });

  describe('getSOPMarkdown()', () => {
    beforeAll(() => {
      seedTestData();
    });

    it('returns markdown content for existing SOP', () => {
      const md = sopModule.getSOPMarkdown('agent-alpha', 'run-001', TEST_DIR);
      assert.ok(md, 'Should return markdown');
      assert.ok(md!.includes('# SOP: Test'));
    });

    it('returns null for non-existent SOP', () => {
      const md = sopModule.getSOPMarkdown('agent-alpha', 'nonexistent', TEST_DIR);
      assert.strictEqual(md, null);
    });

    it('returns null for SOP with only JSON file (no .md)', () => {
      const agentDir = path.join(TEST_DIR, 'json-only-agent');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'no-md.json'), JSON.stringify({ goal: 'No MD' }), 'utf-8');

      const md = sopModule.getSOPMarkdown('json-only-agent', 'no-md', TEST_DIR);
      assert.strictEqual(md, null);
    });
  });

  describe('getSOPDashboardData()', () => {
    beforeAll(() => {
      seedTestData();
    });

    it('returns dashboard data with correct aggregate fields', () => {
      const data = sopModule.getSOPDashboardData(TEST_DIR);
      assert.ok(typeof data === 'object');
      assert.ok(Array.isArray(data.agents));
      assert.ok(Array.isArray(data.sops));
      assert.ok(Array.isArray(data.recentEvents));
      assert.strictEqual(typeof data.total, 'number');
      assert.strictEqual(typeof data.timestamp, 'string');
    });

    it('includes all agents and correct total count', () => {
      const data = sopModule.getSOPDashboardData(TEST_DIR);
      assert.strictEqual(data.total, 3, 'Should have 3 SOPs from seed data');
      assert.ok(data.agents.includes('agent-alpha'));
      assert.ok(data.agents.includes('agent-beta'));
    });
  });

  describe('renderSOPDashboardHtml()', () => {
    beforeAll(() => {
      seedTestData();
    });

    it('returns valid HTML string', () => {
      const html = sopModule.renderSOPDashboardHtml(TEST_DIR);
      assert.ok(typeof html === 'string');
      assert.ok(html.length > 100);
    });

    it('contains required HTML elements', () => {
      const html = sopModule.renderSOPDashboardHtml(TEST_DIR);
      assert.ok(html.includes('<!DOCTYPE html>'));
      assert.ok(html.includes('SOP Dashboard'));
      assert.ok(html.includes('chart.js'));
      assert.ok(html.includes('EventSource'));
      assert.ok(html.includes('/stream/sop'));
      assert.ok(html.includes('sop.update'));
    });

    it('contains counter card labels', () => {
      const html = sopModule.renderSOPDashboardHtml(TEST_DIR);
      assert.ok(html.includes('Total SOPs'));
      assert.ok(html.includes('Agents'));
      assert.ok(html.includes('Total Steps'));
      assert.ok(html.includes('Unique Tags'));
    });

    it('contains chart canvases', () => {
      const html = sopModule.renderSOPDashboardHtml(TEST_DIR);
      assert.ok(html.includes('byAgentChart'));
      assert.ok(html.includes('byTagChart'));
      assert.ok(html.includes('byStepChart'));
    });

    it('contains search and sort functionality', () => {
      const html = sopModule.renderSOPDashboardHtml(TEST_DIR);
      assert.ok(html.includes('searchInput'));
      assert.ok(html.includes('filterSOPs'));
      assert.ok(html.includes('sortBy'));
      assert.ok(html.includes('toggleDetail'));
    });

    it('renders SOP data from custom directory into table rows', () => {
      const html = sopModule.renderSOPDashboardHtml(TEST_DIR);
      assert.ok(html.includes('agent-alpha'), 'Should show agent-alpha in table');
      assert.ok(html.includes('agent-beta'), 'Should show agent-beta in table');
      assert.ok(html.includes('run-001'), 'Should show run-001 in table');
      assert.ok(html.includes('run-003'), 'Should show run-003 in table');
    });

    it('escapes HTML in user-controlled content', () => {
      // Create an SOP with XSS payload
      createSampleSOP('xss-agent', 'xss-run', {
        goal: '<script>alert("xss")</script>',
        tags: ['<img src=x onerror=alert(1)>'],
      } as any);

      const html = sopModule.renderSOPDashboardHtml(TEST_DIR);
      // The dangerous content should be HTML-escaped, not raw
      assert.ok(!html.includes('<script>alert'), 'Raw script tags should not appear');
      assert.ok(html.includes('&lt;script&gt;alert'), 'Script tags should be HTML-escaped');
    });
  });

  describe('renderSOPDashboardHtml() — no data', () => {
    beforeAll(() => {
      cleanTestDir();
    });

    it('renders empty state when no SOPs exist', () => {
      const html = sopModule.renderSOPDashboardHtml(TEST_DIR);
      assert.ok(html.includes('No SOPs generated yet'), 'Should show empty state message');
      assert.ok(html.includes('Total SOPs'), 'Should still show counter cards');
    });
  });
});
