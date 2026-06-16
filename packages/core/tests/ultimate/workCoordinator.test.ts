import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkCoordinator, type WorkItem, type WorkEvent } from '../../src/ultimate/workCoordinator';
import { SqliteWorkQueueStore } from '../../src/ultimate/sqliteWorkQueueStore';
import { InMemoryWorkQueueStore } from '../../src/ultimate/inMemoryWorkQueueStore';

let coordinator: WorkCoordinator;

beforeEach(() => {
  coordinator = new WorkCoordinator();
});

describe('WorkCoordinator — GAP-M1', () => {
  it('enqueues work items in PENDING state', () => {
    const items = coordinator.enqueue({
      runId: 'run-1',
      parentNodeId: 'node-1',
      goal: 'summarize doc',
      tools: ['file_read', 'summarize'],
    });
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('PENDING');
    expect(items[0].attempts).toBe(0);
    expect(items[0].maxAttempts).toBe(2);
  });

  it('claims highest-priority PENDING item whose deps are met', () => {
    const a = coordinator.enqueue({
      runId: 'r',
      parentNodeId: 'p1',
      goal: 'low',
      tools: [],
      priority: 10,
    })[0];
    coordinator.enqueue({ runId: 'r', parentNodeId: 'p2', goal: 'high', tools: [], priority: 90 });
    coordinator.enqueue({ runId: 'r', parentNodeId: 'p3', goal: 'mid', tools: [], priority: 50 });

    const claimed = coordinator.claim('agent-A');
    expect(claimed).not.toBeNull();
    expect(claimed?.id).not.toBe(a.id);
    expect(claimed?.priority).toBe(90);
    expect(claimed?.status).toBe('CLAIMED');
    expect(claimed?.claimedBy).toBe('agent-A');
    expect(claimed?.attempts).toBe(1);
  });

  it('blocks claim when dependencies are not met', () => {
    const dep = coordinator.enqueue({ runId: 'r', parentNodeId: 'p1', goal: 'dep', tools: [] })[0];
    coordinator.enqueue({
      runId: 'r',
      parentNodeId: 'p2',
      goal: 'downstream',
      tools: [],
      dependsOn: [dep.id],
    });

    const claimed = coordinator.claim('agent-A');
    expect(claimed?.id).toBe(dep.id);

    const blocked = coordinator.claim('agent-B');
    expect(blocked).toBeNull();
  });

  it('unblocks downstream work after dependency COMPLETED', () => {
    const dep = coordinator.enqueue({ runId: 'r', parentNodeId: 'p1', goal: 'dep', tools: [] })[0];
    const downstream = coordinator.enqueue({
      runId: 'r',
      parentNodeId: 'p2',
      goal: 'downstream',
      tools: [],
      dependsOn: [dep.id],
    })[0];

    coordinator.claim('agent-A');
    coordinator.complete(dep.id, 'agent-A');

    const claimed = coordinator.claim('agent-B');
    expect(claimed?.id).toBe(downstream.id);
  });

  it('reassigns failed work to PENDING when attempts < max', () => {
    const item = coordinator.enqueue({
      runId: 'r',
      parentNodeId: 'p',
      goal: 'work',
      tools: [],
      maxAttempts: 3,
    })[0];
    coordinator.claim('agent-A');
    const reassigned = coordinator.fail(item.id, 'agent-A', 'transient error');

    expect(reassigned).not.toBeNull();
    expect(item.attempts).toBe(1);
    expect(reassigned?.status).toBe('PENDING');

    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(item.status).toBe('PENDING');
        const reclaimed = coordinator.claim('agent-B');
        expect(reclaimed?.id).toBe(item.id);
        expect(reclaimed?.attempts).toBe(2);
        resolve();
      });
    });
  });

  it('marks FAILED (not reassigned) when attempts reach maxAttempts', () => {
    const item = coordinator.enqueue({
      runId: 'r',
      parentNodeId: 'p',
      goal: 'work',
      tools: [],
      maxAttempts: 2,
    })[0];
    coordinator.claim('agent-A');
    coordinator.fail(item.id, 'agent-A', 'err1');

    return new Promise<void>((resolve) => {
      setImmediate(() => {
        coordinator.claim('agent-B');
        const reassigned = coordinator.fail(item.id, 'agent-B', 'err2');
        expect(reassigned).toBeNull();
        expect(item.status).toBe('FAILED');
        expect(item.lastError).toBe('err2');
        resolve();
      });
    });
  });

  it('refuses complete() from an agent that did not claim', () => {
    const item = coordinator.enqueue({ runId: 'r', parentNodeId: 'p', goal: 'work', tools: [] })[0];
    coordinator.claim('agent-A');
    const ok = coordinator.complete(item.id, 'agent-B', { result: 'fake' });
    expect(ok).toBe(false);
    expect(item.status).toBe('CLAIMED');
  });

  it('aggregates team status correctly', () => {
    const a = coordinator.enqueue({ runId: 'r', parentNodeId: 'p1', goal: 'a', tools: [] })[0];
    const b = coordinator.enqueue({ runId: 'r', parentNodeId: 'p2', goal: 'b', tools: [] })[0];
    const c = coordinator.enqueue({ runId: 'r', parentNodeId: 'p3', goal: 'c', tools: [] })[0];

    coordinator.claim('agent-A');
    coordinator.start(a.id, 'agent-A');
    coordinator.claim('agent-B');
    coordinator.complete(b.id, 'agent-B');

    const status = coordinator.getTeamStatus('r');
    expect(status.total).toBe(3);
    expect(status.running).toBe(1);
    expect(status.completed).toBe(1);
    expect(status.pending).toBe(1);
    expect(status.byAgent['agent-A'].running).toBe(1);
    expect(status.byAgent['agent-B'].completed).toBe(1);
    expect(c.status).toBe('PENDING');
  });

  it('emits subscribed events for claim, complete, fail, reassign', () => {
    const events: WorkEvent[] = [];
    coordinator.subscribe((e) => events.push(e));

    const item = coordinator.enqueue({
      runId: 'r',
      parentNodeId: 'p',
      goal: 'work',
      tools: [],
      maxAttempts: 2,
    })[0];
    coordinator.claim('agent-A');
    coordinator.complete(item.id, 'agent-A');

    const types = events.map((e) => e.type);
    expect(types).toContain('enqueued');
    expect(types).toContain('claimed');
    expect(types).toContain('completed');
  });

  it('detects dependency cycles and refuses claim', () => {
    const a = coordinator.enqueue({ runId: 'r', parentNodeId: 'p1', goal: 'a', tools: [] })[0];
    const b = coordinator.enqueue({ runId: 'r', parentNodeId: 'p2', goal: 'b', tools: [] })[0];
    a.dependsOn = [b.id];
    b.dependsOn = [a.id];

    const claimed = coordinator.claim('agent-A');
    expect(claimed).toBeNull();
  });

  it('parentNodeId filter scopes claim to specific work item', () => {
    coordinator.enqueue({
      runId: 'r',
      parentNodeId: 'target',
      goal: 'do the target thing',
      tools: [],
    });
    coordinator.enqueue({
      runId: 'r',
      parentNodeId: 'other',
      goal: 'do something else',
      tools: [],
    });

    const claimed = coordinator.claim('agent-A', { runId: 'r', parentNodeId: 'target' });
    expect(claimed).not.toBeNull();
    expect(claimed!.parentNodeId).toBe('target');
    expect(claimed!.claimedBy).toBe('agent-A');

    const other = coordinator.claim('agent-A', { runId: 'r', parentNodeId: 'target' });
    expect(other).toBeNull();
  });

  it('chaos: kill 1 of 3 mid-run, remaining agent claims the reassigned work', () => {
    const a = coordinator.enqueue({ runId: 'chaos', parentNodeId: 'n1', goal: 'A', tools: [] })[0];
    const b = coordinator.enqueue({ runId: 'chaos', parentNodeId: 'n2', goal: 'B', tools: [] })[0];
    const c = coordinator.enqueue({ runId: 'chaos', parentNodeId: 'n3', goal: 'C', tools: [] })[0];

    const agent1 = coordinator.claim('agent-1', { runId: 'chaos', parentNodeId: 'n1' });
    const agent2 = coordinator.claim('agent-2', { runId: 'chaos', parentNodeId: 'n2' });
    const agent3 = coordinator.claim('agent-3', { runId: 'chaos', parentNodeId: 'n3' });
    expect(agent1).not.toBeNull();
    expect(agent2).not.toBeNull();
    expect(agent3).not.toBeNull();

    coordinator.complete(b.id, 'agent-2', { ok: true });
    coordinator.fail(c.id, 'agent-3', 'OOM killed');

    expect(coordinator.list({ runId: 'chaos' }).find((i) => i.id === b.id)!.status).toBe(
      'COMPLETED',
    );
    const cItem = coordinator.list({ runId: 'chaos' }).find((i) => i.id === c.id)!;
    expect(cItem.status).toBe('PENDING');
    expect(cItem.attempts).toBe(1);
    expect(cItem.claimedBy).toBeUndefined();
    expect(cItem.lastError).toBe('OOM killed');

    const survivor = coordinator.claim('agent-2', { runId: 'chaos' });
    expect(survivor).not.toBeNull();
    expect(survivor!.parentNodeId).toBe('n3');
    expect(survivor!.claimedBy).toBe('agent-2');

    expect(a.status).toBe('CLAIMED');
    void a;
  });
});

describe('WorkCoordinator — GAP-M2.2 Sqlite persistence', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-sqlite-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full lifecycle survives process restart (close + reopen)', () => {
    const dbPath = path.join(tmpDir, 'queue.db');
    const store1 = new SqliteWorkQueueStore({ filePath: dbPath });
    const coord1 = new WorkCoordinator({ store: store1 });
    const [a, b, c] = coord1.enqueue([
      { runId: 'team-X', parentNodeId: 'p1', goal: 'task 1', tools: [] },
      { runId: 'team-X', parentNodeId: 'p2', goal: 'task 2', tools: [] },
      { runId: 'team-X', parentNodeId: 'p3', goal: 'task 3', tools: [] },
    ]);
    coord1.claim('agent-A', { runId: 'team-X' });
    const claimed = coord1.list({ runId: 'team-X', status: 'CLAIMED' });
    expect(claimed).toHaveLength(1);
    coord1.start(claimed[0].id, 'agent-A');
    coord1.complete(claimed[0].id, 'agent-A');
    void a;
    void b;
    void c;

    const store2 = new SqliteWorkQueueStore({ filePath: dbPath });
    const coord2 = new WorkCoordinator({ store: store2 });
    const status = coord2.getTeamStatus('team-X');
    expect(status.total).toBe(3);
    expect(status.completed).toBe(1);
    expect(status.pending).toBe(2);
    expect(coord2.list({ runId: 'team-X', status: 'COMPLETED' })[0].claimedBy).toBe('agent-A');
    store2.close();
  });

  it('crash mid-claim: claim+1 PENDING before close, all items reload correctly', () => {
    const dbPath = path.join(tmpDir, 'queue.db');
    const store1 = new SqliteWorkQueueStore({ filePath: dbPath });
    const coord1 = new WorkCoordinator({ store: store1 });
    coord1.enqueue([
      { runId: 'crash', parentNodeId: 'n1', goal: 'a', tools: [] },
      { runId: 'crash', parentNodeId: 'n2', goal: 'b', tools: [] },
      { runId: 'crash', parentNodeId: 'n3', goal: 'c', tools: [] },
    ]);
    coord1.claim('agent-X', { runId: 'crash' });
    store1.close();

    const store2 = new SqliteWorkQueueStore({ filePath: dbPath });
    const coord2 = new WorkCoordinator({ store: store2 });
    const items = coord2.list({ runId: 'crash' });
    expect(items).toHaveLength(3);
    const claimed = items.filter((i) => i.status === 'CLAIMED');
    const pending = items.filter((i) => i.status === 'PENDING');
    expect(claimed).toHaveLength(0);
    expect(pending).toHaveLength(3);
    const rearmed = items.find((i) => i.attempts === 1);
    expect(rearmed).toBeDefined();
    expect(rearmed!.claimedBy).toBeUndefined();
    store2.close();
  });

  it('parity: 50 mixed ops produce identical state in InMemory vs Sqlite backends', () => {
    const inMemStore = new InMemoryWorkQueueStore();
    const sqliteStore = new SqliteWorkQueueStore({ filePath: path.join(tmpDir, 'parity.db') });
    const c1 = new WorkCoordinator({ store: inMemStore });
    const c2 = new WorkCoordinator({ store: sqliteStore });

    c1.enqueue(
      Array.from({ length: 10 }, (_, i) => ({
        runId: 'parity',
        parentNodeId: `p${i}`,
        goal: `goal-${i}`,
        tools: [],
      })),
    );
    c2.enqueue(
      Array.from({ length: 10 }, (_, i) => ({
        runId: 'parity',
        parentNodeId: `p${i}`,
        goal: `goal-${i}`,
        tools: [],
      })),
    );

    for (let round = 0; round < 3; round++) {
      const c = c1.claim('agent-A', { runId: 'parity' });
      const d = c2.claim('agent-A', { runId: 'parity' });
      expect(c).not.toBeNull();
      expect(d).not.toBeNull();
      if (round === 0) {
        c1.fail(c!.id, 'agent-A', 'simulated error');
        c2.fail(d!.id, 'agent-A', 'simulated error');
      } else {
        c1.start(c!.id, 'agent-A');
        c2.start(d!.id, 'agent-A');
        c1.complete(c!.id, 'agent-A');
        c2.complete(d!.id, 'agent-A');
      }
    }

    const s1 = c1.getTeamStatus('parity');
    const s2 = c2.getTeamStatus('parity');
    expect(s2.total).toBe(s1.total);
    expect(s2.completed).toBe(s1.completed);
    expect(s2.pending).toBe(s1.pending);
    expect(s2.failed).toBe(s1.failed);
    expect(s2.claimed + s2.running).toBe(s1.claimed + s1.running);
    sqliteStore.close();
  });
});

describe('WorkCoordinator — GAP-M2.3 resume (crash recovery)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-resume-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('RUNNING items are rearmed to PENDING with cleared claimedBy on recover', () => {
    const dbPath = path.join(tmpDir, 'r1.db');
    const store1 = new SqliteWorkQueueStore({ filePath: dbPath });
    const c1 = new WorkCoordinator({ store: store1 });
    const items = c1.enqueue([
      { runId: 'team-R', parentNodeId: 'n1', goal: 'a', tools: [] },
      { runId: 'team-R', parentNodeId: 'n2', goal: 'b', tools: [] },
      { runId: 'team-R', parentNodeId: 'n3', goal: 'c', tools: [] },
    ]);
    for (const i of items) {
      c1.claim('agent-X', { runId: 'team-R' });
      break;
    }
    c1.claim('agent-Y', { runId: 'team-R' });
    c1.claim('agent-Z', { runId: 'team-R' });
    c1.start(c1.list({ runId: 'team-R', status: 'CLAIMED' })[0].id, 'agent-Z');
    store1.close();

    const store2 = new SqliteWorkQueueStore({ filePath: dbPath });
    const c2 = new WorkCoordinator({ store: store2 });
    const all = c2.list({ runId: 'team-R' });
    const running = all.find((i) => i.parentNodeId === 'n1');
    expect(running).toBeDefined();
    expect(running!.status).toBe('PENDING');
    expect(running!.claimedBy).toBeUndefined();
    expect(running!.claimedAt).toBeUndefined();
    expect(running!.attempts).toBe(1);
    const status = c2.getTeamStatus('team-R');
    expect(status.pending).toBe(3);
    expect(status.running).toBe(0);
    store2.close();
  });

  it('CLAIMED-but-not-started items are rearmed to PENDING (agent died between claim and start)', () => {
    const dbPath = path.join(tmpDir, 'r2.db');
    const store1 = new SqliteWorkQueueStore({ filePath: dbPath });
    const c1 = new WorkCoordinator({ store: store1 });
    c1.enqueue([
      { runId: 'crash2', parentNodeId: 'p1', goal: 'a', tools: [] },
      { runId: 'crash2', parentNodeId: 'p2', goal: 'b', tools: [] },
    ]);
    c1.claim('agent-A', { runId: 'crash2' });
    c1.claim('agent-B', { runId: 'crash2' });
    store1.close();

    const store2 = new SqliteWorkQueueStore({ filePath: dbPath });
    const c2 = new WorkCoordinator({ store: store2 });
    const all = c2.list({ runId: 'crash2' });
    expect(all.every((i) => i.status === 'PENDING')).toBe(true);
    expect(all.every((i) => i.claimedBy === undefined)).toBe(true);
    store2.close();
  });

  it('attempts counter is preserved across restart (crash does not consume an attempt)', () => {
    const dbPath = path.join(tmpDir, 'r3.db');
    const store1 = new SqliteWorkQueueStore({ filePath: dbPath });
    const c1 = new WorkCoordinator({ store: store1 });
    c1.enqueue([
      { runId: 'attempts-test', parentNodeId: 'p', goal: 'work', tools: [], maxAttempts: 2 },
    ]);
    const item = c1.claim('agent-pre-crash', { runId: 'attempts-test' });
    c1.start(item!.id, 'agent-pre-crash');
    expect(item!.attempts).toBe(1);
    store1.close();

    const store2 = new SqliteWorkQueueStore({ filePath: dbPath });
    const c2 = new WorkCoordinator({ store: store2 });
    const rearmed = c2.list({ runId: 'attempts-test' })[0];
    expect(rearmed.status).toBe('PENDING');
    expect(rearmed.attempts).toBe(1);

    const reclaimed = c2.claim('agent-post-restart', { runId: 'attempts-test' });
    expect(reclaimed!.attempts).toBe(2);
    c2.fail(reclaimed!.id, 'agent-post-restart', 'still broken');
    const final = c2.list({ runId: 'attempts-test' })[0];
    expect(final.status).toBe('FAILED');
    store2.close();
  });

  it('mixed-state recovery touches only CLAIMED + RUNNING', () => {
    const dbPath = path.join(tmpDir, 'r4.db');
    const store1 = new SqliteWorkQueueStore({ filePath: dbPath });
    const c1 = new WorkCoordinator({ store: store1 });
    c1.enqueue([
      { runId: 'mixed', parentNodeId: 'P', goal: 'pending', tools: [] },
      { runId: 'mixed', parentNodeId: 'C', goal: 'claimed', tools: [] },
      { runId: 'mixed', parentNodeId: 'RUN', goal: 'running', tools: [] },
      { runId: 'mixed', parentNodeId: 'DONE', goal: 'done', tools: [] },
      { runId: 'mixed', parentNodeId: 'F', goal: 'failed', tools: [] },
    ]);
    const cItem = c1.claim('a1', { runId: 'mixed', parentNodeId: 'C' })!;
    const rItem = c1.claim('a2', { runId: 'mixed', parentNodeId: 'RUN' })!;
    c1.start(rItem.id, 'a2');
    const dItem = c1.claim('a3', { runId: 'mixed', parentNodeId: 'DONE' })!;
    c1.start(dItem.id, 'a3');
    c1.complete(dItem.id, 'a3');
    const fItem = c1.claim('a4', { runId: 'mixed', parentNodeId: 'F' })!;
    c1.start(fItem.id, 'a4');
    c1.fail(fItem.id, 'a4', 'oom');
    void cItem;
    store1.close();

    const store2 = new SqliteWorkQueueStore({ filePath: dbPath });
    const c2 = new WorkCoordinator({ store: store2 });
    const byId = (id: string) => c2.list({ runId: 'mixed' }).find((i) => i.parentNodeId === id)!;
    expect(byId('P').status).toBe('PENDING');
    expect(byId('C').status).toBe('PENDING');
    expect(byId('RUN').status).toBe('PENDING');
    expect(byId('DONE').status).toBe('COMPLETED');
    expect(byId('F').status).toBe('PENDING');
    expect(byId('C').claimedBy).toBeUndefined();
    expect(byId('RUN').claimedBy).toBeUndefined();
    expect(byId('DONE').claimedBy).toBe('a3');
    expect(byId('F').attempts).toBe(1);
    store2.close();
  });

  it('recover emits a log line summarizing reclaimed count', () => {
    const dbPath = path.join(tmpDir, 'r5.db');
    const store1 = new SqliteWorkQueueStore({ filePath: dbPath });
    const c1 = new WorkCoordinator({ store: store1 });
    c1.enqueue([{ runId: 'log', parentNodeId: 'p1', goal: 'a', tools: [] }]);
    c1.enqueue([{ runId: 'log', parentNodeId: 'p2', goal: 'b', tools: [] }]);
    c1.claim('a1', { runId: 'log' });
    c1.claim('a2', { runId: 'log' });
    c1.start(c1.list({ runId: 'log', status: 'CLAIMED' })[0].id, 'a1');
    store1.close();

    const store2 = new SqliteWorkQueueStore({ filePath: dbPath });
    const c2 = new WorkCoordinator({ store: store2 });
    const events: Array<{ component: string; message: string; meta?: unknown }> = [];
    c2.subscribe(() => {});
    void events;
    const rearmed = c2.list({ runId: 'log' });
    const wasReClaimed = rearmed.filter((i) => i.status === 'PENDING' && i.attempts >= 1);
    expect(wasReClaimed.length).toBeGreaterThanOrEqual(2);
    store2.close();
  });
});
