// packages/core/tests/shadow/proxy.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShadowProxy } from '../../src/shadow/proxy';
import { defaultShadowConfig } from '../../src/shadow/types';

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
});

describe('ShadowProxy', () => {
  it('does not mirror when disabled', async () => {
    const proxy = new ShadowProxy(defaultShadowConfig());
    const ctx = {
      request: { method: 'GET', url: '/x', headers: {} },
      response: { status: 200 },
      latencyMs: 10,
      costUsd: 0,
    };
    await proxy.middleware()(ctx, async () => {});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('mirrors when enabled and sampled', async () => {
    mockFetch.mockResolvedValue({ status: 200 });
    const cfg = { ...defaultShadowConfig(), enabled: true, sampleRate: 1.0, endpoint: 'http://shadow:9999' };
    const proxy = new ShadowProxy(cfg, { seed: 1 });
    const ctx = {
      request: { method: 'POST', url: '/api/x', headers: { Authorization: 'Bearer t' } },
      response: { status: 201, body: { ok: true } },
      latencyMs: 50,
      costUsd: 0.001,
    };
    await proxy.middleware()(ctx, async () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(mockFetch).toHaveBeenCalled();
  });

  it('does not block production on shadow failure', async () => {
    mockFetch.mockRejectedValue(new Error('shadow down'));
    const cfg = { ...defaultShadowConfig(), enabled: true, sampleRate: 1.0, endpoint: 'http://shadow:9999' };
    const proxy = new ShadowProxy(cfg, { seed: 1 });
    const ctx = {
      request: { method: 'GET', url: '/x', headers: {} },
      response: { status: 200 },
      latencyMs: 10,
      costUsd: 0,
    };
    await expect(proxy.middleware()(ctx, async () => {})).resolves.toBeUndefined();
  });
});
