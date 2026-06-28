/**
 * FinallyCleanupHandler — extracted from AgentRuntime.execute()'s finally block.
 *
 * Guarantees cleanup on ALL exit paths (normal, error, exception) of execute():
 *   1. Circuit breaker release (if not already released)
 *   2. Run lifecycle cleanup (removeRun + active_runs gauge)
 *   3. Tenant concurrency release
 *   4. Lane manager slot release
 *   5. Concurrency controller slot release
 *   6. Tracer completeRun
 *   7. SLO check (getSLOManager, checkTrace, recordSLOViolation)
 *   8. OpenTelemetry export (otelExporter.exportSpan)
 *   9. SOP auto-export on success (.md + .json + bus event)
 *  10. Samples/trace store flush + tenant override restoration
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  AgentExecutionContext,
  AgentExecutionResult,
  AgentRuntimeConfig,
} from './types';
import type { TenantConfig } from './tenantProvider';
import type { CircuitBreaker } from './circuitBreaker';
import type { RunLifecycleManager } from './runLifecycleManager';
import type { TenantManager } from './tenantManager';
import type { ConcurrencyController } from './concurrencyController';
import type { SamplesStore } from './samplesStore';
import type { PersistentTraceStore } from './traceStore';
import type { StateCheckpointer } from './stateCheckpointer';
import type { TokenGovernor } from './tokenGovernor';
import type { ThreeLayerMemory } from '../threeLayerMemory';
import type { OpenTelemetryExporter } from './openTelemetryExporter';
import type { ConversationStore } from '../memory/conversationStore';
import type { ExecutionTraceRecorder } from './executionTrace';
import { executionTraceToOtlpSpans } from './openTelemetryExporter';
import { exportSOPFromTrace, formatSOPAsMarkdown } from './sopExport';
import { getMetricsCollector } from './metricsCollector';
import { getSLOManager } from '../observability/sloManager';
import { getLaneManager } from '../sandbox/lane';
import { getMessageBus } from './messageBus';
import { getGlobalLogger } from '../logging';

/**
 * Snapshot of original (pre-tenant-override) runtime services to restore after
 * a run completes. Shape mirrors the local interface historically defined in
 * agentRuntime.ts; structural typing keeps the two interchangeable.
 */
export interface TenantOverrides {
  origSamplesStore: SamplesStore;
  origTraceStore: PersistentTraceStore;
  origCheckpointer: StateCheckpointer;
  origMemory: ThreeLayerMemory | null;
  origGovernor: TokenGovernor;
}

/**
 * Constructor dependencies. These are getter functions so the handler always
 * reads the runtime's CURRENT (possibly tenant-overridden) instance fields
 * rather than stale references captured at construction time.
 */
export interface FinallyCleanupDeps {
  getCircuitBreaker: () => CircuitBreaker;
  getRunLifecycle: () => RunLifecycleManager;
  getTenantManager: () => TenantManager;
  getConcurrencyController: () => ConcurrencyController;
  getTracer: () => ExecutionTraceRecorder;
  getConfig: () => AgentRuntimeConfig;
  getOtelExporter: () => OpenTelemetryExporter | null;
  getSamplesStore: () => SamplesStore;
  getTraceStore: () => PersistentTraceStore;
  getConversationStore: () => ConversationStore | null;
  /** Restore the runtime's pre-tenant-override service instances. */
  restoreTenantOverrides: (
    overrides: TenantOverrides | undefined,
    tenantId: string | undefined,
  ) => void;
}

/** Per-run context passed into cleanup(). */
export interface FinallyCleanupParams {
  runId: string;
  ctx: AgentExecutionContext;
  circuitReleased: boolean;
  tenantCfg: TenantConfig | undefined;
  tenantId: string | undefined;
  currentLane: string;
  startTime: number;
  execResult: AgentExecutionResult | undefined;
  tenantOverrides: TenantOverrides | undefined;
}

/**
 * Encapsulates the finally-block cleanup logic of AgentRuntime.execute().
 * Keeping this in its own module shrinks the god object and makes the cleanup
 * ordering auditable in isolation.
 */
export class FinallyCleanupHandler {
  constructor(private readonly deps: FinallyCleanupDeps) {}

  /**
   * Run the full cleanup sequence. Must be awaited because SOP export and
   * samples flushing perform async filesystem / store I/O.
   */
  async cleanup(params: FinallyCleanupParams): Promise<void> {
    const {
      runId,
      ctx,
      circuitReleased,
      tenantCfg,
      tenantId,
      currentLane,
      execResult,
      tenantOverrides,
    } = params;
    const {
      getCircuitBreaker,
      getRunLifecycle,
      getTenantManager,
      getConcurrencyController,
      getTracer,
      getConfig,
      getOtelExporter,
      getSamplesStore,
      getTraceStore,
      restoreTenantOverrides,
    } = this.deps;
    const tracer = getTracer();

    // 1. Release circuit breaker if neither onSuccess nor onFailure was called
    if (!circuitReleased) getCircuitBreaker().release();

    // 2. GAP-02 + GAP-05: Guarantee cleanup on ALL exit paths (normal, error, exception)
    const runLifecycle = getRunLifecycle();
    runLifecycle.removeRun(runId);
    getMetricsCollector().setGauge(
      'active_runs',
      'Active concurrent runs',
      runLifecycle.getActiveRunCount(),
    );

    // 3. Tenant concurrency release
    if (tenantCfg?.enabled && tenantCfg.maxConcurrency > 0 && tenantId) {
      getTenantManager().releaseTenantConcurrency(tenantId);
    }

    // 4. Lane manager slot release
    getLaneManager().releaseSlot(currentLane);

    // 5. Concurrency controller slot release
    getConcurrencyController().releaseSlot();

    // 6. Tracer completeRun
    try {
      tracer.completeRun(runId);
    } catch (e) {
      getGlobalLogger().warn('AgentRuntime', 'Failed to complete trace', {
        runId,
        error: (e as Error)?.message,
      });
    }

    // 7. SLO check: evaluate trace against all active SLOs and record violations
    try {
      const trace = tracer.getTrace(runId);
      if (trace) {
        const sloManager = getSLOManager();
        const violations = sloManager.checkTrace(trace);
        for (const v of violations) {
          const sloDef = sloManager.getSLO(v.sloId);
          getMetricsCollector().recordSLOViolation(
            v.sloId,
            sloDef?.name ?? v.sloId,
            v.metric,
            v.severity,
            v.actualValue,
            v.threshold,
            tenantId,
          );
        }
      }
    } catch (e) {
      getGlobalLogger().warn('AgentRuntime', 'SLO check failed', {
        runId,
        error: (e as Error)?.message,
      });
    }

    // 8. Export trace to OpenTelemetry if configured
    const otelExporter = getOtelExporter();
    if (otelExporter) {
      try {
        const trace = tracer.getTrace(runId);
        if (trace) {
          const otelSpans = executionTraceToOtlpSpans(trace);
          for (const span of otelSpans) {
            otelExporter.exportSpan(span);
          }
        }
      } catch (e) {
        getGlobalLogger().warn('AgentRuntime', 'Failed to export OTel spans', {
          runId,
          error: (e as Error)?.message,
        });
      }
    }

    // 9. Auto-export SOP template on successful execution
    if (execResult?.status === 'success') {
      try {
        const trace = tracer.getTrace(runId);
        if (trace) {
          const sop = exportSOPFromTrace(trace);
          if (sop) {
            const sopDir = path.join(
              getConfig().sopDir || '.commander/sops',
              ctx.agentId,
            );
            await fs.promises.mkdir(sopDir, { recursive: true });
            const sopPath = path.join(sopDir, `${runId}.md`);
            await fs.promises.writeFile(sopPath, formatSOPAsMarkdown(sop), 'utf-8');
            // Also write structured JSON for API retrieval
            const jsonPath = path.join(sopDir, `${runId}.json`);
            await fs.promises.writeFile(jsonPath, JSON.stringify(sop, null, 2), 'utf-8');
            getGlobalLogger().debug('AgentRuntime', 'SOP auto-exported', {
              runId,
              path: sopPath,
            });
            // Publish bus event for SSE streaming and API visibility
            getMessageBus().publish('sop.generated', ctx.agentId, {
              runId,
              agentId: ctx.agentId,
              goal: sop.goal,
              path: sopPath,
              stepCount: sop.totalSteps,
              status: 'success',
              tags: sop.tags,
            });
          }
        }
      } catch (e) {
        getGlobalLogger().debug('AgentRuntime', 'SOP auto-export failed', {
          runId,
          error: (e as Error)?.message,
        });
      }
    }

    // 10. Flush stores + restore tenant overrides
    try {
      await getSamplesStore().flush();
    } catch (e) {
      getGlobalLogger().warn('AgentRuntime', 'Failed to flush samples', {
        runId,
        error: (e as Error)?.message,
      });
    }
    try {
      getTraceStore().flushAll();
    } catch (e) {
      getGlobalLogger().warn('AgentRuntime', 'Failed to flush traces', {
        runId,
        error: (e as Error)?.message,
      });
    }
    restoreTenantOverrides(tenantOverrides, tenantId);
  }
}
