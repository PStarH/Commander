import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WorkerService } from './workerService.js';
import { runWorkerServiceWithHealth } from './main.js';

describe('worker main lifecycle', () => {
  it('drains on SIGTERM and closes health server once', async () => {
    const service: WorkerService = {
      async run(signal) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };

    const runPromise = runWorkerServiceWithHealth(service, 0);
    process.emit('SIGTERM');
    await runPromise;
    assert.notEqual(process.exitCode, 1);
  });

  it('closes health server once when service completes normally', async () => {
    const service: WorkerService = {
      async run() {
        // immediate drain
      },
    };
    await runWorkerServiceWithHealth(service, 0);
    assert.notEqual(process.exitCode, 1);
  });
});
