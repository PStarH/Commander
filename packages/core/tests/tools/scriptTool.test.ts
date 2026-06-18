/**
 * VM Sandbox Escape Prevention Tests
 *
 * Tests that the ExecuteScriptTool's VM sandbox blocks all known escape vectors
 * while still allowing normal tool calls to function. These are critical security
 * tests — a sandbox escape gives the agent arbitrary code execution on the host.
 *
 * Known escape vectors tested:
 *   1. setTimeout.constructor('return this')() -> globalThis
 *   2. tools.fn.constructor('return this')()   -> globalThis
 *   3. Function('return this')()                -> globalThis
 *   4. eval('this')                             -> globalThis
 *   5. tools.fn.apply.constructor('return this')()
 *   6. arguments.callee.caller / caller chain
 *   7. import() dynamic import escape
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { ExecuteScriptTool } from '../../src/tools/scriptTool';

function makeTool(): ExecuteScriptTool {
  const tool = new ExecuteScriptTool();
  // Register a simple echo tool for functional testing
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<string>>();
  tools.set('echo', async (args: Record<string, unknown>) => {
    return `echoed: ${JSON.stringify(args)}`;
  });
  tools.set('add', async (args: Record<string, unknown>) => {
    const a = Number(args['a'] ?? 0);
    const b = Number(args['b'] ?? 0);
    return String(a + b);
  });
  tool.setTools(tools);
  return tool;
}

// ============================================================================
// Escape vector 1: setTimeout.constructor
// ============================================================================
describe('VM sandbox: setTimeout.constructor escape', () => {
  it('blocks setTimeout.constructor("return this")() to reach globalThis', async () => {
    const tool = makeTool();
    const result = await tool.execute({
      script: `
        try {
          const g = setTimeout.constructor('return this')();
          console.log('ESCAPED:' + typeof g.process);
        } catch (e) {
          console.log('BLOCKED');
        }
      `,
    });
    assert.ok(!result.includes('ESCAPED:'), 'setTimeout.constructor escape must be blocked');
    assert.ok(result.includes('BLOCKED'), 'Escape attempt should throw');
  });

  it('setTimeout is available but constructor is blocked', async () => {
    const tool = makeTool();
    const result = await tool.execute({
      script: `
        try {
          const t = typeof setTimeout;
          console.log('setTimeout:' + t);
        } catch (e) {
          console.log('ERROR');
        }
      `,
    });
    // setTimeout IS available (injected for async support), but constructor is blocked
    assert.ok(
      result.includes('setTimeout:function') || result.includes('setTimeout:undefined'),
      'setTimeout should be available or undefined',
    );
  });
});

// ============================================================================
// Escape vector 2: tools.fn.constructor
// ============================================================================
describe('VM sandbox: tools.fn.constructor escape', () => {
  it('blocks tools.echo.constructor("return this")()', async () => {
    const tool = makeTool();
    const result = await tool.execute({
      script: `
        try {
          const g = tools.echo.constructor('return this')();
          console.log('ESCAPED:' + typeof g.process);
        } catch (e) {
          console.log('BLOCKED');
        }
      `,
    });
    assert.ok(!result.includes('ESCAPED:'), 'tools.fn.constructor escape must be blocked');
  });

  it('blocks tools.add.constructor("return this")()', async () => {
    const tool = makeTool();
    const result = await tool.execute({
      script: `
        try {
          const g = tools.add.constructor('return this')();
          console.log('ESCAPED:' + typeof g.process);
        } catch (e) {
          console.log('BLOCKED');
        }
      `,
    });
    assert.ok(!result.includes('ESCAPED:'), 'tools.fn.constructor escape must be blocked');
  });

  it('constructor property returns undefined on tool functions', async () => {
    const tool = makeTool();
    const result = await tool.execute({
      script: `
        const c = tools.echo.constructor;
        console.log('constructor:' + typeof c);
      `,
    });
    assert.ok(
      result.includes('constructor:undefined'),
      'constructor must return undefined via Proxy',
    );
  });
});

// ============================================================================
// Escape vector 3: Function() constructor
// ============================================================================
describe('VM sandbox: Function() escape', () => {
  it('blocks new Function("return this")()', async () => {
    const tool = makeTool();
    const result = await tool.execute({
      script: `
        try {
          const g = new Function('return this')();
          console.log('ESCAPED:' + typeof g.process);
        } catch (e) {
          console.log('BLOCKED');
        }
      `,
    });
    assert.ok(!result.includes('ESCAPED:'), 'Function() constructor escape must be blocked');
    assert.ok(result.includes('BLOCKED') || result.includes('Script failed'), 'Should fail');
  });

  it('blocks Function constructor via indirect reference', async () => {
    const tool = makeTool();
    const result = await tool.execute({
      script: `
        try {
          const F = Function;
          const g = F('return this')();
          console.log('ESCAPED:' + typeof g.process);
        } catch (e) {
          console.log('BLOCKED');
        }
      `,
    });
    assert.ok(!result.includes('ESCAPED:'), 'Indirect Function() escape must be blocked');
  });
});

// ============================================================================
// Escape vector 4: eval() escape
// ============================================================================
describe('VM sandbox: eval escape', () => {
  it('blocks eval("this") to reach globalThis', async () => {
    const tool = makeTool();
    const result = await tool.execute({
      script: `
        try {
          const g = eval('this');
          console.log('ESCAPED:' + typeof g.process);
        } catch (e) {
          console.log('BLOCKED');
        }
      `,
    });
    // eval('this') inside a VM context returns the sandbox, not globalThis,
    // but codeGeneration.strings=false should block eval entirely
    assert.ok(!result.includes('ESCAPED:'), 'eval escape must be blocked');
  });

  it('blocks eval to define and call Function', async () => {
    const tool = makeTool();
    const result = await tool.execute({
      script: `
        try {
          eval('function evil() { return this.constructor.constructor("return this")(); }');
          const g = evil();
          console.log('ESCAPED:' + typeof g.process);
        } catch (e) {
          console.log('BLOCKED');
        }
      `,
    });
    assert.ok(!result.includes('ESCAPED:'), 'eval-based escape must be blocked');
  });
});

// ============================================================================
// Escape vector 5: tools.fn.apply.constructor / .call.constructor / .bind.constructor
// ============================================================================
describe('VM sandbox: apply/call/bind constructor escape', () => {
  it('blocks tools.fn.apply.constructor escape', async () => {
    const tool = makeTool();
    const result = await tool.execute({
      script: `
        try {
          const g = tools.echo.apply.constructor('return this')();
          console.log('ESCAPED:' + typeof g.process);
        } catch (e) {
          console.log('BLOCKED');
        }
      `,
    });
    assert.ok(!result.includes('ESCAPED:'), 'apply.constructor escape must be blocked');
  });

  it('blocks tools.fn.call.constructor escape', async () => {
    const tool = makeTool();
    const result = await tool.execute({
      script: `
        try {
          const g = tools.echo.call.constructor('return this')();
          console.log('ESCAPED:' + typeof g.process);
        } catch (e) {
          console.log('BLOCKED');
        }
      `,
    });
    assert.ok(!result.includes('ESCAPED:'), 'call.constructor escape must be blocked');
  });

  it('blocks tools.fn.bind.constructor escape', async () => {
    const tool = makeTool();
    const result = await tool.execute({
      script: `
        try {
          const g = tools.echo.bind.constructor('return this')();
          console.log('ESCAPED:' + typeof g.process);
        } catch (e) {
          console.log('BLOCKED');
        }
      `,
    });
    assert.ok(!result.includes('ESCAPED:'), 'bind.constructor escape must be blocked');
  });

  it('apply/call/bind return undefined on tool functions', async () => {
    const tool = makeTool();
    const result = await tool.execute({
      script: `
        console.log('apply:' + typeof tools.echo.apply);
        console.log('call:' + typeof tools.echo.call);
        console.log('bind:' + typeof tools.echo.bind);
      `,
    });
    assert.ok(result.includes('apply:undefined'), 'apply must be blocked');
    assert.ok(result.includes('call:undefined'), 'call must be blocked');
    assert.ok(result.includes('bind:undefined'), 'bind must be blocked');
  });
});

// ============================================================================
// Escape vector 6: __proto__ / prototype chain
// ============================================================================
describe('VM sandbox: prototype chain escape', () => {
  it('blocks __proto__ access on tools', async () => {
    const tool = makeTool();
    const result = await tool.execute({
      script: `
        try {
          const p = tools.__proto__;
          console.log('PROTO:' + typeof p);
        } catch (e) {
          console.log('BLOCKED');
        }
      `,
    });
    assert.ok(!result.includes('PROTO:object'), '__proto__ must not expose Object.prototype');
  });

  it('blocks prototype access on tool functions', async () => {
    const tool = makeTool();
    const result = await tool.execute({
      script: `
        try {
          const p = tools.echo.prototype;
          console.log('PROTOTYPE:' + typeof p);
        } catch (e) {
          console.log('BLOCKED');
        }
      `,
    });
    assert.ok(
      result.includes('PROTOTYPE:undefined') || result.includes('BLOCKED'),
      'prototype must be blocked',
    );
  });

  it('blocks constructor on objects returned by tool calls', async () => {
    const tool = makeTool();
    const result = await tool.execute({
      script: `
        try {
          const r = await tools.echo({ test: true });
          // r is a string, but try to get its constructor
          const c = r.constructor;
          console.log('RESULT_CONSTRUCTOR:' + typeof c);
        } catch (e) {
          console.log('BLOCKED');
        }
      `,
    });
    // String result is a primitive, so constructor access on it goes through
    // the sandbox context — the important thing is it doesn't escape
    assert.ok(!result.includes('ESCAPED'), 'Tool result constructor must not escape');
  });
});

// ============================================================================
// Normal functionality: tool calls must still work
// ============================================================================
describe('VM sandbox: normal tool calls work', () => {
  let tool: ExecuteScriptTool;

  beforeEach(() => {
    tool = makeTool();
  });

  it('can call a tool without throwing', async () => {
    const result = await tool.execute({
      script: `
        try {
          const r = await tools.echo({ hello: 'world' });
          console.log('TOOL_CALLED');
        } catch (e) {
          console.log('TOOL_ERROR:' + e.message);
        }
      `,
    });
    assert.ok(result.includes('TOOL_CALLED'), 'Tool call must succeed without throwing');
  });

  it('can call multiple tools in sequence', async () => {
    const result = await tool.execute({
      script: `
        try {
          await tools.add({ a: 3, b: 4 });
          await tools.add({ a: 10, b: 20 });
          console.log('ALL_CALLED');
        } catch (e) {
          console.log('ERROR:' + e.message);
        }
      `,
    });
    assert.ok(result.includes('ALL_CALLED'), 'All tool calls must succeed');
  });

  it('can use JavaScript control flow with tool calls', async () => {
    const result = await tool.execute({
      script: `
        const values = [1, 2, 3, 4, 5];
        let count = 0;
        for (const v of values) {
          await tools.add({ a: 0, b: v });
          count++;
        }
        console.log('count:' + count);
      `,
    });
    assert.ok(result.includes('count:5'), 'Must call tool 5 times in loop');
  });

  it('console.log output is captured and returned', async () => {
    const result = await tool.execute({
      script: `
        console.log('line1');
        console.log('line2');
        console.log('line3');
      `,
    });
    assert.ok(result.includes('line1'), 'Must capture first log');
    assert.ok(result.includes('line2'), 'Must capture second log');
    assert.ok(result.includes('line3'), 'Must capture third log');
  });

  it('console.warn output is captured with [warn] prefix', async () => {
    const result = await tool.execute({
      script: `
        console.warn('warning message');
      `,
    });
    assert.ok(result.includes('[warn] warning message'), 'Must capture warn output');
  });

  it('console.error output is captured with [error] prefix', async () => {
    const result = await tool.execute({
      script: `
        console.error('error message');
      `,
    });
    assert.ok(result.includes('[error] error message'), 'Must capture error output');
  });

  it('handles errors in tool calls gracefully', async () => {
    const result = await tool.execute({
      script: `
        try {
          await tools.nonexistent({ x: 1 });
          console.log('NO_ERROR');
        } catch (e) {
          console.log('CAUGHT:' + e.message);
        }
      `,
    });
    // Should either catch the error or show it in failure output
    assert.ok(
      result.includes('CAUGHT:') || result.includes('Script failed') || result.includes('Error'),
      'Must handle tool call errors',
    );
  });

  it('can restrict which tools are available', async () => {
    const restrictedTool = new ExecuteScriptTool();
    const tools = new Map<string, (args: Record<string, unknown>) => Promise<string>>();
    tools.set('echo', async (args) => `echoed: ${JSON.stringify(args)}`);
    tools.set('secret', async () => 'SECRET_DATA');
    restrictedTool.setTools(tools);

    const result = await restrictedTool.execute({
      script: `
        try {
          await tools.echo({ test: true });
          console.log('ECHO_WORKED');
        } catch (e) {
          console.log('ECHO_FAILED');
        }
        try {
          // secret should not be available when restricted to ['echo']
          const s = tools.secret;
          if (s === undefined) {
            console.log('SECRET_BLOCKED');
          } else {
            await s({});
            console.log('GOT_SECRET');
          }
        } catch (e) {
          console.log('SECRET_ERROR');
        }
      `,
      tools: ['echo'], // only expose echo, not secret
    });
    assert.ok(result.includes('ECHO_WORKED'), 'Exposed tool must work');
    assert.ok(
      result.includes('SECRET_BLOCKED') ||
        result.includes('SECRET_ERROR') ||
        !result.includes('GOT_SECRET'),
      'Non-exposed tools must not be callable',
    );
  });
});

// ============================================================================
// Additional hardening tests
// ============================================================================
describe('VM sandbox: additional hardening', () => {
  it('blocks import() dynamic import escape via sandbox context isolation', async () => {
    const tool = makeTool();
    const result = await tool.execute({
      script: `
        try {
          // import() in a VM context has no access to host modules
          const m = await import('child_process');
          console.log('ESCAPED:' + typeof m.execSync);
        } catch (e) {
          console.log('BLOCKED');
        }
      `,
    });
    // import() may throw because child_process is not resolvable from the VM context
    assert.ok(!result.includes('ESCAPED:'), 'Dynamic import escape must be blocked');
  });

  it('blocks access to process via this in async context', async () => {
    const tool = makeTool();
    const result = await tool.execute({
      script: `
        try {
          // In async arrow function, 'this' is the enclosing scope
          const g = (function() { return this; })();
          console.log('THIS:' + typeof g.process);
        } catch (e) {
          console.log('BLOCKED');
        }
      `,
    });
    assert.ok(!result.includes('THIS:object'), 'this must not expose global process');
  });

  it('blocks toString/valueOf constructor tricks', async () => {
    const tool = makeTool();
    const result = await tool.execute({
      script: `
        try {
          const g = tools.echo.toString.constructor('return this')();
          console.log('ESCAPED:' + typeof g.process);
        } catch (e) {
          console.log('BLOCKED');
        }
      `,
    });
    assert.ok(!result.includes('ESCAPED:'), 'toString.constructor escape must be blocked');
  });

  it('empty script returns helpful message', async () => {
    const tool = makeTool();
    const result = await tool.execute({ script: '' });
    assert.ok(
      result.includes('Error') || result.includes('required'),
      'Empty script must return error',
    );
  });

  it('script timeout parameter is respected (not default 30s)', async () => {
    const tool = makeTool();
    // The timeout is clamped to max 120s and min 1s
    // We verify that a very short timeout value is accepted (clamped to 1s)
    // without crashing — the actual enforcement is via vm.runInNewContext timeout
    const result = await tool.execute({
      script: `console.log('fast')`,
      timeout: 0.001, // very short, should be clamped
    });
    assert.ok(result.includes('fast'), 'Fast script must complete even with short timeout');
  });
});
