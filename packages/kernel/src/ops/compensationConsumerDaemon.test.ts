import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CompensationConsumerDaemon } from './compensationConsumerDaemon.js';

describe('CompensationConsumerDaemon', () => {
  it('is unhealthy before the first successful tick', () => {
    const daemon = new CompensationConsumerDaemon({
      intervalMs: 60_000,
      probe: async () => {},
    });
    assert.equal(daemon.isHealthy(), false);
  });

  it('becomes healthy after a successful probe tick', async () => {
    let probes = 0;
    const daemon = new CompensationConsumerDaemon({
      intervalMs: 60_000,
      probe: async () => {
        probes += 1;
      },
    });
    daemon.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(probes, 1);
    assert.equal(daemon.isHealthy(), true);
    await daemon.stop();
    assert.equal(daemon.isHealthy(), false);
  });

  it('stays unhealthy when the probe fails', async () => {
    const daemon = new CompensationConsumerDaemon({
      intervalMs: 60_000,
      probe: async () => {
        throw new Error('outbox unreachable');
      },
    });
    daemon.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(daemon.isHealthy(), false);
    assert.match(daemon.lastFailure() ?? '', /outbox unreachable/);
    await daemon.stop();
  });
});
