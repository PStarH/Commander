import { describe, it, expect } from 'vitest';
import { isConfidentResponse, hasInformationGain } from '../../src/runtime/entropyGater';

describe('EntropyGater - isConfidentResponse', () => {
  it('returns false when tool calls are present', () => {
    expect(isConfidentResponse({
      content: 'Let me search for that.',
      toolCalls: [{ name: 'web_search' }],
      finishReason: 'tool_calls',
    })).toBe(false);
  });

  it('returns false for non-stop finish reason', () => {
    expect(isConfidentResponse({
      content: 'Some response',
      finishReason: 'length',
    })).toBe(false);
  });

  it('returns false for short responses', () => {
    expect(isConfidentResponse({
      content: 'Hi',
      finishReason: 'stop',
    })).toBe(false);
  });

  it('returns false for uncertain responses', () => {
    expect(isConfidentResponse({
      content: 'I am not sure about the answer. I need to search for more information.',
      finishReason: 'stop',
    })).toBe(false);
  });

  it('returns false for hedging responses', () => {
    expect(isConfidentResponse({
      content: 'It depends on the context and requirements.',
      finishReason: 'stop',
    })).toBe(false);
  });

  it('returns true for confident final answers', () => {
    expect(isConfidentResponse({
      content: 'Here is the complete analysis. The result shows that the system performs well under load. In summary, the architecture is sound.',
      finishReason: 'stop',
    })).toBe(true);
  });

  it('returns true for long definitive content', () => {
    expect(isConfidentResponse({
      content: 'Based on the analysis, the optimal configuration is to use 8 workers with a batch size of 64. This maximizes throughput while minimizing latency. The data clearly supports this conclusion across all tested scenarios.',
      finishReason: 'stop',
    })).toBe(true);
  });

  it('handles empty content', () => {
    expect(isConfidentResponse({
      content: '',
      finishReason: 'stop',
    })).toBe(false);
  });
});

describe('EntropyGater - hasInformationGain', () => {
  it('returns false for empty tool calls', () => {
    expect(hasInformationGain([], [])).toBe(false);
  });

  it('returns true for state-mutating tools', () => {
    expect(hasInformationGain(
      [{ name: 'shell_execute', arguments: {} }],
      [],
    )).toBe(true);
    expect(hasInformationGain(
      [{ name: 'file_write', arguments: {} }],
      [],
    )).toBe(true);
  });

  it('returns true when no recent results exist', () => {
    expect(hasInformationGain(
      [{ name: 'web_search', arguments: { query: 'test' } }],
      [],
    )).toBe(true);
  });

  it('returns true when recent results have errors', () => {
    expect(hasInformationGain(
      [{ name: 'web_search', arguments: { query: 'test' } }],
      [{ name: 'web_search', output: '', error: 'timeout' }],
    )).toBe(true);
  });
});
