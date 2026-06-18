/**
 * Unit tests for Persistence tools (memory_store, memory_recall, memory_list).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { MemoryStoreTool, MemoryRecallTool, MemoryListTool } from '../../src/tools/persistenceTool';

describe('MemoryStoreTool', () => {
  let tool: MemoryStoreTool;

  beforeEach(() => {
    tool = new MemoryStoreTool();
  });

  it('has correct definition', () => {
    assert.strictEqual(tool.definition.name, 'memory_store');
    assert.ok(tool.definition.description);
    assert.ok(tool.definition.inputSchema);
  });

  it('has required parameters', () => {
    const schema = tool.definition.inputSchema;
    assert.ok(schema.properties.key);
    assert.ok(schema.properties.value);
  });

  it('stores a memory', async () => {
    const result = await tool.execute({ key: 'test-key', value: 'test value' });
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('returns error for missing key', async () => {
    const result = await tool.execute({ value: 'test' });
    assert.ok(result.includes('Error'));
  });
});

describe('MemoryRecallTool', () => {
  let tool: MemoryRecallTool;

  beforeEach(() => {
    tool = new MemoryRecallTool();
  });

  it('has correct definition', () => {
    assert.strictEqual(tool.definition.name, 'memory_recall');
    assert.ok(tool.definition.description);
    assert.ok(tool.definition.inputSchema);
  });

  it('has required parameters', () => {
    const schema = tool.definition.inputSchema;
    assert.ok(schema.properties.key);
  });

  it('returns result for any key', async () => {
    const result = await tool.execute({ key: 'test-key' });
    assert.ok(typeof result === 'string');
  });
});

describe('MemoryListTool', () => {
  let tool: MemoryListTool;

  beforeEach(() => {
    tool = new MemoryListTool();
  });

  it('has correct definition', () => {
    assert.strictEqual(tool.definition.name, 'memory_list');
    assert.ok(tool.definition.description);
  });

  it('lists memories', async () => {
    const result = await tool.execute({});
    assert.ok(typeof result === 'string');
  });
});
