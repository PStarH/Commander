import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  EventSourcingEngine,
  resetGlobalEventSourcingEngine,
} from '../../src/runtime/eventSourcingEngine';

async function rmDirRetry(dir: string, attempts = 8): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}

describe('EventSourcingEngine segmented WAL', () => {
  let tmpDir: string;
  let walPath: string;
  let engines: EventSourcingEngine[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-seg-'));
    walPath = path.join(tmpDir, 'events.wal');
    engines = [];
  });

  afterEach(async () => {
    for (const engine of engines) {
      await engine.flush();
    }
    engines = [];
    await resetGlobalEventSourcingEngine();
    // Windows can retain WAL handles briefly after flush — retry rmdir.
    await rmDirRetry(tmpDir);
  });

  it('retains only hot window in RAM while tracking total count', async () => {
    const engine = new EventSourcingEngine({ walPath, hotWindowSize: 3 });
    engines.push(engine);
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
    engines.push(engine);
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
    engines.push(engine);
    await engine.init();
    for (let i = 0; i < 4; i++) {
      await engine.append({ type: 'integrity', payload: { i } });
    }
    expect(await engine.verifyIntegrity()).toBe(true);
  });
});
