/**
 * Unit tests for Code Execution tools (python_execute, shell_execute).
 *
 * Note: Actual execution tests are limited due to sandboxing.
 * These tests verify tool definitions and error handling.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { PythonExecuteTool, ShellExecuteTool } from '../../src/tools/codeExecutionTool';

describe('PythonExecuteTool', () => {
  let tool: PythonExecuteTool;

  beforeEach(() => {
    tool = new PythonExecuteTool();
  });

  it('has correct definition', () => {
    assert.strictEqual(tool.definition.name, 'python_execute');
    assert.strictEqual(tool.definition.category, 'code');
    assert.ok(tool.definition.description);
    assert.ok(tool.definition.inputSchema);
  });

  it('has required code parameter', () => {
    const schema = tool.definition.inputSchema;
    assert.ok(schema.properties.code);
    assert.ok(schema.required.includes('code'));
  });

  it('has optional timeout parameter', () => {
    const schema = tool.definition.inputSchema;
    assert.ok(schema.properties.timeout);
  });

  it('returns error for missing code', async () => {
    const result = await tool.execute({});
    assert.ok(result.includes('Error'));
  });

  it('returns string result for any code', async () => {
    const result = await tool.execute({ code: 'print("test")' });
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });
});

describe('ShellExecuteTool', () => {
  let tool: ShellExecuteTool;

  beforeEach(() => {
    tool = new ShellExecuteTool();
  });

  it('has correct definition', () => {
    assert.strictEqual(tool.definition.name, 'shell_execute');
    assert.strictEqual(tool.definition.category, 'code');
    assert.ok(tool.definition.description);
  });

  it('has required command parameter', () => {
    const schema = tool.definition.inputSchema;
    assert.ok(schema.properties.command);
    assert.ok(schema.required.includes('command'));
  });

  it('has optional timeout parameter', () => {
    const schema = tool.definition.inputSchema;
    assert.ok(schema.properties.timeout);
  });

  it('returns error for missing command', async () => {
    const result = await tool.execute({});
    assert.ok(result.includes('Error'));
  });

  it('returns string result for any command', async () => {
    const result = await tool.execute({ command: 'echo test' });
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('includes exit code in result', async () => {
    const result = await tool.execute({ command: 'echo test' });
    assert.ok(result.includes('Exit'));
  });
});
