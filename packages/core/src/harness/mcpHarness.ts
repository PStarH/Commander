/**
 * McpHarness — Model Context Protocol server mode harness.
 *
 * Exposes Commander's tools and runtime via the MCP protocol so that MCP
 * clients (Claude Desktop, IDE plugins, etc.) can drive Commander.
 *
 * This is a stub for the future — the full MCP server integration will
 * delegate runAttempt to the existing Commander MCP server (see
 * packages/core/src/mcp/server.ts) and provide a transport over stdio.
 *
 * Capabilities are advertised for harness selection but runAttempt returns
 * a "not implemented" failure until the full MCP server mode is wired in.
 */
import type {
  AgentHarness,
  HarnessSelectionContext,
  HarnessRunParams,
  HarnessCapabilities,
  HarnessEvent,
  HarnessEventHandler,
  Unsubscribe,
  SteerMessage,
} from './harnessTypes';
import type { AgentExecutionResult } from '../runtime/types';
import { getGlobalLogger } from '../logging';
import { generateId, now } from '../runtime/runtimeHelpers';

export const MCP_HARNESS_CAPABILITIES: HarnessCapabilities = {
  supportsSubAgents: false,
  supportsSteering: false,
  supportsGuardianApproval: false,
  supportsHashlineEdits: false,
  supportsAppendOnlyContext: false,
  supportsIntentTracing: false,
  supportsPlanMode: false,
  supportsPatchApplication: false,
  supportsSkillsLoading: false,
  supportsSessionPersistence: false,
  supportsFileWatching: false,
  supportsNetworkPolicy: false,
  supportsCommandClassification: false,
  supportsSandboxedExecution: false,
  supportsConcurrentExecution: false,
  supportsReasoningEffort: false,
  maxConcurrentTools: 1,
  maxToolCallsPerTurn: 1,
  description: 'MCP server mode — exposes Commander via Model Context Protocol (stub)',
};

export class McpHarness implements AgentHarness {
  readonly name = 'mcp';

  private eventHandlers: Set<HarnessEventHandler> = new Set();
  private steerQueueInternal: SteerMessage[] = [];

  supports(ctx: HarnessSelectionContext): boolean {
    return ctx.features.includes('mcp-server');
  }

  async runAttempt(params: HarnessRunParams): Promise<AgentExecutionResult> {
    const runId = generateId();
    const startTime = Date.now();

    this.emitEvent({
      type: 'run_start',
      runId,
      goal: params.goal,
      harness: this.name,
      timestamp: Date.now(),
    });

    getGlobalLogger().warn(
      'McpHarness',
      'MCP server mode not yet fully implemented; goal will not be executed',
    );

    const result: AgentExecutionResult = {
      runId,
      agentId: params.goal.slice(0, 32),
      status: 'failed',
      summary:
        'MCP server mode is not yet fully implemented. The harness system supports selecting this harness via features=["mcp-server"], but execution is not wired up. Use DefaultHarness or CodeAgentHarness for now.',
      steps: [],
      totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      totalDurationMs: Date.now() - startTime,
      error: 'MCP server mode not yet implemented',
    };

    this.emitEvent({
      type: 'run_error',
      error: result.error ?? 'unknown',
      runId,
      timestamp: Date.now(),
    });
    return result;
  }

  abort(): void {
    this.steerQueueInternal = [];
  }

  steer(message: string, priority: number = 0, _abortCurrent: boolean = false): void {
    this.steerQueueInternal.push({
      id: `steer_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      message,
      timestamp: Date.now(),
      priority,
      abortCurrent: _abortCurrent,
    });
  }

  subscribe(handler: HarnessEventHandler): Unsubscribe {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  getCapabilities(): HarnessCapabilities {
    return MCP_HARNESS_CAPABILITIES;
  }

  private emitEvent(event: HarnessEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        const result = handler(event);
        if (result instanceof Promise) {
          result.catch((err) => {
            getGlobalLogger().error('McpHarness', 'Async event handler error', err as Error);
          });
        }
      } catch (err) {
        getGlobalLogger().error('McpHarness', 'Event handler error', err as Error);
      }
    }
  }
}
