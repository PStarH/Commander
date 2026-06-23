/**
 * Tier1Harness — Production-grade harness built on Tier1AgentLoop.
 *
 * Combines the best patterns from:
 *   - Codex CLI: parallel tool execution, structured errors, content sanitization,
 *     loop guards, circuit-breaker-aware execution via ToolOrchestrator
 *   - MiMo Code: tool whitelist enforcement, permission merge, non-interactive safety,
 *     plugin hooks, skills auto-discovery
 *   - Industry best practices: prompt-cache-friendly message structure,
 *     append-only context, dependency-aware execution, content scanning
 *
 * This harness is the default for all production runs. It delegates the actual
 * agent loop to Tier1AgentLoop and adds:
 *   - Tool whitelist enforcement
 *   - Approval mode integration
 *   - Guardian approval (optional, fail-closed by default)
 *   - Skills injection
 *   - Full audit trail via HarnessEvent stream
 */
import type {
  AgentHarness,
  HarnessSelectionContext,
  HarnessRunParams,
  HarnessCapabilities,
  HarnessServices,
  HarnessEvent,
  HarnessEventHandler,
  Unsubscribe,
  SteerMessage,
} from './harnessTypes';
import type { AgentExecutionResult, AgentExecutionStep, ToolResult } from '../runtime/types';
import { getGlobalLogger } from '../logging';
import { generateId, now } from '../runtime/runtimeHelpers';
import { Tier1AgentLoop, type Tier1LoopParams, type Tier1LoopResult } from './tier1AgentLoop';

export { Tier1AgentLoop, type Tier1LoopParams, type Tier1LoopResult } from './tier1AgentLoop';

export const TIER1_HARNESS_CAPABILITIES: HarnessCapabilities = {
  supportsSubAgents: true,
  supportsSteering: true,
  supportsGuardianApproval: true,
  supportsHashlineEdits: true,
  supportsAppendOnlyContext: true,
  supportsIntentTracing: true,
  supportsPlanMode: true,
  supportsPatchApplication: true,
  supportsSkillsLoading: true,
  supportsSessionPersistence: true,
  supportsFileWatching: true,
  supportsNetworkPolicy: true,
  supportsCommandClassification: true,
  supportsSandboxedExecution: false,
  supportsConcurrentExecution: true,
  supportsReasoningEffort: true,
  maxConcurrentTools: 8,
  maxToolCallsPerTurn: 30,
  description: 'Tier-1 production harness — parallel execution, structured errors, sanitization, loop guards, Guardian approval',
};

export class Tier1Harness implements AgentHarness {
  readonly name = 'tier1';

  private eventHandlers: Set<HarnessEventHandler> = new Set();
  private steerQueueInternal: SteerMessage[] = [];
  private abortController: AbortController | null = null;
  private currentRunId: string | null = null;

  private loop: Tier1AgentLoop;

  constructor() {
    this.loop = new Tier1AgentLoop((event) => this.emitEvent(event));
  }

  supports(_ctx: HarnessSelectionContext): boolean {
    return true;
  }

  async runAttempt(params: HarnessRunParams): Promise<AgentExecutionResult> {
    const {
      goal,
      messages,
      availableTools,
      tokenBudget,
      maxSteps,
      signal,
      tenantId,
      userId,
      routing,
      services,
      outputSchema,
      approvalMode,
      reasoningEffort,
      planMode,
      skills,
      sessionId,
      networkPolicy,
    } = params;

    this.abortController = new AbortController();
    const runId = generateId();
    this.currentRunId = runId;

    // Inject skills into system prompt if provided
    let systemMessages = messages.filter((m) => m.role === 'system');
    let nonSystemMessages = messages.filter((m) => m.role !== 'system');
    let effectiveSystemPrompt = systemMessages.map((m) => m.content).join('\n\n');

    if (skills && skills.length > 0) {
      for (const skillId of skills) {
        try {
          const injected = await services.injectSkill(skillId, effectiveSystemPrompt);
          effectiveSystemPrompt = injected;
        } catch {
          getGlobalLogger().warn('Tier1Harness', `Failed to inject skill ${skillId}`);
        }
      }
    }

    // Auto-load relevant skills if none specified
    if (!skills || skills.length === 0) {
      try {
        const relevantSkills = await services.loadSkills({ tags: ['harness', 'tool-calling', 'security'], limit: 5 });
        for (const skill of relevantSkills) {
          effectiveSystemPrompt = await services.injectSkill(skill.id, effectiveSystemPrompt);
        }
      } catch {
        // best-effort
      }
    }

    const initialMessages: typeof messages = [
      ...(effectiveSystemPrompt ? [{ role: 'system' as const, content: effectiveSystemPrompt }] : []),
      ...nonSystemMessages,
    ];

    const loopResult = await this.loop.run({
      goal,
      initialMessages,
      availableTools,
      tokenBudget,
      maxSteps,
      signal,
      abortSignal: this.abortController.signal,
      tenantId,
      userId,
      routing,
      services,
      outputSchema,
      approvalMode,
      reasoningEffort,
      planMode,
      skills,
      sessionId,
      networkPolicy,
      eventHandler: (event) => this.emitEvent(event),
    });

    // Map loop result to AgentExecutionResult
    const result: AgentExecutionResult = {
      runId: loopResult.result.runId,
      agentId: loopResult.result.agentId,
      status: loopResult.result.status,
      summary: loopResult.result.summary,
      steps: loopResult.result.steps.map((s) => ({
        stepNumber: s.stepNumber,
        timestamp: s.timestamp,
        type: s.type,
        content: s.content ?? '',
        tokenUsage: s.tokenUsage,
        durationMs: s.durationMs ?? 0,
        toolResult: s.toolResult,
      })),
      totalTokenUsage: loopResult.result.totalTokenUsage,
      totalDurationMs: loopResult.result.totalDurationMs,
      error: loopResult.result.error,
      outputData: loopResult.result.outputData,
    };

    return result;
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.currentRunId = null;
  }

  steer(message: string, priority: number = 0, abortCurrent: boolean = false): void {
    this.steerQueueInternal.push({
      id: `steer_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      message,
      timestamp: Date.now(),
      priority,
      abortCurrent,
    });
    if (abortCurrent || priority >= 10) {
      this.abort();
    }
  }

  subscribe(handler: HarnessEventHandler): Unsubscribe {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  getCapabilities(): HarnessCapabilities {
    return TIER1_HARNESS_CAPABILITIES;
  }

  // ============================================================================
  // Private: Event Emission
  // ============================================================================

  private emitEvent(event: HarnessEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        const result = handler(event);
        if (result instanceof Promise) {
          result.catch((err) => {
            getGlobalLogger().error('Tier1Harness', 'Async event handler error', err as Error);
          });
        }
      } catch (err) {
        getGlobalLogger().error('Tier1Harness', 'Event handler error', err as Error);
      }
    }
  }
}
