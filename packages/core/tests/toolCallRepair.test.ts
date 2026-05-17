import { describe, it } from 'node:test';
import assert from 'node:assert';
import { repairToolCallArguments } from '../src/runtime/toolCallRepair';

describe('Tool Call Repair', () => {
  it('passes through valid JSON object', () => {
    const input = '{"query": "hello", "limit": 5}';
    const result = repairToolCallArguments(input, 'web_search');
    assert.deepStrictEqual(result.args, { query: 'hello', limit: 5 });
    assert.strictEqual(result.repairs.length, 0);
  });

  it('passes through already-parsed object', () => {
    const input = { query: 'hello', limit: 5 };
    const result = repairToolCallArguments(input, 'web_search');
    assert.deepStrictEqual(result.args, { query: 'hello', limit: 5 });
    assert.strictEqual(result.repairs.length, 0);
  });

  it('repairs trailing comma before closing brace', () => {
    const input = '{"query": "hello", "limit": 5,}';
    const result = repairToolCallArguments(input, 'web_search');
    assert.deepStrictEqual(result.args, { query: 'hello', limit: 5 });
    assert.ok(result.repairs.some(r => r.includes('trailing comma')));
  });

  it('repairs trailing comma before closing bracket', () => {
    const input = '{"items": [1, 2, 3,]}';
    const result = repairToolCallArguments(input, 'test');
    assert.deepStrictEqual(result.args, { items: [1, 2, 3] });
  });

  it('strips markdown code fences', () => {
    const input = '```json\n{"query": "test"}\n```';
    const result = repairToolCallArguments(input, 'web_search');
    assert.deepStrictEqual(result.args, { query: 'test' });
    assert.ok(result.repairs.some(r => r.includes('markdown')));
  });

  it('strips markdown code fences without language tag', () => {
    const input = '```\n{"query": "test"}\n```';
    const result = repairToolCallArguments(input, 'web_search');
    assert.deepStrictEqual(result.args, { query: 'test' });
  });

  it('extracts JSON from surrounding text', () => {
    const input = 'Here is the result: {"query": "test"} hope this helps!';
    const result = repairToolCallArguments(input, 'web_search');
    assert.deepStrictEqual(result.args, { query: 'test' });
    assert.ok(result.repairs.some(r => r.includes('extracted')));
  });

  it('removes single-line comments', () => {
    const input = '{\n  // This is a comment\n  "query": "test"\n}';
    const result = repairToolCallArguments(input, 'web_search');
    assert.deepStrictEqual(result.args, { query: 'test' });
    assert.ok(result.repairs.some(r => r.includes('comments')));
  });

  it('removes block comments', () => {
    const input = '{\n  /* multi\n  line */\n  "query": "test"\n}';
    const result = repairToolCallArguments(input, 'web_search');
    assert.deepStrictEqual(result.args, { query: 'test' });
  });

  it('returns empty args for completely unparseable input', () => {
    const input = 'this is not json at all, just random text';
    const result = repairToolCallArguments(input, 'test');
    assert.deepStrictEqual(result.args, {});
    assert.ok(result.repairs.length > 0);
  });

  it('handles non-string non-object input', () => {
    const result = repairToolCallArguments(42, 'test');
    assert.deepStrictEqual(result.args, {});
  });

  it('handles nested object repair', () => {
    const input = '{"config": {"timeout": 5000,}, "query": "test"}';
    const result = repairToolCallArguments(input, 'test');
    assert.strictEqual(result.args.query, 'test');
    assert.ok(typeof result.args.config === 'object');
  });
});
