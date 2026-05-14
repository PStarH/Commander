import type { ModelTier, TokenUsage, RoutingDecision } from '../runtime/types';

// ============================================================================
// TELOS Token Budget Types
// ============================================================================

export interface TELOSBudget {
  /** Hard cap on total tokens for this run (0 = no cap) */
  hardCapTokens: number;
  /** Soft cap — warn but don't stop */
  softCapTokens: number;
  /** Hard cap on total cost in USD */
  costCapUsd: number;
}

export interface TokenCheckResult {
  allowed: boolean;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  totalEstimated: number;
  budgetRemaining: number;
  reason?: string;
}

export interface CostRecord {
  runId: string;
  modelId: string;
  provider: string;
  tier: ModelTier;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  timestamp: string;
  agentId: string;
}

export interface CostSummary {
  totalCostUsd: number;
  totalTokens: number;
  totalCalls: number;
  perModel: Record<string, { calls: number; tokens: number; costUsd: number }>;
  perAgent: Record<string, { calls: number; tokens: number; costUsd: number }>;
}

export interface BudgetAlert {
  type: 'soft_cap_warning' | 'hard_cap_reached' | 'cost_cap_reached' | 'budget_exhausted';
  runId: string;
  current: number;
  limit: number;
  message: string;
}

// ============================================================================
// TELOS Plan Context — built ONCE, consumed by Runtime
// ============================================================================

export interface TELOSPlanContext {
  planId: string;
  projectId: string;
  mode: TELOSOrchestrationMode;
  agentAssignments: TELOSAgentAssignment[];
  slimContext: {
    goal: string;
    systemPrompt: string;
    availableToolNames: string[];
    /** Estimated tokens for the system + user messages combined */
    estimatedContextTokens: number;
    /** Token budget for this specific plan */
    budget: TELOSBudget;
  };
  governance: {
    riskLevel: string;
    governanceMode: string;
    requiresApproval: boolean;
  };
  reasoning: string[];
  createdAt: string;
}

export interface TELOSAgentAssignment {
  agentId: string;
  role: 'lead' | 'executor' | 'reviewer' | 'voter';
  modelTier: ModelTier;
  subtask: string;
  dependencies: string[];
}

export type TELOSOrchestrationMode =
  | 'SEQUENTIAL'
  | 'PARALLEL'
  | 'HANDOFF'
  | 'MAGENTIC'
  | 'CONSENSUS';

// ============================================================================
// TELOS Provider Pool Types
// ============================================================================

export interface ProviderEndpoint {
  provider: string;
  modelId: string;
  baseUrl?: string;
  apiKey?: string;
  priority: number;
  weight: number;
  isEnabled: boolean;
}

export interface ProviderHealth {
  provider: string;
  modelId: string;
  status: 'healthy' | 'degraded' | 'down';
  latencyMs: number;
  lastCheck: string;
  consecutiveFailures: number;
  rateLimitRemaining: number;
  rateLimitResetAt?: string;
}

export interface ProviderSelection {
  provider: string;
  modelId: string;
  endpoint: ProviderEndpoint;
  estimatedCost: number;
}

// ============================================================================
// TELOS Stream Types
// ============================================================================

export interface StreamChunk {
  content: string;
  isFinal: boolean;
  tokenUsage?: TokenUsage;
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'error';
}

export type StreamCallback = (chunk: StreamChunk) => void | Promise<void>;

export interface StreamController {
  /** Abort the stream mid-way */
  abort(): void;
  /** Pause / resume */
  pause(): void;
  resume(): void;
  /** Whether the stream is still active */
  isActive: boolean;
}

// ============================================================================
// TELOS Integration Types
// ============================================================================

export interface TELOSConfig {
  defaultBudget: TELOSBudget;
  maxRetries: number;
  retryDelayMs: number;
  enableStreaming: boolean;
  enableCostTracking: boolean;
  enableBudgetEnforcement: boolean;
  monthlyCostLimitUsd: number;
}

export const DEFAULT_TELOS_CONFIG: TELOSConfig = {
  defaultBudget: {
    hardCapTokens: 64000,
    softCapTokens: 48000,
    costCapUsd: 2.00,
  },
  maxRetries: 2,
  retryDelayMs: 2000,
  enableStreaming: true,
  enableCostTracking: true,
  enableBudgetEnforcement: true,
  monthlyCostLimitUsd: 50.00,
};
