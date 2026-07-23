import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('worker main health wiring', () => {
  it('starts health before bootstrap and marks ready only after registration', async () => {
    const source = await readFile(new URL('./main.ts', import.meta.url), 'utf8');
    assert.match(source, /startWorkerHealthServer/);
    assert.match(source, /COMMANDER_WORKER_HEALTH_PORT/);
    assert.match(source, /await service\.start\(\);[\s\S]*ready = true;/);
  });

  it('uses readiness rather than liveness for the Cell compose healthcheck', async () => {
    const compose = await readFile(
      new URL('../../../docker-compose.cell.yml', import.meta.url),
      'utf8',
    );
    assert.match(compose, /127\.0\.0\.1:8083\/ready/);
  });
});
