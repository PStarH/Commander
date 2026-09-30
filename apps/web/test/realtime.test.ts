/**
 * Plan D2 clause 3 — the War Room must listen for the SSE event names the
 * server actually emits, and batch the resulting refreshes.
 *
 * Baseline defect: useWarRoom.ts listened for a `snapshot` event that
 * apps/api/src/streamEndpoints.ts never emits (`snapshot` is not even a valid
 * MessageBusTopic), so live refresh silently relied on the 12s poll.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  WAR_ROOM_REFRESH_TOPICS,
  isWarRoomRefreshTopic,
  createRefreshBatcher,
  type RefreshBatcherTimers,
} from '../src/realtime';

const here = dirname(fileURLToPath(import.meta.url));

/** Minimal manual clock so batching is testable without a DOM. */
function makeClock(): {
  timers: RefreshBatcherTimers;
  advance: (ms: number) => void;
} {
  let now = 0;
  let nextId = 1;
  const tasks = new Map<number, { fn: () => void; at: number }>();
  return {
    timers: {
      setTimeout: (fn, ms) => {
        const id = nextId++;
        tasks.set(id, { fn, at: now + ms });
        return id;
      },
      clearTimeout: (handle) => {
        tasks.delete(handle as number);
      },
    },
    advance(ms) {
      now += ms;
      for (const [id, task] of [...tasks]) {
        if (task.at <= now) {
          tasks.delete(id);
          task.fn();
        }
      }
    },
  };
}

describe('WAR_ROOM_REFRESH_TOPICS', () => {
  test('is a non-empty, duplicate-free list of dotted topic names', () => {
    assert.ok(WAR_ROOM_REFRESH_TOPICS.length > 0);
    const seen = new Set<string>();
    for (const topic of WAR_ROOM_REFRESH_TOPICS) {
      assert.match(topic, /^[a-z]+\.[a-z_]+$/, `unexpected topic shape: ${topic}`);
      assert.ok(!seen.has(topic), `duplicate topic: ${topic}`);
      seen.add(topic);
    }
  });

  test('does not advertise a `snapshot` event the server never emits', () => {
    assert.equal(isWarRoomRefreshTopic('snapshot'), false);
  });

  test('recognises a real bus topic', () => {
    assert.equal(isWarRoomRefreshTopic('mission.updated'), true);
    assert.equal(isWarRoomRefreshTopic('agent.started'), true);
  });

  test('matches the server DEFAULT_TOPICS feed (cross-package alignment)', () => {
    const serverPath = resolve(here, '../../api/src/streamEndpoints.ts');
    let source: string;
    try {
      source = readFileSync(serverPath, 'utf8');
    } catch {
      // apps/web tested in isolation — the monorepo server file is absent.
      return;
    }
    const block = source.match(/const DEFAULT_TOPICS[\s\S]*?=\s*\[([\s\S]*?)\];/);
    assert.ok(block, 'could not locate DEFAULT_TOPICS in streamEndpoints.ts');
    const serverTopics = [...block[1].matchAll(/'([a-z]+\.[a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(serverTopics.length > 0, 'DEFAULT_TOPICS parse produced no topics');
    assert.deepEqual(
      [...WAR_ROOM_REFRESH_TOPICS].sort(),
      [...serverTopics].sort(),
      'War Room refresh topics drifted from the server default feed',
    );
  });
});

describe('createRefreshBatcher', () => {
  test('collapses a burst of schedules into a single load', () => {
    const clock = makeClock();
    let loads = 0;
    const batcher = createRefreshBatcher(() => loads++, 250, clock.timers);

    batcher.schedule();
    batcher.schedule();
    batcher.schedule();
    batcher.schedule();
    batcher.schedule();
    assert.equal(loads, 0, 'must not load synchronously');
    clock.advance(250);
    assert.equal(loads, 1);
  });

  test('a schedule arriving after the window opens a new load', () => {
    const clock = makeClock();
    let loads = 0;
    const batcher = createRefreshBatcher(() => loads++, 250, clock.timers);

    batcher.schedule();
    clock.advance(250);
    assert.equal(loads, 1);

    batcher.schedule();
    clock.advance(250);
    assert.equal(loads, 2);
  });

  test('honours the configured delay', () => {
    const clock = makeClock();
    let loads = 0;
    const batcher = createRefreshBatcher(() => loads++, 250, clock.timers);

    batcher.schedule();
    clock.advance(249);
    assert.equal(loads, 0, 'must not fire before the delay elapses');
    clock.advance(1);
    assert.equal(loads, 1);
  });

  test('cancel drops a queued refresh', () => {
    const clock = makeClock();
    let loads = 0;
    const batcher = createRefreshBatcher(() => loads++, 250, clock.timers);

    batcher.schedule();
    batcher.cancel();
    clock.advance(1000);
    assert.equal(loads, 0);
    assert.equal(batcher.pending, false);
  });

  test('tracks pending state across the window', () => {
    const clock = makeClock();
    const batcher = createRefreshBatcher(() => undefined, 250, clock.timers);

    assert.equal(batcher.pending, false);
    batcher.schedule();
    assert.equal(batcher.pending, true);
    clock.advance(250);
    assert.equal(batcher.pending, false);
  });
});
