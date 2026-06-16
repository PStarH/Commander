import { describe, it, beforeEach, expect } from 'vitest';
import { LaneManager } from '../../src/sandbox/lane';

describe('LaneManager', () => {
  let manager: LaneManager;

  beforeEach(() => {
    manager = new LaneManager(100);
  });

  describe('default lane', () => {
    it('creates a default lane on construction', () => {
      const names = manager.getLaneNames();
      expect(names).toContain('default');
    });

    it('default lane has configured max concurrency', () => {
      const lane = manager.getLane('default');
      expect(lane).toBeDefined();
      expect(lane!.config.maxConcurrency).toBe(100);
    });
  });

  describe('registerLane', () => {
    it('registers a new lane', () => {
      manager.registerLane({ name: 'test-lane', maxConcurrency: 5, priority: 3 });
      const lane = manager.getLane('test-lane');
      expect(lane).toBeDefined();
      expect(lane!.config.maxConcurrency).toBe(5);
      expect(lane!.config.priority).toBe(3);
    });

    it('updates existing lane config', () => {
      manager.registerLane({ name: 'updatable', maxConcurrency: 5, priority: 3 });
      manager.registerLane({ name: 'updatable', maxConcurrency: 10, priority: 1 });
      const lane = manager.getLane('updatable');
      expect(lane).toBeDefined();
      expect(lane!.config.maxConcurrency).toBe(10);
      expect(lane!.config.priority).toBe(1);
    });
  });

  describe('unregisterLane', () => {
    it('removes a lane', () => {
      manager.registerLane({ name: 'removable', maxConcurrency: 5, priority: 3 });
      expect(manager.getLane('removable')).toBeDefined();
      manager.unregisterLane('removable');
      expect(manager.getLane('removable')).toBeUndefined();
    });

    it('cannot remove the default lane', () => {
      expect(manager.unregisterLane('default')).toBe(false);
    });

    it('returns false for non-existent lane', () => {
      expect(manager.unregisterLane('nonexistent')).toBe(false);
    });
  });

  describe('selectLane', () => {
    it('routes to default lane when no specific lane matches', () => {
      const lane = manager.selectLane({ agentId: 'agent-1' });
      expect(lane.config.name).toBe('default');
    });

    it('routes by explicit lane arg', () => {
      manager.registerLane({ name: 'explicit-lane', maxConcurrency: 5, priority: 3 });
      const lane = manager.selectLane({
        agentId: 'agent-1',
        args: { lane: 'explicit-lane' },
      });
      expect(lane.config.name).toBe('explicit-lane');
    });

    it('routes by tenant id', () => {
      manager.registerLane({
        name: 'tenant-lane',
        maxConcurrency: 5,
        priority: 3,
        tenantIds: ['tenant-1'],
      });
      const lane = manager.selectLane({
        agentId: 'agent-1',
        tenantId: 'tenant-1',
      });
      expect(lane.config.name).toBe('tenant-lane');
    });

    it('falls back to default when tenant has no specific lane', () => {
      manager.registerLane({
        name: 'tenant-lane',
        maxConcurrency: 5,
        priority: 3,
        tenantIds: ['tenant-1'],
      });
      const lane = manager.selectLane({
        agentId: 'agent-1',
        tenantId: 'tenant-999',
      });
      expect(lane.config.name).toBe('default');
    });

    it('custom selectors take precedence', () => {
      manager.registerLane({ name: 'custom-lane', maxConcurrency: 5, priority: 3 });
      manager.addSelector(() => 'custom-lane');
      const lane = manager.selectLane({ agentId: 'agent-1' });
      expect(lane.config.name).toBe('custom-lane');
    });
  });

  describe('acquireSlot / releaseSlot', () => {
    it('acquires a slot when under capacity', async () => {
      manager.registerLane({ name: 'test', maxConcurrency: 2, priority: 3 });
      const laneName = await manager.acquireSlot({
        agentId: 'agent-1',
        args: { lane: 'test' },
      });
      expect(laneName).toBe('test');
      const lane = manager.getLane('test');
      expect(lane).toBeDefined();
      expect(lane!.runningCount).toBe(1);
      manager.releaseSlot('test');
    });

    it('releases a slot', async () => {
      manager.registerLane({ name: 'test', maxConcurrency: 2, priority: 3 });
      await manager.acquireSlot({ agentId: 'agent-1', args: { lane: 'test' } });
      manager.releaseSlot('test');
      const lane = manager.getLane('test');
      expect(lane).toBeDefined();
      expect(lane!.runningCount).toBe(0);
      expect(lane!.totalCompleted).toBe(1);
    });

    it('transfers slot to waiting queue on release', async () => {
      manager.registerLane({ name: 'test', maxConcurrency: 1, priority: 3 });
      await manager.acquireSlot({ agentId: 'agent-1', args: { lane: 'test' } });
      const p2 = manager.acquireSlot({ agentId: 'agent-2', args: { lane: 'test' } });
      manager.releaseSlot('test');
      const laneName = await p2;
      expect(laneName).toBe('test');
      manager.releaseSlot('test');
    });

    it('acquireSlot waits when lane is full and resolves on release', async () => {
      manager.registerLane({ name: 'full-lane', maxConcurrency: 1, priority: 3 });
      const acquired = await manager.acquireSlot({
        agentId: 'agent-1',
        args: { lane: 'full-lane' },
      });
      expect(acquired).toBe('full-lane');
      // Second acquire should wait (not return immediately)
      let resolved = false;
      const p2 = manager
        .acquireSlot({ agentId: 'agent-2', args: { lane: 'full-lane' } })
        .then((r) => {
          resolved = true;
          return r;
        });
      // Verify it hasn't resolved yet (next microtask)
      await new Promise((r) => setTimeout(r, 5));
      expect(resolved).toBe(false);
      // Release should unblock
      manager.releaseSlot('full-lane');
      const laneName = await p2;
      expect(laneName).toBe('full-lane');
      expect(resolved).toBe(true);
      manager.releaseSlot('full-lane');
    });
  });

  describe('acquireNamedSlot', () => {
    it('acquires a named slot', async () => {
      manager.registerLane({ name: 'named', maxConcurrency: 2, priority: 3 });
      const result = await manager.acquireNamedSlot('named');
      expect(result).toBe(true);
      manager.releaseSlot('named');
    });

    it('returns false for non-existent lane', async () => {
      const result = await manager.acquireNamedSlot('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('getStats', () => {
    it('returns stats for all lanes', () => {
      manager.registerLane({ name: 'stats-lane', maxConcurrency: 5, priority: 3 });
      const stats = manager.getStats();
      expect(stats.length).toBeGreaterThanOrEqual(2);
      const laneStats = stats.find((s) => s.name === 'stats-lane');
      expect(laneStats).toBeDefined();
      expect(laneStats!.maxConcurrency).toBe(5);
      expect(laneStats!.running).toBe(0);
    });
  });

  describe('getLaneBackend', () => {
    it('returns backend name for pinned lane', () => {
      manager.registerLane({
        name: 'pinned',
        maxConcurrency: 5,
        priority: 3,
        backendName: 'gpu-cluster',
      });
      const backend = manager.getLaneBackend({
        agentId: 'agent-1',
        args: { lane: 'pinned' },
      });
      expect(backend).toBe('gpu-cluster');
    });

    it('returns undefined for default lane', () => {
      const backend = manager.getLaneBackend({ agentId: 'agent-1' });
      expect(backend).toBeUndefined();
    });
  });

  describe('reset', () => {
    it('resets to default state', () => {
      manager.registerLane({ name: 'temp', maxConcurrency: 5, priority: 3 });
      manager.addSelector(() => 'temp');
      manager.reset();
      expect(manager.getLaneNames()).toEqual(['default']);
    });
  });

  describe('getAllLanes sorted by priority', () => {
    it('returns lanes sorted by priority ascending', () => {
      manager.registerLane({ name: 'high', maxConcurrency: 5, priority: 1 });
      manager.registerLane({ name: 'low', maxConcurrency: 5, priority: 9 });
      const lanes = manager.getAllLanes();
      expect(lanes[0].config.name).toBe('high');
    });
  });
});
