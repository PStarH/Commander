/**
 * BaseHarness — shared foundation for all AgentHarness implementations.
 *
 * Centralizes event subscription/emit, steering queue management, abort
 * handling, and common result-building helpers so individual harnesses only
 * implement their specific execution strategy.
 */
import type {
  HarnessEvent,
  HarnessEventHandler,
  HarnessRunParams,
  SteerMessage,
  Unsubscribe,
} from './harnessTypes';
import type { AgentExecutionResult } from '../runtime/types';
import { SteerQueueImpl } from './harnessInfrastructure';
import { getGlobalLogger } from '../logging';
import { generateId } from '../runtime/runtimeHelpers';

export abstract class BaseHarness {
  abstract readonly name: string;

  protected eventHandlers: Set<HarnessEventHandler> = new Set();
  protected steerQueue = new SteerQueueImpl();
  protected abortController: AbortController | null = null;
  protected currentRunId: string | null = null;

  protected emitEvent(event: HarnessEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        const result = handler(event);
        if (result instanceof Promise) {
          result.catch((err) => {
            getGlobalLogger().error(this.name, 'Async event handler error', err as Error);
          });
        }
      } catch (err) {
        getGlobalLogger().error(this.name, 'Event handler error', err as Error);
      }
    }
  }

  subscribe(handler: HarnessEventHandler): Unsubscribe {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  steer(message: string, priority = 0, abortCurrent = false): void {
    this.steerQueue.push(message, priority, abortCurrent);
    if (abortCurrent || priority >= 10) {
      this.abort();
    }
  }

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.currentRunId = null;
  }

  /**
   * Pop the highest-priority steer message, if any.
   */
  protected popSteer(): SteerMessage | null {
    return this.steerQueue.pop();
  }

  /**
   * Drain all pending steer messages.
   */
  protected drainSteer(): SteerMessage[] {
    return this.steerQueue.drain();
  }

  /**
   * Prepare a new run and return common run metadata.
   */
  protected startRun(_goal: string): { runId: string; startTime: number } {
    const runId = generateId();
    this.currentRunId = runId;
    this.abortController = new AbortController();
    return { runId, startTime: Date.now() };
  }

  /**
   * Build a standardized AgentExecutionResult.
   */
  protected buildResult(
    runId: string,
    goal: string,
    status: AgentExecutionResult['status'],
    summary: string,
    params: Pick<HarnessRunParams, 'services' | 'tenantId'>,
    extras: {
      steps?: AgentExecutionResult['steps'];
      totalTokenUsage?: AgentExecutionResult['totalTokenUsage'];
      totalDurationMs?: number;
      error?: string;
      outputData?: Record<string, unknown>;
      artifactContent?: string;
    } = {},
  ): AgentExecutionResult {
    const agentId = goal.slice(0, 32);
    const result: AgentExecutionResult = {
      runId,
      agentId,
      status,
      summary,
      steps: extras.steps ?? [],
      totalTokenUsage: extras.totalTokenUsage ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      totalDurationMs: extras.totalDurationMs ?? 0,
      error: extras.error,
      outputData: extras.outputData,
      artifactContent: extras.artifactContent,
    };

    void params.services.fireOnAgentComplete({ result, runId }).catch((err) => {
      getGlobalLogger().error(this.name, 'onAgentComplete hook error', err as Error);
    });

    return result;
  }
}
