import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactToolDef,
  compactToolDefs,
  buildCompactToolListing,
  formatCompactToolCall,
  estimateCompactSavings,
  ProgrammaticToolFormatter,
  minifyToolDef,
  minifyToolDefs,
  restoreToolDefAliases,
  PARAM_NAME_ALIASES,
  type CompactToolConfig,
} from '../../src/runtime/programmaticToolFormatter.js';
import type { Tool, ToolDefinition, ToolCall } from '../../src/runtime/types.js';

// ============================================================================
// Helpers
// ============================================================================

function makeToolDef(
  name: string,
  description: string,
  props: Record<string, unknown>,
  required?: string[],
  examples?: Array<{ name: string; arguments: Record<string, unknown> }>,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: props,
      ...(required ? { required } : {}),
    },
    ...(examples ? { examples } : {}),
  };
}

function makeTool(name: string, def: ToolDefinition): Tool {
  return {
    definition: def,
    async execute() {
      return 'ok';
    },
  } as unknown as Tool;
}

// ============================================================================
// compactToolDef — Schema compaction
// ============================================================================

describe('compactToolDef', () => {
  it('strips descriptions from properties', () => {
    const def = makeToolDef(
      'test_tool',
      'A test tool',
      {
        path: { type: 'string', description: 'The file path to read' },
        pattern: { type: 'string', description: 'Search pattern' },
      },
      ['path'],
    );
    const compact = compactToolDef(def);
    const props = (compact.inputSchema as Record<string, unknown>).properties as Record<
      string,
      unknown
    >;
    assert.strictEqual((props.path as Record<string, unknown>).description, undefined);
    assert.strictEqual((props.pattern as Record<string, unknown>).description, undefined);
  });

  it('preserves required array', () => {
    const def = makeToolDef(
      'test_tool',
      'Test',
      {
        path: { type: 'string', description: 'x' },
      },
      ['path'],
    );
    const compact = compactToolDef(def);
    assert.deepStrictEqual((compact.inputSchema as Record<string, unknown>).required, ['path']);
  });

  it('preserves enum values', () => {
    const def = makeToolDef('test_tool', 'Test', {
      mode: { type: 'string', enum: ['read', 'write'], description: 'Mode' },
    });
    const compact = compactToolDef(def);
    const props = (compact.inputSchema as Record<string, unknown>).properties as Record<
      string,
      unknown
    >;
    assert.deepStrictEqual((props.mode as Record<string, unknown>).enum, ['read', 'write']);
  });

  it('preserves nested object properties', () => {
    const def = makeToolDef('test_tool', 'Test', {
      config: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'Server host' },
          port: { type: 'number', description: 'Port number' },
        },
      },
    });
    const compact = compactToolDef(def);
    const props = (compact.inputSchema as Record<string, unknown>).properties as Record<
      string,
      unknown
    >;
    const config = (props.config as Record<string, unknown>).properties as Record<string, unknown>;
    assert.strictEqual((config.host as Record<string, unknown>).description, undefined);
    assert.strictEqual((config.port as Record<string, unknown>).description, undefined);
  });

  it('preserves default values (functional information)', () => {
    const def = makeToolDef('test_tool', 'Test', {
      path: { type: 'string', default: '.', description: 'Path' },
    });
    const compact = compactToolDef(def);
    const props = (compact.inputSchema as Record<string, unknown>).properties as Record<
      string,
      unknown
    >;
    assert.strictEqual((props.path as Record<string, unknown>).default, '.');
    // descriptions are still stripped
    assert.strictEqual((props.path as Record<string, unknown>).description, undefined);
  });

  it('strips examples when configured', () => {
    const def = makeToolDef(
      'test_tool',
      'Test',
      {
        path: { type: 'string' },
      },
      ['path'],
      [{ name: 'test_tool', arguments: { path: '/foo' } }],
    );
    const compact = compactToolDef(def, {
      ...new ProgrammaticToolFormatter().getConfig(),
      stripExamples: true,
    });
    assert.strictEqual(compact.examples, undefined);
  });

  it('keeps examples when stripExamples is false', () => {
    const def = makeToolDef(
      'test_tool',
      'Test',
      {
        path: { type: 'string' },
      },
      ['path'],
      [{ name: 'test_tool', arguments: { path: '/foo' } }],
    );
    const compact = compactToolDef(def, {
      ...new ProgrammaticToolFormatter().getConfig(),
      stripExamples: false,
    });
    assert.strictEqual(compact.examples?.length, 1);
  });

  it('preserves array items', () => {
    const def = makeToolDef('test_tool', 'Test', {
      files: {
        type: 'array',
        items: { type: 'string', description: 'File path' },
        description: 'List of files',
      },
    });
    const compact = compactToolDef(def);
    const props = (compact.inputSchema as Record<string, unknown>).properties as Record<
      string,
      unknown
    >;
    const items = (props.files as Record<string, unknown>).items as Record<string, unknown>;
    assert.strictEqual(items.description, undefined);
    assert.strictEqual(items.type, 'string');
  });

  it('keeps full schema for tools in keepFullSchema', () => {
    const def = makeToolDef('git', 'Version control', {
      command: { type: 'string', description: 'Git command' },
    });
    const config: CompactToolConfig = {
      ...new ProgrammaticToolFormatter().getConfig(),
      keepFullSchema: ['git'],
    };
    const compact = compactToolDef(def, config);
    const props = (compact.inputSchema as Record<string, unknown>).properties as Record<
      string,
      unknown
    >;
    assert.ok((props.command as Record<string, unknown>).description);
  });

  it('returns original when disabled', () => {
    const def = makeToolDef('test_tool', 'Test', {
      path: { type: 'string', description: 'Path' },
    });
    const config: CompactToolConfig = {
      ...new ProgrammaticToolFormatter().getConfig(),
      enabled: false,
    };
    const compact = compactToolDef(def, config);
    const props = (compact.inputSchema as Record<string, unknown>).properties as Record<
      string,
      unknown
    >;
    assert.ok((props.path as Record<string, unknown>).description);
  });
});

// ============================================================================
// compactToolDefs — batch compaction
// ============================================================================

describe('compactToolDefs', () => {
  it('compacts all tools in the array', () => {
    const defs = [
      makeToolDef('t1', 'Test 1', { path: { type: 'string', description: 'Path' } }),
      makeToolDef('t2', 'Test 2', { name: { type: 'string', description: 'Name' } }),
    ];
    const compacted = compactToolDefs(defs);
    assert.strictEqual(compacted.length, 2);
    for (const c of compacted) {
      const props = (c.inputSchema as Record<string, unknown>).properties as Record<
        string,
        unknown
      >;
      for (const [, v] of Object.entries(props)) {
        assert.strictEqual((v as Record<string, unknown>).description, undefined);
      }
    }
  });
});

// ============================================================================
// buildCompactToolListing
// ============================================================================

describe('buildCompactToolListing', () => {
  it('produces compact parameter-style listing', () => {
    const tools = new Map<string, Tool>();
    tools.set(
      'file_read',
      makeTool(
        'file_read',
        makeToolDef(
          'file_read',
          'Read file contents',
          {
            path: { type: 'string', description: 'File path' },
          },
          ['path'],
        ),
      ),
    );
    tools.set(
      'shell_execute',
      makeTool(
        'shell_execute',
        makeToolDef('shell_execute', 'Run shell command', {
          cmd: { type: 'string', description: 'Command' },
          cwd: { type: 'string', description: 'Working dir' },
        }),
      ),
    );

    const listing = buildCompactToolListing(tools);
    assert.ok(
      listing.includes('file_read(path: string)'),
      `Expected 'file_read(path: string)' in:\n${listing}`,
    );
    assert.ok(listing.includes('shell_execute'), `Expected shell_execute in:\n${listing}`);
    assert.ok(listing.includes('cwd?: string'), `Expected cwd? in:\n${listing}`);
  });

  it('handles enum parameters', () => {
    const tools = new Map<string, Tool>();
    tools.set(
      'verify',
      makeTool(
        'verify',
        makeToolDef(
          'verify',
          'Verify code',
          {
            checks: {
              type: 'array',
              items: { type: 'string', enum: ['lint', 'typecheck', 'test', 'build'] },
            },
          },
          ['checks'],
        ),
      ),
    );

    const listing = buildCompactToolListing(tools);
    assert.ok(listing.includes('enum[lint|typecheck|test|build]'), `Expected enum in:\n${listing}`);
  });

  it('handles enum property as union type', () => {
    const tools = new Map<string, Tool>();
    tools.set(
      'mode',
      makeTool(
        'mode',
        makeToolDef('mode', 'Set mode', {
          value: { type: 'string', enum: ['auto', 'manual'] },
        }),
      ),
    );

    const listing = buildCompactToolListing(tools);
    assert.ok(listing.includes('auto'), `Expected enum values in:\n${listing}`);
  });

  it('handles tools with no parameters', () => {
    const tools = new Map<string, Tool>();
    tools.set('ping', makeTool('ping', makeToolDef('ping', 'Ping server', {})));
    const listing = buildCompactToolListing(tools);
    assert.ok(
      listing.includes('ping()') || listing.includes('ping —'),
      `Expected ping listing in:\n${listing}`,
    );
  });

  it('falls back to name:description format when compactListing is false', () => {
    const tools = new Map<string, Tool>();
    tools.set(
      'file_read',
      makeTool(
        'file_read',
        makeToolDef('file_read', 'Read file contents', {
          path: { type: 'string' },
        }),
      ),
    );
    const config: CompactToolConfig = {
      ...new ProgrammaticToolFormatter().getConfig(),
      compactListing: false,
    };
    const listing = buildCompactToolListing(tools, config);
    assert.ok(
      listing.includes('- file_read: Read file contents'),
      `Expected old format, got:\n${listing}`,
    );
  });
});

// ============================================================================
// formatCompactToolCall
// ============================================================================

describe('formatCompactToolCall', () => {
  it('produces compact code-like format', () => {
    const call: ToolCall = { id: 'call_1', name: 'file_read', arguments: { path: '/foo/bar.ts' } };
    const output = 'export function foo() { return 42; }';
    const formatted = formatCompactToolCall(call, output);
    assert.ok(formatted.startsWith('[file_read'), `Expected [file_read prefix, got: ${formatted}`);
    assert.ok(formatted.includes('/foo/bar.ts'), `Expected path in: ${formatted}`);
    assert.ok(formatted.includes('export function'), `Expected output in: ${formatted}`);
  });

  it('truncates long outputs', () => {
    const call: ToolCall = { id: 'call_1', name: 'file_read', arguments: { path: '/foo' } };
    const output = 'x'.repeat(1000);
    const config: CompactToolConfig = {
      ...new ProgrammaticToolFormatter().getConfig(),
      maxToolCallChars: 100,
    };
    const formatted = formatCompactToolCall(call, output, config);
    assert.ok(formatted.includes('…[truncated]'), `Expected truncation marker, got: ${formatted}`);
    assert.ok(formatted.length <= 300, `Expected <=300 chars, got ${formatted.length}`);
  });

  it('truncates long argument values', () => {
    const call: ToolCall = {
      id: 'call_1',
      name: 'file_write',
      arguments: { path: '/foo', content: 'x'.repeat(200) },
    };
    const formatted = formatCompactToolCall(call, 'ok');
    assert.ok(formatted.includes('…'), `Expected truncation in args, got: ${formatted}`);
  });

  it('falls back to verbose format when compactToolCalls is false', () => {
    const call: ToolCall = { id: 'call_1', name: 'file_read', arguments: { path: '/foo' } };
    const config: CompactToolConfig = {
      ...new ProgrammaticToolFormatter().getConfig(),
      compactToolCalls: false,
    };
    const formatted = formatCompactToolCall(call, 'output', config);
    assert.ok(formatted.includes('Tool: file_read'), `Expected verbose format, got: ${formatted}`);
    assert.ok(formatted.includes('Args:'), `Expected Args: in: ${formatted}`);
  });
});

// ============================================================================
// estimateCompactSavings
// ============================================================================

describe('estimateCompactSavings', () => {
  it('estimates positive savings for tools with descriptions', () => {
    const tools: ToolDefinition[] = [
      makeToolDef(
        'file_read',
        'Read file',
        {
          path: { type: 'string', description: 'The absolute path to the file to read' },
          encoding: { type: 'string', description: 'File encoding (utf-8, latin-1, etc.)' },
        },
        ['path'],
      ),
      makeToolDef(
        'file_write',
        'Write file',
        {
          path: { type: 'string', description: 'Where to write the file' },
          content: { type: 'string', description: 'The full content to write to the file' },
        },
        ['path', 'content'],
      ),
    ];

    const savings = estimateCompactSavings(tools);
    assert.ok(
      savings.schemaSavings > 0,
      `Expected positive schemaSavings, got ${savings.schemaSavings}`,
    );
    assert.ok(savings.estimatedTotalTokens > 0);
  });

  it('returns zero savings for tools without descriptions', () => {
    const tools: ToolDefinition[] = [
      makeToolDef('minimal', 'Minimal', {
        path: { type: 'string' },
      }),
    ];

    const savings = estimateCompactSavings(tools);
    assert.ok(savings.schemaSavings >= 0);
  });
});

// ============================================================================
// Schema minification — reversible parameter-name aliases
// ============================================================================

describe('minifyToolDef', () => {
  it('shortens aliased parameter names', () => {
    const def = makeToolDef(
      'shell_tool',
      'Run shell command',
      {
        command: { type: 'string', description: 'Shell command' },
        pattern: { type: 'string', description: 'Pattern' },
      },
      ['command'],
    );

    const minified = minifyToolDef(def);
    const props = (minified.inputSchema as Record<string, unknown>).properties as Record<
      string,
      unknown
    >;
    assert.ok('cmd' in props);
    assert.ok('pat' in props);
    assert.ok(!('command' in props));
    assert.ok(!('pattern' in props));
  });

  it('updates required array to match aliased names', () => {
    const def = makeToolDef(
      'shell_tool',
      'Run shell command',
      {
        command: { type: 'string', description: 'Shell command' },
      },
      ['command'],
    );

    const minified = minifyToolDef(def);
    assert.deepStrictEqual((minified.inputSchema as Record<string, unknown>).required, ['cmd']);
  });

  it('preserves non-aliased parameter names', () => {
    const def = makeToolDef(
      'test_tool',
      'Test',
      {
        path: { type: 'string', description: 'Path' },
      },
      ['path'],
    );

    const minified = minifyToolDef(def);
    const props = (minified.inputSchema as Record<string, unknown>).properties as Record<
      string,
      unknown
    >;
    assert.ok('path' in props);
  });

  it('restores original parameter names', () => {
    const def = makeToolDef(
      'shell_tool',
      'Run shell command',
      {
        command: { type: 'string', description: 'Shell command' },
        pattern: { type: 'string', description: 'Pattern' },
      },
      ['command'],
    );

    const minified = minifyToolDef(def);
    const restored = restoreToolDefAliases(minified);
    const props = (restored.inputSchema as Record<string, unknown>).properties as Record<
      string,
      unknown
    >;
    assert.ok('command' in props);
    assert.ok('pattern' in props);
    assert.deepStrictEqual((restored.inputSchema as Record<string, unknown>).required, ['command']);
  });

  it('minifies an array of tool definitions', () => {
    const defs = [
      makeToolDef('t1', 'T1', { command: { type: 'string', description: 'x' } }, ['command']),
      makeToolDef('t2', 'T2', { pattern: { type: 'string', description: 'y' } }, ['pattern']),
    ];
    const minified = minifyToolDefs(defs);
    assert.strictEqual(minified.length, 2);
    const p1 = (minified[0].inputSchema as Record<string, unknown>).properties as Record<
      string,
      unknown
    >;
    const p2 = (minified[1].inputSchema as Record<string, unknown>).properties as Record<
      string,
      unknown
    >;
    assert.ok('cmd' in p1);
    assert.ok('pat' in p2);
  });

  it('exposes known aliases', () => {
    assert.strictEqual(PARAM_NAME_ALIASES.command, 'cmd');
    assert.strictEqual(PARAM_NAME_ALIASES.description, 'desc');
    assert.strictEqual(PARAM_NAME_ALIASES.pattern, 'pat');
  });
});

describe('ProgrammaticToolFormatter', () => {
  it('exposes all methods', () => {
    const fmt = new ProgrammaticToolFormatter();
    const defs = [makeToolDef('t1', 'Test', { path: { type: 'string', description: 'x' } })];

    const compacted = fmt.compactDefs(defs);
    assert.strictEqual(compacted.length, 1);

    const tools = new Map<string, Tool>();
    tools.set('t1', makeTool('t1', defs[0]));
    const listing = fmt.buildListing(tools);
    assert.ok(listing.includes('t1(path?: string)') || listing.includes('t1(path: string)'));

    const call: ToolCall = { id: 'c1', name: 't1', arguments: { path: '/x' } };
    const formatted = fmt.formatCall(call, 'ok');
    assert.ok(formatted.includes('[t1'));

    const savings = fmt.estimateSavings(defs);
    assert.ok('schemaSavings' in savings);
  });
});
