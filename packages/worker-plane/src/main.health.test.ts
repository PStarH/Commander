import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('worker main health wiring', () => {
  it('starts health before bootstrap and marks ready only after the first claim', async () => {
    const source = await readFile(new URL('./main.ts', import.meta.url), 'utf8');
    assert.match(source, /startWorkerHealthServer/);
    assert.match(source, /COMMANDER_WORKER_HEALTH_PORT/);
    // WP-05: readiness means "able to claim work". The claim probe must sit between
    // start() (registration) and the ready flag. Behavioural coverage of the
    // spawned entrypoint lives in main.readiness.test.ts; this guards the wiring
    // order in source so a refactor cannot silently move the probe.
    assert.match(
      source,
      /await service\.start\(\);[\s\S]*await service\.pollOnce\(\);[\s\S]*ready = true;/,
    );
    // The readiness endpoint must be bound to the same `ready` flag, not a
    // constant or an unrelated predicate.
    assert.match(source, /isReady:\s*\(\)\s*=>\s*ready/);
  });

  it('uses readiness rather than liveness for the Cell compose healthcheck', async () => {
    const compose = await readFile(
      new URL('../../../docker-compose.cell.yml', import.meta.url),
      'utf8',
    );
    assert.match(compose, /127\.0\.0\.1:8083\/ready/);
  });
});
