/**
 * Execution Lane Tests
 *
 * Covers: LaneManager, lane routing, slot acquisition/release,
 * lane-pinned backend selection, and default lane behavior.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { LaneManager, getLaneManager, resetLaneManager } from '../src/sandbox/lane';
import type { ExecutionLaneConfig, LaneContext } from '../src/sandbox/lane';
import { ExecutionRouter } from '../src/sandbox/executionRouter';
import { resetHookManager } from '../src/pluginManager';
import type { ExecutionBackend } from '../src/sandbox/types';

function freshLaneManager(): LaneManager {
  resetLaneManager();
  return getLaneManager();
}

class TestBackend implements ExecutionBackend {
  readonly type = 'local' as const;
  readonly available = true;
  constructor(public readonly name: string) {}
  async execute(cmd: string) {
    return { stdout: `${this.name}: ${cmd}`, stderr: '', exitCode: 0, durationMs: 0, sandboxMechanism: 'none' as const };
  }
}

// ============================================================================
// Default lane
// ============================================================================
describe('Default lane', () => {
  it('exists on fresh LaneManager', () => {
    const lm = freshLaneManager();
    const lane = lm.getLane('default');
    assert.ok(lane);
    assert.strictEqual(lane.config.name, 'default');
    assert.strictEqual(lane.config.maxConcurrency, 100);
    assert.strictEqual(lane.config.priority, 5);
  });

  it('routes to default lane when no other lane matches', () => {
    const lm = freshLaneManager();
    const lane = lm.selectLane({ agentId: 'a1' });
    assert.strictEqual(lane.config.name, 'default');
  });
});

// ============================================================================
// Lane registration
// ============================================================================
describe('Lane registration', () => {
  let lm: LaneManager;

  beforeEach(() => { lm = freshLaneManager(); });

  it('registers a new lane', () => {
    lm.registerLane({ name: 'high-priority', maxConcurrency: 3, priority: 1 });
    const lane = lm.getLane('high-priority');
    assert.ok(lane);
    assert.strictEqual(lane.config.maxConcurrency, 3);
    assert.strictEqual(lane.config.priority, 1);
  });

  it('getLaneNames returns all lane names', () => {
    lm.registerLane({ name: 'lane-a', maxConcurrency: 2, priority: 5 });
    lm.registerLane({ name: 'lane-b', maxConcurrency: 4, priority: 3 });
    const names = lm.getLaneNames();
    assert.ok(names.includes('default'));
    assert.ok(names.includes('lane-a'));
    assert.ok(names.includes('lane-b'));
  });

  it('getAllLanes returns lanes sorted by priority (ascending)', () => {
    lm.registerLane({ name: 'low-pri', maxConcurrency: 2, priority: 10 });
    lm.registerLane({ name: 'high-pri', maxConcurrency: 2, priority: 1 });
    lm.registerLane({ name: 'mid-pri', maxConcurrency: 2, priority: 5 });
    const lanes = lm.getAllLanes();
    // high-pri (1) → default (5) → mid-pri (5) → low-pri (10)
    assert.ok(lanes[0].config.priority <= lanes[1].config.priority);
    assert.ok(lanes[1].config.priority <= lanes[2].config.priority);
  });

  it('unregisterLane removes a lane', () => {
    lm.registerLane({ name: 'temp', maxConcurrency: 1, priority: 5 });
    assert.ok(lm.getLane('temp'));
    assert.ok(lm.unregisterLane('temp'));
    assert.strictEqual(lm.getLane('temp'), undefined);
  });

  it('unregisterLane cannot remove default lane', () => {
    assert.strictEqual(lm.unregisterLane('default'), false);
    assert.ok(lm.getLane('default'));
  });

  it('unregisterLane fails if lane has active executions', () => {
    lm.registerLane({ name: 'busy', maxConcurrency: 5, priority: 5 });
    const lane = lm.getLane('busy')!;
    lane.runningCount = 2;
    assert.strictEqual(lm.unregisterLane('busy'), false);
  });
});

// ============================================================================
// Lane routing
// ============================================================================
describe('Lane routing', () => {
  let lm: LaneManager;

  beforeEach(() => {
    lm = freshLaneManager();
    lm.registerLane({ name: 'tenant-a', maxConcurrency: 3, priority: 2, tenantIds: ['tenant-1'] });
    lm.registerLane({ name: 'tenant-b', maxConcurrency: 2, priority: 3, tenantIds: ['tenant-2'] });
  });

  it('routes by tenantId', () => {
    const lane = lm.selectLane({ agentId: 'a1', tenantId: 'tenant-1' });
    assert.strictEqual(lane.config.name, 'tenant-a');
  });

  it('routes different tenant to different lane', () => {
    const lane = lm.selectLane({ agentId: 'a1', tenantId: 'tenant-2' });
    assert.strictEqual(lane.config.name, 'tenant-b');
  });

  it('routes unknown tenant to default lane', () => {
    const lane = lm.selectLane({ agentId: 'a1', tenantId: 'tenant-unknown' });
    assert.strictEqual(lane.config.name, 'default');
  });

  it('routes by explicit lane arg', () => {
    const lane = lm.selectLane({ agentId: 'a1', args: { lane: 'tenant-b' } });
    assert.strictEqual(lane.config.name, 'tenant-b');
  });

  it('explicit lane arg overrides tenant routing', () => {
    const lane = lm.selectLane({ agentId: 'a1', tenantId: 'tenant-1', args: { lane: 'tenant-b' } });
    assert.strictEqual(lane.config.name, 'tenant-b');
  });

  it('no tenant and no args routes to default', () => {
    const lane = lm.selectLane({ agentId: 'a1' });
    assert.strictEqual(lane.config.name, 'default');
  });
});

// ============================================================================
// Custom lane selectors
// ============================================================================
describe('Custom lane selectors', () => {
  let lm: LaneManager;

  beforeEach(() => {
    lm = freshLaneManager();
    lm.registerLane({ name: 'research', maxConcurrency: 2, priority: 3 });
  });

  it('custom selector runs before built-in selectors', () => {
    lm.addSelector((ctx) => {
      if (ctx.toolName === 'web_search') return 'research';
      return null;
    });

    const lane = lm.selectLane({ agentId: 'a1', toolName: 'web_search' });
    assert.strictEqual(lane.config.name, 'research');
  });

  it('custom selector returning null falls through to built-in', () => {
    lm.addSelector(() => null);

    const lane = lm.selectLane({ agentId: 'a1' });
    assert.strictEqual(lane.config.name, 'default');
  });

  it('selector errors are caught and do not break routing', () => {
    lm.addSelector(() => { throw new Error('oops'); });

    const lane = lm.selectLane({ agentId: 'a1' });
    assert.strictEqual(lane.config.name, 'default');
  });
});

// ============================================================================
// Slot acquisition and release
// ============================================================================
describe('Slot acquisition and release', () => {
  let lm: LaneManager;

  beforeEach(() => { lm = freshLaneManager(); });

  it('acquires a slot and increments running count', async () => {
    const laneName = await lm.acquireSlot({ agentId: 'a1' });
    assert.strictEqual(laneName, 'default');
    const lane = lm.getLane('default')!;
    assert.strictEqual(lane.runningCount, 1);
    assert.strictEqual(lane.totalEnqueued, 1);
  });

  it('releases a slot and decrements running count', async () => {
    await lm.acquireSlot({ agentId: 'a1' });
    lm.releaseSlot('default');
    const lane = lm.getLane('default')!;
    assert.strictEqual(lane.runningCount, 0);
    assert.strictEqual(lane.totalCompleted, 1);
  });

  it('blocks when lane is at max concurrency', async () => {
    const lane = lm.getLane('default')!;
    lane.config.maxConcurrency = 1; // only 1 slot

    // Acquire the only slot
    await lm.acquireSlot({ agentId: 'a1' });
    assert.strictEqual(lane.runningCount, 1);

    // Try to acquire again — should wait
    const waitPromise = lm.acquireSlot({ agentId: 'a2' });
    // Should not have resolved yet
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(lane.runningCount, 1); // still 1
    assert.strictEqual(lane.waitingQueue.length, 1); // 1 waiting

    // Release the slot — waiter should proceed
    lm.releaseSlot('default');
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(lane.runningCount, 1); // now 1 again (new one took over)
    assert.strictEqual(lane.waitingQueue.length, 0);
  });

  it('acquireNamedSlot on unknown lane returns false', async () => {
    const result = await lm.acquireNamedSlot('nonexistent');
    assert.strictEqual(result, false);
  });

  it('acquireNamedSlot works on existing lane', async () => {
    const result = await lm.acquireNamedSlot('default');
    assert.strictEqual(result, true);
    assert.strictEqual(lm.getLane('default')!.runningCount, 1);
  });

  it('releaseSlot on unknown lane is a no-op', () => {
    // Should not throw
    lm.releaseSlot('nonexistent');
    assert.ok(true);
  });

  it('tracks totalEnqueued and totalCompleted', async () => {
    await lm.acquireSlot({ agentId: 'a1' });
    await lm.acquireSlot({ agentId: 'a2' });
    lm.releaseSlot('default');
    lm.releaseSlot('default');

    const lane = lm.getLane('default')!;
    assert.strictEqual(lane.totalEnqueued, 2);
    assert.strictEqual(lane.totalCompleted, 2);
  });
});

// ============================================================================
// Lane statistics
// ============================================================================
describe('Lane statistics', () => {
  let lm: LaneManager;

  beforeEach(() => { lm = freshLaneManager(); });

  it('getStats returns all lanes with correct fields', () => {
    lm.registerLane({ name: 'worker', maxConcurrency: 4, priority: 2, backendName: 'worker-pool', tenantIds: ['t1'] });
    const stats = lm.getStats();
    const worker = stats.find(s => s.name === 'worker');
    assert.ok(worker);
    assert.strictEqual(worker.maxConcurrency, 4);
    assert.strictEqual(worker.priority, 2);
    assert.strictEqual(worker.backendName, 'worker-pool');
    assert.deepStrictEqual(worker.tenantIds, ['t1']);
    assert.strictEqual(worker.running, 0);
    assert.strictEqual(worker.waiting, 0);
  });

  it('stats reflect current runtime state', async () => {
    lm.registerLane({ name: 'busy', maxConcurrency: 1, priority: 1 });
    await lm.acquireSlot({ agentId: 'a1', args: { lane: 'busy' } });

    const stats = lm.getStats();
    const busy = stats.find(s => s.name === 'busy')!;
    assert.strictEqual(busy.running, 1);
    assert.strictEqual(busy.totalEnqueued, 1);
  });
});

// ============================================================================
// Lane-pinned backend via getLaneBackend
// ============================================================================
describe('getLaneBackend', () => {
  let lm: LaneManager;

  beforeEach(() => { lm = freshLaneManager(); });

  it('returns undefined for default lane (no pinned backend)', () => {
    const backend = lm.getLaneBackend({ agentId: 'a1' });
    assert.strictEqual(backend, undefined);
  });

  it('returns backend name when lane has pinned backend', () => {
    lm.registerLane({ name: 'pinned-lane', maxConcurrency: 2, priority: 1, backendName: 'prod-cluster' });
    const backend = lm.getLaneBackend({ agentId: 'a1', args: { lane: 'pinned-lane' } });
    assert.strictEqual(backend, 'prod-cluster');
  });

  it('returns undefined for unknown lane name in args', () => {
    const backend = lm.getLaneBackend({ agentId: 'a1', args: { lane: 'nonexistent' } });
    // Falls through to default lane which has no pinned backend
    assert.strictEqual(backend, undefined);
  });
});

// ============================================================================
// Lane + ExecutionRouter integration
// ============================================================================
describe('Lane + ExecutionRouter integration', () => {
  let lm: LaneManager;
  let router: ExecutionRouter;

  beforeEach(() => {
    lm = freshLaneManager();
    router = new ExecutionRouter();
    resetHookManager();
  });

  it('selectBackend uses lane-pinned backend when matched', async () => {
    const backend = new TestBackend('lane-backend');
    router.registerBackend('lane-backend', backend);
    lm.registerLane({ name: 'ssh-lane', maxConcurrency: 2, priority: 1, backendName: 'lane-backend', tenantIds: ['t1'] });

    const result = await router.selectBackend({
      _toolName: 'shell_execute',
      _tenantId: 't1',
      _agentId: 'a1',
    });
    assert.strictEqual(result, backend);
  });

  it('selectBackend does not use lane backend if lane has no pin', async () => {
    const result = await router.selectBackend({ _toolName: 'shell_execute', _agentId: 'a1' });
    assert.strictEqual(result.type, 'local');
  });

  it('selectBackend ignores lane pin if no registered backend matches', async () => {
    lm.registerLane({ name: 'broken-lane', maxConcurrency: 2, priority: 1, backendName: 'nonexistent-backend' });

    const result = await router.selectBackend({ _toolName: 'shell_execute', _agentId: 'a1', args: { lane: 'broken-lane' } });
    assert.strictEqual(result.type, 'local');
  });

  it('explicit backend_name in args overrides lane pinning', async () => {
    const explicitBackend = new TestBackend('explicit');
    const laneBackend = new TestBackend('lane-pin');
    router.registerBackend('explicit', explicitBackend);
    router.registerBackend('lane-pin', laneBackend);
    lm.registerLane({ name: 'pinned', maxConcurrency: 2, priority: 1, backendName: 'lane-pin' });

    const result = await router.selectBackend({
      _toolName: 'shell_execute', _agentId: 'a1',
      backend_name: 'explicit',
      args: { lane: 'pinned' },
    });
    assert.strictEqual(result, explicitBackend);
  });
});

// ============================================================================
// resetLaneManager
// ============================================================================
describe('resetLaneManager', () => {
  it('clears all lanes and recreates default', () => {
    const lm = freshLaneManager();
    lm.registerLane({ name: 'custom', maxConcurrency: 1, priority: 1 });
    assert.strictEqual(lm.getLaneNames().length, 2);

    resetLaneManager();
    const newLm = getLaneManager();
    assert.strictEqual(newLm.getLaneNames().length, 1);
    assert.ok(newLm.getLane('default'));
  });
});
