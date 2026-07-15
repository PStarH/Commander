/**
 * Re-export of canonical observability/sloMonitoringEngine.ts (near-verbatim; core uses named SRE constants).
 */
export {
  DEFAULT_WINDOW_CONFIG,
  SLOMonitoringEngine,
  getSLOMonitoringEngine,
  resetSLOMonitoringEngine,
  type SLOWindowConfig,
  type BurnRateSeverity,
  type BurnRateResult,
  type SLODashboard,
} from '../../../observability/sloMonitoringEngine';
