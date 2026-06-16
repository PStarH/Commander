/**
 * Unit tests for ToolRegistry and createAllTools.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ToolRegistry, TOOL_CATEGORIES, createAllTools } from '../../src/tools/index';

describe('ToolRegistry', () => {
  it('is exported', () => {
    assert.ok(ToolRegistry);
    assert.strictEqual(typeof ToolRegistry, 'function');
  });

  it('can be instantiated', () => {
    const registry = ToolRegistry.getInstance();
    assert.ok(registry);
  });
});

describe('TOOL_CATEGORIES', () => {
  it('is exported', () => {
    assert.ok(TOOL_CATEGORIES);
    assert.strictEqual(typeof TOOL_CATEGORIES, 'object');
  });

  it('defines expected categories', () => {
    const categories = Object.keys(TOOL_CATEGORIES);
    assert.ok(categories.length > 0);
  });
});

describe('createAllTools', () => {
  it('creates a map of tools', () => {
    const tools = createAllTools();
    assert.ok(tools instanceof Map);
    assert.ok(tools.size > 0);
  });

  it('includes core tools', () => {
    const tools = createAllTools();

    // STRAP consolidation exposes domain-level resource tools rather than
    // granular CRUD names.
    const expectedTools = [
      'web', 'file', 'exec', 'memory', 'git',
      'browser', 'code', 'checkpoint', 'handoff', 'media', 'system',
    ];

    for (const name of expectedTools) {
      assert.ok(tools.has(name), `Missing tool: ${name}`);
    }
  });

  it('each tool has definition and execute', () => {
    const tools = createAllTools();

    for (const [name, tool] of tools) {
      assert.ok(tool.definition, `${name} missing definition`);
      assert.ok(tool.definition.name, `${name} definition missing name`);
      assert.ok(tool.definition.description, `${name} definition missing description`);
      assert.strictEqual(typeof tool.execute, 'function', `${name} execute is not a function`);
    }
  });

  it('includes meta tools when enabled', () => {
    const tools = createAllTools({ enableMetaTools: true });
    assert.ok(tools.size > createAllTools().size);
  });
});
