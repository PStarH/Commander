// Span kinds follow OpenTelemetry GenAI semantic conventions (alpha).
// Spec: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/

export type OtelGenAiOperation =
  | 'chat'
  | 'generate_content'
  | 'text_completion'
  | 'embeddings'
  | 'retrieval'
  | 'execute_tool'
  | 'invoke_agent'
  | 'create_agent'
  | 'invoke_workflow';

export type SpanKind =
  | 'AGENT'
  | 'TASK'
  | 'TOOL'
  | 'LLM'
  | 'RETRIEVER'
  | 'EMBEDDING'
  | 'EVALUATOR'
  | 'GUARDRAIL'
  | 'CHAIN'
  | 'DECISION'
  | 'ERROR'
  | 'STATE_CHANGE';

export interface ModelPricing {
  provider: string;
  model: string;
  inputPer1k: number;
  outputPer1k: number;
  cachedInputPer1k?: number;
  reasoningPer1k?: number;
}

export interface CostBreakdown {
  totalCostUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cachedCostUsd?: number;
  reasoningCostUsd?: number;
}

export interface TokenBreakdown {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  total: number;
}

export interface TimelineNode {
  spanId: string;
  parentSpanId?: string;
  traceId: string;
  type: SpanKind;
  operation: OtelGenAiOperation;
  name: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: 'ok' | 'error' | 'unset';
  errorMessage?: string;
  agentId?: string;
  agentName?: string;
  toolName?: string;
  toolCategory?: string;
  model?: string;
  provider?: string;
  tier?: string;
  taskCategory?: string;
  tokens?: TokenBreakdown;
  cost?: CostBreakdown;
  reasoning?: string;
  promptContent?: string;
  completionContent?: string;
  toolInputPreview?: string;
  toolOutputPreview?: string;
  decision?: string;
  stateTransition?: { from: string; to: string };
  evaluationScore?: number;
  evaluationPassed?: boolean;
  hasChildren: boolean;
}

export interface SpanTreeNode {
  span: TimelineNode;
  children: SpanTreeNode[];
  depth: number;
}

export interface TimelineView {
  runId: string;
  traceId: string;
  agentId: string;
  tenantId?: string;
  startedAt: string;
  endedAt?: string;
  totalDurationMs: number;
  nodes: TimelineNode[];
  summary: {
    totalSpans: number;
    llmCalls: number;
    toolCalls: number;
    agentInvocations: number;
    errors: number;
    totalTokens: TokenBreakdown;
    totalCost: CostBreakdown;
    modelsUsed: Array<{ model: string; provider: string; calls: number; tokens: number; costUsd: number }>;
  };
}

export interface SpanTreeView {
  runId: string;
  traceId: string;
  root: SpanTreeNode;
  orphans: SpanTreeNode[];
}

export interface DecisionNode {
  spanId: string;
  parentSpanId?: string;
  timestamp: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  decisionReason: string;
  llmSpanId?: string;
  llmReasoning?: string;
  llmModel?: string;
  thinkDurationMs: number;
  alternatives?: Array<{ toolName: string; reason: string }>;
}

export interface CostReport {
  runId: string;
  traceId: string;
  total: CostBreakdown;
  byModel: Array<{
    model: string;
    provider: string;
    tokens: TokenBreakdown;
    cost: CostBreakdown;
    calls: number;
  }>;
  byTool: Array<{
    toolName: string;
    invocations: number;
    downstreamCost: CostBreakdown;
  }>;
  byAgent: Array<{
    agentId: string;
    tokens: TokenBreakdown;
    cost: CostBreakdown;
  }>;
}

export interface SessionTraceGroup {
  sessionId: string;
  conversationId: string;
  tenantId?: string;
  runs: Array<{
    runId: string;
    agentId: string;
    startedAt: string;
    completedAt?: string;
    totalCost: CostBreakdown;
    totalTokens: TokenBreakdown;
  }>;
  totalCost: CostBreakdown;
  totalTokens: TokenBreakdown;
}

export interface ReplaySpec {
  runId: string;
  substitutions: Array<{
    target: 'tool_output' | 'llm_response' | 'tool_input';
    spanId: string;
    field?: string;
    value: unknown;
  }>;
  reExecuteLlm: boolean;
  modelOverride?: string;
  onlySpanIds?: string[];
}

export interface ReplayResult {
  runId: string;
  traceId: string;
  originalSummary: TimelineView['summary'];
  replaySummary: TimelineView['summary'];
  diff: {
    newSpans: number;
    changedSpans: number;
    costDeltaUsd: number;
    tokenDelta: number;
  };
  replayedNodes: TimelineNode[];
}

export interface ExecutiveSummary {
  runId: string;
  traceId: string;
  status: 'success' | 'error' | 'partial';
  durationMs: number;
  totalCostUsd: number;
  totalTokens: number;
  llmCalls: number;
  toolCalls: number;
  errors: number;
  modelsUsed: string[];
  toolsUsed: string[];
  topology?: string;
  taskCategory?: string;
  narrative: string;
  highlights: string[];
  timeline: Array<{
    timestamp: string;
    label: string;
    detail: string;
    durationMs?: number;
    costUsd?: number;
  }>;
}

export const SPAN_KIND_TO_OPERATION: Record<SpanKind, OtelGenAiOperation> = {
  AGENT: 'invoke_agent',
  TASK: 'invoke_agent',
  TOOL: 'execute_tool',
  LLM: 'chat',
  RETRIEVER: 'retrieval',
  EMBEDDING: 'embeddings',
  EVALUATOR: 'chat',
  GUARDRAIL: 'chat',
  CHAIN: 'chat',
  DECISION: 'invoke_agent',
  ERROR: 'chat',
  STATE_CHANGE: 'invoke_agent',
};

export const COMMANDER_TYPE_TO_SPAN_KIND: Record<string, SpanKind> = {
  llm_call: 'LLM',
  tool_execution: 'TOOL',
  decision: 'DECISION',
  error: 'ERROR',
  state_change: 'STATE_CHANGE',
  verification: 'EVALUATOR',
};
