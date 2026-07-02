/**
 * CompensationService — owns compensation logic for AgentRuntime.
 *
 * Encapsulates CompensationRegistry, CompensationEventSubscriber, the
 * periodic queue-processing timer, default mutation-tool handlers,
 * rollback plan generation, and saga execution.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { CompensationRegistry, type CompensableAction } from './compensationRegistry';
import { CompensationEventSubscriber } from './compensationEventSubscriber';
import { DeadLetterQueue } from './deadLetterQueue';
import { getMessageBus } from './messageBus';
import { getGlobalLogger } from '../logging';
import type { PersistentTraceStore } from './traceStore';
import { generateRollbackPlan } from '../compensation/rollbackPlanner';
import type { PlannedToolCall, PlanInput } from '../compensation/rollbackPlanner';
import type { CompensationPlan } from '../compensation/types';
import * as fsp from 'node:fs/promises';

export interface CompensationServiceDeps {
  dlq: DeadLetterQueue;
  getRunId: () => string;
  traceStore: PersistentTraceStore;
}

export class CompensationService {
  private registry: CompensationRegistry;
  private eventSubscriber: CompensationEventSubscriber;
  private dlq: DeadLetterQueue;
  private getRunId: () => string;
  private traceStore: PersistentTraceStore;
  private queueTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: CompensationServiceDeps) {
    this.dlq = deps.dlq;
    this.getRunId = deps.getRunId;
    this.traceStore = deps.traceStore;
    this.registry = new CompensationRegistry();
    this.eventSubscriber = new CompensationEventSubscriber();
    this.eventSubscriber.start(getMessageBus(), this.traceStore);
    this.registerDefaultCompensation();

    // Process any durable compensations queued from a prior run.
    try {
      this.registry
        .processQueue()
        .then((n) => {
          if (n > 0) {
            getGlobalLogger().info(
              'CompensationService',
              `Processed ${n} queued compensations on startup`,
            );
          }
        })
        .catch(() => {});
    } catch (err) {
      reportSilentFailure(err, 'compensationService:56');
      /* best-effort */
    }

    // Schedule periodic compensation queue processing (every 5 minutes)
    this.queueTimer = setInterval(
      () => {
        try {
          this.registry.processQueue().catch(() => {});
        } catch (err) {
          reportSilentFailure(err, 'compensationService:66');
          /* best-effort */
        }
      },
      5 * 60 * 1000,
    );
    if (typeof this.queueTimer.unref === 'function') this.queueTimer.unref();
  }

  getRegistry(): CompensationRegistry {
    return this.registry;
  }

  /**
   * Handle a mutation tool failure by generating a rollback plan and triggering compensation.
   * Publishes a 'tool.compensation_planned' bus event with plan metadata.
   * For safe plans, auto-executes compensation via the saga runner.
   */
  async handleMutationToolFailure(
    toolName: string,
    args: Record<string, unknown>,
    error: string,
    executedMutations: PlannedToolCall[],
  ): Promise<void> {
    const bus = getMessageBus();
    const runId = this.getRunId();

    const input: PlanInput = {
      plannedCalls: executedMutations,
      failure: { toolName, args, error },
    };
    const plan = generateRollbackPlan(input);

    for (const step of plan.steps) {
      this.registry.recordAction({
        actionId:
          step.forwardAction.actionId ??
          `comp-${step.forwardAction.toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        toolName: step.forwardAction.toolName,
        args: step.forwardAction.args,
        description: step.description,
        tags: ['tool', 'compensation', step.forwardAction.toolName],
        runId,
        agentId: 'system',
      });
    }

    bus.publish('tool.compensation_planned', 'runtime', {
      runId,
      toolName,
      stepCount: plan.steps.length,
      risk: plan.risk,
    });

    if (plan.risk === 'safe' && plan.steps.length > 0) {
      await this.compensateViaSaga(plan);
    }
  }

  /**
   * Execute a compensation plan by iterating through steps and calling
   * compensationRegistry.compensate() for each recorded action.
   */
  async compensateViaSaga(plan: CompensationPlan): Promise<void> {
    const bus = getMessageBus();
    const runId = this.getRunId();
    const totalSteps = plan.steps.length;

    for (let stepIndex = 0; stepIndex < totalSteps; stepIndex++) {
      const step = plan.steps[stepIndex];
      const actionId = step.forwardAction.actionId;
      if (!actionId) continue;

      const stepPayload = {
        runId,
        toolName: step.forwardAction.toolName,
        actionId,
        stepIndex,
        totalSteps,
      };

      bus.publish('tool.compensation_step', 'runtime', {
        ...stepPayload,
        status: 'started' as const,
      });

      try {
        const STEP_TIMEOUT_MS = 30_000;
        const MAX_ATTEMPTS = 3;
        let lastError: string | undefined;
        let lastResult: { success: boolean; error?: string } | undefined;
        let successfulAttempt = 0;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          const ac = new AbortController();
          const timeoutId = setTimeout(() => ac.abort(), STEP_TIMEOUT_MS);
          const compensationPromise = this.registry
            .compensate(actionId)
            .finally(() => clearTimeout(timeoutId));
          try {
            const result = await Promise.race<
              { success: boolean; error?: string } | { _aborted: true; reason: string }
            >([
              compensationPromise,
              new Promise<{ _aborted: true; reason: string }>((resolve) => {
                ac.signal.addEventListener('abort', () =>
                  resolve({ _aborted: true, reason: 'compensation_timeout' }),
                );
              }),
            ]);
            if ('_aborted' in result) {
              lastError = `Compensation timed out after ${STEP_TIMEOUT_MS}ms`;
            } else {
              lastResult = result;
              if (result.success) {
                successfulAttempt = attempt;
                break;
              }
              lastError = result.error;
            }
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
          }
          await compensationPromise.catch(() => undefined);
          if (attempt < MAX_ATTEMPTS) {
            const backoffMs = 200 * Math.pow(2, attempt - 1);
            await new Promise<void>((r) => setTimeout(r, backoffMs));
          }
        }
        const finalAttempt = successfulAttempt > 0 ? successfulAttempt : MAX_ATTEMPTS;
        if (lastResult?.success) {
          bus.publish('tool.compensation_step', 'runtime', {
            ...stepPayload,
            status: 'completed' as const,
            attempt: finalAttempt,
          });
        } else {
          bus.publish('tool.compensation_step', 'runtime', {
            ...stepPayload,
            status: 'failed' as const,
            error: lastError,
            attempt: finalAttempt,
          });
          getGlobalLogger().debug('CompensationService', 'Compensation step failed', {
            actionId,
            toolName: step.forwardAction.toolName,
            error: lastError,
            attempt: finalAttempt,
          });
          try {
            this.dlq.enqueue({
              category: 'compensation',
              operationName: 'compensation.exhausted',
              errorMessage: lastError ?? 'unknown',
              tags: [step.forwardAction.toolName, `attempt:${finalAttempt}`],
              failureMode: 'compensation_exhausted',
              failureModeNumber: 12,
            });
          } catch (err) {
            reportSilentFailure(err, 'compensationService:224');
            /* best-effort */
          }
        }
      } catch (err) {
        try {
          bus.publish('system.alert', 'runtime', {
            type: 'compensation_saga_threw',
            error: err instanceof Error ? err.message : String(err),
            totalSteps,
            runId,
          });
        } catch (err) {
          reportSilentFailure(err, 'compensationService:237');
          /* best-effort */
        }
        getGlobalLogger().debug('CompensationService', 'Compensation via saga threw unexpectedly', {
          error: err instanceof Error ? err.message : String(err),
          totalSteps,
          runId,
        });
        throw err;
      }
    }
  }

  /** Register default compensation handlers for mutation tools */
  private registerDefaultCompensation(): void {
    const reg = this.registry;
    const restoreFromSnapshot = async (action: CompensableAction) => {
      const filePath = action.args.filePath ?? action.args.path;
      if (typeof filePath !== 'string') return { success: true };
      const snapshotPath = `${filePath}.atr-snapshot.${action.actionId}`;
      try {
        // Async I/O — don't block the event loop on disk I/O during compensation.
        // Same semantics as the legacy sync impl: if no snapshot is on
        // disk, just unlink the live file; otherwise restore from snapshot
        // and remove the snapshot. ENOENT on unlink of filePath is benign.
        try {
          await fsp.access(snapshotPath);
        } catch {
          try {
            await fsp.unlink(filePath);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
          return { success: true };
        }
        const original = await fsp.readFile(snapshotPath, 'utf-8');
        await fsp.writeFile(filePath, original, 'utf-8');
        await fsp.unlink(snapshotPath);
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    };
    reg.register('file_write', restoreFromSnapshot);
    reg.register('file_edit', restoreFromSnapshot);
    reg.register('apply_patch', restoreFromSnapshot);
    reg.register('code_fixer', restoreFromSnapshot);
    reg.register('code_refiner', restoreFromSnapshot);
    reg.register('file_delete', restoreFromSnapshot);
    reg.register('mkdir', async (action) => {
      const dir = action.args.path ?? action.args.dir;
      if (typeof dir !== 'string') return { success: true };
      try {
        try {
          await fsp.access(dir);
        } catch {
          return { success: true };
        }
        const entries = await fsp.readdir(dir);
        if (entries.length === 0) {
          await fsp.rmdir(dir);
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });
    reg.register('memory_store', async (action) => {
      const key = action.args.key;
      if (typeof key !== 'string') return { success: true };
      try {
        const path = await import('path');
        const memoryPath = path.join(process.cwd(), '.commander', 'memory.json');
        try {
          await fsp.access(memoryPath);
        } catch {
          return { success: true };
        }
        const raw = await fsp.readFile(memoryPath, 'utf-8');
        const data = JSON.parse(raw) as Array<{ key: string }>;
        const filtered = data.filter((e) => e.key !== key);
        await fsp.writeFile(memoryPath, JSON.stringify(filtered, null, 2), 'utf-8');
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });
  }

  dispose(): void {
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }
    this.eventSubscriber.stop();
  }
}
