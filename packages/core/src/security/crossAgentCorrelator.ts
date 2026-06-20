/**
 * CrossAgentCorrelator — Multi-agent attack chain detection.
 *
 * Complements GuardianAgent (single-agent behavioral monitoring) by detecting
 * attack patterns that span multiple agents. A single agent's behavior may look
 * benign in isolation, but when correlated with other agents' actions, reveals
 * a coordinated attack.
 *
 * Built-in correlation rules detect:
 *   1. Coordinated data exfiltration — one agent reads, another sends
 *   2. Privilege escalation chain — low-privilege agent spawns high-privilege
 *   3. Lateral movement — Agent A's tool output influences Agent B unexpectedly
 *   4. Distributed DoS — multiple agents simultaneously exhausting resources
 *   5. Command-and-control — one agent receiving instructions passed to others
 *   6. Collusion — agents collectively bypassing governance controls
 *
 * Design:
 *   GuardianAgent.events → CrossAgentCorrelator.ingest() → correlate()
 *                                                       ↘ SecurityMonitor (alerts)
 *                                                       ↘ AuditChainLedger (tamper-evident)
 *
 * Correlation Window: events within a configurable time window are correlated.
 * Correlation Graph: agents are nodes, correlated events are edges with weights.
 */

import * as crypto from 'crypto';
import { getAuditChainLedger } from './auditChainLedger';
import { getSecurityMonitor } from './securityMonitor';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

// ============================================================================
// Types
// ============================================================================

export type CorrelationRuleType =
  | 'coordinated_exfiltration'
  | 'privilege_escalation_chain'
  | 'lateral_movement'
  | 'distributed_dos'
  | 'command_and_control'
  | 'collusion';

export interface CrossAgentEvent {
  /** Unique event ID */
  id: string;
  /** Agent that generated this event */
  agentId: string;
  /** Run ID (if applicable) */
  runId?: string;
  /** Event type */
  type:
    | 'tool_call'
    | 'tool_result'
    | 'llm_call'
    | 'state_change'
    | 'agent_spawn'
    | 'agent_terminate'
    | 'data_read'
    | 'data_write'
    | 'network_request'
    | 'governance_override';
  /** Content or summary of the event */
  summary: string;
  /** Key metadata for correlation */
  metadata: Record<string, unknown>;
  /** Timestamp */
  timestamp: number;
  /** Severity */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** Agent that spawned this agent (for lineage) */
  parentAgentId?: string;
  /** Data sensitivity labels if applicable */
  dataLabels?: string[];
}

export interface CorrelationMatch {
  /** Match ID */
  id: string;
  /** Which correlation rule triggered */
  ruleType: CorrelationRuleType;
  /** Events involved in this match */
  events: CrossAgentEvent[];
  /** Agent IDs involved */
  agentIds: string[];
  /** Risk score 0-100 */
  riskScore: number;
  /** Human-readable description of the attack pattern */
  description: string;
  /** Recommended action */
  recommendation: string;
  /** Detected at */
  detectedAt: string;
  /** Whether this is a confirmed attack or preliminary */
  confidence: 'low' | 'medium' | 'high';
}

export interface CorrelationRule {
  /** Rule type */
  type: CorrelationRuleType;
  /** Whether the rule is enabled */
  enabled: boolean;
  /** Minimum number of agents required to trigger */
  minAgents: number;
  /** Time window for correlation (ms) */
  timeWindowMs: number;
  /** Minimum risk score threshold to emit alert */
  minRiskScore: number;
  /** Rule-specific configuration */
  config?: Record<string, unknown>;
}

export interface CorrelatorConfig {
  /** Whether the correlator is enabled */
  enabled: boolean;
  /** Maximum events to retain per agent */
  maxEventsPerAgent: number;
  /** Default time window for correlation (ms) */
  defaultTimeWindowMs: number;
  /** Minimum confidence to emit alert */
  minAlertConfidence: 'low' | 'medium' | 'high';
  /** Maximum correlation matches to retain (oldest pruned first) */
  maxMatches: number;
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: CorrelatorConfig = {
  enabled: true,
  maxEventsPerAgent: 200,
  defaultTimeWindowMs: 5 * 60 * 1000, // 5 minutes
  minAlertConfidence: 'medium',
  maxMatches: 200,
};

// ============================================================================
// Built-in Correlation Rules
// ============================================================================

const DEFAULT_RULES: CorrelationRule[] = [
  {
    type: 'coordinated_exfiltration',
    enabled: true,
    minAgents: 2,
    timeWindowMs: 3 * 60 * 1000, // 3 minutes
    minRiskScore: 50,
  },
  {
    type: 'privilege_escalation_chain',
    enabled: true,
    minAgents: 2,
    timeWindowMs: 5 * 60 * 1000,
    minRiskScore: 60,
  },
  {
    type: 'lateral_movement',
    enabled: true,
    minAgents: 2,
    timeWindowMs: 10 * 60 * 1000, // 10 minutes
    minRiskScore: 50,
  },
  {
    type: 'distributed_dos',
    enabled: true,
    minAgents: 3,
    timeWindowMs: 60 * 1000, // 1 minute
    minRiskScore: 40,
  },
  {
    type: 'command_and_control',
    enabled: true,
    minAgents: 3,
    timeWindowMs: 10 * 60 * 1000,
    minRiskScore: 70,
  },
  {
    type: 'collusion',
    enabled: true,
    minAgents: 2,
    timeWindowMs: 15 * 60 * 1000,
    minRiskScore: 60,
  },
];

// ============================================================================
// CrossAgentCorrelator
// ============================================================================

export class CrossAgentCorrelator {
  private config: CorrelatorConfig;
  private events: CrossAgentEvent[] = [];
  private rules: CorrelationRule[];
  private matches: CorrelationMatch[] = [];

  constructor(config?: Partial<CorrelatorConfig>, customRules?: CorrelationRule[]) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rules = customRules ?? DEFAULT_RULES;
  }

  // ── Event Ingestion ─────────────────────────────────────────────────

  /** Ingest an event from any agent. Returns any matches found during correlation. */
  ingest(event: CrossAgentEvent): CorrelationMatch[] {
    if (!this.config.enabled) return [];

    this.events.push(event);

    // Enforce max events per agent
    const agentEvents = this.events.filter((e) => e.agentId === event.agentId);
    if (agentEvents.length > this.config.maxEventsPerAgent) {
      // Remove oldest events for this agent
      const toRemove = agentEvents.slice(0, agentEvents.length - this.config.maxEventsPerAgent);
      this.events = this.events.filter((e) => !toRemove.includes(e));
    }

    // Run correlation
    return this.correlate();
  }

  /** Ingest multiple events at once. */
  ingestBatch(events: CrossAgentEvent[]): CorrelationMatch[] {
    if (!this.config.enabled) return [];
    for (const event of events) {
      this.events.push(event);
    }
    return this.correlate();
  }

  // ── Correlation Engine ──────────────────────────────────────────────

  /**
   * Run all enabled correlation rules against the event buffer.
   * Returns new matches found.
   */
  correlate(): CorrelationMatch[] {
    const newMatches: CorrelationMatch[] = [];

    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      const match = this.evaluateRule(rule);
      if (match && this.isNewMatch(match)) {
        newMatches.push(match);
        this.matches.push(match);
        // Enforce maxMatches — prune oldest when over limit
        if (this.matches.length > this.config.maxMatches) {
          this.matches.sort(
            (a, b) => new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime(),
          );
          this.matches.splice(0, this.matches.length - this.config.maxMatches);
        }
        this.alertOnMatch(match);
      }
    }

    return newMatches;
  }

  /** Evaluate a specific correlation rule. */
  private evaluateRule(rule: CorrelationRule): CorrelationMatch | null {
    const now = Date.now();
    const windowStart = now - rule.timeWindowMs;

    // Get events within the time window
    const windowEvents = this.events.filter((e) => e.timestamp >= windowStart);

    // Check minimum agent count
    const agentIds = new Set(windowEvents.map((e) => e.agentId));
    if (agentIds.size < rule.minAgents) return null;

    // Apply rule-specific detection logic
    switch (rule.type) {
      case 'coordinated_exfiltration':
        return this.detectCoordinatedExfiltration(windowEvents, rule);
      case 'privilege_escalation_chain':
        return this.detectPrivilegeEscalation(windowEvents, rule);
      case 'lateral_movement':
        return this.detectLateralMovement(windowEvents, rule);
      case 'distributed_dos':
        return this.detectDistributedDoS(windowEvents, rule);
      case 'command_and_control':
        return this.detectCommandAndControl(windowEvents, rule);
      case 'collusion':
        return this.detectCollusion(windowEvents, rule);
      default:
        return null;
    }
  }

  // ── Detection Methods ──────────────────────────────────────────────

  /** Detect: one agent reads data, another sends it externally. */
  private detectCoordinatedExfiltration(
    events: CrossAgentEvent[],
    rule: CorrelationRule,
  ): CorrelationMatch | null {
    const dataReaders = events.filter(
      (e) => e.type === 'data_read' && (e.dataLabels?.some((l) => l.includes('sensitive') || l.includes('internal')) ?? false),
    );
    const dataSenders = events.filter(
      (e) => e.type === 'network_request' || e.type === 'data_write',
    );

    if (dataReaders.length >= 1 && dataSenders.length >= 1) {
      const readerAgents = new Set(dataReaders.map((e) => e.agentId));
      const senderAgents = new Set(dataSenders.map((e) => e.agentId));

      // If readers and senders are different agents, that's suspicious
      const allShared = [...readerAgents].every((a) => senderAgents.has(a));
      if (!allShared && readerAgents.size >= 1 && senderAgents.size >= 1) {
        const riskScore = Math.min(
          100,
          40 + dataReaders.length * 10 + dataSenders.length * 10,
        );
        if (riskScore < rule.minRiskScore) return null;

        return this.buildMatch(
          'coordinated_exfiltration',
          [...dataReaders, ...dataSenders],
          riskScore,
          `${dataReaders.length} agent(s) read sensitive data while ${dataSenders.length} other agent(s) performed network writes — possible coordinated data exfiltration`,
          'Halt all implicated agents. Audit data access and network logs. Verify the legitimacy of the data flow.',
        );
      }
    }

    return null;
  }

  /** Detect: low-privilege agent spawns a higher-privilege agent. */
  private detectPrivilegeEscalation(
    events: CrossAgentEvent[],
    rule: CorrelationRule,
  ): CorrelationMatch | null {
    const spawns = events.filter((e) => e.type === 'agent_spawn' && e.parentAgentId);
    const escalations: CrossAgentEvent[] = [];

    for (const spawn of spawns) {
      const parentPriv = (spawn.metadata as { parentPrivilege?: string }).parentPrivilege ?? 'low';
      const childPriv = (spawn.metadata as { childPrivilege?: string }).childPrivilege ?? 'low';

      const privOrder = ['low', 'medium', 'high', 'admin'];
      const parentIdx = privOrder.indexOf(parentPriv);
      const childIdx = privOrder.indexOf(childPriv);

      if (childIdx > parentIdx) {
        escalations.push(spawn);
      }
    }

    if (escalations.length > 0) {
      const riskScore = Math.min(100, 50 + escalations.length * 20);
      if (riskScore < rule.minRiskScore) return null;

      return this.buildMatch(
        'privilege_escalation_chain',
        escalations,
        riskScore,
        `${escalations.length} privilege escalation(s) detected via agent spawning — agents spawned with higher privileges than parent`,
        'Revoke elevated privileges. Audit the spawn chain. Verify governance approval was granted.',
      );
    }

    return null;
  }

  /** Detect: Agent A's tool output becomes Agent B's context in a suspicious pattern. */
  private detectLateralMovement(
    events: CrossAgentEvent[],
    rule: CorrelationRule,
  ): CorrelationMatch | null {
    const toolOutputs = events.filter(
      (e) => e.type === 'tool_result' || e.type === 'data_read',
    );
    const consumers = events.filter(
      (e) => e.type === 'llm_call' &&
        (e.metadata as { consumedAgentOutput?: string })?.consumedAgentOutput,
    );

    if (toolOutputs.length >= 1 && consumers.length >= 1) {
      // Check if output and consumer are from different agents
      const outputAgents = new Set(toolOutputs.map((e) => e.agentId));
      const consumerAgents = new Set(consumers.map((e) => e.agentId));

      const differentAgents = [...outputAgents].some((a) => !consumerAgents.has(a));
      if (differentAgents) {
        const riskScore = 50 + consumers.length * 15;
        if (riskScore < rule.minRiskScore) return null;

        return this.buildMatch(
          'lateral_movement',
          [...toolOutputs, ...consumers],
          riskScore,
          `${consumers.length} agent(s) consumed output from ${outputAgents.size} other agent(s) — possible lateral movement`,
          'Verify the data flow is legitimate. Check if governance controls were bypassed.',
        );
      }
    }

    return null;
  }

  /** Detect: multiple agents simultaneously exhausting resources. */
  private detectDistributedDoS(
    events: CrossAgentEvent[],
    rule: CorrelationRule,
  ): CorrelationMatch | null {
    // Count tool calls per agent in the window
    const toolCallsByAgent = new Map<string, number>();
    for (const e of events) {
      if (e.type === 'tool_call') {
        toolCallsByAgent.set(e.agentId, (toolCallsByAgent.get(e.agentId) ?? 0) + 1);
      }
    }

    // Detect if multiple agents are all making excessive tool calls
    const highRateAgents = [...toolCallsByAgent.entries()]
      .filter(([, count]) => count > 50)
      .map(([agentId]) => agentId);

    if (highRateAgents.length >= rule.minAgents) {
      const totalCalls = [...toolCallsByAgent.values()].reduce((a, b) => a + b, 0);
      const riskScore = Math.min(100, 30 + totalCalls / 2);
      if (riskScore < rule.minRiskScore) return null;

      const matchedEvents = events.filter((e) => e.type === 'tool_call');

      return this.buildMatch(
        'distributed_dos',
        matchedEvents,
        riskScore,
        `${highRateAgents.length} agent(s) executing excessive tool calls (${totalCalls} total) — possible distributed resource exhaustion`,
        'Rate-limit or pause the implicated agents. Verify the task requirements.',
      );
    }

    return null;
  }

  /** Detect: one agent receiving instructions and passing them to others. */
  private detectCommandAndControl(
    events: CrossAgentEvent[],
    rule: CorrelationRule,
  ): CorrelationMatch | null {
    // Look for agents that receive external input AND spawn other agents
    const inputReceivers = events.filter(
      (e) =>
        (e.type === 'llm_call' || e.type === 'network_request') &&
        (e.metadata as { external?: boolean })?.external,
    );
    const spawners = events.filter((e) => e.type === 'agent_spawn');

    if (inputReceivers.length >= 1 && spawners.length >= 1) {
      const receiverAgents = new Set(inputReceivers.map((e) => e.agentId));
      const spawnerAgents = new Set(spawners.map((e) => e.parentAgentId!));

      // If the same agent both receives external input AND spawns children
      const c2Agents = [...receiverAgents].filter((a) => spawnerAgents.has(a));

      if (c2Agents.length > 0) {
        const riskScore = 60 + c2Agents.length * 20;
        if (riskScore < rule.minRiskScore) return null;

        return this.buildMatch(
          'command_and_control',
          [...inputReceivers, ...spawners],
          riskScore,
          `${c2Agents.length} agent(s) received external input and then spawned sub-agents — possible C2 pattern`,
          'Isolate the C2 agent. Audit external communication. Revoke spawn permissions.',
        );
      }
    }

    return null;
  }

  /** Detect: agents collectively bypassing governance controls. */
  private detectCollusion(
    events: CrossAgentEvent[],
    rule: CorrelationRule,
  ): CorrelationMatch | null {
    const overrides = events.filter((e) => e.type === 'governance_override');
    const bypassIndicators = events.filter(
      (e) =>
        e.type === 'state_change' &&
        (e.metadata as { bypassedGovernance?: boolean })?.bypassedGovernance,
    );

    if (overrides.length >= 1 || bypassIndicators.length >= 1) {
      const colludingAgents = new Set([
        ...overrides.map((e) => e.agentId),
        ...bypassIndicators.map((e) => e.agentId),
      ]);

      if (colludingAgents.size >= rule.minAgents) {
        const riskScore = 70 + colludingAgents.size * 15;
        if (riskScore < rule.minRiskScore) return null;

        return this.buildMatch(
          'collusion',
          [...overrides, ...bypassIndicators],
          riskScore,
          `${colludingAgents.size} agent(s) bypassed governance controls — possible collusion to circumvent restrictions`,
          'Freeze all implicated agents. Escalate to SOC. Audit governance logs.',
        );
      }
    }

    return null;
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private buildMatch(
    ruleType: CorrelationRuleType,
    events: CrossAgentEvent[],
    riskScore: number,
    description: string,
    recommendation: string,
  ): CorrelationMatch {
    const confidence: CorrelationMatch['confidence'] =
      riskScore >= 80 ? 'high' : riskScore >= 50 ? 'medium' : 'low';

    return {
      id: `corr_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      ruleType,
      events,
      agentIds: [...new Set(events.map((e) => e.agentId))],
      riskScore,
      description,
      recommendation,
      detectedAt: new Date().toISOString(),
      confidence,
    };
  }

  private isNewMatch(match: CorrelationMatch): boolean {
    // Skip if we already have this exact combination of agentIds + ruleType recently
    const recentKey = `${match.ruleType}:${match.agentIds.sort().join(',')}`;
    const recent = this.matches.filter(
      (m) =>
        `${m.ruleType}:${m.agentIds.sort().join(',')}` === recentKey &&
        Date.now() - new Date(m.detectedAt).getTime() < 30_000,
    );
    return recent.length === 0;
  }

  private alertOnMatch(match: CorrelationMatch): void {
    try {
      // Log to audit chain
      getAuditChainLedger().logEvent({
        type: 'config_change',
        severity: match.confidence === 'high' ? 'critical' : 'high',
        source: 'CrossAgentCorrelator',
        message: `Cross-agent correlation match: ${match.ruleType} — ${match.description}`,
        details: {
          matchId: match.id,
          ruleType: match.ruleType,
          agentIds: match.agentIds,
          riskScore: match.riskScore,
          confidence: match.confidence,
        },
      });

      // Alert SecurityMonitor
      const monitor = getSecurityMonitor();
      monitor.logAlert({
        type: 'cross_agent_correlation',
        severity: match.confidence === 'high' ? 'critical' : 'high',
        source: 'CrossAgentCorrelator',
        message: match.description,
        details: {
          matchId: match.id,
          ruleType: match.ruleType,
          agentIds: match.agentIds,
          riskScore: match.riskScore,
          recommendation: match.recommendation,
        },
        timestamp: match.detectedAt,
      });
    } catch {
      /* best-effort */
    }
  }

  // ── Public Accessors ───────────────────────────────────────────────

  /** Get all correlation matches (recent first). */
  getMatches(): CorrelationMatch[] {
    return [...this.matches].reverse();
  }

  /** Get matches for a specific agent. */
  getMatchesForAgent(agentId: string): CorrelationMatch[] {
    return this.matches.filter((m) => m.agentIds.includes(agentId));
  }

  /** Get the event buffer. */
  getEvents(): CrossAgentEvent[] {
    return [...this.events];
  }

  /** Reset the correlator state (for test isolation). */
  reset(): void {
    this.events = [];
    this.matches = [];
  }
}

// ============================================================================
// Singleton
// ============================================================================

const correlatorSingleton = createTenantAwareSingleton(() => new CrossAgentCorrelator());

export function getCrossAgentCorrelator(
  config?: Partial<CorrelatorConfig>,
): CrossAgentCorrelator {
  return correlatorSingleton.get();
}

export function resetCrossAgentCorrelator(): void {
  correlatorSingleton.reset();
}
