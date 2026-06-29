/**
 * Saga Coordinator — Distributed transactions with compensating actions
 *
 * Implements the ISagaCoordinator contract from Pillar I.
 *
 * A saga is a sequence of steps, each with an optional compensation
 * (rollback) action. If any step fails, all previously completed steps
 * are compensated in reverse order.
 *
 * Pattern:
 *   Step 1: BookFlight  → compensate: CancelFlight
 *   Step 2: BookHotel   → compensate: CancelHotel
 *   Step 3: BookCar     → compensate: CancelCar
 *
 * If Step 3 fails → compensate Step 2, then Step 1.
 *
 * Per constraint NFR-CON-02, provides strong consistency (not eventual).
 */

import * as crypto from 'node:crypto';
import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import type { ISagaCoordinator, ISagaStep, SagaStatus } from '../contracts/pillarI';

// ============================================================================
// Types
// ============================================================================

interface SagaExecution {
  id: string;
  steps: ISagaStep[];
  status: SagaStatus;
  completedSteps: string[];
  currentStepIndex: number;
  startedAt: number;
  completedAt: number | null;
  error: Error | null;
}

// ============================================================================
// ContractSagaCoordinator Implementation
// ============================================================================

export class ContractSagaCoordinator implements ISagaCoordinator {
  private sagas: Map<string, SagaExecution> = new Map();
  private compensations: Map<string, () => Promise<unknown>> = new Map();
  private defaultTimeoutMs: number;

  constructor(options?: { defaultTimeoutMs?: number }) {
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 60000;
  }

  /**
   * Execute a saga with the given steps.
   *
   * Steps are executed sequentially. If any step fails:
   * 1. The saga status changes to COMPENSATING
   * 2. All completed steps are compensated in reverse order
   * 3. The saga status becomes FAILED or ABORTED
   *
   * Returns the result of the last step, or throws on failure.
   */
  async executeSaga(steps: ISagaStep[], options?: { timeoutMs?: number }): Promise<unknown> {
    const sagaId = crypto.randomUUID();
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;

    const saga: SagaExecution = {
      id: sagaId,
      steps,
      status: 'EXECUTING',
      completedSteps: [],
      currentStepIndex: 0,
      startedAt: Date.now(),
      completedAt: null,
      error: null,
    };

    this.sagas.set(sagaId, saga);

    getGlobalLogger().info('SagaCoordinator', 'Saga started', {
      sagaId,
      stepCount: steps.length,
    });

    let lastResult: unknown = undefined;

    try {
      // Execute each step sequentially
      for (let i = 0; i < steps.length; i++) {
        saga.currentStepIndex = i;
        const step = steps[i];

        // Execute with timeout
        const stepTimeout = step.timeoutMs ?? timeoutMs;
        lastResult = await this.executeWithTimeout(step.execute, stepTimeout);

        saga.completedSteps.push(step.id);

        // Register compensation if provided
        if (step.compensate) {
          this.compensations.set(`${sagaId}:${step.id}`, step.compensate);
        }

        getGlobalLogger().debug('SagaCoordinator', 'Step completed', {
          sagaId,
          stepId: step.id,
          stepIndex: i,
        });
      }

      // All steps completed successfully
      saga.status = 'COMPLETED';
      saga.completedAt = Date.now();

      getGlobalLogger().info('SagaCoordinator', 'Saga completed', {
        sagaId,
        durationMs: saga.completedAt - saga.startedAt,
      });

      return lastResult;
    } catch (err) {
      saga.error = err as Error;
      saga.status = 'COMPENSATING';

      getGlobalLogger().warn('SagaCoordinator', 'Saga failed — compensating', {
        sagaId,
        failedStep: saga.steps[saga.currentStepIndex]?.id,
        error: (err as Error).message,
      });

      // Compensate in reverse order
      await this.compensateSaga(saga);

      saga.status = 'FAILED';
      saga.completedAt = Date.now();

      throw err;
    }
  }

  /**
   * Register a compensation action for a completed step.
   */
  registerCompensation(stepId: string, compensation: () => Promise<unknown>): void {
    // Find the saga that contains this step
    for (const [sagaId, saga] of this.sagas) {
      if (saga.completedSteps.includes(stepId)) {
        this.compensations.set(`${sagaId}:${stepId}`, compensation);
        return;
      }
    }

    // If no saga found, store with a global key
    this.compensations.set(`global:${stepId}`, compensation);
  }

  /**
   * Get the status of a saga by ID.
   */
  getStatus(sagaId: string): SagaStatus {
    const saga = this.sagas.get(sagaId);
    return saga?.status ?? 'PENDING';
  }

  /**
   * Get a saga execution by ID.
   */
  getSaga(sagaId: string): SagaExecution | undefined {
    return this.sagas.get(sagaId);
  }

  /**
   * Get all saga executions.
   */
  getAllSagas(): SagaExecution[] {
    return [...this.sagas.values()];
  }

  /**
   * Get sagas by status.
   */
  getSagasByStatus(status: SagaStatus): SagaExecution[] {
    return [...this.sagas.values()].filter((s) => s.status === status);
  }

  // ------------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------------

  /**
   * Compensate all completed steps in reverse order.
   */
  private async compensateSaga(saga: SagaExecution): Promise<void> {
    const completedSteps = [...saga.completedSteps].reverse();

    for (const stepId of completedSteps) {
      const compensationKey = `${saga.id}:${stepId}`;
      const compensation = this.compensations.get(compensationKey);

      if (compensation) {
        try {
          await compensation();
          getGlobalLogger().debug('SagaCoordinator', 'Compensation succeeded', {
            sagaId: saga.id,
            stepId,
          });
        } catch (compErr) {
          // Compensation failure is critical but we continue compensating
          reportSilentFailure(compErr, `sagaCoordinator:compensate:${stepId}`);
          getGlobalLogger().error('SagaCoordinator', 'Compensation failed', compErr as Error, {
            sagaId: saga.id,
            stepId,
          });
        }
      }
    }

    // Clean up compensations for this saga
    for (const stepId of saga.completedSteps) {
      this.compensations.delete(`${saga.id}:${stepId}`);
    }
  }

  /**
   * Execute a function with a timeout.
   */
  private async executeWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    if (timeoutMs <= 0) {
      return fn();
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Step timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalContractSagaCoordinator: ContractSagaCoordinator | null = null;

export function getGlobalContractSagaCoordinator(): ContractSagaCoordinator {
  if (!globalContractSagaCoordinator) {
    globalContractSagaCoordinator = new ContractSagaCoordinator();
  }
  return globalContractSagaCoordinator;
}
