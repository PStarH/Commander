import { generateId } from './runtimeHelpers';
import type { AgentExecutionContext, AgentExecutionResult, AgentRuntimeConfig } from './types';
import type { TenantConfig, TenantProvider } from './tenantProvider';
import type { TenantManager } from './tenantManager';
import type { ConcurrencyController } from './concurrencyController';
import type { LaneManager } from '../sandbox/lane';
import type { RunLifecycleManager } from './runLifecycleManager';
import type { FreezeDryManager, ActiveRunState } from './freezeDry';
import type { ExecutionTraceRecorder } from './executionTrace';
import type { ExecutionScheduler, RunHandle } from '../atr/scheduler';
import type { TenantOverrides } from './finallyCleanupHandler';
import { getMessageBus } from './messageBus';
import { getGlobalLogger } from '../logging';
import { getGlobalTenantProvider } from './tenantProvider';
import { getMetricsCollector } from './metricsCollector';
import { getIntentLog } from './intentLog';
import { reportSilentFailure } from '../silentFailureReporter';

export interface RunInitializerDeps {
  getConfig(): AgentRuntimeConfig;
  getConcurrencyController(): ConcurrencyController;
  getTenantProvider(): TenantProvider;
  getTenantManager(): TenantManager;
  getLaneManager(): LaneManager;
  getRunLifecycle(): RunLifecycleManager;
  getFreezeDryManager(): FreezeDryManager;
  getTracer(): ExecutionTraceRecorder;
  getExecutionScheduler(): ExecutionScheduler;
}

export interface InitResult {
  runId: string;
  tenantId: string | undefined;
  tenantCfg: TenantConfig | undefined;
  tenantOverrides: TenantOverrides | undefined;
  currentLane: string;
  startTime: number;
  circuitReleased: boolean;
  runHandle: RunHandle;
}

export class RunInitializer {
  constructor(private deps: RunInitializerDeps) {}

  async initialize(ctx: AgentExecutionContext): Promise<InitResult> {
    await this.deps.getConcurrencyController().acquireSlot();

    const runId = generateId();
    const bus = getMessageBus();
    const tracer = this.deps.getTracer();
    const startTime = Date.now();

    const tenantId = getGlobalTenantProvider().getCurrentTenantId() ?? ctx.tenantId ?? undefined;
    const tenantCfg = tenantId
      ? this.deps.getTenantProvider().getTenantConfig(tenantId)
      : undefined;

    // tenantResolution is resolved inside AgentRuntime; we keep the simple path here
    // and assume the caller (AgentRuntime) supplies tenant overrides via restoreTenantOverrides.

    const currentLane = await this.deps.getLaneManager().acquireSlot({
      tenantId: getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
      agentId: ctx.agentId,
      runId,
      args: ctx.lane ? { lane: ctx.lane } : undefined,
    });

    this.deps.getRunLifecycle().addRun(runId);

    try {
      const freezeMgr = this.deps.getFreezeDryManager();
      const activeRuns = new Map<string, ActiveRunState>();
      for (const activeRunId of this.deps.getRunLifecycle().getActiveRuns()) {
        activeRuns.set(activeRunId, {
          runId: activeRunId,
          agentId: ctx.agentId,
          phase: 'executing',
          stepNumber: 0,
          goal: ctx.goal,
          completedToolCalls: 0,
        });
      }
      freezeMgr.setActiveRuns(activeRuns);
    } catch (err) {
      reportSilentFailure(err, 'runInitializer:freezeDryInit');
    }

    tracer.startRun(runId, ctx.agentId, ctx.missionId, undefined, {
      tenantId: ctx.tenantId,
      parentRunId: ctx.parentRunId,
      subAgentDepth: ctx.subAgentDepth,
      subAgentRole: ctx.subAgentRole,
    });

    try {
      getIntentLog(ctx.tenantId).write({
        schemaVersion: 1,
        runId,
        capturedAt: new Date().toISOString(),
        stage: 'agentRuntime.execute',
        decision: 'start',
        reason: 'execute() entered',
        payload: {
          agentId: ctx.agentId,
          goal: ctx.goal.slice(0, 200),
          parentRunId: ctx.parentRunId,
          subAgentDepth: ctx.subAgentDepth,
        },
      });
    } catch (err) {
      reportSilentFailure(err, 'runInitializer:intentLog');
    }

    getMetricsCollector().setGauge(
      'active_runs',
      'Active concurrent runs',
      this.deps.getRunLifecycle().getActiveRunCount(),
    );

    const runHandle = this.deps.getExecutionScheduler().beginRun({
      runId,
      goal: ctx.goal,
      tenantId: getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
      metadata: { agentId: ctx.agentId, missionId: ctx.missionId },
      holder: 'agent-runtime',
    });

    return {
      runId,
      tenantId,
      tenantCfg,
      tenantOverrides: undefined,
      currentLane,
      startTime,
      circuitReleased: false,
      runHandle,
    };
  }

  toErrorResult(ctx: AgentExecutionContext, err: unknown): AgentExecutionResult {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      runId: '',
      agentId: ctx.agentId,
      missionId: ctx.missionId,
      status: 'failed',
      summary: msg,
      steps: [],
      totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      totalDurationMs: 0,
      error: msg,
    };
  }
}
