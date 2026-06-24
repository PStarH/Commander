/**
 * eventGlue.test — Phase 1 hub glue layered dispatcher test suite.
 *
 * Coverage:
 *   1. off mode → no subscriptions, no JSONL writes
 *   2. shadow mode writes JSONL and never invokes dispatchers
 *   3. on mode invokes overloads for the configured topic
 *   4. Idempotency: same msg.id dropped (no double dispatch)
 *   5. install() is idempotent (second call returns same handle)
 *   6. bounded LRU dedupe under spam
 *   7. HUB_TOPICS ⊆ WRITE_TOPICS invariant (drift defense)
 *
 * Moved from `src/hub/eventGlue.test.ts` to satisfy the project's
 * vitest include-allowlist (vitest.config.ts only picks tests under
 * `tests/`).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BusMessage } from '../../src/runtime/types/messageBus';
import { getMessageBus, resetMessageBus } from '../../src/runtime/messageBus';
import {
  DEFAULT_DISPATCHERS,
  EventGlue,
  getEventGlue,
  resetEventGlue,
  type EventGlueOptions,
} from '../../src/hub/eventGlue';
import { HUB_TOPICS, WRITE_TOPICS } from '../../src/hub/eventGlue.topics';

describe('eventGlue', () => {
  let shadowDir: string;

  beforeEach(() => {
    resetMessageBus();
    resetEventGlue();
    shadowDir = mkdtempSync(join(tmpdir(), 'glue-test-'));
  });

  afterEach(() => {
    resetEventGlue();
    resetMessageBus();
    if (existsSync(shadowDir)) {
      rmSync(shadowDir, { recursive: true, force: true });
    }
  });

  it('off mode subscribes nothing and writes no shadow file', async () => {
    const glue = new EventGlue({ mode: 'off', shadowDir, shadowFilename: 'glue-shadow.ndjson' });
    const handle = glue.install();
    expect(typeof handle).toBe('function');

    getMessageBus().publish('memory.written', 'svc', {
      layer: 'working',
      content: 'should-not-be-logged',
      tags: [],
    });
    await flush(20);

    expect(existsSync(shadowPath())).toBe(false);
  });

  it('shadow mode writes JSONL and does NOT invoke backend dispatchers', async () => {
    let memoryCalls = 0;
    let auditCalls = 0;
    const opts: EventGlueOptions = {
      mode: 'shadow',
      shadowDir,
      shadowFilename: 'glue-shadow.ndjson',
      overloads: {
        unifiedMemory: async () => {
          memoryCalls++;
        },
        auditChain: async () => {
          auditCalls++;
        },
        runLedger: async () => {},
        sagaEventForwarder: async () => {},
      },
    };
    const glue = new EventGlue(opts);
    glue.install();

    getMessageBus().publish('memory.written', 'svc', {
      layer: 'working',
      content: 'shadow-only',
      tags: ['x'],
    });
    getMessageBus().publish('security.capability_minted', 'svc', {
      agentId: 'a',
      capability: 'read',
      ttlSeconds: 60,
      mintId: 'm1',
    });
    await flush(40);
    await flush(40);

    const file = shadowPath();
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('memory.written');
    expect(lines[1]).toContain('security.capability_minted');

    expect(memoryCalls).toBe(0);
    expect(auditCalls).toBe(0);
  });

  it('on mode invokes the configured dispatcher overload', async () => {
    let memoryCalls = 0;
    const opts: EventGlueOptions = {
      mode: 'on',
      shadowDir,
      overloads: {
        unifiedMemory: async () => {
          memoryCalls++;
        },
        auditChain: async () => {},
        runLedger: async () => {},
        sagaEventForwarder: async () => {},
      },
    };
    const glue = new EventGlue(opts);
    glue.install();

    getMessageBus().publish('memory.written', 'svc', {
      layer: 'working',
      content: 'on-mode',
      tags: [],
    });
    await flush(80);

    expect(memoryCalls).toBe(1);
  });

  it('drops duplicate messages by msg.id (true idempotency)', async () => {
    let memoryCalls = 0;
    const glue = new EventGlue({
      mode: 'on',
      shadowDir,
      overloads: {
        unifiedMemory: async () => {
          memoryCalls++;
        },
        auditChain: async () => {},
        runLedger: async () => {},
        sagaEventForwarder: async () => {},
      },
    });
    glue.install();

    // Synthesize two BusMessages with the SAME msg.id (simulating a
    // re-broadcast or sagaEventForwarder replay) and dispatch directly
    // via the private dispatchOne API (test escape).
    const env: BusMessage = {
      id: 'duplicate-id-test-001',
      topic: 'memory.written',
      source: 'svc',
      payload: { layer: 'working', content: 'once', tags: [] },
      priority: 'normal',
      timestamp: new Date().toISOString(),
    };
    const dispatchOne = (glue as unknown as {
      dispatchOne: (m: BusMessage) => Promise<void>;
    }).dispatchOne.bind(glue);
    await dispatchOne(env);
    await dispatchOne(env);
    await dispatchOne(env);
    expect(memoryCalls).toBe(1);
  });

  it('install() is idempotent (second call returns same handle)', async () => {
    const calls: string[] = [];
    const glue = new EventGlue({
      mode: 'on',
      shadowDir,
      topics: ['memory.written'],
      overloads: {
        unifiedMemory: async () => {
          calls.push('m');
        },
        auditChain: async () => {},
        runLedger: async () => {},
        sagaEventForwarder: async () => {},
      },
    });
    const a = glue.install();
    const b = glue.install();
    expect(a).toBe(b);

    getMessageBus().publish('memory.written', 'svc', {
      layer: 'working',
      content: 'once',
      tags: [],
    });
    await flush(50);
    expect(calls.length).toBe(1);

    a();
    getMessageBus().publish('memory.written', 'svc', {
      layer: 'working',
      content: 'after-uninstall',
      tags: [],
    });
    await flush(50);
    expect(calls.length).toBe(1);
  });

  it('default dispatchers are non-empty for all 4 anchors', () => {
    expect(typeof DEFAULT_DISPATCHERS.unifiedMemory).toBe('function');
    expect(typeof DEFAULT_DISPATCHERS.auditChain).toBe('function');
    expect(typeof DEFAULT_DISPATCHERS.runLedger).toBe('function');
    expect(typeof DEFAULT_DISPATCHERS.sagaEventForwarder).toBe('function');
  });

  it('getEventGlue returns a singleton and resetEventGlue() drops it', () => {
    const a = getEventGlue();
    const b = getEventGlue();
    expect(a).toBe(b);
    resetEventGlue();
    const c = getEventGlue();
    expect(c).not.toBe(a);
  });

  it('dedupeCapacity bounds in-memory Map under spam', async () => {
    let n = 0;
    const glue = new EventGlue({
      mode: 'on',
      shadowDir,
      dedupeCapacity: 8,
      topics: ['memory.written'],
      overloads: {
        unifiedMemory: async () => {
          n++;
        },
        auditChain: async () => {},
        runLedger: async () => {},
        sagaEventForwarder: async () => {},
      },
    });
    glue.install();

    const bus = getMessageBus();
    for (let i = 0; i < 50; i++) {
      bus.publish('memory.written', 'svc', { layer: 'working', content: `c${i}`, tags: [] });
    }
    await flush(80);
    expect(n).toBe(50);
    const dedupe = (glue as unknown as { dedupe: Map<string, number> }).dedupe;
    expect(dedupe.size).toBeLessThanOrEqual(8);
  });

  it('every HUB_TOPICS entry maps to at least one WRITE_TOPICS sub-array', () => {
    const allWrite = new Set<string>([
      ...WRITE_TOPICS.unifiedMemory,
      ...WRITE_TOPICS.auditChain,
      ...WRITE_TOPICS.runLedger,
      ...WRITE_TOPICS.sagaEventForwarder,
    ]);
    for (const t of HUB_TOPICS) {
      expect(allWrite.has(t), `${t} must be in at least one WRITE_TOPICS sub-array`).toBe(true);
    }
  });

  // ───── helpers (kept inside describe so they close over shadowDir) ─────

  function shadowPath(): string {
    return join(shadowDir, 'glue-shadow.ndjson');
  }

  async function flush(times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      // 1 ms is enough for the in-memory bus + sync appendFileSync.
      await new Promise<void>((r) => setTimeout(r, 1));
    }
  }
});
