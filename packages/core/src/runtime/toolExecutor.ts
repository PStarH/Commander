/**
 * Tool Executor — Extracted from AgentRuntime
 *
 * Handles tool execution with:
 * - Tool whitelist enforcement
 * - Hook integration (beforeToolResolve, afterToolResolve)
 * - Tool not found handling with DLQ recording
 * - Mutation tool compensation tracking
 * - Argument validation and repair
 * - Timeout handling
 * - Result caching
 * - Error classification and structured error context
 *
 * Extracted from agentRuntime.ts for better separation of concerns.
 */

import type {
  Tool,
  ToolCall,
  ToolResult,
  AgentRuntimeConfig,
} from './types';
import { getMessageBus } from './messageBus';
import { getTraceRecorder } from './executionTrace';
import { DeadLetterQueue } from './deadLetterQueue';
import { CompensationRegistry } from './compensationRegistry';
import { ToolResultCache } from './toolResultCache';
import { ToolOutputManager } from './toolOutputManager';
import { getHookManager } from '../hooks';
import { getGlobalLogger } from '../logging';
import { isMutationTool } from './toolRegistry';

// ============================================================================
// Types
// ============================================================================

export interface ToolExecutorConfig {
  timeoutMs: number;
  enableCaching: boolean;
  enableCompensation: boolean;
}

export interface ToolExecutorDeps {
  tools: Map<string, Tool>;
  dlq: DeadLetterQueue;
  compensationRegistry: CompensationRegistry;
  toolCache: ToolResultCache;
  outputManager: ToolOutputManager;
  config: AgentRuntimeConfig;
  generateActionId: () => string;
}

// ============================================================================
// Tool Executor
// ============================================================================

export class ToolExecutor {
  private deps: ToolExecutorDeps;

  constructor(deps: ToolExecutorDeps) {
    this.deps = deps;
  }

  /**
   * Execute a tool call and return STRUCTURED error context to the model.
   * Instead of silently logging errors, the model receives enough context
   * to reason about the failure and decide next steps.
   */
  async execute(
    runId: string,
    toolCall: ToolCall,
    agentId: string,
    tenantId?: string,
    allowedTools?: string[],
  ): Promise<ToolResult> {
    const tracer = getTraceRecorder();
    const bus = getMessageBus();
    const startTime = Date.now();
    const { tools, dlq, compensationRegistry, toolCache, outputManager, config, generateActionId } = this.deps;

    // Sub-agent tool whitelist enforcement
    if (allowedTools && !allowedTools.includes(toolCall.name)) {
      const errorMsg = `TOOL_NOT_ALLOWED: "${toolCall.name}" is not in the allowed tools list for this agent. Allowed: ${allowedTools.join(', ')}`;
      bus.publish('tool.blocked', agentId, { runId, toolName: toolCall.name, reason: 'not_allowed', detail: errorMsg });
      return { toolCallId: toolCall.id, name: toolCall.name, output: errorMsg, error: errorMsg, durationMs: 0 };
    }

    // ── Hook: beforeToolResolve (can block by returning ToolResult) ──
    const resolveBlock = await getHookManager().fireBeforeToolResolve({
      toolName: toolCall.name, args: toolCall.arguments, agentId, runId,
    });
    if (resolveBlock !== null) {
      bus.publish('tool.blocked', agentId, { runId, toolName: toolCall.name, reason: 'hook_blocked', detail: resolveBlock.error ?? '' });
      return resolveBlock;
    }

    const tool = tools.get(toolCall.name);
    const toolFound = !!tool;

    // ── Hook: afterToolResolve ──
    getHookManager().fireAfterToolResolve({
      toolName: toolCall.name, args: toolCall.arguments,
      tool: tool ? { name: tool.definition.name, category: tool.definition.category } : undefined,
      notFound: !toolFound, agentId, runId,
    }).catch(e => getGlobalLogger().debug('ToolExecutor', 'afterToolResolve hook failed', { error: (e as Error)?.message }));

    if (!tool) {
      const error = `TOOL_NOT_FOUND: "${toolCall.name}" is not registered. Available: ${Array.from(tools.keys()).join(', ')}`;
      tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, '', 0, error);
      dlq.record({
        id: generateActionId(), category: 'tool', runId, agentId,
        timestamp: new Date().toISOString(), errorClass: 'permanent', errorMessage: error,
        retryable: false, attemptNumber: 0, operationName: toolCall.name,
        inputSnapshot: JSON.stringify(toolCall.arguments).slice(0, 500),
        compensated: false, recovered: false, tags: ['tool_not_found'],
      });
      const errorMsg = `error: ${error}\nadvice: Check the tool name and try again with a registered tool.`;
      return { toolCallId: toolCall.id, name: toolCall.name, output: errorMsg, error: errorMsg, durationMs: 0 };
    }

    // Record compensable action for mutation tools before execution
    const isMutation = isMutationTool(toolCall.name);
    const actionId = generateActionId();
    if (isMutation && this.deps.config.enableCompensation !== false) {
      compensationRegistry.recordAction({
        actionId, toolName: toolCall.name,
        args: toolCall.arguments as Record<string, unknown>,
        description: `${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 200)})`,
        tags: ['tool', toolCall.name],
      });
    }

    const effectiveTimeout = tool.timeout ?? config.timeoutMs;

    // Check cache for read-only tools
    if (config.enableToolCaching && !isMutation) {
      const cached = toolCache.get(toolCall.name, toolCall.arguments);
      if (cached) {
        tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, cached, 0);
        return { toolCallId: toolCall.id, name: toolCall.name, output: cached, durationMs: 0 };
      }
    }

    // Execute with timeout
    let result: ToolResult;
    try {
      result = await this.executeWithTimeout(tool, toolCall, effectiveTimeout);
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = `TOOL_EXECUTION_ERROR: ${(err as Error).message}`;
      tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, '', durationMs, errorMsg);
      result = {
        toolCallId: toolCall.id, name: toolCall.name,
        output: errorMsg, error: errorMsg, durationMs,
      };
    }

    // Record to trace
    tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, result.output ?? '', result.durationMs, result.error);

    // Cache successful read-only results
    if (config.enableToolCaching && !isMutation && !result.error && result.output) {
      toolCache.set(toolCall.name, toolCall.arguments, result.output);
    }

    // Publish tool completion event
    bus.publish('tool.completed', agentId, {
      runId, toolName: toolCall.name, durationMs: result.durationMs,
      success: !result.error, outputLength: (result.output ?? '').length,
    });

    return result;
  }

  /**
   * Execute a tool with timeout.
   */
  private async executeWithTimeout(
    tool: Tool,
    toolCall: ToolCall,
    timeoutMs: number,
  ): Promise<ToolResult> {
    const startTime = Date.now();

    const timeoutPromise = new Promise<ToolResult>((_, reject) => {
      setTimeout(() => reject(new Error(`Tool "${toolCall.name}" timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    const executionPromise = tool.execute(toolCall.arguments);

    const result = await Promise.race([executionPromise, timeoutPromise]);
    const durationMs = Date.now() - startTime;

    return {
      ...result,
      toolCallId: toolCall.id,
      name: toolCall.name,
      durationMs,
    };
  }
}
