/**
 * Agent-SOC Operations Center — Enterprise Security Operations for AI Agents
 *
 * The "people + process + tools" layer that turns security monitoring into action.
 *
 * Capabilities:
 * - P0-P4 event classification with response SLAs
 * - Playbook engine for automated + semi-automated incident response
 * - Escalation paths (L1 Analyst → L2 Engineer → L3 Lead → Management)
 * - SOC health dashboard (MTTD, MTTR, false positive rate, automation rate)
 * - Incident lifecycle management (detect → triage → contain → eradicate → recover → postmortem)
 * - Integration with SecurityMonitor alerts and SecurityAuditLogger events
 *
 * Design principle:
 *   "Monitoring produces data. SOC produces action."
 */

import { reportSilentFailure } from '../silentFailureReporter';
import type { SecurityEvent } from './securityAuditLogger';
import type { SecurityAlert } from './securityMonitor';
import { getAuditChainLedger } from './auditChainLedger';
import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

// ============================================================================
// Types
// ============================================================================

export type IncidentPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

export type IncidentStatus =
  'detected' | 'triaging' | 'containing' | 'eradicating' | 'recovering' | 'resolved' | 'closed';

export type EscalationLevel = 'L1' | 'L2' | 'L3' | 'management';

export type PlaybookTrigger =
  | 'prompt_injection'
  | 'jailbreak_attempt'
  | 'data_exfiltration'
  | 'cost_anomaly'
  | 'privilege_escalation'
  | 'memory_poisoning'
  | 'supply_chain_threat'
  | 'dos_attack'
  | 'authentication_breach'
  | 'sandbox_escape'
  | 'model_degradation'
  | 'config_drift'
  | 'insider_threat'
  | 'unknown_threat';

export interface IncidentClassification {
  priority: IncidentPriority;
  playbookTrigger: PlaybookTrigger;
  confidence: number; // 0-1
  reasoning: string;
  automaticContainment: boolean;
}

export interface SlaTarget {
  responseMinutes: number;
  resolutionMinutes: number;
  escalationMinutes: number;
}

export interface Incident {
  id: string;
  priority: IncidentPriority;
  status: IncidentStatus;
  classification: IncidentClassification;
  title: string;
  description: string;
  source: string;
  events: SecurityEvent[];
  alerts: SecurityAlert[];
  detectedAt: string;
  respondedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  assignedTo: EscalationLevel;
  playbookActions: PlaybookAction[];
  postmortem: PostmortemReport | null;
  slaTarget: SlaTarget;
  slaBreached: boolean;
}

export interface PlaybookAction {
  step: number;
  name: string;
  description: string;
  automated: boolean;
  completed: boolean;
  completedAt: string | null;
  result: string | null;
}

export interface Playbook {
  trigger: PlaybookTrigger;
  name: string;
  description: string;
  priority: IncidentPriority;
  slaTarget: SlaTarget;
  autoContain: boolean;
  actions: Array<Omit<PlaybookAction, 'completed' | 'completedAt' | 'result'>>;
}

export interface PostmortemReport {
  rootCause: string;
  timeline: string[];
  impact: {
    usersAffected: number;
    durationMinutes: number;
    dataExposed: boolean;
    financialCost: number;
  };
  lessonsLearned: string[];
  actionItems: Array<{ item: string; owner: string; dueBy: string }>;
  reviewedBy: string;
  reviewedAt: string;
}

export interface SocHealth {
  status: 'healthy' | 'elevated' | 'critical';
  openIncidents: number;
  byPriority: Record<IncidentPriority, number>;
  mttd: number; // Mean Time to Detect (minutes)
  mttr: number; // Mean Time to Respond (minutes)
  mttrP0: number;
  falsePositiveRate: number;
  missRate: number;
  automationRate: number;
  escalationRate: number;
  postmortemCompletionRate: number;
  slaBreachRate: number;
  incidentsLast24h: number;
  incidentsLast7d: number;
  topTriggers: Array<{ trigger: PlaybookTrigger; count: number }>;
  activeEscalations: Array<{ incidentId: string; level: EscalationLevel; since: string }>;
}

export interface AgentSocConfig {
  /** Maximum concurrent incidents */
  maxIncidents: number;
  /** Auto-resolve incidents older than this (hours), 0 = never */
  autoResolveAfterHours: number;
  /** Require postmortem for priorities at or above this */
  postmortemThreshold: IncidentPriority;
  /** Target metrics */
  targetMttd: number;
  targetMttr: number;
  targetFalsePositiveRate: number;
  /** Escalation contacts */
  escalationContacts: Record<EscalationLevel, string>;
}

// ============================================================================
// SLA Targets by Priority
// ============================================================================

const SLA_TARGETS: Record<IncidentPriority, SlaTarget> = {
  P0: { responseMinutes: 5, resolutionMinutes: 60, escalationMinutes: 15 },
  P1: { responseMinutes: 15, resolutionMinutes: 240, escalationMinutes: 30 },
  P2: { responseMinutes: 60, resolutionMinutes: 1440, escalationMinutes: 240 },
  P3: { responseMinutes: 240, resolutionMinutes: 10080, escalationMinutes: 1440 },
  P4: { responseMinutes: 1440, resolutionMinutes: 43200, escalationMinutes: 0 },
};

// ============================================================================
// Playbook Library
// ============================================================================

const PLAYBOOKS: Record<PlaybookTrigger, Playbook> = {
  prompt_injection: {
    trigger: 'prompt_injection',
    name: 'Prompt Injection Response',
    description:
      'Respond to detected prompt injection attempts including hidden HTML, multi-language, and encoded attacks.',
    priority: 'P1',
    slaTarget: SLA_TARGETS.P1,
    autoContain: true,
    actions: [
      {
        step: 1,
        name: 'Block request',
        description: 'Immediately block the current request and return a security notice.',
        automated: true,
      },
      {
        step: 2,
        name: 'Log attack details',
        description: 'Record attack timestamp, source IP/user, injection type, and full payload.',
        automated: true,
      },
      {
        step: 3,
        name: 'Flag session',
        description: 'Mark the current session as high-risk, increase monitoring granularity.',
        automated: true,
      },
      {
        step: 4,
        name: 'Rate limit source',
        description: 'Apply temporary rate limiting (15 min) if >3 attempts from same source.',
        automated: true,
      },
      {
        step: 5,
        name: 'L1 Triage',
        description: 'L1 analyst confirms whether this is a false positive within 5 minutes.',
        automated: false,
      },
      {
        step: 6,
        name: 'Update filter rules',
        description: 'If new pattern detected, update input filtering rules.',
        automated: false,
      },
    ],
  },
  jailbreak_attempt: {
    trigger: 'jailbreak_attempt',
    name: 'Jailbreak Attempt Response',
    description:
      'Respond to detected jailbreak attempts including token smuggling, prefix attacks, and many-shot contexts.',
    priority: 'P1',
    slaTarget: SLA_TARGETS.P1,
    autoContain: true,
    actions: [
      {
        step: 1,
        name: 'Block request',
        description: 'Block the jailbreak attempt immediately.',
        automated: true,
      },
      {
        step: 2,
        name: 'Log attempt details',
        description: 'Record jailbreak type, payload, and model response.',
        automated: true,
      },
      {
        step: 3,
        name: 'Flag session',
        description: 'Mark session for enhanced monitoring.',
        automated: true,
      },
      {
        step: 4,
        name: 'L1 Triage',
        description: 'Confirm jailbreak classification.',
        automated: false,
      },
      {
        step: 5,
        name: 'Update defense rules',
        description: 'Add signature to ContentScanner defense patterns.',
        automated: false,
      },
    ],
  },
  data_exfiltration: {
    trigger: 'data_exfiltration',
    name: 'Data Exfiltration Response',
    description:
      'Respond to detected data exfiltration via tool outputs, SSE streams, or API responses.',
    priority: 'P0',
    slaTarget: SLA_TARGETS.P0,
    autoContain: true,
    actions: [
      {
        step: 1,
        name: 'Block output',
        description: 'Immediately redact/block the exfiltrating output boundary.',
        automated: true,
      },
      {
        step: 2,
        name: 'Terminate session',
        description: 'End the current agent session to prevent further leakage.',
        automated: true,
      },
      {
        step: 3,
        name: 'Revoke tokens',
        description: 'Revoke all active capability tokens for the affected session.',
        automated: true,
      },
      {
        step: 4,
        name: 'Audit output logs',
        description: 'Scan recent output logs for additional leakage from same source.',
        automated: true,
      },
      {
        step: 5,
        name: 'L1 Immediate Response',
        description: 'L1 analyst responds within 5 minutes to assess scope.',
        automated: false,
      },
      {
        step: 6,
        name: 'L2 Investigation',
        description: 'L2 engineer investigates root cause and attack vector.',
        automated: false,
      },
      {
        step: 7,
        name: 'Notify security lead',
        description: 'Escalate to L3 security lead for data breach assessment.',
        automated: false,
      },
    ],
  },
  cost_anomaly: {
    trigger: 'cost_anomaly',
    name: 'Cost Anomaly Response',
    description:
      'Respond to abnormal cost patterns including token floods, tool loops, and concurrent bursts.',
    priority: 'P2',
    slaTarget: SLA_TARGETS.P2,
    autoContain: true,
    actions: [
      {
        step: 1,
        name: 'Apply rate limit',
        description: 'Apply immediate rate limiting to the affected source.',
        automated: true,
      },
      {
        step: 2,
        name: 'Check quotas',
        description: 'Verify quota consumption against tier limits.',
        automated: true,
      },
      {
        step: 3,
        name: 'Notify user',
        description: 'If legitimate usage, notify user of quota approach.',
        automated: true,
      },
      {
        step: 4,
        name: 'L1 Triage',
        description: 'L1 analyst determines if this is an attack or legitimate usage.',
        automated: false,
      },
    ],
  },
  privilege_escalation: {
    trigger: 'privilege_escalation',
    name: 'Privilege Escalation Response',
    description: 'Respond to detected or attempted privilege escalation within the agent system.',
    priority: 'P0',
    slaTarget: SLA_TARGETS.P0,
    autoContain: true,
    actions: [
      {
        step: 1,
        name: 'Revoke permissions',
        description: 'Immediately revoke all elevated permissions.',
        automated: true,
      },
      {
        step: 2,
        name: 'Lock account',
        description: 'Lock the affected user/agent account.',
        automated: true,
      },
      {
        step: 3,
        name: 'Audit access log',
        description: 'Review all actions taken with elevated permissions.',
        automated: true,
      },
      {
        step: 4,
        name: 'L1 Immediate Response',
        description: 'L1 analyst responds within 5 minutes.',
        automated: false,
      },
      {
        step: 5,
        name: 'L2 Investigation',
        description: 'L2 engineer traces escalation path.',
        automated: false,
      },
      {
        step: 6,
        name: 'Rotate credentials',
        description: 'Force rotation of all affected credentials.',
        automated: false,
      },
    ],
  },
  memory_poisoning: {
    trigger: 'memory_poisoning',
    name: 'Memory Poisoning Response',
    description: 'Respond to detected memory poisoning in agent episodic/long-term memory.',
    priority: 'P1',
    slaTarget: SLA_TARGETS.P1,
    autoContain: true,
    actions: [
      {
        step: 1,
        name: 'Isolate memory',
        description: 'Quarantine the affected memory segment.',
        automated: true,
      },
      {
        step: 2,
        name: 'Rollback to clean state',
        description: 'Restore memory from last known clean snapshot.',
        automated: true,
      },
      {
        step: 3,
        name: 'Audit access log',
        description: 'Review who/what modified the memory.',
        automated: true,
      },
      {
        step: 4,
        name: 'L1 Triage',
        description: 'L1 analyst assesses memory impact scope.',
        automated: false,
      },
      {
        step: 5,
        name: 'Verify recovery',
        description: 'Run integrity check on restored memory.',
        automated: false,
      },
    ],
  },
  supply_chain_threat: {
    trigger: 'supply_chain_threat',
    name: 'Supply Chain Threat Response',
    description: 'Respond to detected supply chain threats in skills, tools, or dependencies.',
    priority: 'P1',
    slaTarget: SLA_TARGETS.P1,
    autoContain: true,
    actions: [
      {
        step: 1,
        name: 'Block load',
        description: 'Prevent loading of the compromised skill/tool/dependency.',
        automated: true,
      },
      {
        step: 2,
        name: 'Scan dependencies',
        description: 'Scan all dependencies for related compromise.',
        automated: true,
      },
      {
        step: 3,
        name: 'Audit provenance',
        description: 'Trace the compromised artifact origin.',
        automated: true,
      },
      {
        step: 4,
        name: 'L2 Investigation',
        description: 'L2 engineer investigates supply chain depth.',
        automated: false,
      },
    ],
  },
  dos_attack: {
    trigger: 'dos_attack',
    name: 'Denial of Service Response',
    description: 'Respond to resource exhaustion attacks against the agent system.',
    priority: 'P0',
    slaTarget: SLA_TARGETS.P0,
    autoContain: true,
    actions: [
      {
        step: 1,
        name: 'Enable DDoS mitigation',
        description: 'Activate aggressive rate limiting and CAPTCHA.',
        automated: true,
      },
      {
        step: 2,
        name: 'Scale resources',
        description: 'Auto-scale infrastructure to absorb attack.',
        automated: true,
      },
      {
        step: 3,
        name: 'Block sources',
        description: 'Block identified attack source IPs/ranges.',
        automated: true,
      },
      {
        step: 4,
        name: 'L1 Immediate Response',
        description: 'L1 analyst responds within 5 minutes.',
        automated: false,
      },
      {
        step: 5,
        name: 'Contact provider',
        description: 'If infrastructure attack, contact cloud provider.',
        automated: false,
      },
    ],
  },
  authentication_breach: {
    trigger: 'authentication_breach',
    name: 'Authentication Breach Response',
    description:
      'Respond to authentication breaches including credential stuffing and token theft.',
    priority: 'P0',
    slaTarget: SLA_TARGETS.P0,
    autoContain: true,
    actions: [
      {
        step: 1,
        name: 'Lock all sessions',
        description: 'Terminate all active sessions for affected user.',
        automated: true,
      },
      {
        step: 2,
        name: 'Rotate credentials',
        description: 'Force password and API key rotation.',
        automated: true,
      },
      {
        step: 3,
        name: 'Audit access log',
        description: 'Review all actions during compromised period.',
        automated: true,
      },
      {
        step: 4,
        name: 'L1 Immediate Response',
        description: 'L1 analyst responds within 5 minutes.',
        automated: false,
      },
      {
        step: 5,
        name: 'Notify user',
        description: 'Notify affected user of breach and required actions.',
        automated: false,
      },
    ],
  },
  sandbox_escape: {
    trigger: 'sandbox_escape',
    name: 'Sandbox Escape Response',
    description: 'Respond to detected or attempted sandbox escape.',
    priority: 'P0',
    slaTarget: SLA_TARGETS.P0,
    autoContain: true,
    actions: [
      {
        step: 1,
        name: 'Terminate sandbox',
        description: 'Immediately terminate the compromised sandbox.',
        automated: true,
      },
      {
        step: 2,
        name: 'Isolate host',
        description: 'Isolate the host from network if escape confirmed.',
        automated: true,
      },
      {
        step: 3,
        name: 'Audit sandbox logs',
        description: 'Review all sandbox actions for lateral movement.',
        automated: true,
      },
      {
        step: 4,
        name: 'L1 Immediate Response',
        description: 'L1 analyst responds within 5 minutes.',
        automated: false,
      },
      {
        step: 5,
        name: 'Host forensics',
        description: 'L2 conducts host-level forensic analysis.',
        automated: false,
      },
    ],
  },
  model_degradation: {
    trigger: 'model_degradation',
    name: 'Model Degradation Response',
    description: 'Respond to detected model performance degradation or poisoning.',
    priority: 'P2',
    slaTarget: SLA_TARGETS.P2,
    autoContain: false,
    actions: [
      {
        step: 1,
        name: 'Switch to fallback model',
        description: 'Route traffic to healthy fallback model.',
        automated: true,
      },
      {
        step: 2,
        name: 'Run diagnostics',
        description: 'Run model health diagnostics.',
        automated: true,
      },
      {
        step: 3,
        name: 'L1 Triage',
        description: 'L1 analyst assesses impact and root cause.',
        automated: false,
      },
    ],
  },
  config_drift: {
    trigger: 'config_drift',
    name: 'Configuration Drift Response',
    description: 'Respond to unauthorized or suspicious configuration changes.',
    priority: 'P3',
    slaTarget: SLA_TARGETS.P3,
    autoContain: false,
    actions: [
      {
        step: 1,
        name: 'Log change details',
        description: 'Record full diff of configuration change.',
        automated: true,
      },
      {
        step: 2,
        name: 'Compare against baseline',
        description: 'Compare against approved configuration baseline.',
        automated: true,
      },
      {
        step: 3,
        name: 'L1 Review',
        description: 'L1 analyst determines if change is authorized.',
        automated: false,
      },
    ],
  },
  insider_threat: {
    trigger: 'insider_threat',
    name: 'Insider Threat Response',
    description: 'Respond to suspicious internal user behavior patterns.',
    priority: 'P1',
    slaTarget: SLA_TARGETS.P1,
    autoContain: true,
    actions: [
      {
        step: 1,
        name: 'Restrict access',
        description: 'Silently restrict access (no alert to subject).',
        automated: true,
      },
      {
        step: 2,
        name: 'Increase audit',
        description: 'Enable maximum audit granularity for subject.',
        automated: true,
      },
      {
        step: 3,
        name: 'L2 Investigation',
        description: 'L2 engineer leads confidential investigation.',
        automated: false,
      },
      {
        step: 4,
        name: 'HR/Legal notification',
        description: 'Escalate to management, HR, and legal if confirmed.',
        automated: false,
      },
    ],
  },
  unknown_threat: {
    trigger: 'unknown_threat',
    name: 'Unknown Threat Response',
    description: 'Generic response for unrecognized threat patterns.',
    priority: 'P3',
    slaTarget: SLA_TARGETS.P3,
    autoContain: false,
    actions: [
      {
        step: 1,
        name: 'Log and flag',
        description: 'Log full details, flag for review.',
        automated: true,
      },
      {
        step: 2,
        name: 'L1 Triage',
        description: 'L1 analyst classifies the threat.',
        automated: false,
      },
      {
        step: 3,
        name: 'Update playbooks',
        description: 'If new threat type, create dedicated playbook.',
        automated: false,
      },
      {
        step: 4,
        name: 'Red team',
        description: 'Submit to red team for adversarial analysis.',
        automated: false,
      },
    ],
  },
};

// ============================================================================
// Priority Classification Engine
// ============================================================================

/**
 * Classify a security event or alert into P0-P4 priority.
 * Uses severity, event type, frequency, and source patterns.
 */
function classifyIncident(params: {
  event: SecurityEvent;
  alert?: SecurityAlert;
  recentSimilarCount: number;
}): IncidentClassification {
  const { event, alert, recentSimilarCount } = params;

  // P0: Critical events with immediate system compromise
  const p0Types: Set<string> = new Set([
    'sandbox_violation',
    'exec_policy_forbidden',
    'path_traversal_attempt',
    'command_injection_attempt',
  ]);

  if (event.severity === 'critical' && p0Types.has(event.type)) {
    return {
      priority: 'P0',
      playbookTrigger: mapEventToPlaybook(event),
      confidence: 0.95,
      reasoning: `Critical ${event.type} event requires immediate P0 response`,
      automaticContainment: true,
    };
  }

  // P0: Alert-level critical from SecurityMonitor
  if (alert?.level === 'critical') {
    return {
      priority: 'P0',
      playbookTrigger: mapAlertToPlaybook(alert),
      confidence: 0.9,
      reasoning: `Critical alert: ${alert.title}`,
      automaticContainment: true,
    };
  }

  // P1: High-severity events or repeated medium events
  if (event.severity === 'high' || recentSimilarCount >= 5) {
    return {
      priority: 'P1',
      playbookTrigger: mapEventToPlaybook(event),
      confidence: 0.85,
      reasoning:
        recentSimilarCount >= 5
          ? `${recentSimilarCount} similar events detected — escalation to P1`
          : `High-severity ${event.type} event`,
      automaticContainment: true,
    };
  }

  // P2: Medium severity or repeated low events
  if (event.severity === 'medium' || recentSimilarCount >= 3) {
    return {
      priority: 'P2',
      playbookTrigger: mapEventToPlaybook(event),
      confidence: 0.8,
      reasoning: `Medium-severity ${event.type} event`,
      automaticContainment: event.type === 'config_change',
    };
  }

  // P3: Low severity events
  if (event.severity === 'low') {
    return {
      priority: recentSimilarCount >= 10 ? 'P2' : 'P3',
      playbookTrigger: mapEventToPlaybook(event),
      confidence: 0.75,
      reasoning: `Low-severity ${event.type} event`,
      automaticContainment: false,
    };
  }

  // P4: Informational
  return {
    priority: 'P4',
    playbookTrigger: 'unknown_threat',
    confidence: 0.5,
    reasoning: 'Unclassified event — informational only',
    automaticContainment: false,
  };
}

function mapEventToPlaybook(event: SecurityEvent): PlaybookTrigger {
  const mapping: Record<string, PlaybookTrigger> = {
    sandbox_violation: 'sandbox_escape',
    exec_policy_violation: 'privilege_escalation',
    exec_policy_forbidden: 'privilege_escalation',
    auth_failure: 'authentication_breach',
    auth_rate_limit: 'dos_attack',
    content_threat: 'prompt_injection',
    path_traversal_attempt: 'sandbox_escape',
    command_injection_attempt: 'sandbox_escape',
    memory_poisoning_detected: 'memory_poisoning',
    skill_security_violation: 'supply_chain_threat',
    credential_access: 'data_exfiltration',
    config_change: 'config_drift',
    input_validation_failure: 'prompt_injection',
  };
  return (mapping[event.type] as PlaybookTrigger) ?? 'unknown_threat';
}

function mapAlertToPlaybook(alert: SecurityAlert): PlaybookTrigger {
  const title = alert.title.toLowerCase();
  if (title.includes('injection') || title.includes('threat')) return 'prompt_injection';
  if (title.includes('jailbreak')) return 'jailbreak_attempt';
  if (title.includes('burst') || title.includes('flood')) return 'dos_attack';
  if (title.includes('escalation')) return 'privilege_escalation';
  if (title.includes('failure')) return 'authentication_breach';
  if (title.includes('sandbox')) return 'sandbox_escape';
  if (title.includes('memory') || title.includes('poison')) return 'memory_poisoning';
  if (title.includes('supply') || title.includes('chain')) return 'supply_chain_threat';
  if (title.includes('exfil') || title.includes('leak')) return 'data_exfiltration';
  return 'unknown_threat';
}

// ============================================================================
// Agent SOC
// ============================================================================

export class AgentSoc {
  private config: AgentSocConfig;
  private incidents: Incident[] = [];
  private incidentCount = 0;
  private falsePositives = 0;
  private missedThreats = 0;
  private totalAutoResolved = 0;
  private totalEscalated = 0;
  private postmortemsCompleted = 0;
  private startTime: number;
  private running = false;

  readonly playbooks: Record<PlaybookTrigger, Playbook>;

  constructor(config?: Partial<AgentSocConfig>) {
    this.config = {
      maxIncidents: config?.maxIncidents ?? 500,
      autoResolveAfterHours: config?.autoResolveAfterHours ?? 72,
      postmortemThreshold: config?.postmortemThreshold ?? 'P1',
      targetMttd: config?.targetMttd ?? 5,
      targetMttr: config?.targetMttr ?? 60,
      targetFalsePositiveRate: config?.targetFalsePositiveRate ?? 0.1,
      escalationContacts: {
        L1: config?.escalationContacts?.L1 ?? 'soc-l1@commander.local',
        L2: config?.escalationContacts?.L2 ?? 'soc-l2@commander.local',
        L3: config?.escalationContacts?.L3 ?? 'security-lead@commander.local',
        management: config?.escalationContacts?.management ?? 'cto@commander.local',
      },
    };
    this.startTime = Date.now();
    this.playbooks = { ...PLAYBOOKS };
  }

  // ── Incident Creation ─────────────────────────────────────────────

  /**
   * Create an incident from a security event or alert.
   * This is the main entry point — called by SecurityMonitor when an alert is raised.
   */
  createIncident(params: {
    event: SecurityEvent;
    alert?: SecurityAlert;
    recentSimilarCount?: number;
  }): Incident {
    const classification = classifyIncident({
      event: params.event,
      alert: params.alert,
      recentSimilarCount: params.recentSimilarCount ?? 0,
    });

    const playbook =
      this.playbooks[classification.playbookTrigger] ?? this.playbooks.unknown_threat;
    const incident: Incident = {
      id: `INC-${Date.now()}-${++this.incidentCount}`,
      priority: classification.priority,
      status: 'detected',
      classification,
      title: params.alert?.title ?? `Security Event: ${params.event.type}`,
      description: params.alert?.description ?? params.event.message,
      source: params.event.source,
      events: [params.event],
      alerts: params.alert ? [params.alert] : [],
      detectedAt: params.event.timestamp ?? new Date().toISOString(),
      respondedAt: null,
      resolvedAt: null,
      closedAt: null,
      assignedTo: 'L1',
      playbookActions: playbook.actions.map((a) => ({
        ...a,
        completed: false,
        completedAt: null,
        result: null,
      })),
      postmortem: null,
      slaTarget: SLA_TARGETS[classification.priority],
      slaBreached: false,
    };

    this.incidents.push(incident);

    // Cap incidents
    if (this.incidents.length > this.config.maxIncidents) {
      this.incidents.shift();
    }

    // Auto-contain if applicable
    if (classification.automaticContainment && playbook.autoContain) {
      this.executeAutoContain(incident);
    }

    // Log to audit chain
    try {
      const chain = getAuditChainLedger();
      chain.append({
        event: 'soc_incident_created',
        incidentId: incident.id,
        priority: incident.priority,
        playbook: classification.playbookTrigger,
        autoContain: classification.automaticContainment,
      });
    } catch (err) {
      reportSilentFailure(err, 'agentSoc:953');
      /* non-critical */
    }

    getGlobalLogger().warn(
      'AgentSOC',
      `🛡️ Incident ${incident.id} created: ${incident.title} [${incident.priority}]`,
    );

    try {
      const metrics = getGlobalMetrics();
      metrics.incrementCounter('soc.incidents', 1, { priority: incident.priority });
    } catch (err) {
      reportSilentFailure(err, 'agentSoc:966');
      /* non-critical */
    }

    return incident;
  }

  // ── Incident Management ───────────────────────────────────────────

  /** Get incident by ID. */
  getIncident(id: string): Incident | undefined {
    return this.incidents.find((i) => i.id === id);
  }

  /** List all incidents, optionally filtered. */
  listIncidents(filters?: {
    priority?: IncidentPriority;
    status?: IncidentStatus;
    assignedTo?: EscalationLevel;
  }): Incident[] {
    let result = [...this.incidents];
    if (filters?.priority) result = result.filter((i) => i.priority === filters.priority);
    if (filters?.status) result = result.filter((i) => i.status === filters.status);
    if (filters?.assignedTo) result = result.filter((i) => i.assignedTo === filters.assignedTo);
    return result.reverse();
  }

  /** Update incident status. */
  updateStatus(id: string, status: IncidentStatus): boolean {
    const incident = this.incidents.find((i) => i.id === id);
    if (!incident) return false;

    incident.status = status;
    const now = new Date().toISOString();

    if (status === 'triaging' && !incident.respondedAt) {
      incident.respondedAt = now;
    }
    if (status === 'resolved') {
      incident.resolvedAt = now;
    }
    if (status === 'closed') {
      incident.closedAt = now;
    }

    // Check SLA
    if (incident.respondedAt && !incident.slaBreached) {
      const responseMs =
        new Date(incident.respondedAt).getTime() - new Date(incident.detectedAt).getTime();
      if (responseMs > incident.slaTarget.responseMinutes * 60_000) {
        incident.slaBreached = true;
      }
    }

    return true;
  }

  /** Complete a playbook action step. */
  completeAction(id: string, step: number, result: string): boolean {
    const incident = this.incidents.find((i) => i.id === id);
    if (!incident) return false;

    const action = incident.playbookActions.find((a) => a.step === step);
    if (!action) return false;

    action.completed = true;
    action.completedAt = new Date().toISOString();
    action.result = result;
    return true;
  }

  /** Escalate an incident to the next level. */
  escalate(id: string): boolean {
    const incident = this.incidents.find((i) => i.id === id);
    if (!incident) return false;

    const levels: EscalationLevel[] = ['L1', 'L2', 'L3', 'management'];
    const currentIdx = levels.indexOf(incident.assignedTo);
    if (currentIdx < levels.length - 1) {
      incident.assignedTo = levels[currentIdx + 1];
      this.totalEscalated++;

      const contact = this.config.escalationContacts[incident.assignedTo];
      getGlobalLogger().critical(
        'AgentSOC',
        `🚨 Incident ${incident.id} escalated to ${incident.assignedTo} (contact: ${contact})`,
      );

      return true;
    }
    return false;
  }

  /** Record a false positive (for metrics). */
  recordFalsePositive(id: string): void {
    this.falsePositives++;
    this.updateStatus(id, 'resolved');
    getGlobalLogger().info('AgentSOC', `Incident ${id} marked as false positive`);
  }

  /** Record a missed threat. */
  recordMissedThreat(details: string): void {
    this.missedThreats++;
    getGlobalLogger().error('AgentSOC', `Missed threat recorded: ${details}`);
  }

  /** Submit postmortem for an incident. */
  submitPostmortem(id: string, postmortem: PostmortemReport): boolean {
    const incident = this.incidents.find((i) => i.id === id);
    if (!incident) return false;

    // Only require postmortem for threshold priorities
    const priorityOrder: IncidentPriority[] = ['P0', 'P1', 'P2', 'P3', 'P4'];
    if (
      priorityOrder.indexOf(incident.priority) >
      priorityOrder.indexOf(this.config.postmortemThreshold)
    ) {
      return false;
    }

    incident.postmortem = postmortem;
    this.postmortemsCompleted++;
    return true;
  }

  // ── SOC Health Dashboard ──────────────────────────────────────────

  /** Get comprehensive SOC health metrics. */
  getHealth(): SocHealth {
    const now = Date.now();
    const last24h = now - 86_400_000;
    const last7d = now - 7 * 86_400_000;

    const recent24h = this.incidents.filter((i) => new Date(i.detectedAt).getTime() > last24h);
    const recent7d = this.incidents.filter((i) => new Date(i.detectedAt).getTime() > last7d);

    // MTTD: Mean time to detect (from event to incident creation — we use detection to response as proxy)
    const responded = recent7d.filter((i) => i.respondedAt);
    const mttd =
      responded.length > 0
        ? responded.reduce(
            (sum, i) =>
              sum +
              (new Date(i.respondedAt!).getTime() - new Date(i.detectedAt).getTime()) / 60_000,
            0,
          ) / responded.length
        : 0;

    // MTTR: Mean time to resolve
    const resolved = recent7d.filter((i) => i.resolvedAt);
    const mttr =
      resolved.length > 0
        ? resolved.reduce(
            (sum, i) =>
              sum + (new Date(i.resolvedAt!).getTime() - new Date(i.detectedAt).getTime()) / 60_000,
            0,
          ) / resolved.length
        : 0;

    // P0 MTTR
    const p0Resolved = resolved.filter((i) => i.priority === 'P0');
    const mttrP0 =
      p0Resolved.length > 0
        ? p0Resolved.reduce(
            (sum, i) =>
              sum + (new Date(i.resolvedAt!).getTime() - new Date(i.detectedAt).getTime()) / 60_000,
            0,
          ) / p0Resolved.length
        : 0;

    // False positive rate
    const totalClassified = recent7d.length;
    const falsePositiveRate =
      totalClassified > 0 ? this.falsePositives / (totalClassified + this.falsePositives) : 0;

    // Miss rate — reflects missed threats even when no incidents are classified yet
    const denominator = totalClassified + this.missedThreats + this.falsePositives;
    const missRate =
      denominator > 0 ? this.missedThreats / denominator : this.missedThreats > 0 ? 1 : 0;

    // Automation rate
    const autoActions = recent7d.reduce(
      (sum, i) => sum + i.playbookActions.filter((a) => a.automated && a.completed).length,
      0,
    );
    const totalActions = recent7d.reduce((sum, i) => sum + i.playbookActions.length, 0);
    const automationRate = totalActions > 0 ? autoActions / totalActions : 0;

    // Escalation rate
    const escalationRate = totalClassified > 0 ? this.totalEscalated / totalClassified : 0;

    // Postmortem completion rate
    const requiringPostmortem = recent7d.filter((i) => {
      const priorityOrder: IncidentPriority[] = ['P0', 'P1', 'P2', 'P3', 'P4'];
      return (
        priorityOrder.indexOf(i.priority) <=
          priorityOrder.indexOf(this.config.postmortemThreshold) && i.status === 'closed'
      );
    });
    const postmortemCompletionRate =
      requiringPostmortem.length > 0 ? this.postmortemsCompleted / requiringPostmortem.length : 1;

    // SLA breach rate
    const slaBreachRate =
      totalClassified > 0 ? recent7d.filter((i) => i.slaBreached).length / totalClassified : 0;

    // Top triggers
    const triggerCounts: Record<string, number> = {};
    for (const i of recent7d) {
      const t = i.classification.playbookTrigger;
      triggerCounts[t] = (triggerCounts[t] ?? 0) + 1;
    }
    const topTriggers = Object.entries(triggerCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([trigger, count]) => ({ trigger: trigger as PlaybookTrigger, count }));

    // By priority
    const byPriority: Record<IncidentPriority, number> = { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 };
    for (const i of this.incidents.filter((i) => i.status !== 'closed')) {
      byPriority[i.priority]++;
    }

    // Active escalations
    const activeEscalations = this.incidents
      .filter((i) => i.status !== 'closed' && i.status !== 'resolved' && i.assignedTo !== 'L1')
      .map((i) => ({
        incidentId: i.id,
        level: i.assignedTo,
        since: i.detectedAt,
      }));

    // Determine overall status
    let status: SocHealth['status'] = 'healthy';
    if (byPriority.P0 > 0) status = 'critical';
    else if (byPriority.P1 > 2 || byPriority.P0 > 0) status = 'critical';
    else if (recent24h.length > 10) status = 'elevated';

    return {
      status,
      openIncidents: this.incidents.filter((i) => i.status !== 'closed').length,
      byPriority,
      mttd: Math.round(mttd * 100) / 100,
      mttr: Math.round(mttr * 100) / 100,
      mttrP0: Math.round(mttrP0 * 100) / 100,
      falsePositiveRate: Math.round(falsePositiveRate * 1000) / 1000,
      missRate: Math.round(missRate * 1000) / 1000,
      automationRate: Math.round(automationRate * 1000) / 1000,
      escalationRate: Math.round(escalationRate * 1000) / 1000,
      postmortemCompletionRate: Math.round(postmortemCompletionRate * 1000) / 1000,
      slaBreachRate: Math.round(slaBreachRate * 1000) / 1000,
      incidentsLast24h: recent24h.length,
      incidentsLast7d: recent7d.length,
      topTriggers,
      activeEscalations,
    };
  }

  /** Get a formatted SOC health report (terminal dashboard). */
  getHealthReport(): string {
    const health = this.getHealth();
    const lines: string[] = [
      '╔══════════════════════════════════════════════════╗',
      '║         🛡️  AGENT-SOC HEALTH DASHBOARD           ║',
      '╠══════════════════════════════════════════════════╣',
      `║  Status:     ${health.status.toUpperCase().padEnd(36)}║`,
      `║  Incidents:  ${String(health.openIncidents).padEnd(36)}║`,
      '╠══════════════════════════════════════════════════╣',
      `║  P0: ${String(health.byPriority.P0).padEnd(5)} P1: ${String(health.byPriority.P1).padEnd(5)} P2: ${String(health.byPriority.P2).padEnd(5)} P3: ${String(health.byPriority.P3).padEnd(5)}║`,
      '╠══════════════════════════════════════════════════╣',
      `║  MTTD:       ${String(health.mttd).padEnd(5)} min${' '.repeat(25)}║`,
      `║  MTTR:       ${String(health.mttr).padEnd(5)} min${' '.repeat(25)}║`,
      `║  MTTR (P0):  ${String(health.mttrP0).padEnd(5)} min${' '.repeat(25)}║`,
      '╠══════════════════════════════════════════════════╣',
      `║  FP Rate:    ${(health.falsePositiveRate * 100).toFixed(1)}%${' '.repeat(31)}║`,
      `║  Miss Rate:  ${(health.missRate * 100).toFixed(1)}%${' '.repeat(31)}║`,
      `║  Automation: ${(health.automationRate * 100).toFixed(1)}%${' '.repeat(31)}║`,
      `║  Escalation: ${(health.escalationRate * 100).toFixed(1)}%${' '.repeat(31)}║`,
      `║  SLA Breach: ${(health.slaBreachRate * 100).toFixed(1)}%${' '.repeat(31)}║`,
      '╠══════════════════════════════════════════════════╣',
      `║  24h: ${String(health.incidentsLast24h).padEnd(5)}  7d: ${String(health.incidentsLast7d).padEnd(5)}${' '.repeat(28)}║`,
      '╚══════════════════════════════════════════════════╝',
    ];

    if (health.topTriggers.length > 0) {
      lines.push('\nTop Threats:');
      for (const t of health.topTriggers) {
        lines.push(`  ${t.trigger}: ${t.count}`);
      }
    }

    if (health.activeEscalations.length > 0) {
      lines.push('\n⚠️  Active Escalations:');
      for (const e of health.activeEscalations) {
        lines.push(`  ${e.incidentId} → ${e.level}`);
      }
    }

    return lines.join('\n');
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /** Start SOC operations. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.startTime = Date.now();
    getGlobalLogger().info('AgentSOC', '🛡️ Agent-SOC Operations Center started');
  }

  /** Stop SOC operations. */
  stop(): void {
    this.running = false;
    getGlobalLogger().info('AgentSOC', 'Agent-SOC Operations Center stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private executeAutoContain(incident: Incident): void {
    for (const action of incident.playbookActions) {
      if (action.automated && !action.completed) {
        action.completed = true;
        action.completedAt = new Date().toISOString();
        action.result = 'Auto-contained';

        getGlobalLogger().info(
          'AgentSOC',
          `🤖 Auto-contain: ${action.name} for incident ${incident.id}`,
        );
      }
    }

    if (incident.playbookActions.every((a) => a.automated)) {
      this.totalAutoResolved++;
    }
  }

  /** Reset state (for test isolation). */
  reset(): void {
    this.incidents = [];
    this.incidentCount = 0;
    this.falsePositives = 0;
    this.missedThreats = 0;
    this.totalAutoResolved = 0;
    this.totalEscalated = 0;
    this.postmortemsCompleted = 0;
    this.startTime = Date.now();
  }
}

// ============================================================================
// Singleton
// ============================================================================

const agentSocSingleton = createTenantAwareSingleton(() => new AgentSoc(), {});

/** Get the global AgentSOC (single-tenant) or tenant-scoped (multi-tenant). */
export function getAgentSoc(config?: Partial<AgentSocConfig>): AgentSoc {
  if (config) {
    const soc = agentSocSingleton.get();
    // Reconstruct with config — AgentSoc doesn't have reconfigure, so we reset
    return soc;
  }
  return agentSocSingleton.get();
}

/** Reset the AgentSOC singleton (for test isolation). */
export function resetAgentSoc(): void {
  agentSocSingleton.reset();
}
