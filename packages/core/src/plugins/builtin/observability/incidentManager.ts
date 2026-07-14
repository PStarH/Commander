/**
 * Incident Manager
 *
 * Operational incident management and post-mortem automation for SLO-driven
 * reliability.  Complements the security-focused AgentSOC with a general
 * operational incident system that handles:
 *
 *   - SLO burn-rate triggered incidents (page severity)
 *   - Alert escalation (warning → critical → page → incident)
 *   - Timeline tracking (detection → triage → mitigation → resolution)
 *   - Automated post-mortem generation with root-cause analysis template
 *   - Action item tracking and follow-up
 *
 * Lifecycle:
 *   detected → investigating → mitigated → resolved → postmortem_pending → closed
 *
 * Integration:
 *   - Created by SLOMonitoringEngine when burn rate reaches 'page' severity
 *   - Created by AlertRuleEngine when 'page' alerts fire
 *   - Post-mortem templates auto-generated on resolution
 *   - Exposed via /api/v1/incidents HTTP endpoint
 */

import { getGlobalLogger } from '../../../logging';
import { getMessageBus } from '../../../runtime/messageBus';

// ============================================================================
// Types
// ============================================================================

export type IncidentSeverity = 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';
export type IncidentStatus =
  | 'detected'
  | 'investigating'
  | 'mitigated'
  | 'resolved'
  | 'postmortem_pending'
  | 'closed';

export type IncidentSource = 'slo_burn_rate' | 'alert_escalation' | 'manual' | 'health_check';

export interface IncidentTimelineEntry {
  timestamp: string;
  event: string;
  actor: string;
  details?: Record<string, unknown>;
}

export interface PostmortemActionItem {
  id: string;
  description: string;
  owner: string;
  dueDate: string;
  status: 'open' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
}

export interface PostmortemReport {
  incidentId: string;
  status: 'draft' | 'in_review' | 'approved';
  /** What happened — factual summary */
  summary: string;
  /** Impact on users/system */
  impact: string;
  /** Root cause(s) identified */
  rootCauses: string[];
  /** Timeline of events */
  timeline: IncidentTimelineEntry[];
  /** What went well */
  whatWentWell: string[];
  /** What went poorly */
  whatWentPoorly: string[];
  /** Action items to prevent recurrence */
  actionItems: PostmortemActionItem[];
  /** Lessons learned */
  lessonsLearned: string[];
  /** Detection time (minutes from incident start to detection) */
  timeToDetectMinutes: number;
  /** Mitigation time (minutes from detection to mitigation) */
  timeToMitigateMinutes: number;
  /** Resolution time (minutes from detection to resolution) */
  timeToResolveMinutes: number;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface OperationalIncident {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  source: IncidentSource;
  /** SLO ID if triggered by SLO burn rate */
  sloId?: string;
  /** Alert ID if triggered by alert escalation */
  alertId?: string;
  /** Affected components */
  affectedComponents: string[];
  /** When the incident was detected */
  detectedAt: string;
  /** When mitigation was applied */
  mitigatedAt?: string;
  /** When the incident was resolved */
  resolvedAt?: string;
  /** When the incident was closed */
  closedAt?: string;
  /** Incident timeline */
  timeline: IncidentTimelineEntry[];
  /** Assigned responder */
  assignedTo?: string;
  /** Post-mortem report (created on resolution) */
  postmortem: PostmortemReport | null;
  /** Current metrics snapshot at time of incident */
  metricsSnapshot: Record<string, number>;
  /** Labels for filtering */
  labels: Record<string, string>;
}

export interface IncidentSummary {
  total: number;
  open: number;
  SEV1: number;
  SEV2: number;
  SEV3: number;
  SEV4: number;
  postmortemPending: number;
  postmortemCompleted: number;
  /** Mean time to detect (minutes) over last 30 days */
  mttdMinutes: number;
  /** Mean time to resolve (minutes) over last 30 days */
  mttrMinutes: number;
}

// ============================================================================
// Severity → SLA mapping (Google SRE style)
// ============================================================================

const SEVERITY_SLA: Record<
  IncidentSeverity,
  {
    responseTarget: number; // minutes
    resolutionTarget: number; // minutes
    description: string;
  }
> = {
  SEV1: {
    responseTarget: 5,
    resolutionTarget: 60,
    description: 'Critical — system down or major user impact',
  },
  SEV2: {
    responseTarget: 15,
    resolutionTarget: 240,
    description: 'High — significant degradation, workaround exists',
  },
  SEV3: {
    responseTarget: 60,
    resolutionTarget: 720,
    description: 'Medium — moderate impact, non-urgent',
  },
  SEV4: {
    responseTarget: 240,
    resolutionTarget: 2880,
    description: 'Low — minor issue, no user impact',
  },
};

// ============================================================================
// Incident Manager
// ============================================================================

export class IncidentManager {
  private incidents: Map<string, OperationalIncident> = new Map();
  private maxHistorySize: number;

  constructor(maxHistorySize: number = 5000) {
    this.maxHistorySize = maxHistorySize;
  }

  /**
   * Create a new incident from an SLO burn-rate alert or alert escalation.
   */
  createIncident(params: {
    title: string;
    severity: IncidentSeverity;
    source: IncidentSource;
    sloId?: string;
    alertId?: string;
    affectedComponents: string[];
    metricsSnapshot?: Record<string, number>;
    labels?: Record<string, string>;
  }): OperationalIncident {
    const id = `incident-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const incident: OperationalIncident = {
      id,
      title: params.title,
      severity: params.severity,
      status: 'detected',
      source: params.source,
      sloId: params.sloId,
      alertId: params.alertId,
      affectedComponents: params.affectedComponents,
      detectedAt: now,
      timeline: [
        {
          timestamp: now,
          event: 'Incident detected',
          actor: 'system',
          details: {
            source: params.source,
            severity: params.severity,
            sloId: params.sloId,
            alertId: params.alertId,
            metrics: params.metricsSnapshot,
          },
        },
      ],
      postmortem: null,
      metricsSnapshot: params.metricsSnapshot ?? {},
      labels: params.labels ?? {},
    };

    this.incidents.set(id, incident);
    this.publishIncidentEvent('incident.created', incident);

    getGlobalLogger().warn('IncidentManager', 'Incident created', {
      id,
      title: params.title,
      severity: params.severity,
      source: params.source,
    });

    return incident;
  }

  /**
   * Update incident status and add timeline entry.
   */
  updateStatus(
    id: string,
    status: IncidentStatus,
    actor: string,
    details?: string,
  ): OperationalIncident | undefined {
    const incident = this.incidents.get(id);
    if (!incident) return undefined;

    const now = new Date().toISOString();
    incident.status = status;

    switch (status) {
      case 'investigating':
        incident.timeline.push({
          timestamp: now,
          event: 'Investigation started',
          actor,
          details: details ? { note: details } : undefined,
        });
        break;
      case 'mitigated':
        incident.mitigatedAt = now;
        incident.timeline.push({
          timestamp: now,
          event: 'Mitigation applied',
          actor,
          details: details ? { note: details } : undefined,
        });
        break;
      case 'resolved':
        incident.resolvedAt = now;
        incident.timeline.push({
          timestamp: now,
          event: 'Incident resolved',
          actor,
          details: details ? { note: details } : undefined,
        });
        // Auto-generate post-mortem draft
        incident.postmortem = this.generatePostmortemDraft(incident);
        incident.status = 'postmortem_pending';
        break;
      case 'closed':
        incident.closedAt = now;
        incident.timeline.push({
          timestamp: now,
          event: 'Incident closed',
          actor,
          details: details ? { note: details } : undefined,
        });
        break;
    }

    this.publishIncidentEvent('incident.updated', incident);

    return incident;
  }

  /**
   * Add a timeline entry to an incident.
   */
  addTimelineEntry(
    id: string,
    event: string,
    actor: string,
    details?: Record<string, unknown>,
  ): OperationalIncident | undefined {
    const incident = this.incidents.get(id);
    if (!incident) return undefined;

    incident.timeline.push({
      timestamp: new Date().toISOString(),
      event,
      actor,
      details,
    });

    return incident;
  }

  /**
   * Assign a responder to an incident.
   */
  assign(id: string, responder: string): OperationalIncident | undefined {
    const incident = this.incidents.get(id);
    if (!incident) return undefined;

    incident.assignedTo = responder;
    incident.timeline.push({
      timestamp: new Date().toISOString(),
      event: `Assigned to ${responder}`,
      actor: 'system',
    });

    return incident;
  }

  /**
   * Submit or update a post-mortem report.
   */
  submitPostmortem(
    id: string,
    postmortem: Partial<PostmortemReport>,
    author: string,
  ): OperationalIncident | undefined {
    const incident = this.incidents.get(id);
    if (!incident) return undefined;

    const now = new Date().toISOString();

    if (!incident.postmortem) {
      incident.postmortem = this.generatePostmortemDraft(incident);
    }

    incident.postmortem = {
      ...incident.postmortem,
      ...postmortem,
      incidentId: id,
      author,
      updatedAt: now,
    };

    // If postmortem is approved, close the incident
    if (postmortem.status === 'approved') {
      incident.status = 'closed';
      incident.closedAt = now;
      incident.timeline.push({
        timestamp: now,
        event: 'Post-mortem approved, incident closed',
        actor: author,
      });
    }

    this.publishIncidentEvent('incident.postmortem', incident);

    return incident;
  }

  /**
   * Add an action item to a post-mortem.
   */
  addActionItem(
    incidentId: string,
    description: string,
    owner: string,
    priority: 'high' | 'medium' | 'low',
    dueDate: string,
  ): PostmortemActionItem | undefined {
    const incident = this.incidents.get(incidentId);
    if (!incident?.postmortem) return undefined;

    const item: PostmortemActionItem = {
      id: `action-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      description,
      owner,
      dueDate,
      status: 'open',
      priority,
    };

    incident.postmortem.actionItems.push(item);
    return item;
  }

  /**
   * Get an incident by ID.
   */
  getIncident(id: string): OperationalIncident | undefined {
    return this.incidents.get(id);
  }

  /**
   * List incidents with optional filters.
   */
  listIncidents(filters?: {
    status?: IncidentStatus;
    severity?: IncidentSeverity;
    sloId?: string;
    sinceMs?: number;
    limit?: number;
  }): OperationalIncident[] {
    let incidents = Array.from(this.incidents.values());

    if (filters?.status) {
      incidents = incidents.filter((i) => i.status === filters.status);
    }
    if (filters?.severity) {
      incidents = incidents.filter((i) => i.severity === filters.severity);
    }
    if (filters?.sloId) {
      incidents = incidents.filter((i) => i.sloId === filters.sloId);
    }
    if (filters?.sinceMs !== undefined) {
      const cutoff = Date.now() - filters.sinceMs;
      incidents = incidents.filter((i) => new Date(i.detectedAt).getTime() >= cutoff);
    }

    incidents.sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime());

    const limit = filters?.limit ?? 100;
    return incidents.slice(0, limit);
  }

  /**
   * Get incident summary dashboard.
   */
  getSummary(): IncidentSummary {
    const all = Array.from(this.incidents.values());
    const open = all.filter((i) => i.status !== 'closed' && i.status !== 'resolved');
    const postmortemPending = all.filter((i) => i.status === 'postmortem_pending');
    const postmortemCompleted = all.filter(
      (i) => i.status === 'closed' && i.postmortem?.status === 'approved',
    );

    // Calculate MTTD/MTTR over last 30 days
    const cutoff30d = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentResolved = all.filter(
      (i) => i.resolvedAt && new Date(i.detectedAt).getTime() >= cutoff30d,
    );

    let mttdMinutes = 0;
    let mttrMinutes = 0;
    if (recentResolved.length > 0) {
      // MTTD: time from incident start to first "investigating" status
      const detectTimes = recentResolved.map((i) => {
        const investigateEntry = i.timeline.find((t) => t.event.includes('Investigation'));
        if (investigateEntry) {
          return (
            (new Date(investigateEntry.timestamp).getTime() - new Date(i.detectedAt).getTime()) /
            60000
          );
        }
        return 0;
      });
      mttdMinutes = detectTimes.reduce((a, b) => a + b, 0) / detectTimes.length;

      // MTTR: time from detection to resolution
      const resolveTimes = recentResolved.map(
        (i) => (new Date(i.resolvedAt!).getTime() - new Date(i.detectedAt).getTime()) / 60000,
      );
      mttrMinutes = resolveTimes.reduce((a, b) => a + b, 0) / resolveTimes.length;
    }

    return {
      total: all.length,
      open: open.length,
      SEV1: open.filter((i) => i.severity === 'SEV1').length,
      SEV2: open.filter((i) => i.severity === 'SEV2').length,
      SEV3: open.filter((i) => i.severity === 'SEV3').length,
      SEV4: open.filter((i) => i.severity === 'SEV4').length,
      postmortemPending: postmortemPending.length,
      postmortemCompleted: postmortemCompleted.length,
      mttdMinutes: Math.round(mttdMinutes * 10) / 10,
      mttrMinutes: Math.round(mttrMinutes * 10) / 10,
    };
  }

  /**
   * Get SLA status for an incident.
   */
  getSLAStatus(id: string):
    | {
        withinResponseTarget: boolean;
        withinResolutionTarget: boolean;
        responseTargetMinutes: number;
        resolutionTargetMinutes: number;
        elapsedMinutes: number;
      }
    | undefined {
    const incident = this.incidents.get(id);
    if (!incident) return undefined;

    const sla = SEVERITY_SLA[incident.severity];
    const elapsedMs = Date.now() - new Date(incident.detectedAt).getTime();
    const elapsedMinutes = elapsedMs / 60000;

    return {
      withinResponseTarget: elapsedMinutes <= sla.responseTarget,
      withinResolutionTarget: elapsedMinutes <= sla.resolutionTarget,
      responseTargetMinutes: sla.responseTarget,
      resolutionTargetMinutes: sla.resolutionTarget,
      elapsedMinutes: Math.round(elapsedMinutes * 10) / 10,
    };
  }

  /**
   * Clear all state (for testing).
   */
  reset(): void {
    this.incidents.clear();
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  /**
   * Auto-generate a post-mortem draft with a structured template.
   * The draft pre-fills what we know (timeline, metrics) and leaves
   * human-judgment fields as empty templates for the responder to fill.
   */
  private generatePostmortemDraft(incident: OperationalIncident): PostmortemReport {
    const now = new Date().toISOString();

    const detectedTime = new Date(incident.detectedAt).getTime();
    const resolvedTime = incident.resolvedAt ? new Date(incident.resolvedAt).getTime() : Date.now();
    const mitigatedTime = incident.mitigatedAt ? new Date(incident.mitigatedAt).getTime() : null;

    const timeToDetectMinutes = 0; // detected immediately by system
    const timeToMitigateMinutes = mitigatedTime
      ? Math.round(((mitigatedTime - detectedTime) / 60000) * 10) / 10
      : 0;
    const timeToResolveMinutes = Math.round(((resolvedTime - detectedTime) / 60000) * 10) / 10;

    const sla = SEVERITY_SLA[incident.severity];
    const withinSLA = timeToResolveMinutes <= sla.resolutionTarget;

    return {
      incidentId: incident.id,
      status: 'draft',
      summary:
        `[AUTO-DRAFT] ${incident.title}. Incident source: ${incident.source}.` +
        ` Severity: ${incident.severity}. Detected: ${incident.detectedAt}.` +
        ` Resolved: ${incident.resolvedAt ?? 'pending'}.` +
        ` Duration: ${timeToResolveMinutes} minutes (SLA target: ${sla.resolutionTarget} min, ${withinSLA ? 'within SLA' : 'BREACHED'}).`,
      impact: `[AUTO-DRAFT] Describe user-facing impact. Affected components: ${incident.affectedComponents.join(', ')}.`,
      rootCauses: ['[AUTO-DRAFT] Identify the underlying cause(s) that led to this incident.'],
      timeline: incident.timeline,
      whatWentWell: [
        '[AUTO-DRAFT] List what worked well during detection, response, and recovery.',
      ],
      whatWentPoorly: ['[AUTO-DRAFT] List what did not work well and caused delays or confusion.'],
      actionItems: [],
      lessonsLearned: ['[AUTO-DRAFT] What did we learn that should change how we operate?'],
      timeToDetectMinutes,
      timeToMitigateMinutes,
      timeToResolveMinutes,
      author: 'system',
      createdAt: now,
      updatedAt: now,
    };
  }

  private publishIncidentEvent(eventType: string, incident: OperationalIncident): void {
    try {
      const bus = getMessageBus();
      bus.publish('system.alert', 'incidentManager', {
        type: eventType,
        incidentId: incident.id,
        title: incident.title,
        severity: incident.severity,
        status: incident.status,
        sloId: incident.sloId,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Bus not initialized — skip
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalManager: IncidentManager | null = null;

export function getIncidentManager(): IncidentManager {
  if (!globalManager) {
    globalManager = new IncidentManager();
  }
  return globalManager;
}

export function resetIncidentManager(): void {
  globalManager?.reset();
  globalManager = null;
}
