import { expect, it, vi } from 'vitest';
import { AgentRuntime } from '../../src/runtime/agentRuntime';
import { getGlobalLogger } from '../../src/logging';

vi.mock('../../src/runtime/modelPerformanceStore', () => ({
  getModelPerformanceStore: () => ({ dispose() {} }),
}));

it('waits for telemetry delivery before disposal resolves', async () => {
  let complete!: () => void;
  const delivery = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const resources = {
    compensationService: { dispose() {} },
    cacheManager: { dispose() {} },
    reliabilityEngine: { shutdown() {} },
    agentInbox: { dispose() {} },
    traceStore: { shutdown() {} },
    tenantManager: { flushAll() {} },
    otelExporter: { stop: () => delivery },
  };
  let disposed = false;
  const pending = Promise.resolve(
    Reflect.apply(AgentRuntime.prototype.dispose, resources, []),
  ).then(() => {
    disposed = true;
  });
  await Promise.resolve();
  expect(disposed).toBe(false);
  complete();
  await pending;
  expect(disposed).toBe(true);
});

it('reports telemetry shutdown failure after flushing persistence without rejecting', async () => {
  const debug = vi.spyOn(getGlobalLogger(), 'debug').mockImplementation(() => {});
  const flush = vi.fn();
  const resources = {
    compensationService: { dispose() {} },
    cacheManager: { dispose() {} },
    reliabilityEngine: { shutdown() {} },
    agentInbox: { dispose() {} },
    traceStore: { shutdown: flush },
    tenantManager: { flushAll: flush },
    otelExporter: {
      stop: async () => {
        throw new Error('delivery unavailable');
      },
    },
  };
  try {
    await expect(
      Reflect.apply(AgentRuntime.prototype.dispose, resources, []),
    ).resolves.toBeUndefined();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(debug).toHaveBeenCalledWith('AgentRuntime', 'OTel exporter stop failed (non-critical)', {
      error: 'delivery unavailable',
    });
  } finally {
    debug.mockRestore();
  }
});
