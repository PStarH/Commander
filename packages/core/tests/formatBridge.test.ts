import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FormatBridge } from '../src/runtime/formatBridge';
import type { ToolDefinition } from '../src/runtime/types';

const sampleTools: ToolDefinition[] = [
  {
    name: 'web_search',
    description: 'Search the web',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results' },
      },
      required: ['query'],
    },
  },
];

describe('Format Bridge', () => {
  it('OpenAI format has correct structure', () => {
    const tools = FormatBridge.adaptToolsForProvider(sampleTools, 'openai');
    assert.strictEqual(tools.length, 1);
    const t = tools[0] as any;
    assert.strictEqual(t.type, 'function');
    assert.strictEqual(t.function.name, 'web_search');
    assert.strictEqual(t.function.description, 'Search the web');
    assert.strictEqual(t.function.parameters.type, 'object');
    assert.ok(t.function.parameters.properties.query);
  });

  it('Anthropic format has correct structure', () => {
    const tools = FormatBridge.adaptToolsForProvider(sampleTools, 'anthropic');
    assert.strictEqual(tools.length, 1);
    const t = tools[0] as any;
    assert.strictEqual(t.name, 'web_search');
    assert.strictEqual(t.description, 'Search the web');
    assert.ok(t.input_schema);
    assert.strictEqual(t.input_schema.type, 'object');
  });

  it('Google format has function_declarations', () => {
    const tools = FormatBridge.adaptToolsForProvider(sampleTools, 'google');
    assert.strictEqual(tools.length, 1);
    const t = tools[0] as any;
    assert.ok(t.function_declarations);
    assert.strictEqual(t.function_declarations.length, 1);
    const decl = t.function_declarations[0];
    assert.strictEqual(decl.name, 'web_search');
    assert.strictEqual(decl.parameters.type, 'OBJECT');
    assert.ok(decl.parameters.properties.query);
    assert.strictEqual(decl.parameters.properties.query.type, 'STRING');
  });

  it('Google format maps types correctly', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'test_tool',
        description: 'Test',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            count: { type: 'number' },
            active: { type: 'boolean' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['text'],
        },
      },
    ];
    const result = FormatBridge.adaptToolsForProvider(tools, 'google');
    const props = (result[0] as any).function_declarations[0].parameters.properties;
    assert.strictEqual(props.text.type, 'STRING');
    assert.strictEqual(props.count.type, 'NUMBER');
    assert.strictEqual(props.active.type, 'BOOLEAN');
    assert.strictEqual(props.tags.type, 'ARRAY');
    assert.strictEqual(props.tags.items.type, 'STRING');
  });

  it('anyOf flattening works for const unions', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        mode: { anyOf: [{ const: 'fast' }, { const: 'slow' }] },
      },
    };
    const flat = FormatBridge.flattenSchema(schema);
    assert.strictEqual((flat.properties as any).mode.type, 'string');
    assert.deepStrictEqual((flat.properties as any).mode.enum, ['fast', 'slow']);
  });

  it('anyOf flattening passes through complex constructs', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
    };
    const flat = FormatBridge.flattenSchema(schema);
    // Complex anyOf should be left unchanged
    assert.ok((flat.properties as any).value.anyOf);
  });

  it('unknown provider defaults to OpenAI format', () => {
    const tools = FormatBridge.adaptToolsForProvider(sampleTools, 'some_new_provider');
    const t = tools[0] as any;
    assert.strictEqual(t.type, 'function');
    assert.strictEqual(t.function.name, 'web_search');
  });
});
