/**
 * CompositeStepExecutor — routes step execution to the appropriate executor
 * based on the step kind.
 *
 * When a worker has multiple capabilities (e.g., both 'agent' and 'tool'),
 * this composite executor dispatches each step to the right handler.
 */

import type { StepExecutor, ClaimedStep, WorkerRecord } from './types.js';
import { WorkerExecutionError } from './types.js';

export class CompositeStepExecutor implements StepExecutor {
  private readonly executors: Map<string, StepExecutor>;

  constructor(executors: Map<string, StepExecutor>) {
    this.executors = executors;
  }

  async execute(
    step: ClaimedStep,
    context: { signal: AbortSignal; worker: WorkerRecord },
  ): Promise<Record<string, unknown> | undefined> {
    const executor = this.executors.get(step.kind);
    if (!executor) {
      throw new WorkerExecutionError(
        `No executor registered for step kind '${step.kind}'. Available: [${[...this.executors.keys()].join(', ')}]`,
        { code: 'NO_EXECUTOR', retryable: false },
      );
    }
    return executor.execute(step, context);
  }

  /** Register an additional executor for a step kind. */
  register(kind: string, executor: StepExecutor): void {
    this.executors.set(kind, executor);
  }
}
