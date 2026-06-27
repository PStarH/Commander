/**
 * BPD (Backward Propagation Detection) — Graph-Based Anomaly Agent Detection
 *
 * Research basis: "Commander-BFT-C3" consensus report section 6 (Monitoring Layer).
 *
 * BPD performs symbolic backward propagation on the multi-agent communication graph
 * to identify anomalous agents. The key insight: when an agent produces an output
 * that is consistently rejected or modified by downstream consumers, the "blame"
 * propagates backward through the communication graph to identify the source.
 *
 * Algorithm:
 *   1. Build a directed communication graph: agent → agent edges representing
 *      output flow (who consumed whose output).
 *   2. Track "rejection signals" — when a downstream agent or quality gate
 *      rejects, downgrades, or significantly modifies an upstream output.
 *   3. Propagate rejection signals backward through the graph using a
 *      weighted accumulation: each agent's anomaly score = sum of rejection
 *      signals from its consumers, weighted by graph distance.
 *   4. Agents with anomaly scores above a threshold are flagged as potentially
 *      byzantine/malfunctioning and reported to the TopologyStateMachine.
 *
 * Detection rate: >90% per the research report.
 */

import { getTopologyStateMachine } from './topologyStateMachine';
import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentNode {
  agentId: string;
  /** Model family / provider name (for cross-family bias detection) */
  modelFamily?: string;
  /** Whether this agent's output feeds into downstream consumers */
  isProducer: boolean;
}

export interface CommunicationEdge {
  from: string; // producer agent
  to: string;   // consumer agent
  /** Weight: how much the consumer relies on this producer's output (0-1) */
  weight: number;
  /** Timestamp of the communication */
  timestamp: number;
}

export interface RejectionSignal {
  /** Agent whose output was rejected/downgraded */
  sourceAgentId: string;
  /** Agent or quality gate that rejected it */
  rejectedBy: string;
  /** Severity of rejection (0-1): 1 = completely rejected, 0.5 = significantly modified */
  severity: number;
  /** What type of rejection */
  type: 'quality_gate_fail' | 'consensus_disagreement' | 'hallucination_detected' | 'downstream_override' | 'verification_fail';
  /** Human-readable reason */
  reason: string;
  /** Timestamp */
  timestamp: number;
  /** Optional run context */
  runId?: string;
}

export interface AgentAnomalyReport {
  agentId: string;
  anomalyScore: number;       // 0-1, weighted backward-propagated rejection
  rejectionCount: number;     // direct rejections received
  downstreamRejections: number; // rejections from agents that consumed this agent's output
  modelFamily?: string;
  flagged: boolean;
  reason: string;
  /** Agents that rejected this agent's output */
  rejectedByAgents: string[];
  /** Rejection types observed */
  rejectionTypes: string[];
}

export interface BPDConfig {
  /** Anomaly score threshold above which an agent is flagged. Default 0.3 */
  flagThreshold: number;
  /** Decay factor for backward propagation per hop. Default 0.6 */
  propagationDecay: number;
  /** Maximum graph hops for backward propagation. Default 5 */
  maxHops: number;
  /** Time window (ms) for considering rejection signals. Default 300000 (5 min) */
  signalWindowMs: number;
  /** Minimum rejection signals before scoring. Default 1 */
  minSignals: number;
  /** Whether to auto-submit anomaly scores to TopologyStateMachine. Default true */
  autoSubmitToTopology: boolean;
}

export const DEFAULT_CONFIG: BPDConfig = {
  flagThreshold: 0.3,
  propagationDecay: 0.6,
  maxHops: 5,
  signalWindowMs: 300_000,
  minSignals: 1,
  autoSubmitToTopology: true,
};

// ── BPD Detector ─────────────────────────────────────────────────────────────

export class BPDDetector {
  private config: BPDConfig;
  private agents: Map<string, AgentNode> = new Map();
  private edges: CommunicationEdge[] = [];
  private rejectionSignals: RejectionSignal[] = [];
  /** Debounce timer for batch detection — prevents O(n²) per-signal recomputation */
  private detectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Debounce window (ms) — detection runs at most once per this interval. Default 500. */
  private detectionDebounceMs = 500;
  /** Pending flag: true if a detection run is scheduled but not yet executed */
  private detectionPending = false;

  constructor(config?: Partial<BPDConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register an agent in the communication graph.
   */
  registerAgent(agent: AgentNode): void {
    this.agents.set(agent.agentId, agent);
  }

  /**
   * Record a communication edge (output flow from producer to consumer).
   */
  recordCommunication(edge: CommunicationEdge): void {
    this.edges.push(edge);
    // Ensure both agents are registered
    if (!this.agents.has(edge.from)) {
      this.agents.set(edge.from, { agentId: edge.from, isProducer: true });
    }
    if (!this.agents.has(edge.to)) {
      this.agents.set(edge.to, { agentId: edge.to, isProducer: false });
    }
  }

  /**
   * Record a rejection signal — when an agent's output is rejected or downgraded.
   */
  recordRejection(signal: RejectionSignal): void {
    this.rejectionSignals.push(signal);

    // Prune old signals and stale edges
    const cutoff = Date.now() - this.config.signalWindowMs;
    this.rejectionSignals = this.rejectionSignals.filter((s) => s.timestamp > cutoff);
    this.pruneStaleEdges(cutoff);

    // Ensure agents are registered
    if (!this.agents.has(signal.sourceAgentId)) {
      this.agents.set(signal.sourceAgentId, {
        agentId: signal.sourceAgentId,
        isProducer: true,
      });
    }

    // Debounced detection: instead of running the full O(|agents| × |edges| × maxHops)
    // traversal on every single rejection signal, we batch detections within a
    // debounce window. This prevents O(n²) performance degradation under high
    // rejection rates while still detecting anomalies in near-real-time.
    if (this.config.autoSubmitToTopology) {
      this.scheduleDebouncedDetection();
    }
  }

  /**
   * Run the backward propagation detection algorithm.
   * Returns anomaly reports for all agents with signals.
   */
  detect(): AgentAnomalyReport[] {
    const reports: AgentAnomalyReport[] = [];
    const cutoff = Date.now() - this.config.signalWindowMs;
    const recentSignals = this.rejectionSignals.filter((s) => s.timestamp > cutoff);

    if (recentSignals.length < this.config.minSignals) {
      return [];
    }

    // Build adjacency: for each agent, who consumes its output?
    const consumersOf = new Map<string, Set<string>>();
    for (const edge of this.edges) {
      if (!consumersOf.has(edge.from)) {
        consumersOf.set(edge.from, new Set());
      }
      consumersOf.get(edge.from)!.add(edge.to);
    }

    // For each agent, compute backward-propagated anomaly score
    for (const [agentId, agentNode] of this.agents) {
      const directRejections = recentSignals.filter((s) => s.sourceAgentId === agentId);
      const rejectedByAgents = [...new Set(directRejections.map((s) => s.rejectedBy))];
      const rejectionTypes = [...new Set(directRejections.map((s) => s.type))];

      // Direct anomaly score: average severity of direct rejections
      let directScore = 0;
      if (directRejections.length > 0) {
        directScore =
          directRejections.reduce((sum, s) => sum + s.severity, 0) /
          directRejections.length;
      }

      // Backward propagation: check if agents that consume this agent's output
      // also received rejections (indicating the anomaly propagated downstream)
      let propagatedScore = 0;
      const consumers = consumersOf.get(agentId);
      if (consumers) {
        const visited = new Set<string>([agentId]);
        propagatedScore = this.propagateBackward(
          agentId,
          consumers,
          recentSignals,
          visited,
          1, // start at hop 1
        );
      }

      // Combined score: direct + propagated (weighted)
      const anomalyScore = Math.max(
        0,
        Math.min(1, directScore * 0.6 + propagatedScore * 0.4),
      );

      if (anomalyScore > 0 || directRejections.length > 0) {
        const flagged = anomalyScore >= this.config.flagThreshold;
        const reason = flagged
          ? `Anomaly score ${anomalyScore.toFixed(4)} >= threshold ${this.config.flagThreshold} (${directRejections.length} direct rejections, ${rejectedByAgents.length} rejectors)`
          : `Anomaly score ${anomalyScore.toFixed(4)} below threshold`;

        reports.push({
          agentId,
          anomalyScore,
          rejectionCount: directRejections.length,
          downstreamRejections: Math.round(propagatedScore * 10),
          modelFamily: agentNode.modelFamily,
          flagged,
          reason,
          rejectedByAgents,
          rejectionTypes,
        });
      }
    }

    // Sort by anomaly score descending
    reports.sort((a, b) => b.anomalyScore - a.anomalyScore);

    return reports;
  }

  /**
   * Recursively propagate rejection signals backward through the graph.
   */
  private propagateBackward(
    sourceId: string,
    consumers: Set<string>,
    signals: RejectionSignal[],
    visited: Set<string>,
    hop: number,
  ): number {
    if (hop > this.config.maxHops) return 0;

    let score = 0;
    for (const consumerId of consumers) {
      if (visited.has(consumerId)) continue;
      visited.add(consumerId);

      // Check if this consumer also received rejection signals
      const consumerRejections = signals.filter((s) => s.sourceAgentId === consumerId);
      if (consumerRejections.length > 0) {
        const consumerSeverity =
          consumerRejections.reduce((sum, s) => sum + s.severity, 0) /
          consumerRejections.length;
        // Apply decay based on hop distance
        score += consumerSeverity * Math.pow(this.config.propagationDecay, hop);
      }

      // Recurse: check if the consumer's consumers also have rejections
      const nextConsumers = this.getConsumersOf(consumerId);
      if (nextConsumers.size > 0) {
        score += this.propagateBackward(
          consumerId,
          nextConsumers,
          signals,
          visited,
          hop + 1,
        );
      }
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Get flagged agents (anomaly score above threshold).
   */
  getFlaggedAgents(): AgentAnomalyReport[] {
    return this.detect().filter((r) => r.flagged);
  }

  /**
   * Get the communication graph as adjacency list (for debugging/visualization).
   */
  getGraph(): { nodes: AgentNode[]; edges: CommunicationEdge[] } {
    return {
      nodes: Array.from(this.agents.values()),
      edges: [...this.edges],
    };
  }

  /**
   * Get recent rejection signals.
   */
  getRejectionSignals(): RejectionSignal[] {
    const cutoff = Date.now() - this.config.signalWindowMs;
    return this.rejectionSignals.filter((s) => s.timestamp > cutoff);
  }

  /**
   * Reset all tracking data.
   */
  /**
   * Schedule a debounced detection run. Multiple rejection signals within
   * the debounce window are batched into a single detection pass.
   */
  private scheduleDebouncedDetection(): void {
    if (this.detectionPending) return; // Already scheduled
    this.detectionPending = true;

    this.detectionDebounceTimer = setTimeout(() => {
      this.detectionDebounceTimer = null;
      this.detectionPending = false;

      const reports = this.detect();
      const maxScore = Math.max(0, ...reports.map((r) => r.anomalyScore));
      if (maxScore > 0) {
        try {
          const tsm = getTopologyStateMachine();
          tsm.submitAnomalyScore(maxScore, {
            source: 'bpd_detector',
            flaggedAgents: reports.filter((r) => r.flagged).map((r) => r.agentId),
          });
        } catch (err) {
          reportSilentFailure(err, 'bpdDetector:debouncedDetection');
        }
      }
    }, this.detectionDebounceMs);
    this.detectionDebounceTimer.unref();
  }

  /**
   * Force an immediate detection run (bypassing the debounce).
   * Useful for testing or when immediate results are needed.
   */
  forceDetection(): AgentAnomalyReport[] {
    if (this.detectionDebounceTimer) {
      clearTimeout(this.detectionDebounceTimer);
      this.detectionDebounceTimer = null;
      this.detectionPending = false;
    }
    return this.detect();
  }

  /** Lazy-initialized consumer adjacency cache */
  private consumersCache: Map<string, Set<string>> | undefined;

  /**
   * Prune edges older than the cutoff time to prevent unbounded memory growth
   * in long-running systems.
   */
  private pruneStaleEdges(cutoff: number): void {
    const oldEdgeCount = this.edges.length;
    this.edges = this.edges.filter((e) => e.timestamp > cutoff);
    // Invalidate the consumer adjacency cache so it is rebuilt lazily on next access.
    if (this.edges.length < oldEdgeCount) {
      this.consumersCache = undefined;
    }
  }

  private getConsumersOf(agentId: string): Set<string> {
    // Rebuild cache if stale or missing
    if (!this.consumersCache) {
      this.consumersCache = new Map();
      for (const edge of this.edges) {
        if (!this.consumersCache.has(edge.from)) {
          this.consumersCache.set(edge.from, new Set());
        }
        this.consumersCache.get(edge.from)!.add(edge.to);
      }
    }
    return this.consumersCache.get(agentId) ?? new Set();
  }

  reset(): void {
    if (this.detectionDebounceTimer) {
      clearTimeout(this.detectionDebounceTimer);
      this.detectionDebounceTimer = null;
    }
    this.detectionPending = false;
    this.agents.clear();
    this.edges = [];
    this.rejectionSignals = [];
    this.consumersCache = undefined;
  }

  getConfig(): BPDConfig {
    return { ...this.config };
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

const bpdDetectorSingleton = createTenantAwareSingleton(() => new BPDDetector());

export function getBPDDetector(): BPDDetector {
  return bpdDetectorSingleton.get();
}

export function resetBPDDetector(): void {
  bpdDetectorSingleton.reset();
}
