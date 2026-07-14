import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  EventSourcingEngine,
  resetGlobalEventSourcingEngine,
} from '../../src/runtime/eventSourcingEngine';

describe('EventSourcingEngine segmented WAL', () => {
  let tmpDir: string;
  let walPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-seg-'));
    walPath = path.join(tmpDir, 'events.wal');
  });

  afterEach(async () => {
    await resetGlobalEventSourcingEngine();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('retains only hot window in RAM while tracking total count', async () => {
    const engine = new EventSourcingEngine({ walPath, hotWindowSize: 3 });
    await engine.init();

    for (let i = 0; i < 10; i++) {
      await engine.append({
        type: 'test.event',
        correlationId: 'run-hot',
        payload: { i },
      });
    }

    expect(engine.getEventCount()).toBe(10);
    // Hot window is internal — verify via correlation scan still finds all events
    const events = engine.getEventsByCorrelationId('run-hot');
    expect(events).toHaveLength(10);
  });

  it('streams cold segments via readFrom from the beginning', async () => {
    const engine = new EventSourcingEngine({ walPath, hotWindowSize: 2 });
    await engine.init();

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const ev = await engine.append({
        type: 'test.event',
        correlationId: 'run-stream',
        payload: { i },
      });
      ids.push(ev.id);
    }

    const replayed: string[] = [];
    for await (const ev of engine.readFrom()) {
      replayed.push(ev.id);
    }
    expect(replayed).toEqual(ids);
  });

  it('verifyIntegrity scans the full on-disk chain', async () => {
    const engine = new EventSourcingEngine({ walPath, hotWindowSize: 1 });
    await engine.init();
    for (let i = 0; i < 4; i++) {
      await engine.append({ type: 'integrity', payload: { i } });
    }
    expect(await engine.verifyIntegrity()).toBe(true);
  });
});
