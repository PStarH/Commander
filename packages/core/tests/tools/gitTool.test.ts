/**
 * Unit tests for GitTool.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { GitTool } from '../../src/tools/gitTool';

describe('GitTool', () => {
  let tool: GitTool;

  beforeEach(() => {
    tool = new GitTool();
  });

  it('has correct definition', () => {
    assert.strictEqual(tool.definition.name, 'git');
    assert.ok(tool.definition.description);
  });

  it('has required parameters', () => {
    const schema = tool.definition.inputSchema;
    assert.ok(schema.properties.command);
    assert.ok(schema.required.includes('command'));
  });

  it('returns error for missing command', async () => {
    const result = await tool.execute({});
    assert.ok(result.includes('Error'));
  });

  it('shows git status', async () => {
    const result = await tool.execute({ command: 'status' });
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('shows git log', async () => {
    const result = await tool.execute({ command: 'log --oneline -5' });
    assert.ok(typeof result === 'string');
  });

  it('shows git branch', async () => {
    const result = await tool.execute({ command: 'branch' });
    assert.ok(typeof result === 'string');
  });
});
