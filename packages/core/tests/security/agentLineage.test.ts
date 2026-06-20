/**
 * AgentLineage tests — Phase 2.2
 *
 * Coverage:
 *   - spawnChild creates node with correct parent→child linkage
 *   - parent→children index is maintained correctly
 *   - getLineage returns full tree from any node
 *   - getAncestorChain returns path to root
 *   - getChildren returns direct children
 *   - findRoot finds the root of any tree
 *   - terminate marks node as revoked
 *   - revokeTree revokes entire subtree
 *   - recordHandoff writes handoff to audit chain
 *   - stats API returns correct counts
 *   - audit chain integration (spawn, terminate, revoke events are chained)
 *   - tenant isolation via singleton
 *   - reset clears all state
 *   - depth tracking across multi-level trees
 *   - query by runId
 *   - max depth traversal cap
 *   - concurrent spawns don't corrupt state
 */
import { describe, test, beforeAll, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  AgentLineage,
  getAgentLineage,
  resetAgentLineage,
} from '../../src/security/agentLineage';
import { getAuditChainLedger, resetAuditChainLedger } from '../../src/security/auditChainLedger';

function makeLineage(): AgentLineage {
  return new AgentLineage();
}

describe('AgentLineage', () => {

beforeAll(() => {
  resetAgentLineage();
  resetAuditChainLedger();
});

afterEach(() => {
  resetAgentLineage();
  resetAuditChainLedger();
});

// ── spawnChild ──────────────────────────────────────────────────────────

test('spawnChild creates a root node with depth 0', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'orchestrator-agent', {
    runId: 'run-1',
    scope: { tools: ['web_search', 'file_read'] },
  });
  assert.equal(root.parentInstanceId, null);
  assert.equal(root.agentId, 'orchestrator-agent');
  assert.equal(root.depth, 0);
  assert.deepEqual(root.scope.tools, ['web_search', 'file_read']);
  assert.equal(typeof root.instanceId, 'string');
  assert.ok(root.instanceId.length > 10);
  assert.equal(root.revokedAt, undefined);
});

test('spawnChild creates a child with correct parent linkage', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'root', { runId: 'run-1' });
  const child = lineage.spawnChild(root.instanceId, 'child', {
    runId: 'run-1',
    scope: { tools: ['file_read'] },
  });
  assert.equal(child.parentInstanceId, root.instanceId);
  assert.equal(child.depth, 1);
});

test('spawnChild computes depth from parent node', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'root');
  const child1 = lineage.spawnChild(root.instanceId, 'child1');
  const child2 = lineage.spawnChild(child1.instanceId, 'child2');
  assert.equal(root.depth, 0);
  assert.equal(child1.depth, 1);
  assert.equal(child2.depth, 2);
});

test('spawnChild stores role and metadata', () => {
  const lineage = makeLineage();
  const node = lineage.spawnChild(null, 'agent-x', {
    role: 'researcher',
    metadata: { goalSnippet: 'Analyze codebase', modelTier: 'standard' },
  });
  assert.equal(node.role, 'researcher');
  assert.equal(node.metadata?.goalSnippet, 'Analyze codebase');
  assert.equal(node.metadata?.modelTier, 'standard');
});

test('spawnChild emits audit chain event', () => {
  const lineage = makeLineage();
  const before = getAuditChainLedger().getEntries().length;
  lineage.spawnChild(null, 'agent-a', { runId: 'run-1' });
  const after = getAuditChainLedger().getEntries().length;
  assert.equal(after, before + 1, 'spawnChild should emit one audit chain event');
  const lastEntry = getAuditChainLedger().getEntries()[after - 1];
  assert.equal(lastEntry?.type, 'approval_granted');
  assert.equal(lastEntry?.source, 'AgentLineage');
  assert.equal(lastEntry?.details?.lineageEventType, 'agent_spawned');
});

// ── getNode / getLineage ───────────────────────────────────────────────

test('getNode returns undefined for unknown instanceId', () => {
  const lineage = makeLineage();
  assert.equal(lineage.getNode('nonexistent'), undefined);
});

test('getNode returns node for known instanceId', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'root');
  const found = lineage.getNode(root.instanceId);
  assert.ok(found);
  assert.equal(found?.agentId, 'root');
});

test('getLineage returns full tree from any node', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'root');
  const child1 = lineage.spawnChild(root.instanceId, 'child1');
  const child2 = lineage.spawnChild(root.instanceId, 'child2');
  const grandchild = lineage.spawnChild(child1.instanceId, 'grandchild');

  // From leaf — should find root and all siblings
  const summary = lineage.getLineage(grandchild.instanceId);
  assert.ok(summary);
  assert.equal(summary!.root.instanceId, root.instanceId);
  assert.equal(summary!.totalNodes, 4);
  assert.equal(summary!.maxDepth, 2);
  assert.equal(summary!.activeNodes, 4);
});

test('getLineage returns null for unknown instanceId', () => {
  const lineage = makeLineage();
  assert.equal(lineage.getLineage('nonexistent'), null);
});

// ── getChildren ─────────────────────────────────────────────────────────

test('getChildren returns direct children', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'root');
  const c1 = lineage.spawnChild(root.instanceId, 'c1');
  const c2 = lineage.spawnChild(root.instanceId, 'c2');
  lineage.spawnChild(c1.instanceId, 'grandchild');

  const children = lineage.getChildren(root.instanceId);
  assert.equal(children.length, 2);
  const ids = children.map((c) => c.agentId).sort();
  assert.deepEqual(ids, ['c1', 'c2']);
});

test('getChildren returns empty for leaf nodes', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'root');
  const children = lineage.getChildren(root.instanceId);
  assert.equal(children.length, 0);
});

// ── getAncestorChain ────────────────────────────────────────────────────

test('getAncestorChain returns path to root', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'root');
  const c1 = lineage.spawnChild(root.instanceId, 'c1');
  const g1 = lineage.spawnChild(c1.instanceId, 'g1');

  const chain = lineage.getAncestorChain(g1.instanceId);
  assert.equal(chain.length, 3);
  assert.equal(chain[0]!.agentId, 'g1'); // self
  assert.equal(chain[1]!.agentId, 'c1'); // parent
  assert.equal(chain[2]!.agentId, 'root'); // grandparent (root)
});

test('getAncestorChain for root returns only itself', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'root');
  const chain = lineage.getAncestorChain(root.instanceId);
  assert.equal(chain.length, 1);
  assert.equal(chain[0]!.agentId, 'root');
});

// ── findRoot ────────────────────────────────────────────────────────────

test('findRoot finds root from any depth', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'root');
  const c1 = lineage.spawnChild(root.instanceId, 'c1');
  const g1 = lineage.spawnChild(c1.instanceId, 'g1');

  assert.equal(lineage.findRoot(g1.instanceId)?.instanceId, root.instanceId);
  assert.equal(lineage.findRoot(c1.instanceId)?.instanceId, root.instanceId);
  assert.equal(lineage.findRoot(root.instanceId)?.instanceId, root.instanceId);
});

// ── terminate / revokeTree ──────────────────────────────────────────────

test('terminate marks node as revoked', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'root');
  const result = lineage.terminate(root.instanceId, 'task completed');
  assert.equal(result, true);
  const node = lineage.getNode(root.instanceId);
  assert.ok(node?.revokedAt);
  assert.equal(node?.metadata?.terminationReason, 'task completed');
});

test('terminate returns false for unknown instanceId', () => {
  const lineage = makeLineage();
  assert.equal(lineage.terminate('nonexistent'), false);
});

test('terminate emits audit chain event', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'root');
  const before = getAuditChainLedger().getEntries().length;
  lineage.terminate(root.instanceId, 'done');
  const after = getAuditChainLedger().getEntries().length;
  assert.equal(after, before + 1);
  const lastEntry = getAuditChainLedger().getEntries()[after - 1];
  assert.equal(lastEntry?.details?.lineageEventType, 'agent_terminated');
});

test('revokeTree revokes entire subtree', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'root');
  const c1 = lineage.spawnChild(root.instanceId, 'c1');
  const c2 = lineage.spawnChild(root.instanceId, 'c2');
  const g1 = lineage.spawnChild(c1.instanceId, 'g1');

  const count = lineage.revokeTree(root.instanceId, 'security incident');
  assert.equal(count, 4);
  assert.ok(lineage.getNode(root.instanceId)?.revokedAt);
  assert.ok(lineage.getNode(c1.instanceId)?.revokedAt);
  assert.ok(lineage.getNode(c2.instanceId)?.revokedAt);
  assert.ok(lineage.getNode(g1.instanceId)?.revokedAt);
});

test('revokeTree emits audit chain events for each node', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'root');
  lineage.spawnChild(root.instanceId, 'c1');
  lineage.spawnChild(root.instanceId, 'c2');

  const before = getAuditChainLedger().getEntries().length; // 3 (3 spawns)
  lineage.revokeTree(root.instanceId, 'kill chain');
  const after = getAuditChainLedger().getEntries().length;
  assert.equal(after, before + 3); // 3 revocations
});

// ── recordHandoff ───────────────────────────────────────────────────────

test('recordHandoff writes handoff event to audit chain', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'agent-A');
  const child = lineage.spawnChild(root.instanceId, 'agent-B');

  const before = getAuditChainLedger().getEntries().length;
  lineage.recordHandoff({
    fromInstanceId: root.instanceId,
    toInstanceId: child.instanceId,
    handoffId: 'handoff-123',
    goal: 'Analyze security vulnerability',
    tools: ['file_read', 'web_search'],
  });
  const after = getAuditChainLedger().getEntries().length;
  assert.equal(after, before + 1);
  const entry = getAuditChainLedger().getEntries()[after - 1];
  assert.equal(entry?.source, 'AgentLineage');
  assert.equal(entry?.details?.lineageEventType, 'agent_handoff');
  assert.equal(entry?.details?.handoffId, 'handoff-123');
});

// ── stats ──────────────────────────────────────────────────────────────

test('getStats returns correct counts', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'root');
  lineage.spawnChild(root.instanceId, 'c1');
  lineage.spawnChild(root.instanceId, 'c2');

  const stats = lineage.getStats();
  assert.equal(stats.totalNodes, 3);
  assert.equal(stats.activeNodes, 3);
  assert.equal(stats.maxDepth, 1);

  lineage.terminate(root.instanceId, 'done');
  const stats2 = lineage.getStats();
  assert.equal(stats2.totalNodes, 3);
  assert.equal(stats2.activeNodes, 2);
});

// ── query ───────────────────────────────────────────────────────────────

test('query by runId returns matching nodes', () => {
  const lineage = makeLineage();
  lineage.spawnChild(null, 'a', { runId: 'run-1' });
  lineage.spawnChild(null, 'b', { runId: 'run-1' });
  lineage.spawnChild(null, 'c', { runId: 'run-2' });

  const r1 = lineage.query({ runId: 'run-1' });
  assert.equal(r1.length, 2);
  const ids = r1.map((n) => n.agentId).sort();
  assert.deepEqual(ids, ['a', 'b']);

  const r2 = lineage.query({ runId: 'run-2' });
  assert.equal(r2.length, 1);
  assert.equal(r2[0]!.agentId, 'c');
});

test('query by instanceId returns lineage tree', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'root');
  const c1 = lineage.spawnChild(root.instanceId, 'c1');

  const results = lineage.query({ instanceId: c1.instanceId });
  assert.equal(results.length, 2); // root + c1
});

test('query with maxDepth caps traversal', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'root');
  const c1 = lineage.spawnChild(root.instanceId, 'c1');
  lineage.spawnChild(c1.instanceId, 'c2');
  lineage.spawnChild(c1.instanceId, 'c3');

  // maxDepth=0 means only the root
  const results = lineage.query({ instanceId: root.instanceId, maxDepth: 0 });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.agentId, 'root');
});

// ── reset ───────────────────────────────────────────────────────────────

test('reset clears all state', () => {
  const lineage = makeLineage();
  lineage.spawnChild(null, 'root');
  assert.equal(lineage.getStats().totalNodes, 1);
  lineage.reset();
  assert.equal(lineage.getStats().totalNodes, 0);
});

// ── singleton ───────────────────────────────────────────────────────────

test('getAgentLineage returns singleton', () => {
  resetAgentLineage();
  const a = getAgentLineage();
  const b = getAgentLineage();
  assert.ok(a === b);
});

test('resetAgentLineage creates fresh instance', () => {
  resetAgentLineage();
  const a = getAgentLineage();
  a.spawnChild(null, 'agent-x');
  assert.equal(a.getStats().totalNodes, 1);
  resetAgentLineage();
  const b = getAgentLineage();
  assert.equal(b.getStats().totalNodes, 0);
  assert.ok(a !== b);
});

// ── concurrent spawns ───────────────────────────────────────────────────

test('many concurrent spawns do not corrupt state', () => {
  const lineage = makeLineage();
  const roots: string[] = [];
  for (let i = 0; i < 100; i++) {
    const r = lineage.spawnChild(null, `agent-${i}`, {
      runId: 'batch-run',
    });
    roots.push(r.instanceId);
  }
  assert.equal(lineage.getStats().totalNodes, 100);
  assert.equal(lineage.query({ runId: 'batch-run' }).length, 100);
});

test('deep chain respects depth tracking', () => {
  const lineage = makeLineage();
  let parent: string | null = null;
  for (let i = 0; i < 5; i++) {
    const node = lineage.spawnChild(parent, `layer-${i}`);
    assert.equal(node.depth, i);
    parent = node.instanceId;
  }
  const stats = lineage.getStats();
  assert.equal(stats.maxDepth, 4);
  assert.equal(stats.totalNodes, 5);
});

// ── LineageSummary correctness ──────────────────────────────────────────

test('LineageSummary counts active nodes correctly', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'root');
  const c1 = lineage.spawnChild(root.instanceId, 'c1');
  lineage.spawnChild(root.instanceId, 'c2');
  lineage.terminate(c1.instanceId, 'completed');

  const summary = lineage.getLineage(root.instanceId);
  assert.ok(summary);
  assert.equal(summary!.totalNodes, 3);
  assert.equal(summary!.activeNodes, 2);
});

test('getLineage from mid-tree node still finds all siblings', () => {
  const lineage = makeLineage();
  const root = lineage.spawnChild(null, 'root');
  const c1 = lineage.spawnChild(root.instanceId, 'c1');
  const c2 = lineage.spawnChild(root.instanceId, 'c2');
  const g1 = lineage.spawnChild(c2.instanceId, 'g1');

  // Query from c1 — should still find root, c2, and g1
  const summary = lineage.getLineage(c1.instanceId);
  assert.ok(summary);
  assert.equal(summary!.totalNodes, 4);
});

}); // describe('AgentLineage')
