import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  compileSchema,
  validateToolCall,
  formatValidationErrors,
} from '../src/runtime/toolCallValidator';

describe('Tool Call Validator', () => {
  const searchSchema = compileSchema({
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Max results', minimum: 1, maximum: 100, default: 10 },
      format: { type: 'string', enum: ['json', 'text', 'html'], default: 'json' },
      verbose: { type: 'boolean', default: false },
    },
    required: ['query'],
  });

  it('validates correct arguments', () => {
    const result = validateToolCall({ query: 'hello', limit: 5 }, searchSchema);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  it('rejects missing required field', () => {
    const result = validateToolCall({ limit: 5 }, searchSchema);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === 'query' && e.message.includes('required')));
  });

  it('rejects wrong type without coercion', () => {
    const result = validateToolCall({ query: ['not', 'a', 'string'] }, searchSchema);
    assert.strictEqual(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.path === 'query' && e.message.includes('expected string')),
    );
  });

  it('coerces string number to number', () => {
    const result = validateToolCall({ query: 'test', limit: '5' }, searchSchema);
    assert.strictEqual(result.valid, true);
    assert.ok(result.repairedArgs);
    assert.strictEqual(result.repairedArgs.limit, 5);
  });

  it('coerces string boolean to boolean', () => {
    const result = validateToolCall({ query: 'test', verbose: 'true' }, searchSchema);
    assert.strictEqual(result.valid, true);
    assert.ok(result.repairedArgs);
    assert.strictEqual(result.repairedArgs.verbose, true);
  });

  it('validates enum values', () => {
    const result = validateToolCall({ query: 'test', format: 'xml' }, searchSchema);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === 'format' && e.message.includes('enum')));
  });

  it('accepts valid enum values', () => {
    const result = validateToolCall({ query: 'test', format: 'json' }, searchSchema);
    assert.strictEqual(result.valid, true);
  });

  it('clamps out-of-range numbers', () => {
    const result = validateToolCall({ query: 'test', limit: 200 }, searchSchema);
    assert.strictEqual(result.valid, true);
    assert.ok(result.repairedArgs);
    assert.strictEqual(result.repairedArgs.limit, 100);
  });

  it('clamps below-minimum numbers', () => {
    const result = validateToolCall({ query: 'test', limit: 0 }, searchSchema);
    assert.strictEqual(result.valid, true);
    assert.ok(result.repairedArgs);
    assert.strictEqual(result.repairedArgs.limit, 1);
  });

  it('injects default values', () => {
    const result = validateToolCall({ query: 'test' }, searchSchema);
    assert.strictEqual(result.valid, true);
    assert.ok(result.repairedArgs);
    assert.strictEqual(result.repairedArgs.limit, 10);
    assert.strictEqual(result.repairedArgs.format, 'json');
    assert.strictEqual(result.repairedArgs.verbose, false);
  });

  it('formatValidationErrors produces readable output', () => {
    const errors = [
      { path: 'query', message: 'required but missing' },
      {
        path: 'limit',
        message: 'expected number, got string "five"',
        expectedType: 'number',
        actualValue: 'five',
      },
    ];
    const formatted = formatValidationErrors(errors, 'web_search');
    assert.ok(formatted.includes('TOOL_VALIDATION_ERROR'));
    assert.ok(formatted.includes('web_search'));
    assert.ok(formatted.includes('query'));
    assert.ok(formatted.includes('limit'));
    assert.ok(formatted.includes('retry'));
  });

  it('compiled schema is reusable across multiple validations', () => {
    const r1 = validateToolCall({ query: 'first' }, searchSchema);
    const r2 = validateToolCall({ query: 'second' }, searchSchema);
    assert.strictEqual(r1.valid, true);
    assert.strictEqual(r2.valid, true);
  });

  it('performance: 10000 validations in <100ms', () => {
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      validateToolCall({ query: `test ${i}`, limit: (i % 100) + 1 }, searchSchema);
    }
    const elapsed = performance.now() - start;
    console.log(`  [Perf] 10K validations: ${elapsed.toFixed(1)}ms`);
    assert.ok(elapsed < 100, `Should be <100ms, got ${elapsed.toFixed(1)}ms`);
  });
});
