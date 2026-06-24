// ============================================================================
// Hub Glue: contract + behavior tests
// ============================================================================
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  HUB_TOPICS,
  WRITE_TOPICS,
  getSinksForTopic,
  install,
  getEventGlue,
  resetForTests,
} from '../../src/hub';
import { getMessageBus } from '../../src/runtime/messageBus';
import type { BusMessage } from '../../src/runtime/types/messageBus';

describe('hub/eventGlue.topics', () => {
  it('HUB_TOPICS is non-empty and contains no duplicates', () => {
    expect(HUB_TOPICS.length).toBeGreaterThan(10);
    expect(new Set(HUB_TOPICS).size).toBe(HUB_TOPICS.length);
  });

  it('WRITE_TOPICS invariance: every hub topic has a backend and vice versa', () => {
    const referenced = new Set<string>([
      ...WRITE_TOPICS.unifiedMemory,
      ...WRITE_TOPICS.runLedger,
      ...WRITE_TOPICS.auditChainLedger,
      ...WRITE_TOPICS.sagas,
    ]);
    for (const t of HUB_TOPICS) {
      expect(referenced.has(t), `hub topic ${t} has no backend`).toBe(true);
    }
    for (const r of referenced) {
      expect((HUB_TOPICS as readonly string[]).includes(r), `write ref ${r} not in HUB_TOPICS`).toBe(true);
    }
  });
});

describe('hub/eventGlue install', () => {
  beforeEach(() => resetForTests());
  afterEach(() => resetForTests());

  it('install() returns the same instance on a second option-free call', () => {
    const a = install({ mode: 'shadow', dedupCapacity: 100 });
    const b = install();
    expect(a).toBe(b);
    expect(getEventGlue()).toBe(a);
  });

  it('install() throws on a second call that supplies options', () => {
    install({ mode: 'shadow', dedupCapacity: 100 });
    expect(() => install({ mode: 'shadow', dedupCapacity: 200 })).toThrow(/already called/);
  });

  it("mode 'on' refuses without enableBackends", () => {
    expect(() => install({ mode: 'on' })).toThrow(/enableBackends/);
  });

  it("mode 'on' is accepted with explicit enableBackends", () => {
    expect(() => install({ mode: 'on', enableBackends: true })).not.toThrow();
  });
});

describe('hub/eventGlue shadow sink', () => {
  let dir: string;
  let log: string;

  beforeEach(() => {
    resetForTests();
    dir = mkdtempSync(join(tmpdir(), 'hubtest-'));
    log = join(dir, 'shadow.jsonl');
    install({ mode: 'shadow', shadowLogPath: log }).start();
  });

  afterEach(() => {
    resetForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes one shadow line per accepted message', () => {
    const bus = getMessageBus();
    bus.publish('memory.written', 'test', { layer: 'semantic', content: 'x' });
    bus.publish('memory.written', 'test', { layer: 'semantic', content: 'y' });
    bus.publish('sandbox.escape_attempted', 'test', { lane: 'light', toolName: 'x', args: '{}', constraint: 'fs.write' });
    expect(existsSync(log)).toBe(true);
    const lines = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.ts).toBeGreaterThan(0);
      expect(parsed.msgId).toBeTypeOf('string');
    }
  });
});

describe('hub/eventGlue dedup via dispatchOne', () => {
  // Use the dispatchOne entry point to force caller-controlled msg.ids —
  // bus.publish auto-generates a fresh id per call, so "100 publishes with
  // the SAME id" is not expressible through the public bus API.
  let dir: string;
  let log: string;

  beforeEach(() => {
    resetForTests();
    dir = mkdtempSync(join(tmpdir(), 'hubtest-dedup-'));
    log = join(dir, 'shadow.jsonl');
    install({ mode: 'shadow', shadowLogPath: log });
  });

  afterEach(() => {
    resetForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('100 dispatches with the same id collapse to 1 shadow line', () => {
    const g = getEventGlue()!;
    for (let i = 0; i < 100; i++) {
      g.dispatchOne('memory.written', {
        id: 'same-id',
        topic: 'memory.written',
        source: 'test',
        payload: { i },
        priority: 'normal',
        timestamp: new Date().toISOString(),
      }).catch(() => undefined);
    }
    const lines = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it('uses bounded dedup capacity', () => {
    // After 50 unique ids against dedupCapacity=8, the dedup window holds
    // at most `capacity` entries (oldest evicted). Assert via the public
    // getter rather than reaching into private Map state.
    resetForTests();
    install({ mode: 'shadow', shadowLogPath: log, dedupCapacity: 8 });
    const g = getEventGlue()!;
    for (let i = 0; i < 50; i++) {
      g.dispatchOne('memory.written', {
        id: `cap-${i}`,
        topic: 'memory.written',
        source: 'test',
        payload: {},
        priority: 'normal',
        timestamp: new Date().toISOString(),
      }).catch(() => undefined);
    }
    expect(g.dedupWindowSize()).toBeLessThanOrEqual(8);
  });
});

describe('hub/eventGlue sinksForTopic helper', () => {
  it("memory.written routes to ['unifiedMemory'] exclusively", () => {
    expect(getSinksForTopic('memory.written')).toEqual(['unifiedMemory']);
  });

  it("sandbox.escape_attempted routes to ['auditChainLedger']", () => {
    expect(getSinksForTopic('sandbox.escape_attempted')).toEqual(['auditChainLedger']);
  });

  it("memory.queried fans out to ['unifiedMemory', 'sagas'] (genuine multi-route)", () => {
    // memory.queried is wired to BOTH unifiedMemory AND sagas in WRITE_TOPICS.
    // Asserting contains + exact length locks the fanout contract while
    // tolerating iteration-order changes in the reverse-index build.
    const sinks = [...getSinksForTopic('memory.queried')];
    expect(sinks).toContain('unifiedMemory');
    expect(sinks).toContain('sagas');
    expect(sinks.length).toBe(2);
  });
});
