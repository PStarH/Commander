import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapMemoryPersistence } from '../../src/memory/utils';
import { getUnifiedMemory, resetUnifiedMemory } from '../../src/memory/unifiedMemory';
import {
  resetGlobalThreeLayerMemory,
  wireGlobalThreeLayerMemory,
} from '../../src/threeLayerMemory';

describe('sub-agent narrow context memory recall', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'commander-subagent-mem-'));
    resetGlobalThreeLayerMemory();
    resetUnifiedMemory();
    wireGlobalThreeLayerMemory(null);
  });

  afterEach(() => {
    resetGlobalThreeLayerMemory();
    resetUnifiedMemory();
    wireGlobalThreeLayerMemory(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('recall returns context for sub-agent injection', async () => {
    await bootstrapMemoryPersistence('json', { basePath: tempDir });
    await getUnifiedMemory().remember({
      projectId: 'proj-1',
      content: 'Prior decision: use SQLite for persistence',
      kind: 'DECISION',
      title: 'storage choice',
      importance: 0.9,
    });

    const recall = await getUnifiedMemory().recall({
      projectId: 'proj-1',
      query: 'persistence storage',
      limit: 3,
    });
    expect(recall.totalCount).toBeGreaterThan(0);
    expect(recall.contextString.length).toBeGreaterThan(0);
  });
});
