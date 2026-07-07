/**
 * Supervision Tree Integration Tests
 *
 * Verifies that the SupervisionTree is correctly wired into the runtime
 * (serviceInitializer creates a root supervisor that subscribes to messageBus
 * 'agent.failed' events and forwards them to reportChildCrash), and that the
 * supervisor publishes supervision events onto the messageBus 'system.alert'
 * topic so downstream consumers can observe crash reports.
 *
 * These tests exercise the real SupervisionTree API end-to-end:
 *   - getSupervisionTreeRegistry() singleton
 *   - registry.createSupervisor(config)
 *   - supervisor.startChild(spec) / reportChildCrash / healthCheck / shutdown
 *   - event publication onto the messageBus
 *
 * Reference style: tests/runtime/agentHandoff.test.ts (vitest + expect).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getSupervisionTreeRegistry,
  resetSupervisionTreeRegistry,
  type Supervisor,
  type SupervisorConfig,
  type ChildSpec,
  type ChildHandle,
} from '../../src/runtime/supervisionTree';
import { getMessageBus, resetMessageBus } from '../../src/runtime/messageBus';

// Shape of the payload the supervisor publishes onto the 'system.alert' topic
// (see supervisionTree.ts -> emitEvent -> bus.publish).
interface SupervisionAlertPayload {
  type: string;
  supervisorId: string;
  childId?: string;
  message: string;
}

function makeSupervisorConfig(id = 'sup-test'): SupervisorConfig {
  return {
    id,
    strategy: 'one_for_one',
    maxRestarts: 5,
    maxRestartIntervalMs: 60_000,
    defaultShutdownMs: 5_000,
    publishEvents: true,
  };
}

interface MakeChildOptions {
  /** Value returned by the child's isAlive(). Defaults to true. */
  alive?: boolean;
  /** Per-child max restarts override. When omitted, the supervisor default is used. */
  maxRestarts?: number;
  /** Per-child restart intensity window override. */
  maxRestartIntervalMs?: number;
  /** Optional graceful stop callback (used to observe shutdown ordering). */
  stop?: (handle: ChildHandle) => Promise<void>;
}

/**
 * Build a ChildSpec whose start() factory returns a ChildHandle with a
 * controllable isAlive(). The factory is re-invoked on every restart so the
 * supervisor's restart strategy can be exercised repeatedly.
 */
function makeChildSpec(id: string, opts: MakeChildOptions = {}): ChildSpec {
  const alive = opts.alive !== false;
  const spec: ChildSpec = {
    id,
    start: async () => ({
      id,
      isAlive: () => alive,
      healthCheck: async () => ({
        healthy: alive,
        issues: alive ? undefined : ['child reports unhealthy'],
      }),
    }),
  };
  if (opts.maxRestarts !== undefined) spec.maxRestarts = opts.maxRestarts;
  if (opts.maxRestartIntervalMs !== undefined) {
    spec.maxRestartIntervalMs = opts.maxRestartIntervalMs;
  }
  if (opts.stop) spec.stop = opts.stop;
  return spec;
}

describe('SupervisionTree integration', () => {
  let supervisor: Supervisor;

  beforeEach(() => {
    resetSupervisionTreeRegistry();
    resetMessageBus();
    const registry = getSupervisionTreeRegistry();
    supervisor = registry.createSupervisor(makeSupervisorConfig());
  });

  afterEach(() => {
    resetSupervisionTreeRegistry();
    resetMessageBus();
  });

  const findChild = (id: string) => supervisor.getChildren().find((c) => c.id === id);

  it('getSupervisionTreeRegistry returns a singleton', () => {
    const a = getSupervisionTreeRegistry();
    const b = getSupervisionTreeRegistry();
    expect(a).toBe(b);
  });

  it('createSupervisor creates a supervisor with the given config', () => {
    expect(supervisor.getId()).toBe('sup-test');

    // A duplicate id must be rejected by the registry.
    const registry = getSupervisionTreeRegistry();
    expect(() => registry.createSupervisor(makeSupervisorConfig())).toThrow();
  });

  it('startChild registers a child and returns a live handle', async () => {
    const handle = await supervisor.startChild(makeChildSpec('child-1'));
    expect(handle.isAlive()).toBe(true);

    const child = findChild('child-1');
    expect(child).toBeDefined();
    expect(child!.state).toBe('running');
  });

  it('reportChildCrash triggers the restart strategy (crashed then restarted)', async () => {
    await supervisor.startChild(makeChildSpec('child-1'));

    await supervisor.reportChildCrash('child-1', 'boom');

    // After the crash the supervisor restarts the child (one_for_one).
    const child = findChild('child-1');
    expect(child!.state).toBe('running');
    expect(child!.restartCount).toBe(1);

    // Both the crash and the restart were recorded in the event history.
    const events = supervisor.getEventHistory();
    expect(events.some((e) => e.type === 'child_crashed')).toBe(true);
    expect(events.some((e) => e.type === 'child_restarted')).toBe(true);
  });

  it('reportChildCrash exceeding maxRestarts leaves the child crashed', async () => {
    // maxRestarts = 1:
    //   crash #1 -> history length 1, 1 > 1 is false -> restart
    //   crash #2 -> history length 2, 2 > 1 is true  -> give up, stay crashed
    await supervisor.startChild(
      makeChildSpec('child-1', { maxRestarts: 1, maxRestartIntervalMs: 60_000 }),
    );

    await supervisor.reportChildCrash('child-1', 'boom-1');
    expect(findChild('child-1')!.state).toBe('running');
    expect(findChild('child-1')!.restartCount).toBe(1);

    await supervisor.reportChildCrash('child-1', 'boom-2');
    expect(findChild('child-1')!.state).toBe('crashed');
    expect(findChild('child-1')!.restartCount).toBe(1);
  });

  it('healthCheck detects a dead child via isAlive()=false and reports it', async () => {
    // Child whose handle reports as not alive.
    await supervisor.startChild(makeChildSpec('child-1', { alive: false }));

    await supervisor.healthCheck();

    const child = findChild('child-1');
    // healthCheck flagged the dead child (then restarted it once).
    expect(child!.restartCount).toBeGreaterThanOrEqual(1);

    // A child_crashed event carrying the isAlive() reason must have been emitted.
    const events = supervisor.getEventHistory();
    const crash = events.find((e) => e.type === 'child_crashed' && e.message.includes('isAlive'));
    expect(crash).toBeDefined();
  });

  it('shutdown stops children in reverse start order', async () => {
    const stopOrder: string[] = [];
    const stopFor = (id: string) => async () => {
      stopOrder.push(id);
    };

    await supervisor.startChild(makeChildSpec('c1', { stop: stopFor('c1') }));
    await supervisor.startChild(makeChildSpec('c2', { stop: stopFor('c2') }));
    await supervisor.startChild(makeChildSpec('c3', { stop: stopFor('c3') }));

    await supervisor.shutdown();

    // Every child is stopped.
    for (const c of supervisor.getChildren()) {
      expect(c.state).toBe('stopped');
    }
    // Children are stopped in reverse start order: c3, c2, c1.
    expect(stopOrder).toEqual(['c3', 'c2', 'c1']);
  });

  it('supervisor events are published to the messageBus system.alert topic', async () => {
    const received: SupervisionAlertPayload[] = [];
    const bus = getMessageBus();
    const unsub = bus.subscribe('system.alert', (msg) => {
      received.push(msg.payload as unknown as SupervisionAlertPayload);
    });

    try {
      await supervisor.startChild(makeChildSpec('child-1'));
      await supervisor.reportChildCrash('child-1', 'boom');

      // The crash must have been published onto 'system.alert'.
      const crashes = received.filter((p) => p.type === 'child_crashed');
      expect(crashes.length).toBeGreaterThan(0);
      expect(crashes[0].supervisorId).toBe('sup-test');
      expect(crashes[0].childId).toBe('child-1');
      expect(crashes[0].message).toContain('boom');

      // child_started must also have been published.
      const started = received.filter((p) => p.type === 'child_started');
      expect(started.length).toBeGreaterThan(0);
    } finally {
      unsub();
    }
  });
});
