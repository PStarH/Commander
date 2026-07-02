// packages/core/tests/chaos/l2Tool.test.ts
import { describe, it, expect } from 'vitest';
import { L2ToolLayer } from '../../src/chaos/l2ToolLayer';

describe('L2ToolLayer', () => {
  it('injects tool fault based on tool name', async () => {
    const layer = new L2ToolLayer();
    layer.arm({ tool: 'web_search', mode: 'http_5xx', statusCode: 503 });
    await expect(layer.intercept('web_search', { query: 'x' }, async () => ({ ok: true })))
      .rejects.toThrow(/503/);
  });

  it('passes through to original handler when no fault', async () => {
    const layer = new L2ToolLayer();
    const handler = async () => ({ result: 'ok' });
    const result = await layer.intercept('web_search', { query: 'x' }, handler);
    expect(result).toEqual({ result: 'ok' });
  });

  it('supports multiple failure modes', () => {
    const layer = new L2ToolLayer();
    layer.arm({ tool: 't', mode: 'disk_full' });
    layer.arm({ tool: 't', mode: 'oom' });
    layer.arm({ tool: 't', mode: 'process_crash' });
    expect(layer.getActiveFaults('t')).toHaveLength(3);
  });
});
