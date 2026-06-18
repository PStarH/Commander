// ============================================================================
// Execution Trace Types
// ============================================================================

import type { TokenUsage, ModelTier } from './shared';

/**
 * A single trace event in execution history.
 * Follows OpenTelemetry span attribute naming conventions for easy export.
 */
export interface TraceEvent {
  /** Schema version for forward-compatible deserialization */
  schemaVersion?: number;
  id: string;
  /** Span ID — unique per event, used for parent-child relationships */
  spanId: string;
  /** Trace ID — shared across all events in an execution, survives restarts */
  traceId: string;
  runId: string;
  agentId: string;
  type: 'llm_call' | 'tool_execution' | 'decision' | 'error' | 'state_change' | 'verification';
  timestamp: string;
  durationMs: number;
  data: {
    input?: unknown;
    output?: unknown;
    /** OTel convention: gen_ai.request.model, gen_ai.response.model */
    modelInfo?: { model: string; provider: string; tier: ModelTier };
    /** OTel convention: gen_ai.usage.prompt_tokens, gen_ai.usage.completion_tokens */
    tokenUsage?: TokenUsage;
    error?: string;
    stateTransition?: { from: string; to: string };
    /** OTel convention: gen_ai.response.id */
    responseId?: string;
    /** OTel convention: gen_ai.output.type */
    outputType?: 'text' | 'json' | 'tool_call' | 'image' | 'audio' | 'video';
    /** OTel convention: gen_ai.usage.reasoning.output_tokens */
    reasoningTokens?: number;
    /** OTel convention: gen_ai.response.finish_reasons */
    finishReason?: 'stop' | 'length' | 'tool_calls' | 'error' | 'content_filter' | 'other';
    /** OTel convention: server.address */
    serverAddress?: string;
    /** OTel convention: gen_ai.tool.call.id */
    toolCallId?: string;
    /** Verification pipeline: confidence score [0-1] */
    evaluationScore?: number;
    /** Verification pipeline: whether the verification passed */
    evaluationPassed?: boolean;
    /** Task category from deliberation (coding, research, reasoning, etc.) */
    taskCategory?: string;
    /** Model tier (budget, standard, premium) */
    tier?: string;
    /** OTel convention: gen_ai.conversation.id — links spans across a multi-turn conversation */
    conversationId?: string;
    /** Human feedback attached to this trace event */
    feedback?: {
      rating?: 'positive' | 'negative' | 'neutral';
      comment?: string;
      tags?: string[];
      timestamp: string;
    };
  };
  /** Parent span ID for creating trace trees */
  parentSpanId?: string;
}

/**
 * Active span handle returned by startSpan().
 * Records duration automatically on end().
 */
export interface TraceSpan {
  spanId: string;
  traceId: string;
  /** Finish the span and record it. Duration computed from start to now. */
  end(attributes?: { output?: unknown; error?: string }): TraceEvent;
  /** Add a child event to this span without ending it */
  recordChild(
    type: TraceEvent['type'],
    attrs?: { input?: unknown; output?: unknown; error?: string; durationMs?: number },
  ): TraceEvent;
}

/**
 * A complete trace of an execution.
 */
export interface ExecutionTrace {
  runId: string;
  traceId: string;
  agentId: string;
  missionId?: string;
  /** Tenant that owns this run (for multi-tenant isolation) */
  tenantId?: string;
  /** Parent runId when this is a sub-agent run */
  parentRunId?: string;
  /** Sub-agent depth (0 = root, 1 = first-level sub-agent, etc.) */
  subAgentDepth?: number;
  /** Role of this sub-agent within the agent team */
  subAgentRole?: string;
  startedAt: string;
  completedAt?: string;
  events: TraceEvent[];
  summary: {
    totalEvents: number;
    totalDurationMs: number;
    totalTokens: number;
    llmCalls: number;
    toolExecutions: number;
    errors: number;
    modelUsed: string;
  };
}
