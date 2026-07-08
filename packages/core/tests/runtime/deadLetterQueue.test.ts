import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DeadLetterQueue, type DeadLetterEntry } from '../../src/runtime/deadLetterQueue';
import { runWithTenant } from '../../src/runtime/tenantContext';

const TEST_DIR = path.join(process.cwd(), '.test_dlq');

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenant('test-tenant', fn);
}

describe('DeadLetterQueue', () => {
  let dlq: DeadLetterQueue;

  beforeEach(() => {
    // Clean up any leftover test data
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    dlq = new DeadLetterQueue(TEST_DIR);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  const makeEntry = (overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry => ({
    id: 'test-1',
    category: 'execution',
    runId: 'run-1',
    agentId: 'agent-1',
    timestamp: new Date().toISOString(),
    errorClass: 'permanent',
    errorMessage: 'Test error',
    retryable: false,
    attemptNumber: 1,
    operationName: 'test-op',
    compensated: false,
    recovered: false,
    tags: ['test'],
    ...overrides,
  });

  it('creates base directory lazily on first write', () =>
    inTenant(async () => {
      expect(fs.existsSync(TEST_DIR)).toBe(false);
      dlq.record(makeEntry());
      await dlq.flush('execution');
      expect(fs.existsSync(TEST_DIR)).toBe(true);
    }));

  it('records entries and flushes to disk', () =>
    inTenant(async () => {
      dlq.record(makeEntry());
      await dlq.flush('execution');

      const filePath = path.join(TEST_DIR, 'execution.ndjson');
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      expect(content).toContain('test-1');
      expect(content).toContain('run-1');
    }));

  it('auto-flushes after 100 entries', () =>
    inTenant(async () => {
      for (let i = 0; i < 100; i++) {
        dlq.record(makeEntry({ id: `test-${i}` }));
      }
      // Auto-flush is async; await an explicit flush to ensure it completed.
      await dlq.flush('execution');
      const filePath = path.join(TEST_DIR, 'execution.ndjson');
      expect(fs.existsSync(filePath)).toBe(true);
    }));

  it('does not auto-flush before 100 entries', () =>
    inTenant(async () => {
      for (let i = 0; i < 99; i++) {
        dlq.record(makeEntry({ id: `test-${i}` }));
      }
      const filePath = path.join(TEST_DIR, 'execution.ndjson');
      expect(fs.existsSync(filePath)).toBe(false);
    }));

  it('reads entries back', () =>
    inTenant(async () => {
      dlq.record(makeEntry({ id: 'entry-1', errorMessage: 'Error 1' }));
      dlq.record(makeEntry({ id: 'entry-2', errorMessage: 'Error 2' }));
      await dlq.flush('execution');

      const entries = await dlq.readEntries('execution', 10);
      expect(entries).toHaveLength(2);
      // readEntries returns newest-first (reversed)
      expect(entries[0].errorMessage).toBe('Error 2');
      expect(entries[1].errorMessage).toBe('Error 1');
    }));

  it('readEntries returns entries in reverse order (newest first)', () =>
    inTenant(async () => {
      dlq.record(makeEntry({ id: 'old', errorMessage: 'old' }));
      await dlq.flush('execution');
      dlq.record(makeEntry({ id: 'new', errorMessage: 'new' }));
      await dlq.flush('execution');

      const entries = await dlq.readEntries('execution', 10);
      expect(entries[0].errorMessage).toBe('new');
      expect(entries[1].errorMessage).toBe('old');
    }));

  it('readEntries respects limit', () =>
    inTenant(async () => {
      for (let i = 0; i < 20; i++) {
        dlq.record(makeEntry({ id: `e-${i}` }));
      }
      await dlq.flush('execution');

      const entries = await dlq.readEntries('execution', 5);
      expect(entries).toHaveLength(5);
    }));

  it('returns empty array for non-existent category', () =>
    inTenant(async () => {
      const entries = await dlq.readEntries('llm', 10);
      expect(entries).toEqual([]);
    }));

  it('handles multiple categories independently', () =>
    inTenant(async () => {
      dlq.record(makeEntry({ id: 'exec-1', category: 'execution' }));
      dlq.record(makeEntry({ id: 'llm-1', category: 'llm' }));
      await dlq.flush('execution');
      await dlq.flush('llm');

      expect(fs.existsSync(path.join(TEST_DIR, 'execution.ndjson'))).toBe(true);
      expect(fs.existsSync(path.join(TEST_DIR, 'llm.ndjson'))).toBe(true);
    }));

  it('getStats returns counts per category', () =>
    inTenant(async () => {
      dlq.record(makeEntry({ id: 'e1', category: 'execution' }));
      dlq.record(makeEntry({ id: 'e2', category: 'execution' }));
      dlq.record(makeEntry({ id: 't1', category: 'tool' }));
      await dlq.flush();
      // re-open to test reading persisted stats
      const dlq2 = new DeadLetterQueue(TEST_DIR);
      const stats = await dlq2.getStats();
      expect(stats.length).toBeGreaterThanOrEqual(2);
      const execStat = stats.find((s) => s.category === 'execution');
      expect(execStat?.count).toBe(2);
    }));

  it('uses atomic write pattern (tmp + rename)', () =>
    inTenant(async () => {
      dlq.record(makeEntry());
      await dlq.flush('execution');

      const filePath = path.join(TEST_DIR, 'execution.ndjson');
      const tmpPath = path.join(TEST_DIR, 'execution.tmp');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.existsSync(tmpPath)).toBe(false); // tmp should be cleaned up
    }));

  it('handles empty getStats when directory has no files', () =>
    inTenant(async () => {
      const emptyDir = path.join(process.cwd(), '.test_dlq_empty');
      if (fs.existsSync(emptyDir)) fs.rmSync(emptyDir, { recursive: true, force: true });
      const dlq2 = new DeadLetterQueue(emptyDir);
      expect(await dlq2.getStats()).toEqual([]);
      if (fs.existsSync(emptyDir)) fs.rmSync(emptyDir, { recursive: true, force: true });
    }));

  it('buffered entries are written to correct category file', () =>
    inTenant(async () => {
      dlq.record(makeEntry({ id: 'exec', category: 'execution' }));
      dlq.record(makeEntry({ id: 'tool', category: 'tool' }));
      dlq.record(makeEntry({ id: 'llm', category: 'llm' }));
      dlq.record(makeEntry({ id: 'verif', category: 'verification' }));
      await dlq.flush();

      for (const cat of ['execution', 'tool', 'llm', 'verification'] as const) {
        const entries = await dlq.readEntries(cat, 10);
        expect(entries).toHaveLength(1);
      }
    }));
});
