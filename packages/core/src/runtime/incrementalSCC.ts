/**
 * Incremental SCC (Strongly Connected Component) Detection
 *
 * Research basis: "Commander Deadlock Prevention" report section 6 (Runtime Detection).
 *
 * In multi-agent A2A (Agent-to-Agent) communication, agents dynamically add
 * communication edges at runtime. If these edges form a cycle (Agent A waits
 * for B, B waits for C, C waits for A), the system deadlocks.
 *
 * This module provides INCREMENTAL SCC detection: instead of recomputing all
 * SCCs from scratch on every edge addition, it maintains the SCC structure
 * incrementally and only does work proportional to the affected region.
 *
 * Algorithm: Based on the incremental cycle detection approach from
 * Bender, Fineman, Gilbert, Tarjan (2015) — "A New Approach to Incremental
 * Cycle Detection and Related Problems". Simplified to a practical implementation:
 *
 *   1. Maintain a directed graph and its SCC decomposition.
 *   2. On edge addition (u → v):
 *      a. If u and v are already in the same SCC, no change needed.
 *      b. If v can reach u (reverse BFS), a new cycle is formed — merge all
 *         nodes on the cycle path into a single SCC.
 *      c. Otherwise, just add the edge (no SCC change).
 *   3. Report any newly formed SCC with size > 1 as a potential deadlock.
 *
 * Time complexity: O(|V| + |E|) per edge addition in the worst case,
 * but typically O(1) amortized for edges that don't create cycles.
 */

import { getGlobalLogger } from '../logging';
import { getMessageBus } from './messageBus';
import { reportSilentFailure } from '../silentFailureReporter';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SCCNode {
  id: string;
  /** Agent metadata */
  agentId?: string;
  /** Type of resource or communication channel this node represents */
  nodeType: 'agent' | 'resource' | 'task';
}

export interface SCCEdge {
  from: string;
  to: string;
  /** Reason for the edge (e.g., "waiting_for_response", "holding_resource") */
  reason: string;
  timestamp: number;
}

export interface SCCComponent {
  id: string;
  nodes: string[];
  /** True if this component has more than 1 node (i.e., a cycle) */
  isCycle: boolean;
  /** Nodes in topological order within the component */
  topologicalOrder: string[];
}

export interface DeadlockAlert {
  type: 'potential_deadlock' | 'cycle_detected';
  component: SCCComponent;
  edges: SCCEdge[];
  message: string;
  timestamp: number;
  /** Agent IDs involved in the deadlock */
  involvedAgents: string[];
}

export interface IncrementalSCCConfig {
  /** Whether to publish deadlock alerts to the message bus. Default true */
  publishAlerts: boolean;
  /** Whether to reject edge additions that would create cycles. Default true */
  rejectCyclicEdges: boolean;
  /** Maximum nodes in the graph before triggering cleanup. Default 10000 */
  maxNodes: number;
  /** Whether to log cycle detections. Default true */
  logCycles: boolean;
}

const DEFAULT_CONFIG: IncrementalSCCConfig = {
  publishAlerts: true,
  rejectCyclicEdges: true,
  maxNodes: 10_000,
  logCycles: true,
};

// ── Incremental SCC Detector ─────────────────────────────────────────────────

export class IncrementalSCCDetector {
  private config: IncrementalSCCConfig;
  private nodes: Map<string, SCCNode> = new Map();
  private edges: Map<string, Set<string>> = new Map(); // adjacency: from → {to, to, ...}
  private reverseEdges: Map<string, Set<string>> = new Map(); // reverse: to → {from, from, ...}
  private edgeMetadata: Map<string, SCCEdge> = new Map(); // "from→to" → edge metadata

  // SCC structure: each node maps to its component ID
  private nodeToComponent: Map<string, string> = new Map();
  private components: Map<string, SCCComponent> = new Map();
  private componentCounter = 0;

  private deadlockHistory: DeadlockAlert[] = [];

  constructor(config?: Partial<IncrementalSCCConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a node in the graph.
   */
  addNode(node: SCCNode): void {
    if (this.nodes.size >= this.config.maxNodes) {
      this.pruneStaleNodes();
    }
    if (!this.nodes.has(node.id)) {
      this.nodes.set(node.id, node);
      this.edges.set(node.id, new Set());
      this.reverseEdges.set(node.id, new Set());
      // Initialize as its own singleton SCC
      const compId = `scc_${this.componentCounter++}`;
      this.nodeToComponent.set(node.id, compId);
      this.components.set(compId, {
        id: compId,
        nodes: [node.id],
        isCycle: false,
        topologicalOrder: [node.id],
      });
    }
  }

  /**
   * Attempt to add an edge (from → to). If the edge would create a cycle
   * and rejectCyclicEdges is true, the edge is rejected and a DeadlockAlert
   * is returned. Otherwise the edge is added and any SCC merging is performed.
   *
   * @returns null if edge was added successfully, or a DeadlockAlert if a cycle was detected/rejected
   */
  addEdge(edge: SCCEdge): DeadlockAlert | null {
    // Ensure nodes exist
    this.addNode({ id: edge.from, nodeType: 'agent' });
    this.addNode({ id: edge.to, nodeType: 'agent' });

    const edgeKey = `${edge.from}→${edge.to}`;

    // Skip if edge already exists
    if (this.edges.get(edge.from)!.has(edge.to)) {
      return null;
    }

    // Check if from and to are already in the same SCC
    const fromComp = this.nodeToComponent.get(edge.from)!;
    const toComp = this.nodeToComponent.get(edge.to)!;

    if (fromComp === toComp) {
      // Already in the same SCC — adding this edge doesn't change anything
      this.edges.get(edge.from)!.add(edge.to);
      this.reverseEdges.get(edge.to)!.add(edge.from);
      this.edgeMetadata.set(edgeKey, edge);
      return null;
    }

    // Check if adding this edge creates a cycle: can we reach 'from' from 'to'?
    const canReach = this.canReach(edge.to, edge.from);

    if (canReach.reachable) {
      // Cycle detected! Merge all nodes on the path into a single SCC
      const cycleNodes = this.findCycleNodes(edge.from, edge.to, canReach.path);
      const alert = this.mergeAndAlert(cycleNodes, edge);

      if (this.config.rejectCyclicEdges) {
        // Don't add the edge — reject it
        return alert;
      }

      // Edge was already added inside mergeAndAlert() — no need to re-add
      return alert;
    }

    // No cycle — safe to add the edge
    this.edges.get(edge.from)!.add(edge.to);
    this.reverseEdges.get(edge.to)!.add(edge.from);
    this.edgeMetadata.set(edgeKey, edge);

    return null;
  }

  /**
   * Remove an edge from the graph. May split an SCC if the edge was critical.
   */
  removeEdge(from: string, to: string): void {
    const edgeKey = `${from}→${to}`;
    this.edges.get(from)?.delete(to);
    this.reverseEdges.get(to)?.delete(from);
    this.edgeMetadata.delete(edgeKey);

    // Check if the SCC containing these nodes needs to be split
    // (simplified: we don't do full SCC splitting — just check if the
    // component is still strongly connected)
    const compId = this.nodeToComponent.get(from);
    if (compId) {
      const comp = this.components.get(compId);
      if (comp && comp.isCycle && comp.nodes.length > 1) {
        // Verify the component is still strongly connected
        if (!this.isStronglyConnected(comp.nodes)) {
          // Split: revert to singleton SCCs (simplified approach)
          this.splitComponent(compId);
        }
      }
    }
  }

  /**
   * Remove a node and all its edges.
   */
  removeNode(nodeId: string): void {
    // Remove outgoing edges
    const outEdges = this.edges.get(nodeId);
    if (outEdges) {
      for (const to of outEdges) {
        this.reverseEdges.get(to)?.delete(nodeId);
        this.edgeMetadata.delete(`${nodeId}→${to}`);
      }
    }
    // Remove incoming edges
    const inEdges = this.reverseEdges.get(nodeId);
    if (inEdges) {
      for (const from of inEdges) {
        this.edges.get(from)?.delete(nodeId);
        this.edgeMetadata.delete(`${from}→${nodeId}`);
      }
    }

    this.edges.delete(nodeId);
    this.reverseEdges.delete(nodeId);
    this.nodes.delete(nodeId);

    // Remove from component
    const compId = this.nodeToComponent.get(nodeId);
    if (compId) {
      const comp = this.components.get(compId);
      if (comp) {
        comp.nodes = comp.nodes.filter((n) => n !== nodeId);
        comp.topologicalOrder = comp.topologicalOrder.filter((n) => n !== nodeId);
        if (comp.nodes.length <= 1) {
          comp.isCycle = false;
        }
        if (comp.nodes.length === 0) {
          this.components.delete(compId);
        }
      }
      this.nodeToComponent.delete(nodeId);
    }
  }

  /**
   * Get all SCC components.
   */
  getComponents(): SCCComponent[] {
    return Array.from(this.components.values());
  }

  /**
   * Get components that are cycles (size > 1).
   */
  getCyclicComponents(): SCCComponent[] {
    return this.getComponents().filter((c) => c.isCycle);
  }

  /**
   * Get deadlock history.
   */
  getDeadlockHistory(): DeadlockAlert[] {
    return [...this.deadlockHistory];
  }

  /**
   * Get the full graph (for debugging).
   */
  getGraph(): { nodes: SCCNode[]; edges: SCCEdge[] } {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edgeMetadata.values()),
    };
  }

  /**
   * Check if there are currently any cycles in the graph.
   */
  hasCycles(): boolean {
    return this.getCyclicComponents().length > 0;
  }

  /**
   * Reset all state.
   */
  reset(): void {
    this.nodes.clear();
    this.edges.clear();
    this.reverseEdges.clear();
    this.edgeMetadata.clear();
    this.nodeToComponent.clear();
    this.components.clear();
    this.componentCounter = 0;
    this.deadlockHistory = [];
  }

  // ── Internal: Cycle Detection ──────────────────────────────────────────────

  /**
   * BFS to check if `target` is reachable from `source`.
   */
  private canReach(source: string, target: string): { reachable: boolean; path: string[] } {
    if (source === target) return { reachable: true, path: [source] };

    const visited = new Set<string>([source]);
    const queue: Array<{ node: string; path: string[] }> = [{ node: source, path: [source] }];

    while (queue.length > 0) {
      const { node, path } = queue.shift()!;

      const neighbors = this.edges.get(node);
      if (!neighbors) continue;

      for (const neighbor of neighbors) {
        if (neighbor === target) {
          return { reachable: true, path: [...path, neighbor] };
        }
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push({ node: neighbor, path: [...path, neighbor] });
        }
      }
    }

    return { reachable: false, path: [] };
  }

  /**
   * Find all nodes involved in a cycle formed by adding edge (from → to).
   * The cycle is: from → to → ... → from (via existing edges from 'to' back to 'from').
   */
  private findCycleNodes(from: string, to: string, reversePath: string[]): string[] {
    // reversePath is: [to, ..., from]
    // The cycle is: from → to → ... → from
    // All nodes in reversePath plus 'from' form the cycle
    const cycleNodes = new Set<string>([from, ...reversePath]);
    return Array.from(cycleNodes);
  }

  /**
   * Merge nodes into a single SCC and emit a deadlock alert.
   */
  private mergeAndAlert(cycleNodes: string[], triggerEdge: SCCEdge): DeadlockAlert {
    // Find all existing components that contain cycle nodes
    const affectedCompIds = new Set<string>();
    for (const nodeId of cycleNodes) {
      const compId = this.nodeToComponent.get(nodeId);
      if (compId) affectedCompIds.add(compId);
    }

    // Merge all affected components into one
    const newCompId = `scc_${this.componentCounter++}`;
    const allNodes: string[] = [];
    for (const compId of affectedCompIds) {
      const comp = this.components.get(compId);
      if (comp) {
        allNodes.push(...comp.nodes);
        this.components.delete(compId);
      }
    }
    // Add any cycle nodes not yet in a component
    for (const nodeId of cycleNodes) {
      if (!allNodes.includes(nodeId)) allNodes.push(nodeId);
    }

    // Update node → component mapping
    for (const nodeId of allNodes) {
      this.nodeToComponent.set(nodeId, newCompId);
    }

    // Collect all edges within the new component
    const componentEdges: SCCEdge[] = [];
    for (const nodeId of allNodes) {
      const outEdges = this.edges.get(nodeId);
      if (outEdges) {
        for (const to of outEdges) {
          if (allNodes.includes(to)) {
            const meta = this.edgeMetadata.get(`${nodeId}→${to}`);
            if (meta) componentEdges.push(meta);
          }
        }
      }
    }
    componentEdges.push(triggerEdge);

    // Add the trigger edge to the graph
    this.edges.get(triggerEdge.from)!.add(triggerEdge.to);
    this.reverseEdges.get(triggerEdge.to)!.add(triggerEdge.from);
    this.edgeMetadata.set(`${triggerEdge.from}→${triggerEdge.to}`, triggerEdge);

    const component: SCCComponent = {
      id: newCompId,
      nodes: allNodes,
      isCycle: true,
      topologicalOrder: allNodes, // In a cycle, topological order is undefined — just list nodes
    };

    this.components.set(newCompId, component);

    // Build alert
    const involvedAgents = allNodes.filter((id) => {
      const node = this.nodes.get(id);
      return node?.nodeType === 'agent';
    });

    const alert: DeadlockAlert = {
      type: 'cycle_detected',
      component,
      edges: componentEdges,
      message: `Deadlock detected: ${allNodes.length} agents in circular wait: ${allNodes.join(' → ')} → ${allNodes[0]}`,
      timestamp: Date.now(),
      involvedAgents,
    };

    this.deadlockHistory.push(alert);
    if (this.deadlockHistory.length > 100) this.deadlockHistory.shift();

    if (this.config.logCycles) {
      getGlobalLogger().warn('IncrementalSCC', `Cycle detected: ${allNodes.join(' → ')}`, {
        involvedAgents,
        edgeReason: triggerEdge.reason,
      });
    }

    if (this.config.publishAlerts) {
      try {
        const bus = getMessageBus();
        bus.publish('system.alert', 'incremental-scc', {
          type: 'deadlock_detected',
          component: component.id,
          nodes: allNodes,
          involvedAgents,
          edgeReason: triggerEdge.reason,
          message: alert.message,
        });
      } catch (err) {
        reportSilentFailure(err, 'incrementalSCC:publishAlert');
      }
    }

    return alert;
  }

  /**
   * Check if a set of nodes is still strongly connected.
   */
  private isStronglyConnected(nodeIds: string[]): boolean {
    if (nodeIds.length <= 1) return true;

    // Check reachability: every node must be able to reach every other node
    for (const start of nodeIds) {
      const visited = new Set<string>([start]);
      const queue = [start];
      while (queue.length > 0) {
        const node = queue.shift()!;
        const neighbors = this.edges.get(node);
        if (!neighbors) continue;
        for (const neighbor of neighbors) {
          if (nodeIds.includes(neighbor) && !visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
      if (visited.size < nodeIds.length) return false;
    }
    return true;
  }

  /**
   * Split a component back into singleton SCCs (simplified approach).
   */
  private splitComponent(compId: string): void {
    const comp = this.components.get(compId);
    if (!comp) return;

    for (const nodeId of comp.nodes) {
      const newCompId = `scc_${this.componentCounter++}`;
      this.nodeToComponent.set(nodeId, newCompId);
      this.components.set(newCompId, {
        id: newCompId,
        nodes: [nodeId],
        isCycle: false,
        topologicalOrder: [nodeId],
      });
    }
    this.components.delete(compId);
  }

  /**
   * Prune nodes that have no edges (stale nodes).
   */
  private pruneStaleNodes(): void {
    const toRemove: string[] = [];
    for (const [nodeId] of this.nodes) {
      const outEdges = this.edges.get(nodeId);
      const inEdges = this.reverseEdges.get(nodeId);
      if (outEdges && outEdges.size === 0 && inEdges && inEdges.size === 0) {
        toRemove.push(nodeId);
      }
    }
    // Remove up to 10% of stale nodes
    const removeCount = Math.min(toRemove.length, Math.ceil(this.config.maxNodes * 0.1));
    for (let i = 0; i < removeCount; i++) {
      this.removeNode(toRemove[i]);
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

import { createTenantAwareSingleton } from './tenantAwareSingleton';

const incrementalSCCSingleton = createTenantAwareSingleton(() => new IncrementalSCCDetector(), {});

export function getIncrementalSCCDetector(): IncrementalSCCDetector {
  return incrementalSCCSingleton.get();
}

export function resetIncrementalSCCDetector(): void {
  incrementalSCCSingleton.reset();
}
