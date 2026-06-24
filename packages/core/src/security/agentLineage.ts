/**
 * AgentLineage — Immutable parent→child agent relationship tracking.
 *
 * Every sub-agent spawn, handoff, and termination creates a cryptographically
 * verifiable lineage record in the hash-chained audit ledger. This closes the
 * competitive gap where no framework (Geordie, Noma, Pragatix) can answer
 * "which agent spawned this tool call, and which agent spawned that agent?"
 *
 * Design
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ LineageNode { instanceId, parentInstanceId, agentId, scope,            │
 * │               capabilityTokenJti, spawnedAt, revokedAt, depth }        │
 * │                                                                        │
 * │ Each node is a single agent instance. Spawning a sub-agent creates a  │
 * │ child node whose parentInstanceId links back. The full tree is        │
 * │ traversable from any node up to the root agent.                        │
 * │                                                                        │
 * │ Integration points:                                                    │
 * │   1. subAgentExecutor.executeAtomicNode() → lineage.spawnChild()      │
 * │   2. agentHandoff.request() → lineage.recordHandoff()                  │
 * │   3. Agent termination → lineage.terminate()                           │
 * │   4. Every spawn/terminate is audited via AuditChainLedger             │
 * │                                                                        │
 * │ Tenant isolation: per-tenant lineage trees via tenantAwareSingleton.  │
 * │ Lineage records are written to the per-tenant audit chain for          │
 * │ tamper-evident storage.                                                │
 * └────────────────────────────────────────────────────────────────────────┘
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as crypto from 'crypto';
import { getAuditChainLedger } from './auditChainLedger';
import type { SecurityEvent } from './securityAuditLogger';
import { getCurrentTenantId } from '../runtime/tenantContext';
import { getMetricsCollector } from '../runtime/metricsCollector';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import { recordSinkFailure } from '../observability/sinkFailureCounter';

// ============================================================================
// Public types
// ============================================================================

/** A single agent instance in the lineage tree. */
export interface LineageNode {
  /** Unique instance identifier (UUID, no dashes). */
  instanceId: string;
  /** Parent instance ID, or null for root agents. */
  parentInstanceId: string | null;
  /** Agent type/template identifier. */
  agentId: string;
  /** Optional human-readable role (researcher, coder, synthesizer, etc.). */
  role?: string;
  /** Tenant that owns this lineage. */
  tenantId?: string;
  /** Orchestration run ID. */
  runId?: string;
  /** Tools this agent instance is authorized to use. */
  scope: { tools: string[] };
  /** JTI of the capability token issued for this agent instance. */
  capabilityTokenJti?: string;
  /** ISO timestamp of spawn. */
  spawnedAt: string;
  /** ISO timestamp of termination/revocation, if any. */
  revokedAt?: string;
  /** Depth in the lineage tree (0 = root agent). */
  depth: number;
  /** Arbitrary metadata (goal snippet, model tier, etc.). */
  metadata?: Record<string, unknown>;
}

/** Event written to the audit chain on lineage changes. */
export type LineageEventType =
  | 'agent_spawned'
  | 'agent_terminated'
  | 'agent_revoked'
  | 'agent_handoff';

/** Summary of a lineage tree for API responses. */
export interface LineageSummary {
  root: LineageNode;
  /** Flat list of all nodes in the tree. */
  nodes: LineageNode[];
  /** Number of nodes in the tree. */
  totalNodes: number;
  /** Maximum depth observed. */
  maxDepth: number;
  /** Number of active (non-terminated) nodes. */
  activeNodes: number;
}

export interface LineageQuery {
  /** Return the lineage tree for this instance ID. */
  instanceId?: string;
  /** Restrict to a specific run. */
  runId?: string;
  /** Restrict to a specific tenant. */
  tenantId?: string;
  /** Maximum depth to traverse (default: unlimited). */
  maxDepth?: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum nodes kept in-memory per tenant. Older nodes are pruned. */
const MAX_NODES_PER_TENANT = 10_000;

/** Maximum depth for lineage tree traversal (prevents infinite loops). */
const MAX_TRAVERSAL_DEPTH = 100;

// ============================================================================
// AgentLineage
// ============================================================================

export class AgentLineage {
  /** In-memory node store keyed by instanceId. */
  private nodes: Map<string, LineageNode> = new Map();
  /** Parent→children index for fast subtree queries. */
  private childrenIndex: Map<string, Set<string>> = new Map();
  /** Run→instanceIds index for run-scoped queries. */
  private runIndex: Map<string, Set<string>> = new Map();
  /** Maximum in-memory nodes before pruning. */
  private readonly maxNodes: number;

  constructor(maxNodes: number = MAX_NODES_PER_TENANT) {
    this.maxNodes = maxNodes;
  }

  // ── Core API ──────────────────────────────────────────────────────────

  /**
   * Record a child agent spawn. Creates a new LineageNode, writes to the
   * audit chain, and returns the node for caller use.
   *
   * @param parentInstanceId - The spawning agent's instance ID, or null for root.
   * @param childAgentId - The child agent's type/template ID.
   * @param options - Scope, capability token JTI, role, metadata.
   */
  spawnChild(
    parentInstanceId: string | null,
    childAgentId: string,
    options: {
      instanceId?: string;
      role?: string;
      runId?: string;
      scope?: { tools: string[] };
      capabilityTokenJti?: string;
      depth?: number;
      metadata?: Record<string, unknown>;
    } = {},
  ): LineageNode {
    const tenantId = getCurrentTenantId();
    const instanceId = options.instanceId ?? crypto.randomUUID().replace(/-/g, '');

    // Compute depth: if parent exists, parent.depth + 1; else from options or 0.
    let depth = options.depth ?? 0;
    if (parentInstanceId) {
      const parent = this.nodes.get(parentInstanceId);
      if (parent) {
        depth = parent.depth + 1;
      }
    }

    const node: LineageNode = {
      instanceId,
      parentInstanceId,
      agentId: childAgentId,
      role: options.role,
      tenantId,
      runId: options.runId,
      scope: options.scope ?? { tools: [] },
      capabilityTokenJti: options.capabilityTokenJti,
      spawnedAt: new Date().toISOString(),
      depth,
      metadata: options.metadata,
    };

    // Store in-memory
    this.nodes.set(instanceId, node);

    // Update parent→children index
    if (parentInstanceId) {
      const children = this.childrenIndex.get(parentInstanceId);
      if (children) children.add(instanceId);
      else this.childrenIndex.set(parentInstanceId, new Set([instanceId]));
    }

    // Update run index
    if (options.runId) {
      const runNodes = this.runIndex.get(options.runId);
      if (runNodes) runNodes.add(instanceId);
      else this.runIndex.set(options.runId, new Set([instanceId]));
    }

    // Prune if over capacity
    this.pruneIfNeeded();

    // Write lineage event to audit chain
    this.auditLineageEvent('agent_spawned', node);

    try {
      getMetricsCollector().incrementCounter(
        'agent_lineage_spawns_total',
        'Agent lineage spawn events',
        1,
        [{ name: 'agent_id', value: childAgentId }],
      );
    } catch (err) {
      reportSilentFailure(err, 'agentLineage:209');
      /* best-effort */
    }

    return node;
  }

  /**
   * Record an agent handoff. Handoffs are special lineage edges where
   * the "parent" is the sending agent and the "child" is the receiving agent.
   * Unlike spawnChild, the receiving agent may already exist (it's not a new
   * instance), so we create a soft edge without a new instanceId.
   */
  recordHandoff(params: {
    fromInstanceId: string;
    toInstanceId: string;
    handoffId: string;
    goal: string;
    tools: string[];
  }): void {
    const tenantId = getCurrentTenantId();
    const fromNode = this.nodes.get(params.fromInstanceId);
    const toNode = this.nodes.get(params.toInstanceId);

    // Audit the handoff even if we don't have full node data
    const event: SecurityEvent = {
      id: `lh_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      type: 'approval_granted', // handoff is a delegation of authority
      severity: 'medium',
      source: 'AgentLineage',
      message: `handoff: ${params.fromInstanceId.slice(0, 12)}→${params.toInstanceId.slice(0, 12)} goal=${params.goal.slice(0, 80)}`,
      details: {
        lineageEventType: 'agent_handoff' as LineageEventType,
        handoffId: params.handoffId,
        fromInstanceId: params.fromInstanceId,
        toInstanceId: params.toInstanceId,
        fromAgentId: fromNode?.agentId,
        toAgentId: toNode?.agentId,
        tools: params.tools,
        goal: params.goal.slice(0, 200),
      },
      context: { tenantId },
    };

    try {
      getAuditChainLedger().logEvent(event);
    } catch (err) {
      recordSinkFailure('agentLineage');
      try {
        // eslint-disable-next-line no-console
        console.error(
          `[agentLineage] audit chain unavailable for handoff: ${(err as Error)?.message ?? String(err)}`,
        );
      } catch (err) {
        reportSilentFailure(err, 'agentLineage:264');
        /* stderr inaccessible */
      }
    }
  }

  /**
   * Mark an agent instance as terminated/revoked.
   */
  terminate(instanceId: string, reason?: string): boolean {
    const node = this.nodes.get(instanceId);
    if (!node) return false;

    node.revokedAt = new Date().toISOString();
    if (reason) {
      node.metadata = { ...(node.metadata ?? {}), terminationReason: reason };
    }

    this.auditLineageEvent('agent_terminated', node);
    return true;
  }

  /**
   * Revoke an agent instance AND all its descendants recursively.
   * This is the "kill chain" — when a root agent is compromised, all
   * sub-agents it spawned must be revoked too.
   */
  revokeTree(instanceId: string, reason: string): number {
    let count = 0;
    const queue = [instanceId];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);

      const node = this.nodes.get(id);
      if (!node) continue;

      // Cascade-revoke capability token if one was issued
      if (node.capabilityTokenJti) {
        try {
          const { getCapabilityTokenIssuer } = require('./capabilityToken');
          getCapabilityTokenIssuer().revoke(
            node.capabilityTokenJti,
            `lineage_tree_revoke: ${reason}`,
          );
        } catch (err) {
          reportSilentFailure(err, 'agentLineage:313');
          /* best-effort — token revocation is separate from lineage marking */
        }
      }

      node.revokedAt = new Date().toISOString();
      node.metadata = { ...(node.metadata ?? {}), revocationReason: reason };
      this.auditLineageEvent('agent_revoked', node);
      count++;

      // Enqueue children
      const children = this.childrenIndex.get(id);
      if (children) {
        for (const childId of children) {
          if (!visited.has(childId)) {
            queue.push(childId);
          }
        }
      }
    }

    return count;
  }

  // ── Query API ──────────────────────────────────────────────────────────

  /**
   * Get a single lineage node by instance ID.
   */
  getNode(instanceId: string): LineageNode | undefined {
    return this.nodes.get(instanceId);
  }

  /**
   * Get the full lineage tree for a given instance.
   * Traverses up to root and down to all descendants.
   */
  getLineage(instanceId: string, maxDepth: number = MAX_TRAVERSAL_DEPTH): LineageSummary | null {
    const root = this.findRoot(instanceId);
    if (!root) return null;

    const nodes: LineageNode[] = [];
    let maxObservedDepth = 0;

    // BFS from root to collect all descendants
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: root.instanceId, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.id)) continue;
      if (current.depth > maxDepth) continue;
      visited.add(current.id);

      const node = this.nodes.get(current.id);
      if (node) {
        nodes.push(node);
        maxObservedDepth = Math.max(maxObservedDepth, node.depth);

        const children = this.childrenIndex.get(current.id);
        if (children) {
          for (const childId of children) {
            queue.push({ id: childId, depth: current.depth + 1 });
          }
        }
      }
    }

    const activeNodes = nodes.filter((n) => !n.revokedAt).length;

    return {
      root,
      nodes,
      totalNodes: nodes.length,
      maxDepth: maxObservedDepth,
      activeNodes,
    };
  }

  /**
   * Query lineage nodes matching filters.
   */
  query(q: LineageQuery = {}): LineageNode[] {
    let candidates: LineageNode[];

    if (q.instanceId) {
      const summary = this.getLineage(q.instanceId, q.maxDepth);
      return summary?.nodes ?? [];
    }

    if (q.runId) {
      const instanceIds = this.runIndex.get(q.runId);
      if (!instanceIds) return [];
      candidates = [];
      for (const id of instanceIds) {
        const node = this.nodes.get(id);
        if (node) candidates.push(node);
      }
    } else {
      candidates = Array.from(this.nodes.values());
    }

    if (q.tenantId) {
      candidates = candidates.filter((n) => n.tenantId === q.tenantId);
    }

    return candidates;
  }

  /**
   * Get all direct children of a given instance.
   */
  getChildren(instanceId: string): LineageNode[] {
    const childIds = this.childrenIndex.get(instanceId);
    if (!childIds) return [];
    const result: LineageNode[] = [];
    for (const id of childIds) {
      const node = this.nodes.get(id);
      if (node) result.push(node);
    }
    return result;
  }

  /**
   * Get the parent chain (instance → parent → grandparent → ... → root).
   */
  getAncestorChain(instanceId: string, maxDepth: number = MAX_TRAVERSAL_DEPTH): LineageNode[] {
    const chain: LineageNode[] = [];
    let current = this.nodes.get(instanceId);
    let depth = 0;

    while (current && depth < maxDepth) {
      chain.push(current);
      if (!current.parentInstanceId) break;
      current = this.nodes.get(current.parentInstanceId);
      depth++;
    }

    return chain;
  }

  /**
   * Find the root of the lineage tree containing this instance.
   */
  findRoot(instanceId: string): LineageNode | undefined {
    let current = this.nodes.get(instanceId);
    if (!current) return undefined;

    const visited = new Set<string>();
    while (current.parentInstanceId && !visited.has(current.instanceId)) {
      visited.add(current.instanceId);
      const parent = this.nodes.get(current.parentInstanceId);
      if (!parent) break;
      current = parent;
    }
    return current;
  }

  // ── Stats ──────────────────────────────────────────────────────────────

  getStats(): { totalNodes: number; activeNodes: number; maxDepth: number } {
    let active = 0;
    let maxD = 0;
    for (const node of this.nodes.values()) {
      if (!node.revokedAt) active++;
      maxD = Math.max(maxD, node.depth);
    }
    return { totalNodes: this.nodes.size, activeNodes: active, maxDepth: maxD };
  }

  /** Clear all state. Test isolation only. */
  reset(): void {
    this.nodes.clear();
    this.childrenIndex.clear();
    this.runIndex.clear();
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private auditLineageEvent(type: LineageEventType, node: LineageNode): void {
    const severity: SecurityEvent['severity'] =
      type === 'agent_revoked' ? 'high' : type === 'agent_terminated' ? 'medium' : 'low';

    const event: SecurityEvent = {
      id: `lh_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      type: type === 'agent_revoked' ? 'approval_denied' : 'approval_granted',
      severity,
      source: 'AgentLineage',
      message: `${type}: ${node.agentId} (${node.instanceId.slice(0, 12)}…) depth=${node.depth}`,
      details: {
        lineageEventType: type,
        instanceId: node.instanceId,
        parentInstanceId: node.parentInstanceId,
        agentId: node.agentId,
        role: node.role,
        depth: node.depth,
        capabilityTokenJti: node.capabilityTokenJti,
        scope: node.scope,
        metadata: node.metadata,
      },
      context: {
        tenantId: node.tenantId,
        agentId: node.agentId,
        runId: node.runId,
      },
    };

    try {
      getAuditChainLedger().logEvent(event);
    } catch (err) {
      recordSinkFailure('agentLineage');
      try {
        // eslint-disable-next-line no-console
        console.error(
          `[agentLineage] audit chain unavailable: ${(err as Error)?.message ?? String(err)}`,
        );
      } catch (err) {
        reportSilentFailure(err, 'agentLineage:531');
        /* stderr inaccessible */
      }
    }
  }

  private pruneIfNeeded(): void {
    if (this.nodes.size <= this.maxNodes) return;

    // Sort by spawnedAt, remove oldest first (FIFO for lineage)
    const sorted = Array.from(this.nodes.entries()).sort(
      (a, b) => new Date(a[1].spawnedAt).getTime() - new Date(b[1].spawnedAt).getTime(),
    );

    const toRemove = this.nodes.size - this.maxNodes + Math.floor(this.maxNodes * 0.1);
    for (let i = 0; i < toRemove && i < sorted.length; i++) {
      const [id, node] = sorted[i];
      this.nodes.delete(id);
      if (node.parentInstanceId) {
        this.childrenIndex.get(node.parentInstanceId)?.delete(id);
      }
      if (node.runId) {
        this.runIndex.get(node.runId)?.delete(id);
      }
    }
  }
}

// ============================================================================
// Tenant-aware singleton
// ============================================================================

const agentLineageSingleton = createTenantAwareSingleton(() => new AgentLineage());

/** Resolve the active AgentLineage via the current tenant context. */
export function getAgentLineage(): AgentLineage {
  return agentLineageSingleton.get();
}

/** Reset all lineage instances. Test isolation only. */
export function resetAgentLineage(): void {
  agentLineageSingleton.reset();
}
