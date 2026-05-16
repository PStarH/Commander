/**
 * StepErrorBoundary — Per-step error recovery for agent execution.
 *
 * Wraps a single operation (tool call or LLM call) with configurable
 * recovery strategies: retry (with modified params), fallback (alternative
 * approach), skip (record and continue), or abort (fail the execution).
 *
 * State recorded to DeadLetterQueue for post-mortem analysis.
 */
import { DeadLetterQueue, type DeadLetterEntry, type DLQCategory } from './deadLetterQueue';
import { classifyLLMError, computeBackoff, type ErrorClass } from './llmRetry';

export type RecoveryStrategy = 'retry' | 'fallback' | 'skip' | 'abort';

export interface ErrorBoundaryConfig {
  maxRetries: number;
  retryDelayMs: number;
  /** Strategy to use when maxRetries exhausted */
  onExhausted: RecoveryStrategy;
  /** Strategy to use for permanent (non-retryable) errors */
  onPermanent: RecoveryStrategy;
}

const DEFAULT_CONFIG: ErrorBoundaryConfig = {
  maxRetries: 2,
  retryDelayMs: 1000,
  onExhausted: 'skip',
  onPermanent: 'abort',
};

export interface ErrorBoundaryResult<T> {
  success: boolean;
  value?: T;
  error?: string;
  errorClass: ErrorClass;
  attempts: number;
  recovered: boolean;
}

export class StepErrorBoundary {
  private config: ErrorBoundaryConfig;
  private dlq: DeadLetterQueue;
  private runId: string;
  private agentId: string;
  private missionId?: string;

  constructor(
    runId: string,
    agentId: string,
    dlq: DeadLetterQueue,
    missionId?: string,
    config?: Partial<ErrorBoundaryConfig>,
  ) {
    this.runId = runId;
    this.agentId = agentId;
    this.missionId = missionId;
    this.dlq = dlq;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async execute<T>(
    operationName: string,
    category: DLQCategory,
    fn: () => Promise<T>,
    options?: {
      tags?: string[];
      inputSnapshot?: string;
      tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
      /** Called before each retry attempt (e.g., to modify request) */
      onRetry?: (attempt: number, error: string) => void;
      /** Called when the operation is skipped */
      onSkip?: (error: string) => void;
    },
  ): Promise<ErrorBoundaryResult<T>> {
    let lastError = '';
    let lastErrorClass: ErrorClass = 'unknown';
    let attempts = 0;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      attempts++;
      try {
        const value = await fn();
        return { success: true, value, errorClass: 'transient', attempts, recovered: attempt > 0 };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        const classified = classifyLLMError(err);
        lastErrorClass = classified.errorClass;

        this.recordToDLQ(operationName, category, lastError, lastErrorClass, classified.retryable, attempt, options);

        if (!classified.retryable) {
          const strategy = this.config.onPermanent;
          if (strategy === 'abort') {
            return { success: false, error: lastError, errorClass: lastErrorClass, attempts, recovered: false };
          }
          if (strategy === 'skip') {
            options?.onSkip?.(lastError);
            return { success: false, error: lastError, errorClass: lastErrorClass, attempts, recovered: false };
          }
          if (strategy === 'fallback') {
            return { success: false, error: lastError, errorClass: lastErrorClass, attempts, recovered: false };
          }
        }

        if (attempt < this.config.maxRetries) {
          options?.onRetry?.(attempt, lastError);
          const delayMs = classified.retryAfter ?? computeBackoff(attempt, this.config.retryDelayMs);
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
    }

    const strategy = this.config.onExhausted;
    if (strategy === 'abort') {
      return { success: false, error: lastError, errorClass: lastErrorClass, attempts, recovered: false };
    }
    options?.onSkip?.(lastError);
    return { success: false, error: lastError, errorClass: lastErrorClass, attempts, recovered: false };
  }

  private recordToDLQ(
    operationName: string,
    category: DLQCategory,
    errorMessage: string,
    errorClass: ErrorClass,
    retryable: boolean,
    attemptNumber: number,
    options?: {
      tags?: string[];
      inputSnapshot?: string;
      tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    },
  ): void {
    const entry: DeadLetterEntry = {
      id: `dlq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      category,
      runId: this.runId,
      agentId: this.agentId,
      missionId: this.missionId,
      timestamp: new Date().toISOString(),
      errorClass,
      errorMessage: errorMessage.slice(0, 500),
      retryable,
      attemptNumber,
      operationName,
      inputSnapshot: options?.inputSnapshot?.slice(0, 1000),
      tokenUsage: options?.tokenUsage,
      compensated: false,
      recovered: false,
      tags: options?.tags ?? [],
    };
    this.dlq.record(entry);
  }
}
