// packages/core/tests/chaos/l1Llm.test.ts
import { describe, it, expect, vi } from 'vitest';
import { L1LlmLayer } from '../../src/chaos/l1LlmLayer';

describe('L1LlmLayer', () => {
  it('injects rate_limit_429 fault on specified call', async () => {
    const layer = new L1LlmLayer();
    const mockProvider = { call: vi.fn().mockRejectedValue(new Error('429')) };
    layer.arm({ faultType: 'rate_limit_429', triggerAtCalls: [1] });
    await expect(layer.intercept(mockProvider, { messages: [] })).rejects.toThrow('429');
  });

  it('passes through when no fault matches', async () => {
    const layer = new L1LlmLayer();
    const mockProvider = { call: vi.fn().mockResolvedValue({ content: 'ok' }) };
    layer.arm({ faultType: 'rate_limit_429', triggerAtCalls: [5] });
    const result = await layer.intercept(mockProvider, { messages: [] });
    expect(result).toEqual({ content: 'ok' });
  });

  it('disarm clears all faults', () => {
    const layer = new L1LlmLayer();
    layer.arm({ faultType: 'rate_limit_429', triggerAtCalls: [1] });
    layer.disarm();
    expect(layer.getActiveFaults()).toHaveLength(0);
  });
});
