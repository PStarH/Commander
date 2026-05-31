/**
 * Unit tests for FileSystem tools (file_read, file_write, file_edit, file_search, file_list).
 *
 * Note: These tests use the current working directory as the workspace root.
 * The SAFE_ROOT is set at module load time, so we work within the existing workspace.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { FileReadTool, FileWriteTool, FileEditTool, FileSearchTool, FileListTool } from '../../src/tools/fileSystemTool';

describe('FileReadTool', () => {
  let tool: FileReadTool;

  beforeEach(() => {
    tool = new FileReadTool();
  });

  it('has correct definition', () => {
    assert.strictEqual(tool.definition.name, 'file_read');
    assert.strictEqual(tool.definition.category, 'filesystem');
    assert.ok(tool.definition.description);
    assert.ok(tool.definition.inputSchema);
  });

  it('reads package.json', async () => {
    const result = await tool.execute({ path: 'package.json' });
    assert.ok(result.includes('name') || result.includes('version'));
    assert.ok(result.startsWith('1:'));
  });

  it('returns error for missing path', async () => {
    const result = await tool.execute({});
    assert.ok(result.includes('Error'));
    assert.ok(result.includes('path'));
  });

  it('returns error for nonexistent file', async () => {
    const result = await tool.execute({ path: 'nonexistent-file-xyz.txt' });
    assert.ok(result.includes('Error'));
    assert.ok(result.includes('not found'));
  });

  it('truncates when maxChars is small', async () => {
    const result = await tool.execute({ path: 'package.json', maxChars: 20 });
    assert.ok(result.includes('truncated'));
  });

  it('includes line numbers', async () => {
    const result = await tool.execute({ path: 'package.json' });
    assert.ok(result.match(/^1: /m));
    assert.ok(result.match(/^2: /m));
  });

  it('blocks path traversal', async () => {
    const result = await tool.execute({ path: '../../../etc/passwd' });
    assert.ok(result.includes('Error'));
  });
});

describe('FileWriteTool', () => {
  let tool: FileWriteTool;

  beforeEach(() => {
    tool = new FileWriteTool();
  });

  it('has correct definition', () => {
    assert.strictEqual(tool.definition.name, 'file_write');
    assert.strictEqual(tool.definition.category, 'filesystem');
  });

  it('returns error for missing path', async () => {
    const result = await tool.execute({ content: 'test' });
    assert.ok(result.includes('Error'));
  });

  it('handles missing content', async () => {
    // Tool may write empty string or return error
    const result = await tool.execute({ path: 'test-empty.txt' });
    assert.ok(typeof result === 'string');
  });

  it('blocks path traversal', async () => {
    const result = await tool.execute({ path: '../../../tmp/evil.txt', content: 'evil' });
    assert.ok(result.includes('Error'));
  });
});

describe('FileEditTool', () => {
  let tool: FileEditTool;

  beforeEach(() => {
    tool = new FileEditTool();
  });

  it('has correct definition', () => {
    assert.strictEqual(tool.definition.name, 'file_edit');
    assert.strictEqual(tool.definition.category, 'filesystem');
  });

  it('returns error for missing parameters', async () => {
    const result = await tool.execute({ path: 'test.txt' });
    assert.ok(result.includes('Error'));
  });

  it('returns error for nonexistent file', async () => {
    const result = await tool.execute({
      path: 'nonexistent-xyz.txt',
      oldString: 'old',
      newString: 'new',
    });
    assert.ok(result.includes('Error'));
  });
});

describe('FileSearchTool', () => {
  let tool: FileSearchTool;

  beforeEach(() => {
    tool = new FileSearchTool();
  });

  it('has correct definition', () => {
    assert.strictEqual(tool.definition.name, 'file_search');
    assert.strictEqual(tool.definition.category, 'filesystem');
  });

  it('searches for TypeScript files', async () => {
    const result = await tool.execute({ pattern: 'src/**/*.ts' });
    assert.ok(result.includes('.ts'));
  });

  it('returns error for missing pattern', async () => {
    const result = await tool.execute({});
    assert.ok(result.includes('Error'));
  });
});

describe('FileListTool', () => {
  let tool: FileListTool;

  beforeEach(() => {
    tool = new FileListTool();
  });

  it('has correct definition', () => {
    assert.strictEqual(tool.definition.name, 'file_list');
    assert.strictEqual(tool.definition.category, 'filesystem');
  });

  it('lists root directory', async () => {
    const result = await tool.execute({ path: '.' });
    assert.ok(result.includes('src'));
    assert.ok(result.includes('package.json'));
  });

  it('lists src directory', async () => {
    const result = await tool.execute({ path: 'src' });
    assert.ok(result.includes('tools'));
    assert.ok(result.includes('runtime'));
  });

  it('returns error for nonexistent directory', async () => {
    const result = await tool.execute({ path: 'nonexistent-dir-xyz' });
    assert.ok(result.includes('Error'));
  });
});
