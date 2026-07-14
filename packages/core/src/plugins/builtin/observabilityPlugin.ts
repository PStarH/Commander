/**
 * Peripheral observability CommanderPlugin (HTTP/MCP/offline analysis live in
 * ./observability/*). Hot-path primitives remain in packages/core/src/observability/.
 *
 * Config flags actually initialize SLO / alert / incident singletons on load.
 */
import type { CommanderPlugin } from '../../pluginManager';
import { getGlobalLogger } from '../../logging';

export { buildTimeline, buildSpanTree } from './observability/timelineBuilder';
export { buildDecisions, decisionsSummary } from './observability/decisionProvenance';
export { dryReplay } from './observability/replay';
export { buildExecutiveSummary } from './observability/executiveSummary';
export { handleObservabilityRequest, OBSERVABILITY_HTTP_ROUTES } from './observability/httpApi';
export type { ObservabilityDeps, ObservabilityResult } from './observability/httpApi';
export {
  handleSLOOperationsRequest,
  getSLOOperations,
  resetSLOOperations,
  DEFAULT_SLO_CONFIG,
} from './observability/sloOperations';
export type { SLOOperationsConfig } from './observability/sloOperations';
export {
  AlertRuleEngine,
  getAlertRuleEngine,
  resetAlertRuleEngine,
  createDefaultSLORules,
} from './observability/alertRuleEngine';
export type { AlertRule, AlertRecord, AlertSummary } from './observability/alertRuleEngine';
export {
  IncidentManager,
  getIncidentManager,
  resetIncidentManager,
} from './observability/incidentManager';
export type {
  OperationalIncident,
  IncidentSummary,
  PostmortemReport,
} from './observability/incidentManager';
export { SLOMonitoringEngine, getSLOMonitoringEngine } from './observability/sloMonitoringEngine';
export { DatadogExporter } from './observability/datadogExporter';
export { SamplingPolicy } from './observability/samplingPolicy';
export { PromptVersionTracker } from './observability/promptVersioning';
export { ToolMetricsCollector } from './observability/toolMetrics';
export { LogPersistence } from './observability/logPersistence';
export { DatasetStore } from '../../observability/dataset';
export type { Dataset } from '../../observability/dataset';
export { ExperimentRunner } from './observability/experimentRunner';
export { AutoScorer } from './observability/autoScorer';
export { EvalScorer } from './observability/evalScorer';
export { compareTraces } from './observability/traceComparison';
export {
  classifyExpected,
  classifyExpectedForSubstringMatch,
  isNormalizedSubstringMatch,
  normalizeForMatch,
} from './observability/normalizeExpected';
export { score } from './observability/score';
export type { Verdict, ScoreResult } from './observability/score';
export { handleRoutingDashboardRequest } from './observability/routingDashboard';
export type { RoutingDashboardDeps } from './observability/routingDashboard';

function asBool(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === 'boolean') return value;
  return defaultValue;
}

export function createObservabilityPlugin(): CommanderPlugin {
  let sloInitialized = false;
  let alertsReady = false;
  let incidentsReady = false;

  return {
    name: 'builtin-observability',
    version: '0.1.0',
    description:
      'Peripheral observability: HTTP API, MCP tools, offline trace analysis, eval scoring, SLO/alert/incident management',
    category: 'monitoring',
    configSchema: {
      type: 'object',
      properties: {
        enableSLOMonitoring: {
          type: 'boolean',
          description: 'Enable SLO burn-rate monitoring engine',
          default: true,
        },
        enableAlertRules: {
          type: 'boolean',
          description: 'Enable alert rule evaluation engine',
          default: true,
        },
        enableIncidentManagement: {
          type: 'boolean',
          description: 'Enable incident tracking and post-mortem automation',
          default: true,
        },
      },
    },

    onLoad: async (ctx) => {
      const enableSLO = asBool(ctx.config.enableSLOMonitoring, true);
      const enableAlerts = asBool(ctx.config.enableAlertRules, true);
      const enableIncidents = asBool(ctx.config.enableIncidentManagement, true);

      // Incidents are a dependency of the unified SLO ops pipeline; force on
      // when SLO monitoring is on so burn-rate → incident wiring is complete.
      const wantIncidents = enableIncidents || enableSLO;
      const wantAlerts = enableAlerts || enableSLO;

      if (wantIncidents) {
        const { getIncidentManager } = await import('./observability/incidentManager');
        getIncidentManager();
        incidentsReady = true;
      }

      if (wantAlerts) {
        const { getAlertRuleEngine } = await import('./observability/alertRuleEngine');
        getAlertRuleEngine();
        alertsReady = true;
      }

      if (enableSLO) {
        const { getSLOOperations, DEFAULT_SLO_CONFIG } = await import(
          './observability/sloOperations'
        );
        getSLOOperations().initialize({
          ...DEFAULT_SLO_CONFIG,
          autoStart: true,
        });
        sloInitialized = true;
      } else if (enableSLO === false) {
        // Explicit off: ensure no leftover monitoring loop from a prior load.
        const { resetSLOOperations } = await import('./observability/sloOperations');
        resetSLOOperations();
        sloInitialized = false;
      }

      getGlobalLogger().info(
        'ObservabilityPlugin',
        `Peripheral observability loaded (slo=${enableSLO}, alerts=${wantAlerts}, incidents=${wantIncidents})`,
      );
    },

    onUnload: async () => {
      try {
        if (sloInitialized) {
          const { resetSLOOperations } = await import('./observability/sloOperations');
          resetSLOOperations();
        } else {
          if (alertsReady) {
            const { resetAlertRuleEngine } = await import('./observability/alertRuleEngine');
            resetAlertRuleEngine();
          }
          if (incidentsReady) {
            const { resetIncidentManager } = await import('./observability/incidentManager');
            resetIncidentManager();
          }
        }
      } catch (err) {
        getGlobalLogger().warn(
          'ObservabilityPlugin',
          `Unload cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      sloInitialized = false;
      alertsReady = false;
      incidentsReady = false;
      getGlobalLogger().info('ObservabilityPlugin', 'Peripheral observability unloaded');
    },
  };
}
