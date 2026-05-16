import { describe, it } from 'node:test';
import assert from 'node:assert';
import { VerificationLoop } from '../../src/runtime/verificationLoop';

class SyntaxVerifier {
  readonly name = 'syntax';
  canVerify(ctx: any) { return !!(ctx.language && ctx.output.length > 0); }
  async verify(ctx: any) {
    const failures: any[] = [];
    const output = ctx.output;
    for (const q of ["'''", '"""']) {
      if ((output.match(new RegExp(q, 'g')) || []).length % 2 !== 0) {
        failures.push({ location: 'docstring', message: `Unclosed ${q}` });
      }
    }
    return { passed: failures.length === 0, failures, suggestions: [] };
  }
}

class SchemaVerifier {
  readonly name = 'schema';
  canVerify(ctx: any) { return !!ctx.schema; }
  async verify(ctx: any) {
    const failures: any[] = [];
    let parsed: any;
    try { parsed = JSON.parse(ctx.output); }
    catch { return { passed: false, failures: [{ location: 'parse', message: 'Invalid JSON' }], suggestions: [] }; }
    const props = (ctx.schema as any)?.properties || {};
    for (const [key, def] of Object.entries(props)) {
      const d = def as any;
      if (d.required && parsed[key] === undefined) {
        failures.push({ location: key, message: `Missing: ${key}` });
      }
    }
    return { passed: failures.length === 0, failures, suggestions: [] };
  }
}

class ToolResultVerifier {
  readonly name = 'tool-result';
  canVerify(ctx: any) { return (ctx.toolsUsed?.length ?? 0) > 0; }
  async verify(ctx: any) {
    const lo = ctx.output.toLowerCase();
    if (lo.includes('error:') || lo.includes('traceback')) {
      return { passed: false, failures: [{ location: 'output', message: 'Error in output' }], suggestions: [] };
    }
    return { passed: true, failures: [], suggestions: [] };
  }
}

describe('SyntaxVerifier', () => {
  it('detects unclosed triple quotes', async () => {
    const v = new SyntaxVerifier();
    const r = await v.verify({ goal: '', output: "print('''hello)", language: 'python' });
    assert.ok(!r.passed);
    assert.ok(r.failures.some((f: any) => f.message.includes('Unclosed')));
  });
  it('passes valid code with no syntax issues', async () => {
    const v = new SyntaxVerifier();
    const r = await v.verify({ goal: '', output: 'x = 1', language: 'python' });
    assert.ok(r.passed);
  });
});

describe('SchemaVerifier', () => {
  it('detects missing required fields', async () => {
    const v = new SchemaVerifier();
    const schema = { properties: { name: { required: true }, age: { required: true } } };
    const r = await v.verify({ goal: '', output: '{"name":"Alice"}', schema: schema as any });
    assert.ok(!r.passed);
    assert.ok(r.failures.some((f: any) => f.location === 'age'));
  });
  it('passes valid JSON', async () => {
    const v = new SchemaVerifier();
    const schema = { properties: { x: { required: true } } };
    const r = await v.verify({ goal: '', output: '{"x":42}', schema: schema as any });
    assert.ok(r.passed);
  });
  it('detects invalid JSON', async () => {
    const v = new SchemaVerifier();
    const schema = { properties: {} };
    const r = await v.verify({ goal: '', output: 'not json', schema: schema as any });
    assert.ok(!r.passed);
  });
});

describe('ToolResultVerifier', () => {
  it('detects error in output', async () => {
    const v = new ToolResultVerifier();
    const r = await v.verify({ goal: '', output: 'Error: file not found', toolsUsed: ['file_read'] });
    assert.ok(!r.passed);
  });
  it('passes clean output', async () => {
    const v = new ToolResultVerifier();
    const r = await v.verify({ goal: '', output: 'ok', toolsUsed: ['file_read'] });
    assert.ok(r.passed);
  });
  it('skips when no tools used', async () => {
    const v = new ToolResultVerifier();
    assert.ok(!v.canVerify({ goal: '', output: 'test' }));
  });
});

describe('VerificationLoop', () => {
  it('passes through valid output', async () => {
    const vl = new VerificationLoop({ strategies: [] });
    const r = await vl.execute('test', 'valid', { goal: 'test', output: 'valid' });
    assert.ok(r.iterations === 1); // 1 iteration with no applicable strategies = passed
  });
  it('detects schema failures', async () => {
    const vl = new VerificationLoop({ strategies: ['schema'] });
    const schema = { properties: { x: { type: 'number', required: true } } };
    const r = await vl.execute('test', '{}', { goal: 'test', output: '{}', schema: schema as any });
    assert.ok(r.failures.length > 0);
  });
  it('enforces max iterations', async () => {
    const vl = new VerificationLoop({ maxIterations: 2, strategies: ['schema'] });
    const schema = { properties: { x: { type: 'number', required: true }, y: { type: 'number', required: true } } };
    const r = await vl.execute('test', '{}', { goal: 'test', output: '{}', schema: schema as any });
    assert.ok(r.iterations <= 2);
  });
  it('can be disabled', async () => {
    const vl = new VerificationLoop({ enabled: false });
    const r = await vl.execute('test', 'output', { goal: 'test', output: 'output' });
    assert.ok(r.iterations === 0 || r.iterations === 1, `Expected 0-1 iteration when disabled, got ${r.iterations}`);
  });
});

describe('Integration — all verifiers compose', () => {
  it('detects both schema and tool errors', async () => {
    const vl = new VerificationLoop({ strategies: ['schema', 'tool-result'] });
    const schema = { properties: { id: { type: 'number', required: true } } };
    const r = await vl.execute('test', 'Error: timeout', { goal: 'test', output: 'Error: timeout', schema: schema as any, toolsUsed: ['api_call'] });
    assert.ok(r.failures.length > 0);
  });
});
