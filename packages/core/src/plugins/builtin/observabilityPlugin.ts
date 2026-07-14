/**
 * observabilityPlugin - Built-in CommanderPlugin for peripheral observability:
 * HTTP API, MCP tools, offline trace analysis, eval scoring, SLO operations,
 * alert/incident management, and experiment runner.
 *
 * Registers as 'builtin-observability' (category: 'monitoring').
 * Hot-path observability primitives (costModel, anomalyDetector, sloManager,
 * otelSemConv, traceContextBridge, sinkFailureCounter) remain in core at
 * packages/core/src/observability/ — this plugin only contains the peripheral
 * analysis and API layer.
 *
 * Integration:
 *   - HTTP API: httpServer.ts imports handleObservabilityRequest etc. directly
 *   - MCP tools: commanderMcpServer.ts calls registerObservabilityTools
 *   - Offline: scripts/tests import buildTimeline, dryReplay, score, etc.
 */
import type { CommanderPlugin } from '../../pluginManager';
import { getGlobalLogger } from '../../logging';

// Re-export the peripheral observability API for consumers.
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

export function createObservabilityPlugin(): CommanderPlugin {
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
      getGlobalLogger().info(
        'ObservabilityPlugin',
        'Peripheral observability loaded (slo=' +
          (ctx.config.enableSLOMonitoring ?? true) +
          ', alerts=' +
          (ctx.config.enableAlertRules ?? true) +
          ', incidents=' +
          (ctx.config.enableIncidentManagement ?? true) +
          ')',
      );
    },

    onUnload: async () => {
      // Reset all singleton state to allow clean reload
      try {
        const { resetSLOOperations } = await import('./observability/sloOperations');
        resetSLOOperations();
      } catch {
        // Already reset or not initialized
      }
      getGlobalLogger().info('ObservabilityPlugin', 'Peripheral observability unloaded');
    },
  };
}
