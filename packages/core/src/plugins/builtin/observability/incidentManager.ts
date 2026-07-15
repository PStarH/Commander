/**
 * Re-export of canonical observability/incidentManager.ts (near-verbatim duplicate collapsed 2026-07-15).
 */
export {
  IncidentManager,
  getIncidentManager,
  resetIncidentManager,
  type IncidentSeverity,
  type IncidentStatus,
  type IncidentSource,
  type IncidentTimelineEntry,
  type PostmortemActionItem,
  type PostmortemReport,
  type OperationalIncident,
  type IncidentSummary,
} from '../../../observability/incidentManager';
