import type { SagaStepNode, SagaContext, RetryPolicy } from './types';
import { RetryController } from './retryController';

export interface CompensableStep {
  node: SagaStepNode;
  result: unknown;
}

export interface CompensationAttempt {
  nodeId: string;
  success: boolean;
  attempts: number;
  error?: Error;
}

export interface FailedCompensation {
  nodeId: string;
  runId: string;
  compensationError: Error;
  attempts: number;
  timestamp: string;
}

export interface CompensationResult {
  compensated: string[];
  failed: FailedCompensation[];
}

export type DeadLetterSink = (entry: FailedCompensation) => Promise<void>;

export interface CompensationSchedulerOptions {
  retryPolicy: RetryPolicy;
  deadLetter?: DeadLetterSink;
}

export class CompensationScheduler {
  private readonly retry: RetryController;
  private readonly dlq: DeadLetterSink;

  constructor(options: CompensationSchedulerOptions) {
    this.retry = new RetryController(options.retryPolicy);
    this.dlq = options.deadLetter ?? (() => Promise.resolve());
  }

  async compensate(
    steps: readonly CompensableStep[],
    context: SagaContext,
  ): Promise<CompensationResult> {
    const compensated: string[] = [];
    const failed: FailedCompensation[] = [];

    for (const step of steps) {
      const attempt = await this.runOne(step, context);
      if (attempt.success) {
        compensated.push(step.node.id);
      } else {
        const entry: FailedCompensation = {
          nodeId: step.node.id,
          runId: context.runId,
          compensationError: attempt.error ?? new Error('unknown'),
          attempts: attempt.attempts,
          timestamp: new Date().toISOString(),
        };
        failed.push(entry);
        await this.dlq(entry);
      }
    }

    return { compensated, failed };
  }

  async compensateParallel(
    steps: readonly CompensableStep[],
    context: SagaContext,
  ): Promise<CompensationResult> {
    const attempts = await Promise.all(steps.map((s) => this.runOne(s, context)));
    const compensated: string[] = [];
    const failed: FailedCompensation[] = [];

    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i];
      if (a.success) {
        compensated.push(steps[i].node.id);
      } else {
        const entry: FailedCompensation = {
          nodeId: steps[i].node.id,
          runId: context.runId,
          compensationError: a.error ?? new Error('unknown'),
          attempts: a.attempts,
          timestamp: new Date().toISOString(),
        };
        failed.push(entry);
        await this.dlq(entry);
      }
    }

    return { compensated, failed };
  }

  async forceCompensate(step: CompensableStep, context: SagaContext): Promise<CompensationAttempt> {
    return this.runOne(step, context);
  }

  private async runOne(step: CompensableStep, context: SagaContext): Promise<CompensationAttempt> {
    if (!step.node.compensate) {
      return { nodeId: step.node.id, success: true, attempts: 0 };
    }

    let attempts = 0;
    let lastError: Error | undefined;
    const max = this.retry.policy_.maxAttempts;

    while (attempts < max) {
      attempts++;
      try {
        await step.node.compensate(step.result);
        return { nodeId: step.node.id, success: true, attempts };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempts < max) {
          const delay = this.retry.computeDelay(attempts);
          if (delay > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
          }
        }
      }
    }

    return {
      nodeId: step.node.id,
      success: false,
      attempts,
      error: lastError,
    };
  }
}

export class CompensationSchedulerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompensationSchedulerError';
  }
}

export function defaultCompensationRetryPolicy(): RetryPolicy {
  return {
    maxAttempts: 3,
    backoff: 'exponential',
    initialDelayMs: 200,
    maxDelayMs: 5_000,
    jitter: 'equal',
  };
}
