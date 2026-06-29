/**
 * GoalCompletionVerifier — Extracted goal-completion verification gate.
 *
 * This block previously lived inline inside `AgentRuntime.execute()`'s retry
 * loop, right after tool execution and step completion. Its job is to verify
 * whether the agent's accumulated work has satisfied the original goal before
 * a stop signal is accepted.
 *
 * Mechanism: if the execution context names a `verificationTool`, the gate
 * invokes that tool (only when the model produced no tool calls of its own —
 * a tool-calling response means the agent is still working). A failed
 * verification forces the agent to continue rather than stopping early: the
 * failure feedback is injected into `request.messages` so the next iteration
 * sees it, and the caller `continue`s the retry loop.
 *
 * Side effects (mirroring the original inline block):
 *  - appends a `tool_result` step to `params.steps`
 *  - appends assistant + tool messages to `params.request.messages`
 *  - on failure (within the attempt budget) appends a user feedback message
 *
 * The runtime remains the orchestrator: terminal early-exit handling,
 * checkpointing, metrics, and cost recording stay in `AgentRuntime`.
 */
import type {
  AgentExecutionContext,
  AgentExecutionStep,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  RoutingDecision,
  ToolCall,
  ToolResult,
} from './types';
import { getHookManager } from '../pluginManager';
import { getGlobalLogger } from '../logging';
import { now } from './runtimeHelpers';

/**
 * Function used to execute a verification tool. Mirrors the surface of
 * `AgentRuntime.executeTool` so the verifier stays decoupled from the
 * runtime's concrete method (which may be reassigned per-tenant).
 */
export type ExecuteToolFn = (
  runId: string,
  toolCall: ToolCall,
  agentId: string,
  tenantId?: string,
  allowedTools?: string[],
  agentCtx?: AgentExecutionContext,
) => Promise<ToolResult>;

/**
 * Constructor dependencies. All are getters so the verifier always observes
 * the runtime's *current* instance state (e.g. `maxRetries` may be overridden
 * per-tenant, and `executeTool` is bound to the runtime).
 */
export interface GoalCompletionVerifierDeps {
  /** Returns a `this`-bound reference to the runtime's tool executor. */
  getExecuteTool: () => ExecuteToolFn;
  /** Returns the configured maximum number of retries for the attempt budget. */
  getMaxRetries: () => number;
}

/** Params for `GoalCompletionVerifier.verify()`. */
export interface GoalCompletionVerifyParams {
  ctx: AgentExecutionContext;
  runId: string;
  routing: RoutingDecision;
  /** Accumulated steps — the verification tool result is appended here. */
  steps: AgentExecutionStep[];
  /** Current request — assistant/tool/feedback messages are appended here. */
  request: LLMRequest;
  /** Latest LLM response — the gate only runs when it has no tool calls. */
  response: LLMResponse;
  /** Resolved tenant id (prefers the global tenant provider over ctx.tenantId). */
  tenantId: string | undefined;
  /** Current retry-loop attempt index. */
  attempt: number;
}

/** Result of a goal-completion verification check. */
export interface GoalCompletionVerifyResult {
  /**
   * True when the goal is considered satisfied from this gate's perspective:
   * no verification tool is configured, the model is still issuing tool
   * calls, or the verification tool reported success.
   */
  isComplete: boolean;
  /**
   * Feedback injected into the next iteration's context when the goal is not
   * yet complete and the attempt budget allows another retry. When set, the
   * caller should assign it to its `lastError` and `continue` the retry loop.
   */
  feedback?: string;
  /** Human-readable trace of the verification decision, for the execution trace. */
  verificationTrace?: string;
}

export class GoalCompletionVerifier {
  constructor(private readonly deps: GoalCompletionVerifierDeps) {}

  /**
   * Goal-completion verification gate.
   *
   * Returns `{ isComplete, feedback?, verificationTrace? }`. When `feedback`
   * is set the caller should `continue` the retry loop so the feedback
   * reaches the next iteration; otherwise execution falls through to the
   * early-exit / session-archive path.
   */
  async verify(params: GoalCompletionVerifyParams): Promise<GoalCompletionVerifyResult> {
    const { ctx, runId, routing, steps, request, response, tenantId, attempt } = params;

    // No verification tool configured → nothing to verify; the goal is
    // considered complete from this gate's perspective.
    if (!ctx.verificationTool) {
      return {
        isComplete: true,
        verificationTrace: `verification=skipped;reason=no_verification_tool;model=${routing.modelId}`,
      };
    }

    // Only verify when the model produced no tool calls of its own — a
    // tool-calling response means the agent is still actively working.
    if (response.toolCalls && response.toolCalls.length > 0) {
      return {
        isComplete: true,
        verificationTrace: `verification=skipped;reason=model_still_calling_tools;tool=${ctx.verificationTool};model=${routing.modelId}`,
      };
    }

    const vToolCallId = `verify-${Date.now()}`;
    const vToolCall: ToolCall = {
      id: vToolCallId,
      name: ctx.verificationTool,
      arguments: {},
    };
    getGlobalLogger().info('AgentRuntime', 'Running verification tool', {
      tool: ctx.verificationTool,
      runId,
    });

    const vStart = Date.now();
    let vResult = await this.deps.getExecuteTool()(
      runId,
      vToolCall,
      ctx.agentId,
      tenantId,
      ctx.availableTools,
      ctx,
    );
    try {
      vResult = await getHookManager().fireAfterToolCall({
        toolName: vToolCall.name,
        args: vToolCall.arguments,
        result: vResult,
        agentId: ctx.agentId,
        runId,
      });
    } catch {
      /* best-effort hook */
    }
    const vDuration = Date.now() - vStart;
    const vOutput = vResult.error ? `error: ${vResult.error}` : vResult.output;

    steps.push({
      stepNumber: steps.length + 1,
      timestamp: now(),
      type: 'tool_result',
      content: vOutput,
      durationMs: vDuration,
    });

    const vAssistantMsg: LLMMessage = {
      role: 'assistant',
      content: response.content,
      ...(response.reasoning_content ? { reasoning_content: response.reasoning_content } : {}),
      tool_calls: [
        {
          id: vToolCallId,
          type: 'function' as const,
          function: {
            name: vToolCall.name,
            arguments: JSON.stringify(vToolCall.arguments),
          },
        },
      ],
    };
    request.messages.push(vAssistantMsg, {
      role: 'tool',
      content: vOutput,
      tool_call_id: vToolCallId,
    });

    const verificationPassed = this.isVerificationResultSuccessful(vResult);
    getGlobalLogger().info('AgentRuntime', 'Verification tool result', {
      tool: ctx.verificationTool,
      passed: verificationPassed,
      runId,
    });

    const verificationTrace = `verification=tool;tool=${ctx.verificationTool};passed=${verificationPassed};error=${vResult.error ?? 'none'};model=${routing.modelId}`;

    // A failed verification forces another iteration — but only while the
    // attempt budget allows it. At the budget boundary we fall through so the
    // runtime's normal terminal handling takes over.
    if (!verificationPassed && attempt < this.deps.getMaxRetries()) {
      const feedback = vResult.error
        ? `Verification tool "${ctx.verificationTool}" reported an error: ${vResult.error}. Use the available tools to complete the task, then call "${ctx.verificationTool}" again.`
        : `Verification tool "${ctx.verificationTool}" did not report success because the task is not complete. Use the available tools to finish the work, then call "${ctx.verificationTool}" again.`;
      request.messages.push({ role: 'user', content: feedback });
      return { isComplete: false, feedback, verificationTrace };
    }

    return { isComplete: verificationPassed, verificationTrace };
  }

  /** Heuristic used by the goal-completion verification gate. A verification
   *  tool succeeds when it reports no error and its output contains an explicit
   *  success signal (or a JSON `passed`/`success`/`ok` field). */
  private isVerificationResultSuccessful(result: ToolResult): boolean {
    if (result.error) return false;
    const output = String(result.output ?? '');
    if (/\b(error|fail|failed|failure|invalid|unsuccessful|false)\b/i.test(output)) {
      return false;
    }
    if (/\b(pass|passed|success|successful|ok|valid|true)\b/i.test(output)) {
      return true;
    }
    try {
      const parsed = JSON.parse(output);
      if (parsed && typeof parsed === 'object') {
        if ('passed' in parsed) return Boolean(parsed.passed);
        if ('success' in parsed) return Boolean(parsed.success);
        if ('ok' in parsed) return Boolean(parsed.ok);
      }
    } catch {
      /* not JSON */
    }
    return true;
  }
}
